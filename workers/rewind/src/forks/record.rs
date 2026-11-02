//! A fork as Rewind stores it, and the two ways the page sees one: with its calls, from every
//! function that runs or reads a fork, and without them, in a run's list of forks. The stored form
//! also keeps every answer the fork has, which the page never sees.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    code::CodeVersion,
    types::{At, Call, Mode, Outcome, Rerun, Step, nest},
};

/// A fork as the page shows it, without its calls.
#[derive(Debug, Clone, Serialize)]
pub struct ForkSummary {
    pub fork_id: String,
    pub run_id: String,
    pub parent: Option<String>,
    pub edit_at: Option<u32>,
    pub namespace: String,
    pub mode: Mode,
    pub auto_read: bool,
    pub auto: bool,
    pub stops: Vec<String>,
    pub copy: Vec<String>,
    pub code: Option<CodeVersion>,
    pub outcome: Outcome,
    /// The latest rerun's trace, and its root span, the copy's `execute <entry>`.
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub rerun: Option<Rerun>,
}

/// One fork with its calls, as every function that runs or reads a fork returns it.
#[derive(Debug, Clone, Serialize)]
pub struct Fork {
    #[serde(flatten)]
    pub summary: ForkSummary,
    pub calls: Vec<Call>,
}

/// A fork in a run's list of forks, which also says when it was made.
#[derive(Debug, Clone, Serialize)]
pub struct ListedFork {
    #[serde(flatten)]
    pub summary: ForkSummary,
    pub created_at_ms: u64,
}

/// A fork as the store keeps it, one JSON body per fork.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForkRecord {
    pub fork_id: String,
    pub number: u64,
    pub run_id: String,
    pub parent: Option<String>,
    pub edit_at: Option<u32>,
    pub namespace: String,
    pub mode: Mode,
    pub auto_read: bool,
    /// Gives a call that has no answer yet a safe default, so the fork pauses only at a stop or
    /// where no safe default exists.
    #[serde(default)]
    pub auto: bool,
    /// Functions a person wants to decide on whenever neither the fork nor the recording has an answer.
    #[serde(default)]
    pub stops: Vec<String>,
    /// The workers the fork runs copies of, the root's worker first. Empty means only the root's.
    #[serde(default)]
    pub copy: Vec<String>,
    /// Every answer collected so far. A rerun uses these before it looks at the recording.
    pub answers: BTreeMap<At, Step>,
    /// The calls the latest run made, in order.
    pub steps: Vec<Step>,
    pub outcome: Outcome,
    pub created_at_ms: u64,
    /// The code the latest run ran.
    #[serde(default)]
    pub code: Option<CodeVersion>,
    /// Each rerun is a trace of its own, because Rewind calls the entry without trace context.
    #[serde(default)]
    pub trace_id: Option<String>,
    /// Found in the engine's trace store the first time someone asks, after the copy has sent its spans.
    #[serde(default)]
    pub span_id: Option<String>,
    /// When the latest rerun started and how long it took, or none for a fork that has not run.
    #[serde(default)]
    pub rerun: Option<Rerun>,
}

impl ForkRecord {
    pub fn view(&self) -> Fork {
        Fork {
            summary: self.summary(),
            calls: nest(self.steps.iter().map(|step| step.call.clone())),
        }
    }

    pub fn listed(&self) -> ListedFork {
        ListedFork {
            summary: self.summary(),
            created_at_ms: self.created_at_ms,
        }
    }

    fn summary(&self) -> ForkSummary {
        ForkSummary {
            fork_id: self.fork_id.clone(),
            run_id: self.run_id.clone(),
            parent: self.parent.clone(),
            edit_at: self.edit_at,
            namespace: self.namespace.clone(),
            mode: self.mode,
            auto_read: self.auto_read,
            auto: self.auto,
            stops: self.stops.clone(),
            copy: self.copy.clone(),
            code: self.code.clone(),
            outcome: self.outcome.clone(),
            trace_id: self.trace_id.clone(),
            span_id: self.span_id.clone(),
            rerun: self.rerun.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn a_fork_shows_its_settings_and_an_older_fork_has_auto_off() {
        let older = json!({
            "fork_id": "f1", "number": 1, "run_id": "run-1", "parent": null, "edit_at": null,
            "namespace": "rewind-f1", "mode": "debug", "auto_read": false, "answers": {}, "steps": [],
            "outcome": { "state": "done", "output": {} }, "created_at_ms": 0
        });
        let mut record: ForkRecord = serde_json::from_value(older).unwrap();
        assert!(!record.auto);
        assert!(record.stops.is_empty());

        record.auto = true;
        record.stops = vec!["email::send".into()];
        let shown = serde_json::to_value(record.view()).unwrap();
        assert_eq!(shown["auto"], true);
        assert_eq!(shown["stops"], json!(["email::send"]));
        assert_eq!(serde_json::to_value(record.listed()).unwrap()["stops"], json!(["email::send"]));
    }

    #[test]
    fn a_fork_shows_its_calls_and_a_listed_fork_shows_when_it_was_made_instead() {
        let stored = json!({
            "fork_id": "f1", "number": 1, "run_id": "run-1", "parent": null, "edit_at": null,
            "namespace": "rewind-f1", "mode": "debug", "auto_read": false, "answers": {}, "steps": [],
            "outcome": { "state": "done", "output": {} }, "created_at_ms": 5
        });
        let record: ForkRecord = serde_json::from_value(stored).unwrap();
        let keys = |value: Value| -> Vec<String> { value.as_object().unwrap().keys().cloned().collect() };
        let shared = [
            "auto", "auto_read", "code", "copy", "edit_at", "fork_id", "mode", "namespace", "outcome", "parent", "rerun",
            "run_id", "span_id", "stops", "trace_id",
        ];
        let with = |extra: &str| -> Vec<String> {
            let mut all: Vec<String> = shared.iter().map(|key| key.to_string()).chain([extra.to_string()]).collect();
            all.sort();
            all
        };
        assert_eq!(keys(serde_json::to_value(record.view()).unwrap()), with("calls"));
        assert_eq!(keys(serde_json::to_value(record.listed()).unwrap()), with("created_at_ms"));
    }

    fn answered(seq: u32, path: Vec<u32>, function_id: &str) -> Value {
        json!({ "seq": seq, "path": path, "function_id": function_id, "worker": "", "effects": [], "input": {}, "answer": { "value": {} }, "source": "copy" })
    }

    #[test]
    fn answers_stored_by_seq_still_read_and_a_call_inside_a_call_keeps_its_path() {
        let older = json!({
            "fork_id": "f1", "number": 1, "run_id": "run-1", "parent": null, "edit_at": null,
            "namespace": "rewind-f1", "mode": "debug", "auto_read": false,
            "answers": {
                "0": { "seq": 0, "function_id": "clock::now", "worker": "clock", "effects": [], "input": {}, "answer": { "value": {} }, "source": "recorded" },
                "4.0": answered(4, vec![4, 0], "http_out POST http://127.0.0.1:49335/email"),
            },
            "steps": [], "outcome": { "state": "done", "output": {} }, "created_at_ms": 0
        });
        let record: ForkRecord = serde_json::from_value(older).unwrap();
        let keys: Vec<At> = record.answers.keys().cloned().collect();
        assert_eq!(keys, [At::top(0), At(vec![4, 0])]);
        assert!(record.copy.is_empty());
        assert_eq!(record.answers[&At(vec![4, 0])].call.at(), At(vec![4, 0]));
        assert_eq!(record.answers[&At::top(0)].call.at(), At::top(0));

        let stored = serde_json::to_value(&record.answers).unwrap();
        assert!(stored.get("4.0").is_some() && stored.get("0").is_some());
        assert!(At::top(4) < At(vec![4, 0]) && At(vec![4, 0]) < At::top(5));
    }
}
