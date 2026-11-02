//! Recordings, sessions and policies the replay's tests share, and `decide` for a call the run
//! made itself, the way a stub calls the decision.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::{
    Session,
    decision::{self, Asked, Decision, Policy, Unanswered},
};
use crate::{
    effects::Effect,
    store::{Event, Store},
    types::{Answer, At, Call, Mode, Source, Step},
};

pub fn step(seq: u32, function_id: &str, input: Value, answer: Answer, source: Source) -> Step {
    let call = Call {
        input,
        ..Call::new(&At::top(seq), function_id, answer, source)
    };
    Step::new(call.with_origin())
}

pub fn recording() -> Vec<Step> {
    vec![
        step(0, "clock::now", json!({}), Answer::value(json!({ "now": "2026-10-27T15:02:11-05:00" })), Source::Recorded),
        step(1, "model::complete", json!({ "turn": 1 }), Answer::value(json!({ "tool_call": {} })), Source::Recorded),
    ]
}

pub fn top(seq: u32) -> At {
    At::top(seq)
}

pub fn placed(answers: BTreeMap<u32, Step>) -> BTreeMap<At, Step> {
    answers.into_iter().map(|(seq, step)| (top(seq), step)).collect()
}

pub fn seqs(answers: &BTreeMap<At, Step>) -> BTreeMap<u32, Step> {
    answers.iter().map(|(at, step)| (at.seq(), step.clone())).collect()
}

pub fn session(mode: Mode, auto_read: bool, answers: BTreeMap<u32, Step>) -> Session {
    let policy = Policy::new(mode, auto_read, Unanswered::LiveUnasked);
    Session::new(policy, recording(), placed(answers))
}

pub fn live_check(run_id: &str) -> Session {
    Session::new(Policy::of_check(run_id, true), recording(), BTreeMap::new())
}

/// A fork of run-1 with auto on, the way `forks` sets it up.
pub fn auto_policy(mode: Mode, stops: &[&str]) -> Policy {
    let mut policy = Policy::new(mode, false, Unanswered::LiveOrFill { run_id: "run-1".into() });
    policy.stops = stops.iter().map(|stop| stop.to_string()).collect();
    policy
}

pub fn auto_fork(stops: &[&str], answers: BTreeMap<u32, Step>) -> Session {
    Session::new(auto_policy(Mode::Debug, stops), recording(), placed(answers))
}

pub fn read_only() -> Vec<Effect> {
    vec![Effect::ReadOnly]
}

pub fn effects(list: &[&str]) -> Vec<Effect> {
    list.iter().map(|effect| Effect::parse(effect)).collect()
}

pub fn no_runs() -> Store {
    Store::in_memory()
}

pub fn event(invocation_id: &str, function_id: &str, run_id: Option<&str>, output: Value) -> Event {
    Event {
        invocation_id: invocation_id.into(),
        function_id: function_id.into(),
        namespace: "default".into(),
        status: "success".into(),
        input: Some(json!({})),
        output: Some(output),
        error: None,
        caller_worker: run_id.map(|_| "agent".into()),
        caller_function_id: run_id.map(|_| "agent::run".into()),
        caller_invocation_id: run_id.map(str::to_string),
        started_at_ms: 1,
        duration_ms: 1.0,
        code_version: None,
        kind: None,
        trace_id: None,
        span_id: None,
    }
}

/// Two runs, where only run-2 sent an invite.
pub fn runs_where_one_sent_an_invite() -> Store {
    let store = Store::in_memory();
    store.insert_event(&event("run-1", "agent::run", None, json!({}))).unwrap();
    store.insert_event(&event("run-2", "agent::run", None, json!({}))).unwrap();
    let sent = json!({ "status": "accepted", "id": "msg_2" });
    store.insert_event(&event("send-2", "email::send", Some("run-2"), sent)).unwrap();
    store
}

/// What a call the run made itself gets back.
pub fn decide(session: &Session, store: &Store, seq: u32, function_id: &str, input: &Value, effects: &[Effect]) -> Decision {
    decide_at(session, store, &At::top(seq), Some(&session.recording), function_id, input, effects)
}

/// What the call at `at` gets back, where `recorded` is what its recorded caller made.
pub fn decide_at(
    session: &Session,
    store: &Store,
    at: &At,
    recorded: Option<&[Step]>,
    function_id: &str,
    input: &Value,
    effects: &[Effect],
) -> Decision {
    let call = Asked {
        at,
        recorded,
        function_id,
        input,
        effects,
    };
    decision::decide(&session.answers, &session.policy, store, &call)
}
