//! Observer targets for the recording bench. `noop` only counts, `batch` sends what arrived to
//! `scale::append` every 50 ms or 500 events, and `sink` owns `scale::append` and only counts.
//! Each role returns its counters from `scale::stats-<role>`.
//! Run: III_URL=ws://127.0.0.1:49534 SCALE_OBSERVE=scale::run-0 ./target/release/scale-noop noop

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use iii_sdk::{
    Capture, IIIClient, InitOptions, ObserverHandle, ObserverOptions, On, RegisterFunction, Source, Target,
    WorkerIdentityMode, protocol::TriggerRequest, register_worker, runtime::WorkerMetadata,
};
use serde_json::{Value, json};
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::Notify,
};

const RECORD_TARGET: &str = "scale::noop-record";
const APPEND: &str = "scale::append";
const STATS: &str = "scale::stats";
const FLUSH_EVERY: Duration = Duration::from_millis(50);
const FLUSH_AT: usize = 500;

#[derive(Default)]
struct Counters {
    received: AtomicU64,
    batches: AtomicU64,
    batched_events: AtomicU64,
    failed_batches: AtomicU64,
    flush_us_total: AtomicU64,
    flush_us_max: AtomicU64,
}

impl Counters {
    fn json(&self) -> Value {
        let batches = self.batches.load(Ordering::Relaxed);
        let total_us = self.flush_us_total.load(Ordering::Relaxed);
        let mean_ms = if batches == 0 { 0.0 } else { total_us as f64 / batches as f64 / 1000.0 };
        json!({
            "received": self.received.load(Ordering::Relaxed),
            "batches": batches,
            "batched_events": self.batched_events.load(Ordering::Relaxed),
            "failed_batches": self.failed_batches.load(Ordering::Relaxed),
            "flush_ms_mean": mean_ms,
            "flush_ms_max": self.flush_us_max.load(Ordering::Relaxed) as f64 / 1000.0,
        })
    }
}

#[derive(Default)]
struct Buffer {
    events: Mutex<Vec<Value>>,
    full: Notify,
}

fn connect(url: &str, name: &str) -> IIIClient {
    register_worker(
        url,
        InitOptions {
            metadata: Some(WorkerMetadata {
                name: name.to_string(),
                ..Default::default()
            }),
            identity: WorkerIdentityMode::Explicit,
            ..Default::default()
        },
    )
}

/// Each role has its own stats id, because the engine refuses a second owner of one id.
fn register_stats(iii: &IIIClient, role: &str, counters: &Arc<Counters>) {
    let counters = counters.clone();
    iii.register_function(
        format!("{STATS}-{role}"),
        RegisterFunction::new_async(move |_input: Value| {
            let counters = counters.clone();
            async move { Ok(counters.json()) }
        })
        .metadata(json!({ "internal": true })),
    );
}

/// Rewind sets no `max_in_flight`, so the engine's default applies unless `SCALE_MAX_IN_FLIGHT` says otherwise.
fn observer_options() -> ObserverOptions {
    let in_flight = std::env::var("SCALE_MAX_IN_FLIGHT").ok().and_then(|text| text.trim().parse::<u32>().ok());
    match in_flight {
        Some(limit) => ObserverOptions::default().max_in_flight(limit),
        None => ObserverOptions::default(),
    }
}

/// The same source Rewind's recorder asks for, so the engine does the same work per call.
fn observe_all(iii: &IIIClient) -> Vec<ObserverHandle> {
    let wanted = std::env::var("SCALE_OBSERVE").unwrap_or_default();
    wanted
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|function_id| {
            iii.observe_with(
                Source::function(function_id)
                    .namespace("default")
                    .on(On::Complete)
                    .capture([Capture::Input, Capture::Output, Capture::Error, Capture::Caller]),
                Target::function(RECORD_TARGET).namespace("default"),
                observer_options(),
            )
        })
        .collect()
}

fn register_counting_target(iii: &IIIClient, counters: &Arc<Counters>) {
    let counters = counters.clone();
    iii.register_function(
        RECORD_TARGET,
        RegisterFunction::new_async(move |_envelope: Value| {
            counters.received.fetch_add(1, Ordering::Relaxed);
            async { Ok(Value::Null) }
        })
        .metadata(json!({ "internal": true })),
    );
}

fn register_buffering_target(iii: &IIIClient, counters: &Arc<Counters>, buffer: &Arc<Buffer>) {
    let counters = counters.clone();
    let buffer = buffer.clone();
    iii.register_function(
        RECORD_TARGET,
        RegisterFunction::new_async(move |envelope: Value| {
            counters.received.fetch_add(1, Ordering::Relaxed);
            let waiting = {
                let mut events = buffer.events.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                events.push(envelope);
                events.len()
            };
            if waiting >= FLUSH_AT {
                buffer.full.notify_one();
            }

            async { Ok(Value::Null) }
        })
        .metadata(json!({ "internal": true })),
    );
}

/// Waits for each batch's answer before sending the next, as a recorder that must not lose a
/// batch would, so a slow store shows up as a longer flush and a bigger next batch.
async fn flush_forever(iii: IIIClient, counters: Arc<Counters>, buffer: Arc<Buffer>) {
    let mut batch_number: u64 = 0;
    loop {
        tokio::select! {
            _ = buffer.full.notified() => {}
            _ = tokio::time::sleep(FLUSH_EVERY) => {}
        }

        let events = std::mem::take(&mut *buffer.events.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
        if events.is_empty() {
            continue;
        }

        batch_number += 1;
        let count = events.len() as u64;
        let started = Instant::now();
        let mut request = TriggerRequest::new(APPEND, json!({ "batch_id": format!("b-{batch_number}"), "events": events }));
        request.timeout_ms = Some(30_000);
        let sent = iii.trigger(request).await;
        let took_us = started.elapsed().as_micros() as u64;
        if sent.is_err() {
            counters.failed_batches.fetch_add(1, Ordering::Relaxed);
            continue;
        }

        counters.batches.fetch_add(1, Ordering::Relaxed);
        counters.batched_events.fetch_add(count, Ordering::Relaxed);
        counters.flush_us_total.fetch_add(took_us, Ordering::Relaxed);
        counters.flush_us_max.fetch_max(took_us, Ordering::Relaxed);
    }
}

fn register_sink(iii: &IIIClient, counters: &Arc<Counters>) {
    let counters = counters.clone();
    iii.register_function(
        APPEND,
        RegisterFunction::new_async(move |input: Value| {
            let count = input["events"].as_array().map(Vec::len).unwrap_or(0) as u64;
            counters.batches.fetch_add(1, Ordering::Relaxed);
            counters.received.fetch_add(count, Ordering::Relaxed);
            async move { Ok(json!({ "stored": count })) }
        })
        .metadata(json!({ "effects": ["writes", "idempotent"], "internal": true })),
    );
}

fn start_role(role: &str, iii: &IIIClient, counters: &Arc<Counters>) -> Vec<ObserverHandle> {
    if role == "sink" {
        register_sink(iii, counters);
        return Vec::new();
    }

    if role == "batch" {
        let buffer = Arc::new(Buffer::default());
        register_buffering_target(iii, counters, &buffer);
        tokio::spawn(flush_forever(iii.clone(), counters.clone(), buffer));
        return observe_all(iii);
    }

    register_counting_target(iii, counters);
    observe_all(iii)
}

#[tokio::main]
async fn main() {
    let url = std::env::var("III_URL").unwrap_or_else(|_| "ws://127.0.0.1:49534".to_string());
    let role = std::env::args().nth(1).unwrap_or_else(|| "noop".to_string());
    let counters = Arc::new(Counters::default());
    let iii = connect(&url, &format!("scale-{role}"));
    register_stats(&iii, &role, &counters);
    let observers = start_role(&role, &iii, &counters);

    if let Err(error) = iii.wait_until_registered(Duration::from_secs(60)).await {
        eprintln!("scale-{role}: the engine did not accept the connection: {error}");
        std::process::exit(1);
    }

    eprintln!("scale-{role}: ready on {url}, observing {} functions", observers.len());
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        eprintln!("scale-{role}: could not listen for signals");
        std::process::exit(1);
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }

    drop(observers);
    let _ = tokio::task::spawn_blocking(move || iii.shutdown()).await;
}
