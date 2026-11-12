//! When workers in `default` connect and disconnect, from `engine::on-workers-changed`. An
//! event has only the worker's id, and a worker that is gone can't be looked up, so Rewind
//! keeps each name it learns. Rewind's own connections and its copies are left out.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use iii_sdk::{CallRequest, ObserverHandle, RegisterFunction, Source, Target, engine::EngineFunctions};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    app::{App, REWIND_WORKER},
    catalog::DEFAULT_NAMESPACE,
    copies::STUB_WORKER,
    error::Result,
    store::Event,
    time::now_ms,
};

const CHANGED_TARGET: &str = "rewind::on-workers-changed";
/// A run's page shows changes up to this long after the run ended, long enough for compose to restart a worker.
const AFTER_RUN_MS: u64 = 5_000;
const PRELOAD_WORKER: &str = "rewind-preload";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkerChange {
    pub at_ms: u64,
    pub worker: String,
    pub worker_id: String,
    /// `connected` or `disconnected`.
    pub event: String,
}

#[derive(Debug, Clone)]
struct Known {
    name: String,
    namespace: String,
    announced: bool,
}

#[derive(Default)]
pub struct Workers {
    known: Mutex<HashMap<String, Known>>,
    watcher: Mutex<Option<ObserverHandle>>,
}

/// From the run's start to a few seconds after it ended.
pub fn window(run: &Event) -> (u64, u64) {
    let ended = run.started_at_ms + run.duration_ms.max(0.0).ceil() as u64;
    (run.started_at_ms, ended + AFTER_RUN_MS)
}

fn followed(known: &Known) -> bool {
    known.namespace == DEFAULT_NAMESPACE
        && !known.name.is_empty()
        && ![REWIND_WORKER, STUB_WORKER, PRELOAD_WORKER].contains(&known.name.as_str())
}

async fn listed(app: &App) -> Result<Vec<Value>> {
    let mut request = CallRequest::new(EngineFunctions::LIST_WORKERS, json!({}));
    request.timeout_ms = Some(10_000);
    let listing = app.iii.call(request).await?;
    Ok(listing["workers"].as_array().cloned().unwrap_or_default())
}

fn known_of(row: &Value) -> Known {
    Known {
        name: row["name"].as_str().unwrap_or_default().to_string(),
        namespace: row["namespace"].as_str().unwrap_or(DEFAULT_NAMESPACE).to_string(),
        announced: false,
    }
}

fn store(app: &App, change: WorkerChange) {
    if let Err(error) = app.store.insert_worker_change(&change) {
        eprintln!("rewind: could not store that {} {}: {error}", change.worker, change.event);
    }
}

/// A connect is stored once the worker has a name, which can arrive in a later metadata event.
async fn seen(app: &App, worker_id: &str, at_ms: u64) -> Result<()> {
    let rows = listed(app).await?;
    let Some(row) = rows.iter().find(|row| row["id"] == worker_id) else {
        return Ok(());
    };
    let mut found = known_of(row);
    let change = {
        let mut known = app.workers.known.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let announced = known.get(worker_id).is_some_and(|earlier| earlier.announced);
        found.announced = announced || followed(&found);
        known.insert(worker_id.to_string(), found.clone());
        (!announced && followed(&found)).then(|| WorkerChange {
            at_ms: row["connected_at_ms"].as_u64().unwrap_or(at_ms),
            worker: found.name.clone(),
            worker_id: worker_id.to_string(),
            event: "connected".into(),
        })
    };
    if let Some(change) = change {
        store(app, change);
    }

    Ok(())
}

fn gone(app: &App, worker_id: &str, at_ms: u64) {
    let left = app
        .workers
        .known
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(worker_id);
    if let Some(left) = left.filter(followed) {
        store(app, WorkerChange { at_ms, worker: left.name, worker_id: worker_id.to_string(), event: "disconnected".into() });
    }
}

async fn on_change(app: &App, envelope: &Value) -> Result<()> {
    let input = &envelope["input"];
    let worker_id = input["worker_id"].as_str().unwrap_or_default();
    let at_ms = envelope["started_at_ms"].as_u64().unwrap_or_else(now_ms);
    match input["event"].as_str().unwrap_or_default() {
        "worker_connected" | "worker_metadata_updated" => seen(app, worker_id, at_ms).await,
        "worker_disconnected" => {
            gone(app, worker_id, at_ms);
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn register(app: &Arc<App>) {
    let changed_app = app.clone();
    app.iii.register_function(
        CHANGED_TARGET,
        RegisterFunction::new_async(move |envelope: Value| {
            let app = changed_app.clone();
            async move {
                app.rt.clone().spawn(async move {
                    if let Err(error) = on_change(&app, &envelope).await {
                        eprintln!("rewind: could not follow a worker change: {error}");
                    }
                });
                Ok(Value::Null)
            }
        })
        .description("Stores when a worker in default connects or disconnects")
        .metadata(json!({ "internal": true })),
    );
}

/// Learns the workers already connected, without storing them as changes, then follows the events.
pub async fn start(app: &Arc<App>) {
    match listed(app).await {
        Ok(rows) => {
            let mut known = app.workers.known.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            for row in rows {
                if let Some(id) = row["id"].as_str() {
                    known.insert(id.to_string(), Known { announced: true, ..known_of(&row) });
                }
            }
        }
        Err(error) => eprintln!("rewind: could not list the workers: {error}"),
    }

    let watcher = app.iii.observe(Source::function("engine::on-workers-changed"), Target::function(CHANGED_TARGET));
    *app.workers.watcher.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(watcher);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(started_at_ms: u64, duration_ms: f64) -> Event {
        Event {
            invocation_id: "run-1".into(),
            function_id: "agent::run".into(),
            namespace: "default".into(),
            status: "success".into(),
            input: None,
            output: None,
            error: None,
            caller_worker: None,
            caller_function_id: None,
            caller_invocation_id: None,
            started_at_ms,
            duration_ms,
            code_version: None,
            kind: None,
            trace_id: None,
            span_id: None,
        }
    }

    #[test]
    fn a_runs_window_goes_from_its_start_to_five_seconds_after_its_end() {
        assert_eq!(window(&run(1_000, 2_500.2)), (1_000, 8_501));
        assert_eq!(window(&run(1_000, 0.0)), (1_000, 6_000));
    }

    #[test]
    fn only_named_workers_in_default_that_are_not_rewinds_own_are_followed() {
        let known = |name: &str, namespace: &str| Known { name: name.into(), namespace: namespace.into(), announced: false };
        assert!(followed(&known("tools", "default")));
        assert!(!followed(&known("agent", "rewind-f3")));
        assert!(!followed(&known("rewind", "default")));
        assert!(!followed(&known("rewind-stubs", "default")));
        assert!(!followed(&known("", "default")));
    }

    #[test]
    fn changes_in_the_window_come_back_oldest_first() {
        let store = crate::store::Store::in_memory();
        let change = |at_ms: u64, worker_id: &str, event: &str| WorkerChange {
            at_ms,
            worker: "tools".into(),
            worker_id: worker_id.into(),
            event: event.into(),
        };
        let stored = [
            change(500, "old", "connected"),
            change(2_000, "old", "disconnected"),
            change(3_100, "new", "connected"),
            change(9_000, "new", "disconnected"),
        ];
        for one in &stored {
            store.insert_worker_change(one).unwrap();
        }

        let (from, to) = window(&run(1_000, 2_500.0));
        let found = store.worker_changes_between(from, to).unwrap();
        assert_eq!(found, [change(2_000, "old", "disconnected"), change(3_100, "new", "connected")]);
    }
}
