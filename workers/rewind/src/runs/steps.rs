//! A recorded run's calls as steps, the form a replay matches against: each call placed in the run,
//! with the worker and effects from the function list and what the caller saw of it. The calls a
//! call made in turn are read the same way, for a replay that copies more than the root's worker.

use std::collections::HashMap;

use serde_json::Value;

use super::{callee_answer, inference::infer_caller_view, pick_calls};
use crate::{
    catalog::Catalog,
    effects::Effect,
    error::Result,
    json::normalize_input,
    outside::{self, Kind},
    store::{Event, Store},
    types::{Answer, At, Call, Source, Step},
};

/// The run's own calls, already in start order, as steps a replay matches against. Each answer is
/// what the caller saw, so a call the caller gave up on is held as long as the recorded call took.
pub fn recorded_steps(calls: &[Event], catalog: &Catalog) -> Vec<Step> {
    recorded_steps_under(&At::default(), calls, catalog)
}

/// The calls one recorded call made, each placed under `parent`.
fn recorded_steps_under(parent: &At, calls: &[Event], catalog: &Catalog) -> Vec<Step> {
    let inferences = infer_caller_view(calls);
    calls
        .iter()
        .zip(inferences)
        .enumerate()
        .map(|(position, (event, inference))| {
            let (worker, effects) = recorded_worker(event, catalog);
            let (answer, inferred, hold) = match inference {
                Some(found) => (found.answer, Some(found.note), Some(found.hold)),
                None => (callee_answer(event), None, None),
            };
            let at = parent.child(position as u32);
            let call = Call {
                worker,
                effects,
                input: normalize_input(event.input.as_ref().unwrap_or(&Value::Null)),
                inferred,
                ..recorded_call(&at, event, answer)
            };
            Step {
                hold,
                ..Step::new(call.with_origin())
            }
        })
        .collect()
}

/// Every recorded call's own calls below the run's, keyed by the recorded call's invocation id,
/// so a replay that copies a callee's worker can match the calls the callee makes too.
pub fn recorded_below(top: &[Step], store: &Store, catalog: &Catalog) -> Result<HashMap<String, Vec<Step>>> {
    let mut below = HashMap::new();
    let mut waiting: Vec<(At, String)> = top
        .iter()
        .filter_map(|step| Some((step.call.at(), step.call.invocation_id.clone()?)))
        .collect();
    while let Some((at, invocation_id)) = waiting.pop() {
        if below.contains_key(&invocation_id) {
            continue;
        }

        let steps = recorded_steps_under(&at, &pick_calls(&invocation_id, &store.children(&invocation_id)?), catalog);
        waiting.extend(steps.iter().filter_map(|step| Some((step.call.at(), step.call.invocation_id.clone()?))));
        below.insert(invocation_id, steps);
    }

    Ok(below)
}

/// The requests around iii that each call's own worker made while it ran, kept on the call.
pub fn with_inner(calls: Vec<Call>, store: &Store) -> Result<Vec<Call>> {
    calls
        .into_iter()
        .map(|mut call| {
            let Some(invocation_id) = call.invocation_id.clone() else {
                return Ok(call);
            };
            let mut inner: Vec<Event> = store
                .children(&invocation_id)?
                .into_iter()
                .filter(|event| Kind::parse(event.kind.as_deref()).is_request())
                .collect();
            inner.sort_by_key(|event| event.started_at_ms);
            call.inner = inner.iter().map(|event| inner_call(call.seq, event)).collect();
            Ok(call)
        })
        .collect()
}

/// A request inside a call, which takes its call's seq because it never gets one of its own.
fn inner_call(seq: u32, event: &Event) -> Call {
    let call = Call {
        worker: event.caller_worker.clone().unwrap_or_default(),
        effects: outside::effects(&event.function_id).unwrap_or_default(),
        input: event.input.clone().unwrap_or(Value::Null),
        ..recorded_call(&At::top(seq), event, callee_answer(event))
    };
    call.with_origin()
}

/// A recorded call at `at` with the ids, timing and trace of its event.
fn recorded_call(at: &At, event: &Event, answer: Answer) -> Call {
    Call {
        invocation_id: Some(event.invocation_id.clone()),
        started_at_ms: Some(event.started_at_ms),
        duration_ms: Some(event.duration_ms),
        trace_id: event.trace_id.clone(),
        span_id: event.span_id.clone(),
        ..Call::new(at, event.function_id.clone(), answer, Source::Recorded)
    }
}

/// The worker that owns an iii function, or for a call around iii, the worker that made it.
fn recorded_worker(event: &Event, catalog: &Catalog) -> (String, Vec<Effect>) {
    let (owner, effects) = catalog.describe(&event.function_id);
    if Kind::parse(event.kind.as_deref()) == Kind::Iii {
        return (owner, effects);
    }

    (event.caller_worker.clone().unwrap_or_default(), effects)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runs::testing::call;

    #[test]
    fn a_post_made_inside_a_call_is_listed_under_it_and_is_not_a_step() {
        let store = Store::in_memory();
        let send = call("send-1", "email::send", json!({ "to": "dana@example.com" }), 900, 400.0);
        let post = Event {
            invocation_id: "cap-1".into(),
            function_id: "http_out POST http://127.0.0.1:49335/email".into(),
            input: Some(json!({ "method": "POST", "url": "http://127.0.0.1:49335/email", "body": "{}" })),
            output: Some(json!({ "status": 200, "body": "{\"status\":\"accepted\"}" })),
            caller_worker: Some("tools".into()),
            caller_function_id: Some("email::send".into()),
            caller_invocation_id: Some("send-1".into()),
            kind: Some("http_out".into()),
            ..call("cap-1", "x", json!({}), 950, 200.0)
        };
        store.insert_event(&send).unwrap();
        store.insert_event(&post).unwrap();

        let steps = recorded_steps(&pick_calls("run-1", &[send.clone(), post.clone()]), &Catalog::default());
        assert_eq!(steps.len(), 1);
        let calls = with_inner(steps.into_iter().map(|step| step.call).collect(), &store).unwrap();
        let inner = &calls[0].inner;
        assert_eq!(inner.len(), 1);
        assert_eq!(inner[0].seq, 0);
        assert_eq!(inner[0].worker, "tools");
        assert_eq!(inner[0].origin.kind, Kind::HttpOut);
        assert_eq!(inner[0].effects, [Effect::External, Effect::Irreversible]);
    }

    #[test]
    fn the_calls_below_a_recorded_call_are_placed_under_it() {
        let store = Store::in_memory();
        let send = call("send-1", "email::send", json!({ "to": "dana@example.com" }), 900, 400.0);
        let post = Event {
            function_id: "http_out POST http://127.0.0.1:49335/email".into(),
            input: Some(json!({ "method": "POST", "url": "http://127.0.0.1:49335/email", "body": "{}" })),
            caller_worker: Some("tools".into()),
            caller_function_id: Some("email::send".into()),
            caller_invocation_id: Some("send-1".into()),
            kind: Some("http_out".into()),
            ..call("cap-1", "x", json!({}), 950, 200.0)
        };
        let span = Event {
            function_id: "function src/main.py:post_email".into(),
            kind: Some("function".into()),
            caller_invocation_id: Some("send-1".into()),
            ..call("span-1", "x", json!({}), 951, 100.0)
        };
        for stored in [&send, &post, &span] {
            store.insert_event(stored).unwrap();
        }

        let top = recorded_steps(&[call("a", "clock::now", json!({}), 0, 2.0), send], &Catalog::default());
        let below = recorded_below(&top, &store, &Catalog::default()).unwrap();
        let inside = &below["send-1"];
        assert_eq!(inside.len(), 1);
        assert_eq!(inside[0].call.at(), At(vec![1, 0]));
        assert_eq!(inside[0].call.seq, 1);
        assert!(below["a"].is_empty());
    }
}
