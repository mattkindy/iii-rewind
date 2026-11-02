//! Recorded events and listings the runs tests share.

use serde_json::{Value, json};

use super::recorded_steps;
use crate::{
    catalog::{Catalog, FunctionRow},
    store::{Event, Store},
    types::Step,
};

/// A listing of `default` and a store, for whatever a test needs Rewind to know.
pub struct Seen {
    pub catalog: Catalog,
    pub store: Store,
}

impl Seen {
    pub fn listing(function_ids: &[&str]) -> Self {
        let rows: Vec<FunctionRow> = function_ids
            .iter()
            .filter_map(|id| FunctionRow::from_listing(&json!({ "function_id": id, "worker_name": "tools" })))
            .collect();
        let catalog = Catalog::default();
        catalog.replace(&rows);
        Self {
            catalog,
            store: Store::in_memory(),
        }
    }

    /// Whether Rewind has seen a function, the way `App::known_functions` answers it.
    pub fn known(&self) -> impl Fn(&str) -> bool + '_ {
        |function_id| self.catalog.get(function_id).is_some() || self.store.has_recorded(function_id).unwrap_or(false)
    }
}

pub fn not_found(function_id: &str) -> String {
    format!("function_not_found: Function {function_id} not found in namespace default.")
}

/// A run whose tool call got `error`, which the agent passes to the model and then returns.
pub fn run_after_tool_error(tool: &str, error: &str) -> (Event, Vec<Step>) {
    let calls = vec![
        call("a", "clock::now", json!({}), 0, 2.0),
        call("b", "model::complete", json!({ "turn": 1 }), 3, 600.0),
        call(
            "c",
            "model::complete",
            json!({ "turn": 2, "messages": [{ "role": "tool", "name": tool, "result": { "error": error } }] }),
            900,
            500.0,
        ),
    ];
    let reply = format!("I couldn't book it, because {tool} failed: {error}");
    let run = run(json!({ "status": "failed", "reply": reply }));
    (run, recorded_steps(&calls, &Catalog::default()))
}

pub fn call(id: &str, function_id: &str, input: Value, started_at_ms: u64, duration_ms: f64) -> Event {
    Event {
        invocation_id: id.into(),
        function_id: function_id.into(),
        namespace: "default".into(),
        status: "success".into(),
        input: Some(input),
        output: Some(json!({ "ok": id })),
        error: None,
        caller_worker: Some("agent".into()),
        caller_function_id: Some("agent::run".into()),
        caller_invocation_id: Some("run-1".into()),
        started_at_ms,
        duration_ms,
        code_version: None,
        kind: None,
        trace_id: None,
        span_id: None,
    }
}

pub fn run(output: Value) -> Event {
    Event {
        caller_invocation_id: None,
        caller_function_id: None,
        output: Some(output),
        ..call("run-1", "agent::run", json!({ "request": "x" }), 0, 4000.0)
    }
}
