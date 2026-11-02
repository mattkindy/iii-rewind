//! Checking a group of runs against the code on disk now, one after another on one
//! copy whose namespace goes away afterwards. Nothing is stored as a fork. A live check
//! also runs what a person could run live, and gives anything else another run's answer.

use std::{collections::BTreeMap, sync::Arc};

use serde::Serialize;
use serde_json::Value;

use crate::{
    app::App,
    code::CodeVersion,
    copies::ForkSpace,
    error::{Error, Result},
    forks::session_for,
    json::{differences, normalize_input},
    namespaces,
    replay::{self, CallAt, Filled, Policy, Ran, Unanswered},
    runs::callee_answer,
    store::Event,
    types::{Answer, At, Mode, Outcome, Step},
};

pub const MAX_RUNS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Same,
    Different,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoppedAt {
    pub seq: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub run_id: String,
    pub result: Verdict,
    pub recorded: Outcome,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<StoppedAt>,
    pub code: CodeVersion,
    /// Only a live check runs any calls live.
    pub live_calls: usize,
    /// Each call the check ran live, in run order.
    pub live: Vec<CallAt>,
    /// The calls a live check may not run, each given another run's answer.
    pub filled: Vec<Filled>,
}

/// How the recorded run ended, written the way a fork's outcome is.
pub fn recorded_outcome(run: &Event) -> Outcome {
    match callee_answer(run) {
        Answer::Value { value } => Outcome::Done { output: value },
        Answer::Error { error } => Outcome::Crashed { error },
    }
}

fn as_json(outcome: &Outcome) -> Value {
    serde_json::to_value(outcome).unwrap_or(Value::Null)
}

/// The paths that came out differently in two replays of the same recording on
/// the same code. They change on every replay, so they say nothing about the code.
pub fn noise(first: &Outcome, second: &Outcome) -> Vec<String> {
    let (first, second) = (as_json(first), as_json(second));
    if first["state"] != second["state"] {
        return Vec::new();
    }

    differences(&first, &second)
}

pub fn same_ignoring(recorded: &Outcome, outcome: &Outcome, noise: &[String]) -> bool {
    differences(&as_json(recorded), &as_json(outcome)).iter().all(|path| {
        noise
            .iter()
            .any(|ignored| path == ignored || path.starts_with(&format!("{ignored}/")))
    })
}

/// The verdict one replay settles, or `None` when only a second replay can tell
/// a different outcome from noise.
pub fn first_verdict(recorded: &Outcome, first: &Outcome) -> Option<Verdict> {
    if first.is_paused() {
        return Some(Verdict::Stopped);
    }

    same_ignoring(recorded, first, &[]).then_some(Verdict::Same)
}

pub fn second_verdict(recorded: &Outcome, first: &Outcome, second: &Outcome) -> Verdict {
    if same_ignoring(recorded, first, &noise(first, second)) {
        return Verdict::Same;
    }

    Verdict::Different
}

fn stopped_at(outcome: &Outcome) -> Option<StoppedAt> {
    let Outcome::Paused { need } = outcome else {
        return None;
    };
    Some(StoppedAt {
        seq: need.seq,
        path: need.path.clone(),
        function_id: need.function_id.clone(),
    })
}

/// One run to check, and the space its replays share with the other runs of the check.
struct Checked<'a> {
    space: &'a Arc<ForkSpace>,
    copies: usize,
    run: Event,
    input: Value,
    recording: Vec<Step>,
}

async fn replay_once(app: &Arc<App>, checked: &Checked<'_>, policy: Policy, answers: BTreeMap<At, Step>) -> Result<Ran> {
    let session = session_for(app, &checked.run, checked.recording.clone(), policy, answers, checked.copies)?;
    replay::run_in(app, checked.space, &checked.run.function_id, checked.input.clone(), session).await
}

async fn verdict(app: &Arc<App>, checked: &Checked<'_>, recorded: &Outcome, first: &Ran) -> Result<Verdict> {
    if let Some(verdict) = first_verdict(recorded, &first.outcome) {
        return Ok(verdict);
    }

    // Given every answer the first replay got, the second makes no live calls, so
    // whatever still differs between the two comes from the code itself.
    let never_live = Policy::new(Mode::Debug, false, Unanswered::Pause);
    let second = replay_once(app, checked, never_live, first.answers.clone()).await?;
    Ok(second_verdict(recorded, &first.outcome, &second.outcome))
}

async fn check_one(app: &Arc<App>, space: &Arc<ForkSpace>, copies: usize, run_id: &str, live: bool) -> Result<CheckResult> {
    let (run, recording) = app.run(run_id)?;
    let input = normalize_input(run.input.as_ref().unwrap_or(&Value::Null));
    let recorded = recorded_outcome(&run);
    let checked = Checked {
        space,
        copies,
        run,
        input,
        recording,
    };
    let first = replay_once(app, &checked, Policy::of_check(run_id, live), BTreeMap::new()).await?;
    let result = verdict(app, &checked, &recorded, &first).await?;
    Ok(CheckResult {
        run_id: run_id.to_string(),
        result,
        stopped_at: stopped_at(&first.outcome),
        recorded,
        live_calls: first.live.len(),
        live: first.live,
        filled: first.filled,
        outcome: first.outcome,
        code: first.code,
    })
}

// One after another on one copy: a replay with every answer known takes milliseconds,
// and a single copy keeps a large check from starting a process per run.
async fn check_each(app: &Arc<App>, space: &Arc<ForkSpace>, copies: usize, run_ids: &[String], live: bool) -> Result<Vec<CheckResult>> {
    let mut results = Vec::with_capacity(run_ids.len());
    for run_id in run_ids {
        let result = check_one(app, space, copies, run_id, live).await?;
        let event = serde_json::to_value(&result).map_err(|error| Error::Internal(error.to_string()))?;
        app.changes.emit_check(run_id, event);
        results.push(result);
    }

    Ok(results)
}

/// The workers every run of a check copies. The runs share one copy, so their roots have to
/// belong to the same worker.
fn shared_copies(app: &App, run_ids: &[String], copy: &[String]) -> Result<Vec<String>> {
    let mut copies: Option<Vec<String>> = None;
    for run_id in run_ids {
        let (run, _) = app.run(run_id)?;
        let wanted = app.copies_for(&run.function_id, copy)?;
        match &copies {
            Some(shared) if shared[0] != wanted[0] => {
                return Err(Error::BadInput(format!(
                    "run {run_id} is a run of {}, and a check copies one worker's runs at a time",
                    wanted[0]
                )));
            }
            Some(_) => {}
            None => copies = Some(wanted),
        }
    }

    Ok(copies.unwrap_or_default())
}

pub async fn check(app: &Arc<App>, run_ids: &[String], live: bool, copy: &[String]) -> Result<Vec<CheckResult>> {
    if run_ids.len() > MAX_RUNS {
        return Err(Error::BadInput(format!("a check takes at most {MAX_RUNS} runs")));
    }

    let copies = shared_copies(app, run_ids, copy)?;
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }

    let namespace = namespaces::check(app.store.next_check_number()?);
    let space = app.spaces.open(app, &namespace, &copies).await?;
    let checked = check_each(app, &space, copies.len(), run_ids, live).await;
    app.spaces.close(&namespace).await;
    checked
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::{ErrorAnswer, Need, PauseReason};

    fn done(output: Value) -> Outcome {
        Outcome::Done { output }
    }

    fn crashed(message: &str) -> Outcome {
        Outcome::Crashed {
            error: ErrorAnswer {
                code: Some("invocation_failed".into()),
                message: message.into(),
            },
        }
    }

    fn paused(seq: u32, function_id: &str) -> Outcome {
        Outcome::Paused {
            need: Need {
                seq,
                path: Vec::new(),
                function_id: function_id.into(),
                input: json!({}),
                effects: vec!["external".into()],
                choices: vec![],
                reason: PauseReason::NoAnswer,
                response_format: None,
                trace_id: None,
                span_id: None,
            },
        }
    }

    #[test]
    fn a_replay_that_ends_like_the_recording_is_the_same() {
        let recorded = crashed("Unterminated string in JSON at position 40");
        assert_eq!(first_verdict(&recorded, &recorded.clone()), Some(Verdict::Same));
        let booked = done(json!({ "status": "booked", "turns": 3 }));
        assert_eq!(first_verdict(&booked, &done(json!({ "turns": 3.0, "status": "booked" }))), Some(Verdict::Same));
    }

    #[test]
    fn a_replay_that_reaches_a_call_the_recording_lacks_is_stopped() {
        let recorded = crashed("Unterminated string in JSON at position 40");
        let outcome = paused(2, "model::complete");
        assert_eq!(first_verdict(&recorded, &outcome), Some(Verdict::Stopped));
        assert_eq!(
            stopped_at(&outcome),
            Some(StoppedAt {
                seq: 2,
                path: Vec::new(),
                function_id: "model::complete".into()
            })
        );
        assert_eq!(stopped_at(&recorded), None);
    }

    #[test]
    fn a_different_ending_needs_a_second_replay_to_tell() {
        let recorded = crashed("Unterminated string in JSON at position 40");
        let fixed = done(json!({ "status": "failed", "turns": 2 }));
        assert_eq!(first_verdict(&recorded, &fixed), None);
        assert_eq!(second_verdict(&recorded, &fixed, &fixed.clone()), Verdict::Different);
    }

    #[test]
    fn a_field_that_changes_between_replays_is_ignored() {
        let recorded = done(json!({ "status": "booked", "request_id": "a1" }));
        let first = done(json!({ "status": "booked", "request_id": "b2" }));
        let second = done(json!({ "status": "booked", "request_id": "c3" }));
        assert_eq!(noise(&first, &second), ["/output/request_id"]);
        assert_eq!(second_verdict(&recorded, &first, &second), Verdict::Same);

        let changed = done(json!({ "status": "failed", "request_id": "b2" }));
        let again = done(json!({ "status": "failed", "request_id": "c3" }));
        assert_eq!(second_verdict(&recorded, &changed, &again), Verdict::Different);
    }

    #[test]
    fn replays_that_end_in_different_states_hide_nothing() {
        let recorded = done(json!({ "status": "booked" }));
        let first = done(json!({ "status": "failed" }));
        assert!(noise(&first, &crashed("boom")).is_empty());
        assert_eq!(second_verdict(&recorded, &first, &crashed("boom")), Verdict::Different);
    }

    #[test]
    fn a_check_makes_live_calls_only_when_asked_to() {
        assert_eq!(Policy::of_check("run-1", false).unanswered, Unanswered::Pause);
        assert_eq!(
            Policy::of_check("run-1", true).unanswered,
            Unanswered::LiveOrFill { run_id: "run-1".into() }
        );
    }

    #[test]
    fn a_recorded_run_ends_the_way_its_event_says() {
        let mut run = Event {
            invocation_id: "run-1".into(),
            function_id: "agent::run".into(),
            namespace: "default".into(),
            status: "success".into(),
            input: Some(json!({ "request": "x" })),
            output: Some(json!({ "status": "booked" })),
            error: None,
            caller_worker: None,
            caller_function_id: None,
            caller_invocation_id: None,
            started_at_ms: 0,
            duration_ms: 1.0,
            code_version: None,
            kind: None,
            trace_id: None,
            span_id: None,
        };
        assert_eq!(recorded_outcome(&run), done(json!({ "status": "booked" })));

        run.status = "error".into();
        run.output = None;
        run.error = Some(json!({ "code": "invocation_failed", "message": "boom", "stacktrace": "at x" }));
        assert_eq!(recorded_outcome(&run), crashed("boom"));
    }
}
