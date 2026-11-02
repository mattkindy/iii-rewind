//! The JSON shapes of a call and of how a run ends, which the page, the store and saved tests
//! all read: an answer, a call and its place in a run, a pause and an outcome. Field names
//! follow the spec. A fork's own record is in `forks`, and a run's summary is in `runs`.

use iii_sdk::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{effects::Effect, outside::Origin, replay::Choice};

/// What the SDKs send for an ordinary thrown error, used when an answer leaves the code out.
pub const DEFAULT_ERROR_CODE: &str = "invocation_failed";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub message: String,
}

/// What a call returned or threw, written `{ value }` or `{ error }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Answer {
    Error { error: ErrorAnswer },
    Value { value: Value },
}

impl Answer {
    pub fn value(value: Value) -> Self {
        Answer::Value { value }
    }

    pub fn error(code: Option<&str>, message: impl Into<String>) -> Self {
        Answer::Error {
            error: ErrorAnswer {
                code: code.map(str::to_string),
                message: message.into(),
            },
        }
    }

    pub fn is_error(&self) -> bool {
        matches!(self, Answer::Error { .. })
    }

    /// The caller's SDK shows an error as `<code>: <message>` and the agent passes that
    /// text to the model, so the recorded code and message go out unchanged.
    pub fn into_reply(self) -> Result<Value, Error> {
        match self {
            Answer::Value { value } => Ok(value),
            Answer::Error { error } => Err(Error::Remote {
                code: error.code.unwrap_or_else(|| DEFAULT_ERROR_CODE.to_string()),
                message: error.message,
                stacktrace: None,
            }),
        }
    }

    pub fn from_result(result: Result<Value, Error>) -> Self {
        match result {
            Ok(value) => Answer::value(value),
            Err(error) => Answer::Error {
                error: error_answer(error),
            },
        }
    }
}

pub fn error_answer(error: Error) -> ErrorAnswer {
    match error {
        Error::Remote { code, message, .. } => ErrorAnswer {
            code: Some(code),
            message,
        },
        Error::Timeout => ErrorAnswer {
            code: Some("TIMEOUT".to_string()),
            message: "invocation timed out".to_string(),
        },
        other => ErrorAnswer {
            code: Some(DEFAULT_ERROR_CODE.to_string()),
            message: other.to_string(),
        },
    }
}

/// Who gave a call its answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Recorded,
    Edited,
    Injected,
    Live,
    Typed,
    /// Another run's answer, for a call Rewind may not run live.
    Filled,
    /// What a copy of the function's worker returned, because the fork copies that worker.
    Copy,
}

/// Where a call is in a run: its position among its caller's calls, for each caller from the run
/// down, so a call the run made itself has its seq alone. It is written as text, `4` or `4.0`.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct At(pub Vec<u32>);

impl At {
    pub fn top(seq: u32) -> Self {
        At(vec![seq])
    }

    /// The place a call shows as its `seq` and `path`: the path when it has one, or else the seq.
    pub fn of(seq: u32, path: &[u32]) -> Self {
        if path.is_empty() {
            return At::top(seq);
        }

        At(path.to_vec())
    }

    /// The seq of the run's own call this one is in, or is.
    pub fn seq(&self) -> u32 {
        self.0.first().copied().unwrap_or(0)
    }

    pub fn child(&self, position: u32) -> Self {
        let mut path = self.0.clone();
        path.push(position);
        At(path)
    }

    pub fn is_top(&self) -> bool {
        self.0.len() <= 1
    }

    /// The path a call shows, which only a call inside another call has.
    pub fn shown_path(&self) -> Vec<u32> {
        if self.is_top() {
            return Vec::new();
        }

        self.0.clone()
    }
}

impl std::fmt::Display for At {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let parts: Vec<String> = self.0.iter().map(u32::to_string).collect();
        f.write_str(&parts.join("."))
    }
}

impl Serialize for At {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for At {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty() {
            return Ok(At::default());
        }

        text.split('.')
            .map(|part| part.parse::<u32>().map_err(serde::de::Error::custom))
            .collect::<Result<Vec<u32>, _>>()
            .map(At)
    }
}

/// One call in a run as the page shows it: what was called, by which worker, with what input, and
/// the answer it got and from whom. Recorded runs, forks and checks all list their calls this way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub seq: u32,
    /// For a call inside another call, such as the POST inside a copied `email::send`, its
    /// position under each caller from the run down. Its `seq` is the run's call it is in.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
    pub worker: String,
    pub effects: Vec<Effect>,
    pub input: Value,
    pub answer: Answer,
    pub source: Source,
    /// The run a filled answer came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filled_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inferred: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(flatten)]
    pub origin: Origin,
    /// Requests the call's worker made around iii while it ran, such as the email POST
    /// under `email::send`. A replay never makes them, since a stub answers the call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inner: Vec<Call>,
    /// The call's trace, and its span: the callee's `execute` span when recorded, the stub's in a fork.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    /// In a fork: milliseconds from the start of the latest rerun to when the stub got the call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerun_at_ms: Option<f64>,
    /// In a fork: how long the stub took to answer, including any wait to replay a caller's timeout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerun_ms: Option<f64>,
}

/// When a fork's latest rerun started and how long the entry call took.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rerun {
    pub started_at_ms: u64,
    pub duration_ms: f64,
}

impl Call {
    /// A call at `at` that is known only by its function and answer. Struct update syntax sets the rest.
    pub fn new(at: &At, function_id: impl Into<String>, answer: Answer, source: Source) -> Self {
        Call {
            seq: at.seq(),
            path: at.shown_path(),
            function_id: function_id.into(),
            worker: String::new(),
            effects: Vec::new(),
            input: Value::Null,
            answer,
            source,
            filled_from: None,
            inferred: None,
            invocation_id: None,
            started_at_ms: None,
            duration_ms: None,
            origin: Origin::default(),
            inner: Vec::new(),
            trace_id: None,
            span_id: None,
            rerun_at_ms: None,
            rerun_ms: None,
        }
    }

    /// Sets what the call went through from its function id, so a call that changed hands keeps it right.
    pub fn with_origin(mut self) -> Self {
        self.origin = Origin::of(&self.function_id, &self.input);
        self
    }

    pub fn at(&self) -> At {
        At::of(self.seq, &self.path)
    }

    pub fn placed(mut self, at: &At) -> Self {
        self.seq = at.seq();
        self.path = at.shown_path();
        self
    }
}

/// A fork's calls with each call inside another listed in that call's `inner`.
pub fn nest(calls: impl IntoIterator<Item = Call>) -> Vec<Call> {
    let mut top: Vec<Call> = Vec::new();
    for call in calls {
        attach(&mut top, call);
    }

    top
}

/// Puts `call` under the nearest call in `calls` whose path starts its own, or in `calls` when none does.
fn attach(calls: &mut Vec<Call>, call: Call) {
    let path = call.at().0;
    let parent = calls.iter_mut().rev().find(|candidate| {
        let above = candidate.at().0;
        above.len() < path.len() && path.starts_with(&above)
    });
    match parent {
        Some(parent) => attach(&mut parent.inner, call),
        None => calls.push(call),
    }
}

/// A call the caller stopped waiting for. The stub waits `ms`, then sends the callee's
/// own outcome, so the caller's SDK times out on its own clock with its own message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hold {
    pub ms: u64,
    pub reply: Answer,
}

/// A call as a replay uses it: the call the page shows, and how a stub gives its answer, which
/// can wait out a `Hold`. Recordings, a fork's answers and its steps are all steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    #[serde(flatten)]
    pub call: Call,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold: Option<Hold>,
    /// Rewind chose this answer without asking anyone, so changing the fork's settings can drop it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unasked: bool,
}

impl Step {
    /// A step a person or the recording gave, which the caller waits on as usual.
    pub fn new(call: Call) -> Self {
        Step {
            call,
            hold: None,
            unasked: false,
        }
    }
}

/// A debug fork replays a run to change it. A recovery finishes a run a dead worker cut short.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Debug,
    Recover,
}

/// Why a fork paused.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    /// The function is one of the fork's stops.
    Stop,
    /// Nothing could answer the call without a person.
    #[default]
    NoAnswer,
    /// The call a recovery's worker died in. Nobody can tell whether it reached its provider.
    Lost,
}

/// The call a paused fork waits on, and what a person may choose for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Need {
    pub seq: u32,
    /// For a call inside another call, its place under each caller, the same as `Call::path`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
    pub input: Value,
    /// Empty when the function declares none, so a page can say its effects are unknown.
    pub effects: Vec<Effect>,
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub reason: PauseReason,
    /// The paused function's response format as the engine reports it, so a page can build the
    /// answer from it. A request around iii and a function that declares none have no format.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
    /// The trace and span of the stub call that paused, so a page can select it in Traces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
}

impl Need {
    pub fn at(&self) -> At {
        At::of(self.seq, &self.path)
    }
}

/// How a run, a rerun or a check's replay ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Outcome {
    Done { output: Value },
    Crashed { error: ErrorAnswer },
    Paused { need: Need },
}

impl Outcome {
    pub fn is_paused(&self) -> bool {
        matches!(self, Outcome::Paused { .. })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn answers_parse_from_either_form() {
        let value: Answer = serde_json::from_value(json!({ "value": { "now": "x" } })).unwrap();
        assert_eq!(value, Answer::value(json!({ "now": "x" })));

        let null: Answer = serde_json::from_value(json!({ "value": null })).unwrap();
        assert_eq!(null, Answer::value(Value::Null));

        let error: Answer = serde_json::from_value(json!({ "error": { "message": "boom" } })).unwrap();
        assert_eq!(error, Answer::error(None, "boom"));
    }

    #[test]
    fn an_error_answer_replies_with_its_recorded_code_and_message() {
        let answer = Answer::error(Some("invocation_failed"), "unsupported type for timedelta minutes component: str");
        let Err(Error::Remote { code, message, .. }) = answer.into_reply() else {
            panic!("expected a remote error");
        };
        assert_eq!(code, "invocation_failed");
        assert_eq!(message, "unsupported type for timedelta minutes component: str");
    }

    #[test]
    fn a_fetch_call_is_marked_outside_iii_and_an_older_call_reads_as_iii() {
        let input = json!({ "method": "GET", "url": "http://127.0.0.1:49335/holidays", "body": null });
        let fetched = Call::new(
            &At::top(2),
            "fetch GET http://127.0.0.1:49335/holidays",
            Answer::value(json!({ "status": 200 })),
            Source::Recorded,
        );
        let call = Call {
            worker: "agent".into(),
            effects: vec!["read-only".into()],
            input,
            ..fetched
        }
        .with_origin();
        let shown = serde_json::to_value(&call).unwrap();
        assert_eq!(shown["kind"], "fetch");
        assert_eq!(shown["outside_iii"], true);
        assert_eq!(shown["method"], "GET");
        assert_eq!(shown["url"], "http://127.0.0.1:49335/holidays");

        let older = json!({ "seq": 0, "function_id": "clock::now", "worker": "clock", "effects": [], "input": {}, "answer": { "value": {} }, "source": "recorded" });
        let parsed: Call = serde_json::from_value(older).unwrap();
        assert_eq!(parsed.origin, Origin::default());
        assert_eq!(serde_json::to_value(&parsed).unwrap()["kind"], "iii");
    }

    #[test]
    fn a_step_keeps_its_hold_through_the_store() {
        let timed_out = Answer::error(Some("TIMEOUT"), "invocation timed out after about 1500ms");
        let step = Step {
            call: Call {
                worker: "tools".into(),
                effects: vec!["irreversible".into()],
                input: json!({ "to": "dana@example.com" }),
                inferred: Some("the caller retried".into()),
                invocation_id: Some("abc".into()),
                started_at_ms: Some(10),
                duration_ms: Some(2500.5),
                ..Call::new(&At::top(3), "email::send", timed_out, Source::Recorded)
            },
            hold: Some(Hold {
                ms: 2501,
                reply: Answer::value(json!({ "status": "accepted" })),
            }),
            unasked: false,
        };
        let text = serde_json::to_string(&step).unwrap();
        let back: Step = serde_json::from_str(&text).unwrap();
        assert_eq!(back, step);
    }

    #[test]
    fn a_filled_call_says_which_run_its_answer_came_from() {
        let older = json!({ "seq": 4, "function_id": "email::send", "worker": "tools", "effects": ["irreversible"], "input": {}, "answer": { "value": {} }, "source": "recorded" });
        let mut step: Step = serde_json::from_value(older).unwrap();
        assert!(!step.unasked);
        assert_eq!(step.call.filled_from, None);

        step.call.source = Source::Filled;
        step.call.filled_from = Some("run-2".into());
        step.unasked = true;
        let shown = serde_json::to_value(&step.call).unwrap();
        assert_eq!(shown["source"], "filled");
        assert_eq!(shown["filled_from"], "run-2");
        let text = serde_json::to_string(&step).unwrap();
        assert_eq!(serde_json::from_str::<Step>(&text).unwrap(), step);
    }

    #[test]
    fn a_pause_says_why_and_an_older_one_paused_for_want_of_an_answer() {
        let need = json!({ "seq": 2, "function_id": "billing::charge", "input": {}, "effects": [], "choices": ["live"] });
        let older: Need = serde_json::from_value(need).unwrap();
        assert_eq!(older.reason, PauseReason::NoAnswer);
        assert_eq!(serde_json::to_value(&older).unwrap()["reason"], "no_answer");
        assert_eq!(serde_json::to_value(&older).unwrap()["effects"], json!([]));
        assert_eq!(serde_json::to_value(PauseReason::Stop).unwrap(), "stop");
        assert_eq!(serde_json::to_value(PauseReason::Lost).unwrap(), "lost");
    }

    fn answered(seq: u32, path: Vec<u32>, function_id: &str) -> Value {
        json!({ "seq": seq, "path": path, "function_id": function_id, "worker": "", "effects": [], "input": {}, "answer": { "value": {} }, "source": "copy" })
    }

    #[test]
    fn a_call_inside_a_copied_call_is_shown_in_its_inner() {
        let calls: Vec<Call> = [
            answered(3, vec![], "calendar::find-slot"),
            answered(4, vec![], "email::send"),
            answered(4, vec![4, 0], "http_out POST http://127.0.0.1:49335/email"),
            answered(5, vec![], "model::complete"),
        ]
        .into_iter()
        .map(|call| serde_json::from_value(call).unwrap())
        .collect();
        let shown = nest(calls);
        let ids: Vec<&str> = shown.iter().map(|call| call.function_id.as_str()).collect();
        assert_eq!(ids, ["calendar::find-slot", "email::send", "model::complete"]);
        assert_eq!(shown[1].inner.len(), 1);
        assert_eq!(shown[1].inner[0].path, [4, 0]);
        assert_eq!(serde_json::to_value(&shown[0]).unwrap().get("path"), None);
        assert_eq!(serde_json::to_value(Source::Copy).unwrap(), "copy");
    }
}
