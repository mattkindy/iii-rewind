//! Rewind: records calls between iii functions, replays a recorded request
//! against the worker's own code, forks it when someone changes an answer, and
//! recovers runs a dead worker cut short.

mod app;
mod captures;
mod catalog;
mod changes;
mod checks;
mod code;
mod config;
mod copies;
mod effects;
mod error;
mod fixtures;
mod forks;
mod functions;
mod idempotency;
mod inbound;
mod json;
mod locks;
mod namespaces;
mod outside;
mod pool;
mod recording;
mod recovery;
mod replay;
mod retention;
mod runs;
mod settling;
mod sources;
mod spans;
mod store;
mod time;
mod traces;
mod types;
mod ui;
mod workers;

use std::{sync::Arc, time::Duration};

use tokio::signal::unix::{SignalKind, signal};

use crate::{
    app::{App, REWIND_WORKER, connect},
    config::Config,
    spans::Spans,
    store::Store,
};

fn exit_with(message: String) -> ! {
    eprintln!("rewind: {message}");
    std::process::exit(1);
}

async fn wait_for_signal() {
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
        signal(SignalKind::hangup()),
    ) else {
        exit_with("could not listen for signals".to_string());
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
        _ = hup.recv() => {}
    }
}

#[tokio::main]
async fn main() {
    let config = Config::from_env();
    let store = Store::open(&config.db_path)
        .unwrap_or_else(|error| exit_with(format!("could not open {}: {error}", config.db_path.display())));
    let spans = Spans::open(&config.spans_path)
        .unwrap_or_else(|error| exit_with(format!("could not open {}: {error}", config.spans_path.display())));
    eprintln!(
        "rewind: engine {}, entry {}, data {}, copies from {}",
        config.url,
        config.entry,
        config.db_path.display(),
        config.target_dir.display()
    );

    let iii = connect(&config.url, REWIND_WORKER, None);
    let app = Arc::new(App::new(config, iii, store, spans, tokio::runtime::Handle::current()));
    recording::register(&app);
    functions::register_all(&app);
    changes::register(&app);
    ui::register(&app);
    workers::register(&app);

    if let Err(error) = app.iii.wait_until_registered(Duration::from_secs(60)).await {
        exit_with(format!("the engine did not accept Rewind's connection: {error}"));
    }

    if let Err(error) = recording::confirm_target_owner(&app).await {
        exit_with(error);
    }

    // Runs are stamped with the code version as they are recorded, so it is read before recording starts.
    match app.target_code.now().await {
        Ok(code) => eprintln!("rewind: the code under test is version {}", code.version),
        Err(error) => eprintln!("rewind: {error}"),
    }

    recording::start(&app);
    settling::start(&app);
    captures::start(&app);
    retention::start(&app);
    workers::start(&app).await;
    code::start(&app);
    copies::start_pool(&app);
    copies::start_idle_close(&app);
    ui::start(&app);
    eprintln!("rewind: ready");

    wait_for_signal().await;
    eprintln!("rewind: stopping the copies and closing");
    tokio::join!(copies::close_pool(&app), app.spaces.close_all());
    let client = app.iii.clone();
    let _ = tokio::task::spawn_blocking(move || client.shutdown()).await;
    recording::finish_writing(&app).await;
}
