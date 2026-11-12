//! `rewind::changed`, the event the UI observes. Rewind calls it with `{ kind, id }` whenever a
//! run, fork, lost run, the code under test or the count of dropped calls changes, and with
//! `{ kind: "check", id, check }` as each checked run finishes. iii hands each one to every observer.

use std::sync::{Arc, OnceLock};

use iii_sdk::{CallRequest, IIIClient, RegisterFunction, runtime::FunctionRef};
use serde_json::{Value, json};
use tokio::{runtime::Handle, sync::mpsc};

use crate::app::App;

pub const CHANGED: &str = "rewind::changed";

#[derive(Default)]
pub struct Changes {
    function: OnceLock<FunctionRef>,
    events: OnceLock<mpsc::UnboundedSender<Value>>,
}

impl Changes {
    fn send(&self, event: Value) {
        if !self.function.get().is_some_and(FunctionRef::is_observed) {
            return;
        }

        if let Some(events) = self.events.get() {
            let _ = events.send(event);
        }
    }

    pub fn emit(&self, kind: &str, id: &str) {
        self.send(json!({ "kind": kind, "id": id }));
    }

    /// A fork's event also says which trace its latest rerun was, so a page can open it in Traces.
    pub fn emit_fork(&self, fork_id: &str, trace_id: Option<&str>) {
        self.send(json!({ "kind": "fork", "id": fork_id, "trace_id": trace_id }));
    }

    /// A check returns only when every run is done, so each event also has the
    /// run's result, and the page can show results as they land.
    pub fn emit_check(&self, run_id: &str, result: Value) {
        self.send(json!({ "kind": "check", "id": run_id, "check": result }));
    }
}

/// One task makes the calls, so observers get the events in the order Rewind sent them.
fn start_sending(iii: IIIClient, rt: &Handle) -> mpsc::UnboundedSender<Value> {
    let (sender, mut received) = mpsc::unbounded_channel::<Value>();
    rt.spawn(async move {
        while let Some(event) = received.recv().await {
            if let Err(error) = iii.call(CallRequest::new(CHANGED, event)).await {
                eprintln!("rewind: could not send a change to the page: {error}");
            }
        }
    });
    sender
}

pub fn register(app: &Arc<App>) {
    let function = app.iii.register_function(
        CHANGED,
        RegisterFunction::new(|event: Value| Ok::<_, iii_sdk::Error>(event))
            .description("Called with { kind, id } whenever a run, fork, lost run, the code under test or the count of dropped calls changes, and as each checked run finishes. Observe it to get each one.")
            .metadata(json!({ "internal": true }))
            .private(),
    );
    let _ = app.changes.function.set(function);
    let _ = app.changes.events.set(start_sending(app.iii.clone(), &app.rt));
}
