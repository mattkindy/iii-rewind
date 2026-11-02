//! Runs, read back from the recording. A run is a root call in `default`, and its calls are the
//! events it made, in start order. `steps` rebuilds a run's calls, `inference` works out what the
//! caller saw of each, `lost` finds a run a dead worker cut short, and `search` lists runs.

mod inference;
mod lost;
mod search;
mod steps;
#[cfg(test)]
mod testing;

use serde::Serialize;
use serde_json::Value;

pub use lost::{is_stopped, lost_call, lost_mid_call_at};
pub use search::{RunFilter, RunQuery};
pub use steps::{recorded_below, recorded_steps, with_inner};

use crate::{
    catalog::{Catalog, DEFAULT_NAMESPACE},
    forks::ListedFork,
    json::normalize_input,
    outside::Kind,
    store::{Event, Status},
    types::{Answer, Call, ErrorAnswer, Step},
    workers::WorkerChange,
};

/// Function ids that are never the root of a run, because they are Rewind's or the engine's.
pub const NOT_ROOTS: [&str; 2] = ["rewind::", "engine::"];

/// Whether a recorded call is the root of a run. The entry always is, even when `traffic::burst`
/// called it, and so is a call nothing recorded called, or a request to a worker's own HTTP server.
/// Rewind's and the engine's functions never are, nor is an internal one or one in another namespace.
pub fn is_root(event: &Event, entry: &str, catalog: &Catalog) -> bool {
    let kind = Kind::parse(event.kind.as_deref());
    let own = NOT_ROOTS.iter().any(|prefix| event.function_id.starts_with(prefix));
    let internal = catalog.get(&event.function_id).is_some_and(|row| row.internal);
    if event.namespace != DEFAULT_NAMESPACE || own || internal {
        return false;
    }

    match kind {
        Kind::HttpIn => true,
        Kind::Iii => event.function_id == entry || event.caller_invocation_id.is_none(),
        _ => false,
    }
}

/// The run's own calls among `events`, in the order they started.
pub fn pick_calls(run_id: &str, events: &[Event]) -> Vec<Event> {
    let mut calls: Vec<Event> = events
        .iter()
        .filter(|event| event.caller_invocation_id.as_deref() == Some(run_id))
        .filter(|event| event.invocation_id != run_id)
        .filter(|event| Kind::parse(event.kind.as_deref()).is_step())
        .cloned()
        .collect();
    // Arrival order is not start order: in-process calls are reported in batches.
    // Two calls that start in the same millisecond ran shortest first.
    calls.sort_by(|a, b| {
        a.started_at_ms
            .cmp(&b.started_at_ms)
            .then(a.duration_ms.total_cmp(&b.duration_ms))
    });
    calls
}

/// What the callee returned or threw, as the observer reported it.
pub fn callee_answer(event: &Event) -> Answer {
    if event.status == Status::Error {
        let error = event.error.clone().unwrap_or(Value::Null);
        return Answer::Error {
            error: ErrorAnswer {
                code: error["code"].as_str().map(str::to_string),
                message: error["message"].as_str().unwrap_or_default().to_string(),
            },
        };
    }

    Answer::value(event.output.clone().unwrap_or(Value::Null))
}

#[derive(Debug, Clone, Serialize)]
pub struct RunSummary {
    pub run_id: String,
    /// The root's function, such as the entry, a function someone triggered directly, or a request.
    pub function_id: String,
    pub status: RunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorAnswer>,
    pub input: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    pub started_at_ms: u64,
    pub duration_ms: f64,
    pub calls: usize,
    /// The version of the code under test when Rewind recorded the run, if it was recorded with one.
    pub code_version: Option<String>,
    /// The run's trace, and its own `execute` span once someone has asked for the run.
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
}

/// How a run ended as recorded, or `stopped` when a worker died under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Success,
    Error,
    Stopped,
}

fn run_status(run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> RunStatus {
    if is_stopped(run, steps, known) {
        return RunStatus::Stopped;
    }

    match run.status {
        Status::Success => RunStatus::Success,
        Status::Error => RunStatus::Error,
    }
}

/// The trace the run's calls ran in, which is the run's own. The run's record gets its caller's
/// trace, and a run started with no trace context has none, so Rewind's handler gets a new one.
pub fn trace_of(run: &Event, steps: &[Step]) -> Option<String> {
    steps
        .iter()
        .find_map(|step| step.call.trace_id.clone())
        .or_else(|| run.trace_id.clone())
}

/// A run as the runs list shows it. `known` says whether Rewind has seen a function in `default`.
pub fn summarize(run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> RunSummary {
    let error = match callee_answer(run) {
        Answer::Error { error } => Some(error),
        Answer::Value { .. } => None,
    };
    RunSummary {
        run_id: run.invocation_id.clone(),
        function_id: run.function_id.clone(),
        status: run_status(run, steps, known),
        error,
        input: normalize_input(run.input.as_ref().unwrap_or(&Value::Null)),
        output: run.output.clone(),
        started_at_ms: run.started_at_ms,
        duration_ms: run.duration_ms,
        calls: steps.len(),
        code_version: run.code_version.clone(),
        trace_id: trace_of(run, steps),
        span_id: run.span_id.clone(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RunDetail {
    pub run: RunSummary,
    pub calls: Vec<Call>,
    pub forks: Vec<ListedFork>,
    /// Workers that connected or disconnected from the run's start to a few seconds after it ended.
    pub worker_changes: Vec<WorkerChange>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{testing::*, *};
    use crate::catalog::FunctionRow;

    fn ids(events: Vec<Event>) -> Vec<String> {
        events.into_iter().map(|event| event.invocation_id).collect()
    }

    #[test]
    fn picks_only_the_runs_own_calls_in_start_order() {
        let mut other = call("x", "clock::now", json!({}), 5, 1.0);
        other.caller_invocation_id = Some("run-2".into());
        let events = vec![
            call("c", "model::complete", json!({ "turn": 1 }), 20, 500.0),
            other,
            call("a", "clock::now", json!({}), 10, 2.0),
            run(json!({})),
        ];
        assert_eq!(ids(pick_calls("run-1", &events)), ["a", "c"]);
    }

    #[test]
    fn two_calls_in_the_same_millisecond_go_shortest_first() {
        let events = vec![
            call("model", "model::complete", json!({}), 10, 600.0),
            call("clock", "clock::now", json!({}), 10, 0.4),
        ];
        assert_eq!(ids(pick_calls("run-1", &events)), ["clock", "model"]);
    }

    #[test]
    fn a_recorded_error_keeps_its_code_and_message() {
        let mut failed = call("slot", "calendar::find-slot", json!({ "duration": "30" }), 0, 500.0);
        failed.status = Status::Error;
        failed.output = None;
        failed.error = Some(json!({
            "code": "invocation_failed",
            "message": "unsupported type for timedelta minutes component: str",
            "stacktrace": "Traceback ...",
        }));
        assert_eq!(
            callee_answer(&failed),
            Answer::error(Some("invocation_failed"), "unsupported type for timedelta minutes component: str")
        );
    }

    #[test]
    fn a_booked_run_is_neither_failed_nor_stopped() {
        let steps = recorded_steps(&[call("a", "clock::now", json!({}), 0, 2.0)], &Catalog::default());
        let booked = run(json!({ "status": "booked" }));
        let seen = Seen::listing(&[]);
        assert!(!RunFilter::Failed.keeps(&booked, &steps, &seen.known()));
        assert!(!RunFilter::Stopped.keeps(&booked, &steps, &seen.known()));
        assert_eq!(summarize(&booked, &steps, &seen.known()).status, RunStatus::Success);
        assert_eq!(serde_json::to_value(RunStatus::Stopped).unwrap(), "stopped");
    }

    #[test]
    fn a_run_is_in_the_trace_its_calls_ran_in() {
        const RUN_TRACE: &str = "26c5020a167ec0c4b0e64d0006b63b40";
        let mut started_without_context = run(json!({ "status": "booked" }));
        started_without_context.trace_id = Some("905906ae37cd76f707a3d5a4c8a3d022".into());
        let mut clock = call("a", "clock::now", json!({}), 0, 2.0);
        clock.trace_id = Some(RUN_TRACE.into());
        let steps = recorded_steps(&[clock], &Catalog::default());
        let seen = Seen::listing(&[]);
        assert_eq!(summarize(&started_without_context, &steps, &seen.known()).trace_id.as_deref(), Some(RUN_TRACE));
        assert_eq!(trace_of(&started_without_context, &[]), started_without_context.trace_id);
    }

    fn uncalled(id: &str, function_id: &str) -> Event {
        Event {
            caller_worker: None,
            caller_function_id: None,
            caller_invocation_id: None,
            ..call(id, function_id, json!({}), 0, 1.0)
        }
    }

    #[test]
    fn the_entry_is_a_root_even_when_traffic_called_it() {
        let catalog = Catalog::default();
        let from_burst = Event {
            caller_function_id: Some("traffic::burst".into()),
            caller_invocation_id: Some("burst-1".into()),
            ..run(json!({}))
        };
        assert!(is_root(&from_burst, "agent::run", &catalog));
        assert!(is_root(&uncalled("burst-1", "traffic::burst"), "agent::run", &catalog));
    }

    #[test]
    fn a_call_nothing_recorded_called_is_a_root_and_a_call_inside_a_run_is_not() {
        let catalog = Catalog::default();
        assert!(is_root(&uncalled("slot-1", "calendar::find-slot"), "agent::run", &catalog));
        assert!(!is_root(&call("slot-2", "calendar::find-slot", json!({}), 0, 1.0), "agent::run", &catalog));

        let request = Event {
            kind: Some("http_in".into()),
            ..uncalled("in-1", "http_in GET http://127.0.0.1:49335/holidays")
        };
        assert!(is_root(&request, "agent::run", &catalog));
        let fetch_outside_a_handler = Event {
            kind: Some("fetch".into()),
            ..uncalled("fetch-1", "fetch GET http://x/")
        };
        assert!(!is_root(&fetch_outside_a_handler, "agent::run", &catalog));
    }

    #[test]
    fn rewinds_own_the_engines_internal_and_other_namespaces_calls_are_never_roots() {
        let rows: Vec<FunctionRow> = [
            json!({ "function_id": "calendar::find-slot", "worker_name": "tools", "metadata": { "effects": ["read-only"] } }),
            json!({ "function_id": "tools::warm-cache", "worker_name": "tools", "metadata": { "internal": true } }),
        ]
        .iter()
        .filter_map(FunctionRow::from_listing)
        .collect();
        let catalog = Catalog::default();
        catalog.replace(&rows);
        for function_id in ["rewind::runs", "engine::functions::list", "tools::warm-cache"] {
            assert!(!is_root(&uncalled("x", function_id), "agent::run", &catalog), "{function_id}");
        }

        let in_a_fork = Event {
            namespace: "rewind-f3".into(),
            ..uncalled("y", "calendar::find-slot")
        };
        assert!(!is_root(&in_a_fork, "agent::run", &catalog));
        assert!(is_root(&uncalled("z", "calendar::find-slot"), "agent::run", &catalog));
    }
}
