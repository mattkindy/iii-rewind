//! Runs a dead worker cut short. A call that was running when its worker died fails with
//! `invocation_stopped`, and one made in the second before compose restarts the worker fails with
//! `function_not_found`. The run's later calls, or its own result, quote that error.

use serde_json::Value;

use crate::{store::Event, types::Step};

/// What the engine says when a worker dies with a call in flight.
pub const STOPPED_MARK: &str = "invocation_stopped";

/// What the engine says to a call made while the function's worker is gone. A model that makes up
/// a tool name gets the same error, so it only means lost work for a function Rewind knows.
const NOT_FOUND_MARK: &str = "function_not_found";

/// The call a dead worker cost a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LostCall {
    /// The seq the lost call would have had.
    pub seq: u32,
    /// The worker died while it ran the call, so the call may have reached its provider. A call
    /// that failed with `function_not_found` never reached a worker at all.
    pub mid_call: bool,
}

/// Whether a dead worker cut the run short. `known` says whether Rewind has seen a function in
/// `default`, from the latest listing or from the recording, since a dead worker's functions drop out.
pub fn is_stopped(run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> bool {
    lost_call(run, steps, known).is_some()
}

/// The first call whose input quotes the lost call's error, or the end of the run when only the
/// run's own result does. Anything that quotes `invocation_stopped` there counts as mid-call, so a
/// person decides whenever it is unclear.
pub fn lost_call(run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> Option<LostCall> {
    let first_mention = steps.iter().find(|step| quotes_lost_call(&step.call.input, known));
    if let Some(step) = first_mention {
        return Some(LostCall {
            seq: step.call.seq,
            mid_call: quotes_stop(&step.call.input),
        });
    }

    let run_mentions = results(run).any(|value| quotes_lost_call(value, known));
    run_mentions.then(|| LostCall {
        seq: steps.len() as u32,
        mid_call: results(run).any(quotes_stop),
    })
}

/// The seq of the call a recovery treats as lost: the lost call, when the worker died while running
/// it. A call that failed with `function_not_found` never reached a worker, so the recovery goes by
/// its effects, the same as for any call after it.
pub fn lost_mid_call_at(run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> Option<u32> {
    lost_call(run, steps, known)
        .filter(|lost| lost.mid_call)
        .map(|lost| lost.seq)
}

fn results(run: &Event) -> impl Iterator<Item = &Value> {
    [&run.error, &run.output].into_iter().flatten()
}

fn quotes_stop(value: &Value) -> bool {
    value.to_string().contains(STOPPED_MARK)
}

fn quotes_lost_call(value: &Value, known: &dyn Fn(&str) -> bool) -> bool {
    let text = value.to_string();
    text.contains(STOPPED_MARK) || missing_functions(&text).any(known)
}

/// The function each `function_not_found` in the text is about. Callers quote the engine's
/// message after the code, and it says "Function <id> not found in namespace <namespace>."
fn missing_functions(text: &str) -> impl Iterator<Item = &str> {
    text.match_indices(NOT_FOUND_MARK).filter_map(|(at, _)| {
        let (_, message) = text[at..].split_once("Function ")?;
        let (function_id, _) = message.split_once(" not found")?;
        let one_word = !function_id.is_empty() && !function_id.contains(char::is_whitespace);
        one_word.then_some(function_id)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::{
        catalog::Catalog,
        replay::{
            Decision, Policy, Session, Unanswered,
            testing::{decide, effects},
        },
        runs::{RunFilter, RunStatus, recorded_steps, summarize, testing::*},
        store::Status,
        types::{Mode, PauseReason},
    };

    fn lost_at(run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> Option<u32> {
        lost_call(run, steps, known).map(|lost| lost.seq)
    }

    #[test]
    fn a_run_is_stopped_when_a_later_call_quotes_invocation_stopped() {
        let calls = vec![
            call("a", "clock::now", json!({}), 0, 2.0),
            call("b", "model::complete", json!({ "turn": 1 }), 3, 600.0),
            call(
                "c",
                "model::complete",
                json!({ "turn": 2, "messages": [{ "role": "tool", "result": { "error": "invocation_stopped: Invocation stopped" } }] }),
                900,
                500.0,
            ),
        ];
        let steps = recorded_steps(&calls, &Catalog::default());
        let run = run(json!({ "status": "failed", "reply": "calendar::find-slot failed: invocation_stopped: Invocation stopped" }));
        let seen = Seen::listing(&[]);
        assert_eq!(lost_at(&run, &steps, &seen.known()), Some(2));
        assert!(RunFilter::Stopped.keeps(&run, &steps, &seen.known()));
        assert!(RunFilter::Failed.keeps(&run, &steps, &seen.known()));
        assert_eq!(summarize(&run, &steps, &seen.known()).status, RunStatus::Stopped);
    }

    #[test]
    fn a_run_that_failed_on_its_own_error_is_lost_at_its_end() {
        let mut crashed = run(Value::Null);
        crashed.status = Status::Error;
        crashed.output = None;
        crashed.error = Some(json!({ "code": "invocation_failed", "message": "invocation_stopped: Invocation stopped" }));
        let steps = recorded_steps(&[call("a", "clock::now", json!({}), 0, 2.0)], &Catalog::default());
        assert_eq!(lost_at(&crashed, &steps, &Seen::listing(&[]).known()), Some(1));
    }

    #[test]
    fn a_run_is_lost_when_a_listed_function_was_not_found() {
        let (run, steps) = run_after_tool_error("calendar::find-slot", &not_found("calendar::find-slot"));
        let seen = Seen::listing(&["calendar::find-slot", "email::send"]);
        assert_eq!(lost_at(&run, &steps, &seen.known()), Some(2));
        assert!(RunFilter::Stopped.keeps(&run, &steps, &seen.known()));
        assert_eq!(summarize(&run, &steps, &seen.known()).status, RunStatus::Stopped);
    }

    // While the worker restarts, its functions can be missing from the listing too.
    #[test]
    fn a_run_is_lost_when_a_recorded_function_was_not_found() {
        let (run, steps) = run_after_tool_error("email::send", &not_found("email::send"));
        let seen = Seen::listing(&[]);
        seen.store
            .insert_event(&call("earlier", "email::send", json!({ "to": "x" }), 0, 300.0))
            .unwrap();
        assert_eq!(lost_at(&run, &steps, &seen.known()), Some(2));
    }

    #[test]
    fn a_made_up_function_that_was_not_found_is_not_lost_work() {
        let (run, steps) = run_after_tool_error("calendar::book", &not_found("calendar::book"));
        let seen = Seen::listing(&["calendar::find-slot", "email::send"]);
        assert_eq!(lost_at(&run, &steps, &seen.known()), None);
        assert!(!RunFilter::Stopped.keeps(&run, &steps, &seen.known()));
        assert_eq!(summarize(&run, &steps, &seen.known()).status, RunStatus::Success);
    }

    /// A recovery of the run as `forks` sets one up, with no stops.
    fn recovery(run: &Event, steps: &[Step], seen: &Seen, unanswered: Unanswered) -> Session {
        let mut policy = Policy::new(Mode::Recover, false, unanswered);
        policy.lost_at = lost_mid_call_at(run, steps, &seen.known());
        Session::new(policy, steps.to_vec(), BTreeMap::new())
    }

    #[test]
    fn a_recovery_pauses_as_lost_at_a_send_cut_off_mid_call() {
        let (run, steps) = run_after_tool_error("email::send", "invocation_stopped: Invocation stopped");
        let seen = Seen::listing(&["calendar::find-slot", "email::send"]);
        assert_eq!(lost_call(&run, &steps, &seen.known()), Some(LostCall { seq: 2, mid_call: true }));
        let asking = recovery(&run, &steps, &seen, Unanswered::LiveUnasked);
        let send = decide(&asking, &seen.store, 2, "email::send", &json!({}), &effects(&["irreversible"]));
        assert_eq!(send, Decision::Pause(PauseReason::Lost));
    }

    #[test]
    fn a_recovery_runs_a_read_only_lookup_cut_off_mid_call_again() {
        let (run, steps) = run_after_tool_error("calendar::find-slot", "invocation_stopped: Invocation stopped");
        let seen = Seen::listing(&["calendar::find-slot", "email::send"]);
        assert_eq!(lost_call(&run, &steps, &seen.known()), Some(LostCall { seq: 2, mid_call: true }));
        let asking = recovery(&run, &steps, &seen, Unanswered::LiveUnasked);
        let lookup = decide(&asking, &seen.store, 2, "calendar::find-slot", &json!({}), &effects(&["read-only"]));
        assert_eq!(lookup, Decision::Live);
    }

    // The engine never gave the call to a worker, so it can't have reached the provider.
    #[test]
    fn a_recovery_goes_by_the_effects_of_a_call_that_was_not_found() {
        let seen = Seen::listing(&["calendar::find-slot", "email::send"]);
        let (run, steps) = run_after_tool_error("email::send", &not_found("email::send"));
        assert_eq!(lost_call(&run, &steps, &seen.known()), Some(LostCall { seq: 2, mid_call: false }));
        let irreversible = effects(&["irreversible"]);
        let asking = recovery(&run, &steps, &seen, Unanswered::LiveUnasked);
        let send = decide(&asking, &seen.store, 2, "email::send", &json!({}), &irreversible);
        assert_eq!(send, Decision::Pause(PauseReason::NoAnswer));

        seen.store.insert_event(&run).unwrap();
        let elsewhere = Event {
            caller_invocation_id: Some("run-2".into()),
            ..call("send-2", "email::send", json!({ "to": "x" }), 0, 300.0)
        };
        seen.store.insert_event(&elsewhere).unwrap();
        let auto = recovery(&run, &steps, &seen, Unanswered::LiveOrFill { run_id: "run-1".into() });
        let filled = decide(&auto, &seen.store, 2, "email::send", &json!({}), &irreversible);
        assert!(matches!(filled, Decision::Fill(..)), "{filled:?}");

        let (run, steps) = run_after_tool_error("calendar::find-slot", &not_found("calendar::find-slot"));
        let asking = recovery(&run, &steps, &seen, Unanswered::LiveUnasked);
        let lookup = decide(&asking, &seen.store, 2, "calendar::find-slot", &json!({}), &effects(&["read-only"]));
        assert_eq!(lookup, Decision::Live);
    }
}
