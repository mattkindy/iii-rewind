//! What the caller saw of each recorded call, where it differs from the callee's outcome. The
//! observer reports how the callee finished, but a caller that gave up first saw a timeout or
//! moved on, and a replay has to make the copy's own SDK reach the same decision on its own clock.

use serde_json::Value;

use super::callee_answer;
use crate::{
    json::same_input,
    store::Event,
    types::{Answer, Hold},
};

// Start times are whole milliseconds, so two calls in a row can look up to a
// millisecond or so apart from where they were.
const OVERLAP_TOLERANCE_MS: f64 = 5.0;

// A stub replaying a timeout waits this much past the caller's retry, so the
// caller's own timer fires first even when the recorded call finished soon after it.
const TIMEOUT_MARGIN_MS: u64 = 500;

/// What the caller saw of a call it stopped waiting for: the answer it got, a note the page shows,
/// and the hold a replay waits out before sending the callee's own outcome.
#[derive(Debug, Clone, PartialEq)]
pub struct Inference {
    pub answer: Answer,
    pub note: String,
    pub hold: Hold,
}

/// When a later call started before a call finished, the caller had stopped waiting for it, and
/// when that later call is the same function with the same input, the caller timed out and retried.
/// Either way the replay waits as long as the recorded call took.
pub fn infer_caller_view(calls: &[Event]) -> Vec<Option<Inference>> {
    calls
        .iter()
        .enumerate()
        .map(|(index, call)| infer_one(call, &calls[index + 1..]))
        .collect()
}

fn infer_one(call: &Event, later: &[Event]) -> Option<Inference> {
    let finished_at = call.started_at_ms as f64 + call.duration_ms;
    let started_before_finish = |next: &&Event| (next.started_at_ms as f64) + OVERLAP_TOLERANCE_MS < finished_at;
    let overlapping = later.iter().find(started_before_finish)?;
    let reply = callee_answer(call);
    let took_ms = call.duration_ms.ceil() as u64;

    let retry = later.iter().filter(started_before_finish).find(|next| {
        next.function_id == call.function_id
            && same_input(
                next.input.as_ref().unwrap_or(&Value::Null),
                call.input.as_ref().unwrap_or(&Value::Null),
            )
    });
    if let Some(retry) = retry {
        let gap_ms = retry.started_at_ms.saturating_sub(call.started_at_ms);
        return Some(Inference {
            answer: Answer::error(Some("TIMEOUT"), format!("invocation timed out after about {gap_ms}ms")),
            note: format!(
                "{} finished after {took_ms} ms, but the caller called it again with the same input after {gap_ms} ms, so the caller saw a timeout",
                call.function_id
            ),
            hold: Hold {
                ms: took_ms.max(gap_ms + TIMEOUT_MARGIN_MS),
                reply,
            },
        });
    }

    let gap_ms = overlapping.started_at_ms.saturating_sub(call.started_at_ms);
    Some(Inference {
        answer: reply.clone(),
        note: format!(
            "{} started {gap_ms} ms in, before this call finished at {took_ms} ms, so the replay waits {took_ms} ms before answering",
            overlapping.function_id
        ),
        hold: Hold { ms: took_ms, reply },
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runs::testing::call;

    #[test]
    fn a_sequential_run_needs_no_inference() {
        let calls = vec![
            call("a", "clock::now", json!({}), 0, 2.0),
            call("b", "model::complete", json!({ "turn": 1 }), 3, 600.0),
            call("c", "calendar::find-slot", json!({ "day": "x" }), 604, 500.0),
        ];
        assert_eq!(infer_caller_view(&calls), vec![None, None, None]);
    }

    #[test]
    fn a_retry_before_the_first_send_finished_is_a_timeout_for_the_caller() {
        let send = json!({ "to": "dana@example.com", "subject": "30 minutes, Tuesday", "start": "s" });
        let calls = vec![
            call("first", "email::send", send.clone(), 1000, 2504.2),
            call("retry", "email::send", send, 2502, 300.0),
            call("model", "model::complete", json!({ "turn": 3 }), 2803, 500.0),
        ];
        let inferred = infer_caller_view(&calls);
        let first = inferred[0].clone().expect("the first send is inferred");
        assert_eq!(first.answer, Answer::error(Some("TIMEOUT"), "invocation timed out after about 1502ms"));
        assert_eq!(first.hold.ms, 2505);
        assert_eq!(first.hold.reply, Answer::value(json!({ "ok": "first" })));
        assert_eq!(inferred[1], None);
        assert_eq!(inferred[2], None);
    }

    #[test]
    fn a_hold_always_outlasts_the_retry_by_the_margin() {
        let send = json!({ "to": "x" });
        let calls = vec![
            call("first", "email::send", send.clone(), 0, 1510.0),
            call("retry", "email::send", send, 1503, 300.0),
        ];
        let first = infer_caller_view(&calls)[0].clone().unwrap();
        assert_eq!(first.hold.ms, 2003);
    }

    #[test]
    fn the_routed_caller_field_does_not_hide_a_retry() {
        let calls = vec![
            call("first", "email::send", json!({ "to": "x" }), 0, 2500.0),
            call("retry", "email::send", json!({ "to": "x", "_caller_worker_id": "w" }), 1500, 300.0),
        ];
        assert!(infer_caller_view(&calls)[0].clone().unwrap().answer.is_error());
    }

    #[test]
    fn a_call_overtaken_by_a_different_call_keeps_its_answer_and_waits() {
        let calls = vec![
            call("slow", "email::send", json!({ "to": "x" }), 0, 2500.0),
            call("next", "model::complete", json!({ "turn": 3 }), 1500, 400.0),
        ];
        let slow = infer_caller_view(&calls)[0].clone().unwrap();
        assert_eq!(slow.answer, Answer::value(json!({ "ok": "slow" })));
        assert_eq!(slow.hold.ms, 2500);
    }
}
