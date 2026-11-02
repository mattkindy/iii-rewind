//! `rewind::changed`, the live trigger the UI binds to. Each bound console tab
//! gets `{ kind, id }` whenever a run, a fork, a lost run or the code under test
//! changes, and `{ kind: "check", id, check }` as each run in a check finishes.

use std::sync::{Arc, Mutex};

use iii_sdk::{Observe, ObserveHandler, ObserveRejection, Observer, RegisterFunction};
use serde_json::{Value, json};

use crate::app::App;

pub const CHANGED: &str = "rewind::changed";

#[derive(Default)]
pub struct Changes {
    observers: Mutex<Vec<Observer>>,
}

impl Changes {
    fn send(&self, event: &Value) {
        let observers = self.observers.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        for observer in observers {
            let _ = observer.emit(event);
        }
    }

    pub fn emit(&self, kind: &str, id: &str) {
        self.send(&json!({ "kind": kind, "id": id }));
    }

    /// A fork's event also says which trace its latest rerun was, so a page can open it in Traces.
    pub fn emit_fork(&self, fork_id: &str, trace_id: Option<&str>) {
        self.send(&json!({ "kind": "fork", "id": fork_id, "trace_id": trace_id }));
    }

    /// A check returns only when every run is done, so each event also has the
    /// run's result, and the page can show results as they land.
    pub fn emit_check(&self, run_id: &str, result: Value) {
        self.send(&json!({ "kind": "check", "id": run_id, "check": result }));
    }
}

struct ChangeObservers(Arc<Changes>);

#[async_trait::async_trait]
impl ObserveHandler for ChangeObservers {
    async fn on_observer_added(&self, observer: &Observer) -> Result<(), ObserveRejection> {
        self.0
            .observers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(observer.clone());
        Ok(())
    }

    async fn on_observer_removed(&self, observer: &Observer) {
        self.0
            .observers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|kept| kept.id() != observer.id());
    }
}

pub fn register(app: &Arc<App>) {
    // A page's registerTrigger({ type: "rewind::changed" }) arrives as an observer of this function.
    app.iii.register_function(
        CHANGED,
        RegisterFunction::new_async(|_input: Value| async move { Ok(Value::Null) })
            .description("Fires { kind, id } whenever a run, fork, lost run or the code under test changes, and as each checked run finishes")
            .metadata(json!({ "internal": true }))
            .observe(
                Observe::owner()
                    .legacy_trigger_type(CHANGED)
                    .handler(ChangeObservers(app.changes.clone())),
            ),
    );
}
