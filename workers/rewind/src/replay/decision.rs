//! What a stub gives a call the copy made: the fork's own answer or the recording's when either has
//! one, and otherwise a live call, another run's answer, or a pause, by the fork's policy and the
//! call's declared effects. `decide` reads top to bottom, and `runs_live` is the table behind it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::session::Pending;
use crate::{
    effects::Effect,
    json::same_input,
    outside::{self, Kind, same_request},
    runs::callee_answer,
    store::{Event, Store},
    forks::ForkRecord,
    types::{At, Call, Mode, Need, PauseReason, Source, Step},
};

/// What a replay does with a call that neither its own answers nor the recording has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unanswered {
    /// Tests, and checks without live calls, never call the live system.
    Pause,
    /// A fork runs the call live when its effects let it skip asking a person.
    LiveUnasked,
    /// A live check, and a fork with auto on, run what a person could run live, and give any other
    /// call the newest successful answer the same function gave in a run other than `run_id`.
    LiveOrFill { run_id: String },
}

/// How one replay treats the calls it has no answer for.
#[derive(Debug, Clone)]
pub struct Policy {
    pub mode: Mode,
    /// Lets a debug fork run pure and read-only calls live without asking.
    pub auto_read: bool,
    pub unanswered: Unanswered,
    /// Functions that pause whenever they have no answer, whatever `unanswered` would do.
    pub stops: Vec<String>,
    /// In a recovery, the seq of the call the worker died while running. A lost call that
    /// failed with `function_not_found` has none, because it never reached a worker.
    pub lost_at: Option<u32>,
}

impl Policy {
    /// A policy with no stops and no lost call, as checks and saved tests use.
    pub fn new(mode: Mode, auto_read: bool, unanswered: Unanswered) -> Self {
        Self {
            mode,
            auto_read,
            unanswered,
            stops: Vec::new(),
            lost_at: None,
        }
    }

    /// A fork's policy, from its settings and, in a recovery, the call its worker died in.
    pub fn of_fork(record: &ForkRecord, lost_at: Option<u32>) -> Self {
        Self {
            mode: record.mode,
            auto_read: record.auto_read,
            unanswered: unanswered_for_fork(record),
            stops: record.stops.clone(),
            lost_at,
        }
    }

    /// The first replay of a check runs live only when the check is live. Its second replay,
    /// given every answer the first one got, uses `Unanswered::Pause`.
    pub fn of_check(run_id: &str, live: bool) -> Self {
        Self::new(Mode::Debug, false, unanswered_for_check(run_id, live))
    }
}

/// With auto on, a fork fills what it may not run live the same way a live check does.
fn unanswered_for_fork(record: &ForkRecord) -> Unanswered {
    if record.auto {
        return Unanswered::LiveOrFill {
            run_id: record.run_id.clone(),
        };
    }

    Unanswered::LiveUnasked
}

fn unanswered_for_check(run_id: &str, live: bool) -> Unanswered {
    if live {
        return Unanswered::LiveOrFill {
            run_id: run_id.to_string(),
        };
    }

    Unanswered::Pause
}

/// How far a call's declared effects reach, which is all the decision reads from them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Safety {
    /// Every effect is `pure` or `read-only`.
    ReadOnly,
    /// It reaches an outside service too, but nothing it declares writes or is irreversible.
    External,
    /// It writes, is irreversible, declares an effect Rewind doesn't know, or declares nothing.
    Unsafe,
}

impl Safety {
    pub fn of(effects: &[Effect]) -> Self {
        let reads = |effect: &Effect| matches!(effect, Effect::Pure | Effect::ReadOnly);
        let safe = |effect: &Effect| reads(effect) || *effect == Effect::External;
        if effects.is_empty() || !effects.iter().all(safe) {
            return Safety::Unsafe;
        }

        if effects.iter().all(reads) {
            return Safety::ReadOnly;
        }

        Safety::External
    }
}

/// What a stub gives the call at one place in a rerun.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// The fork's own answer, or the recording's.
    Answer(Box<Step>),
    /// Another run's answer, and the id of that run.
    Fill(Box<Step>, String),
    Live,
    Pause(PauseReason),
}

/// A call a stub has to answer, with what its recorded caller made at the same level.
#[derive(Debug, Clone, Copy)]
pub struct Asked<'a> {
    pub at: &'a At,
    /// The calls the recorded caller made, or none when the caller matched nothing in the recording.
    pub recorded: Option<&'a [Step]>,
    pub function_id: &'a str,
    /// The input with each fork invocation id it quotes swapped for the recorded one.
    pub input: &'a Value,
    pub effects: &'a [Effect],
}

/// What the call gets back: the fork's own answer for the function at that place, then the
/// recording's answer for the same call there, and otherwise whatever `unanswered` says.
pub fn decide(answers: &BTreeMap<At, Step>, policy: &Policy, store: &Store, call: &Asked) -> Decision {
    if let Some(step) = answers.get(call.at)
        && step.call.function_id == call.function_id
    {
        return Decision::Answer(Box::new(step.clone()));
    }

    if let Some(step) = recorded_match(call.recorded, call.at, call.function_id, call.input) {
        return Decision::Answer(Box::new(step.clone()));
    }

    match unanswered(policy, call.at, call.function_id, call.input, call.effects) {
        Fallback::Live => Decision::Live,
        Fallback::Fill { run_id } => fill(store, &run_id, call.at, call.function_id),
        Fallback::Pause(reason) => Decision::Pause(reason),
    }
}

/// What a stub does with a call that neither the fork's answers nor the recording has.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Fallback {
    Live,
    /// The newest successful answer the function gave in a run other than `run_id`.
    Fill { run_id: String },
    Pause(PauseReason),
}

/// A stop comes first, because a person asked to decide that call. A request whose body the
/// preload cut would go out with only the start of its body, so it never runs live.
fn unanswered(policy: &Policy, at: &At, function_id: &str, input: &Value, effects: &[Effect]) -> Fallback {
    if policy.stops.iter().any(|stop| stop == function_id) {
        return Fallback::Pause(PauseReason::Stop);
    }

    let sendable = !outside::body_was_cut(input);
    if policy.lost_at == Some(at.seq()) {
        return lost_call(Safety::of(effects), sendable);
    }

    if runs_live(policy, Safety::of(effects)) && sendable {
        return Fallback::Live;
    }

    match &policy.unanswered {
        Unanswered::LiveOrFill { run_id } => Fallback::Fill { run_id: run_id.clone() },
        Unanswered::Pause | Unanswered::LiveUnasked => Fallback::Pause(PauseReason::NoAnswer),
    }
}

/// The call a recovery's worker died in, or a call inside it in a copy. A pure or read-only call
/// changes nothing when it runs twice, so it runs again live. Anything else is never run or filled,
/// because only a person can say whether it reached its provider.
fn lost_call(safety: Safety, sendable: bool) -> Fallback {
    if safety == Safety::ReadOnly && sendable {
        return Fallback::Live;
    }

    Fallback::Pause(PauseReason::Lost)
}

/// Whether Rewind runs a call live without asking anyone. Nothing unsafe ever runs this way, and
/// a debug fork that asks first runs only read-only calls, and those only with auto_read on.
fn runs_live(policy: &Policy, safety: Safety) -> bool {
    match (&policy.unanswered, policy.mode, safety) {
        (_, _, Safety::Unsafe) => false,
        (Unanswered::Pause, _, _) => false,
        (Unanswered::LiveOrFill { .. }, _, _) => true,
        (Unanswered::LiveUnasked, Mode::Recover, _) => true,
        (Unanswered::LiveUnasked, Mode::Debug, Safety::ReadOnly) => policy.auto_read,
        (Unanswered::LiveUnasked, Mode::Debug, Safety::External) => false,
    }
}

/// What a person may pick for a paused call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Live,
    Typed,
    Inject,
    Stop,
}

impl Choice {
    pub fn as_str(self) -> &'static str {
        match self {
            Choice::Live => "live",
            Choice::Typed => "typed",
            Choice::Inject => "inject",
            Choice::Stop => "stop",
        }
    }
}

/// Live is offered where a debug fork may run the call, and for any call in a recovery, because
/// only a person can settle the calls a recovery pauses at. A request with a cut body never gets it.
pub fn choices(mode: Mode, effects: &[Effect], input: &Value) -> Vec<Choice> {
    let live = may_choose_live(mode, Safety::of(effects)) && !outside::body_was_cut(input);
    live.then_some(Choice::Live)
        .into_iter()
        .chain([Choice::Typed, Choice::Inject, Choice::Stop])
        .collect()
}

fn may_choose_live(mode: Mode, safety: Safety) -> bool {
    match (mode, safety) {
        (Mode::Recover, _) => true,
        (Mode::Debug, Safety::Unsafe) => false,
        (Mode::Debug, Safety::ReadOnly | Safety::External) => true,
    }
}

/// What a paused fork needs a person to answer, with the span of the stub call that paused.
pub fn need_of(pending: &Pending, mode: Mode, effects: Vec<Effect>, response_format: Option<Value>) -> Need {
    Need {
        seq: pending.at.seq(),
        path: pending.at.shown_path(),
        function_id: pending.function_id.clone(),
        input: pending.input.clone(),
        choices: choices(mode, &effects, &pending.input),
        effects,
        reason: pending.reason,
        response_format,
        trace_id: pending.span.0.clone(),
        span_id: pending.span.1.clone(),
    }
}

/// The answers a fork keeps when a person changes its settings: all that a person or the
/// recording gave, and each one Rewind chose by itself that the new settings would choose again.
pub fn answers_to_keep(answers: BTreeMap<At, Step>, policy: &Policy) -> BTreeMap<At, Step> {
    answers
        .into_iter()
        .filter(|(_, step)| chosen_again(step, policy))
        .collect()
}

fn chosen_again(step: &Step, policy: &Policy) -> bool {
    if !step.unasked {
        return true;
    }

    let call = &step.call;
    match unanswered(policy, &call.at(), &call.function_id, &call.input, &call.effects) {
        Fallback::Live => call.source == Source::Live,
        Fallback::Fill { .. } => call.source == Source::Filled,
        Fallback::Pause(_) => false,
    }
}

/// The recorded call at the same place under its caller, with the same function and input.
pub fn recorded_match<'a>(recorded: Option<&'a [Step]>, at: &At, function_id: &str, input: &Value) -> Option<&'a Step> {
    let position = *at.0.last()? as usize;
    recorded?
        .get(position)
        .filter(|step| step.call.function_id == function_id && same_call(function_id, &step.call.input, input))
}

/// A request around iii matches on its method, URL and body. Any other call matches on its input.
fn same_call(function_id: &str, recorded: &Value, input: &Value) -> bool {
    if Kind::of_id(function_id).is_request() {
        return same_request(recorded, input);
    }

    same_input(recorded, input)
}

/// Another run's answer for a call Rewind may not run, or a pause when no other run has one.
fn fill(store: &Store, run_id: &str, at: &At, function_id: &str) -> Decision {
    let donor = store
        .newest_success_elsewhere(function_id, run_id)
        .inspect_err(|error| eprintln!("rewind: could not look up another run's {function_id}: {error}"))
        .ok()
        .flatten();
    let Some(donor) = donor else {
        return Decision::Pause(PauseReason::NoAnswer);
    };

    let from_run_id = donor.caller_invocation_id.clone().unwrap_or_default();
    Decision::Fill(Box::new(filled_step(at, &donor, &from_run_id)), from_run_id)
}

// The copy gets the other run's answer right away, so a call that was slow there can't time out here.
fn filled_step(at: &At, donor: &Event, from_run_id: &str) -> Step {
    let call = Call {
        filled_from: Some(from_run_id.to_string()),
        invocation_id: Some(donor.invocation_id.clone()),
        ..Call::new(at, donor.function_id.clone(), callee_answer(donor), Source::Filled)
    };
    Step {
        unasked: true,
        ..Step::new(call)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        replay::{
            Session,
            testing::{
                auto_fork, auto_policy, decide, decide_at, effects, live_check, no_runs, placed, read_only, recording,
                runs_where_one_sent_an_invite, session, step, top,
            },
        },
        types::Answer,
    };

    const NO_ANSWER: Decision = Decision::Pause(PauseReason::NoAnswer);
    const STOPPED: Decision = Decision::Pause(PauseReason::Stop);

    fn live_allowed(mode: Mode, declared: &[Effect]) -> bool {
        may_choose_live(mode, Safety::of(declared))
    }

    fn runs_live_unasked(mode: Mode, auto_read: bool, declared: &[Effect]) -> bool {
        runs_live(&Policy::new(mode, auto_read, Unanswered::LiveUnasked), Safety::of(declared))
    }

    fn check_runs_live(declared: &[Effect]) -> bool {
        runs_live(&Policy::of_check("run-1", true), Safety::of(declared))
    }

    /// Whether a fork with auto on runs the call live, in either mode.
    fn auto_runs_live(declared: &[Effect]) -> bool {
        let debug = runs_live(&auto_policy(Mode::Debug, &[]), Safety::of(declared));
        assert_eq!(debug, runs_live(&auto_policy(Mode::Recover, &[]), Safety::of(declared)), "{declared:?}");
        debug
    }

    fn offered(mode: Mode, declared: &[Effect]) -> Vec<&'static str> {
        choices(mode, declared, &json!({})).into_iter().map(Choice::as_str).collect()
    }

    #[test]
    fn a_read_only_call_offers_live() {
        assert_eq!(offered(Mode::Debug, &effects(&["read-only"])), ["live", "typed", "inject", "stop"]);
    }

    #[test]
    fn an_external_call_without_irreversible_offers_live() {
        assert!(live_allowed(Mode::Debug, &effects(&["external"])));
        assert!(!live_allowed(Mode::Debug, &effects(&["external", "irreversible"])));
    }

    #[test]
    fn an_irreversible_call_never_offers_live_while_debugging() {
        assert_eq!(offered(Mode::Debug, &effects(&["irreversible"])), ["typed", "inject", "stop"]);
    }

    #[test]
    fn a_write_or_undeclared_call_does_not_offer_live_while_debugging() {
        assert!(!live_allowed(Mode::Debug, &effects(&["writes"])));
        assert!(!live_allowed(Mode::Debug, &[]));
    }

    #[test]
    fn recovery_offers_live_for_an_irreversible_call() {
        assert_eq!(offered(Mode::Recover, &effects(&["irreversible"])), ["live", "typed", "inject", "stop"]);
    }

    #[test]
    fn auto_read_runs_only_pure_and_read_only_calls() {
        assert!(runs_live_unasked(Mode::Debug, true, &effects(&["read-only"])));
        assert!(runs_live_unasked(Mode::Debug, true, &effects(&["pure"])));
        assert!(!runs_live_unasked(Mode::Debug, true, &effects(&["external"])));
        assert!(!runs_live_unasked(Mode::Debug, false, &effects(&["read-only"])));
    }

    #[test]
    fn a_live_check_runs_only_what_a_person_could_run_live() {
        assert!(check_runs_live(&effects(&["pure"])));
        assert!(check_runs_live(&effects(&["read-only"])));
        assert!(check_runs_live(&effects(&["external"])));
        assert!(!check_runs_live(&effects(&["external", "irreversible"])));
        assert!(!check_runs_live(&effects(&["irreversible"])));
        assert!(!check_runs_live(&effects(&["writes"])));
        assert!(!check_runs_live(&[]));
    }

    #[test]
    fn auto_runs_what_a_live_check_runs() {
        for allowed in [effects(&["pure"]), effects(&["read-only"]), effects(&["external"])] {
            assert!(auto_runs_live(&allowed), "{allowed:?}");
        }

        for kept_back in [effects(&["writes"]), effects(&["external", "irreversible"]), Vec::new()] {
            assert!(!auto_runs_live(&kept_back), "{kept_back:?}");
        }
    }

    #[test]
    fn recovery_runs_only_pure_read_only_and_external_calls_unasked() {
        for allowed in [effects(&["pure"]), effects(&["read-only"]), effects(&["external"]), effects(&["read-only", "external"])] {
            assert!(runs_live_unasked(Mode::Recover, false, &allowed), "{allowed:?}");
        }

        let kept_back = [
            effects(&["writes"]),
            effects(&["irreversible"]),
            effects(&["external", "irreversible"]),
            effects(&["read-only", "writes"]),
            effects(&["sends-mail"]),
            effects(&["read-onyl"]),
            Vec::new(),
        ];
        for declared in kept_back {
            assert!(!runs_live_unasked(Mode::Recover, false, &declared), "{declared:?}");
        }
    }

    #[test]
    fn recovery_runs_unasked_exactly_what_a_debug_fork_lets_a_person_run_live() {
        for declared in [effects(&["read-only"]), effects(&["external"]), effects(&["writes"]), effects(&["typo"]), Vec::new()] {
            assert_eq!(runs_live_unasked(Mode::Recover, false, &declared), live_allowed(Mode::Debug, &declared), "{declared:?}");
        }
    }

    #[test]
    fn a_matching_call_gets_the_recorded_answer() {
        let session = session(Mode::Debug, false, BTreeMap::new());
        let routed = json!({ "_caller_worker_id": "w", "turn": 1 });
        let Decision::Answer(found) = decide(&session, &no_runs(), 1, "model::complete", &routed, &[]) else {
            panic!("expected the recorded answer");
        };
        assert_eq!(found.call.source, Source::Recorded);
    }

    #[test]
    fn the_forks_own_answer_comes_before_the_recording() {
        let edited = step(1, "model::complete", json!({ "turn": 1 }), Answer::value(json!({ "text": "fixed" })), Source::Edited);
        let session = session(Mode::Debug, false, BTreeMap::from([(1, edited.clone())]));
        assert_eq!(
            decide(&session, &no_runs(), 1, "model::complete", &json!({ "turn": 1 }), &[]),
            Decision::Answer(Box::new(edited))
        );
    }

    #[test]
    fn a_forks_answer_for_another_function_is_not_used() {
        let other = step(1, "calendar::find-slot", json!({}), Answer::value(json!({})), Source::Typed);
        let session = session(Mode::Debug, false, BTreeMap::from([(1, other)]));
        let Decision::Answer(found) = decide(&session, &no_runs(), 1, "model::complete", &json!({ "turn": 1 }), &[]) else {
            panic!("expected the recorded answer");
        };
        assert_eq!(found.call.source, Source::Recorded);
    }

    #[test]
    fn a_different_input_misses_the_recording_and_pauses() {
        let session = session(Mode::Debug, false, BTreeMap::new());
        assert_eq!(decide(&session, &no_runs(), 1, "model::complete", &json!({ "turn": 2 }), &[]), NO_ANSWER);
    }

    #[test]
    fn a_call_past_the_end_of_the_recording_pauses() {
        let session = session(Mode::Debug, false, BTreeMap::new());
        assert_eq!(decide(&session, &no_runs(), 2, "calendar::find-slot", &json!({}), &read_only()), NO_ANSWER);
    }

    #[test]
    fn auto_read_runs_a_read_only_call_live() {
        let session = session(Mode::Debug, true, BTreeMap::new());
        assert_eq!(decide(&session, &no_runs(), 2, "calendar::find-slot", &json!({}), &read_only()), Decision::Live);
        assert_eq!(decide(&session, &no_runs(), 2, "email::send", &json!({}), &effects(&["irreversible"])), NO_ANSWER);
    }

    #[test]
    fn recovery_runs_pure_read_only_and_external_calls_live_and_pauses_on_the_rest() {
        let session = session(Mode::Recover, false, BTreeMap::new());
        assert_eq!(decide(&session, &no_runs(), 2, "model::complete", &json!({}), &effects(&["external"])), Decision::Live);
        assert_eq!(decide(&session, &no_runs(), 2, "clock::now", &json!({}), &read_only()), Decision::Live);
        for kept_back in [effects(&["irreversible"]), effects(&["writes"]), effects(&["read-onyl"]), Vec::new()] {
            assert_eq!(decide(&session, &no_runs(), 3, "email::send", &json!({}), &kept_back), NO_ANSWER, "{kept_back:?}");
        }
    }

    #[test]
    fn a_test_never_goes_live() {
        let mut session = session(Mode::Recover, true, BTreeMap::new());
        session.policy.unanswered = Unanswered::Pause;
        assert_eq!(decide(&session, &no_runs(), 2, "clock::now", &json!({}), &read_only()), NO_ANSWER);
    }

    #[test]
    fn a_live_check_still_uses_the_recording_first() {
        let session = live_check("run-1");
        let turn_one = json!({ "turn": 1 });
        let Decision::Answer(found) = decide(&session, &no_runs(), 1, "model::complete", &turn_one, &effects(&["external"])) else {
            panic!("expected the recorded answer");
        };
        assert_eq!(found.call.source, Source::Recorded);
    }

    #[test]
    fn a_live_check_runs_a_call_a_person_could_run_live() {
        let session = live_check("run-1");
        let store = runs_where_one_sent_an_invite();
        let retried = json!({ "turn": 1, "today": "2026-10-27" });
        assert_eq!(decide(&session, &store, 2, "model::complete", &retried, &effects(&["external"])), Decision::Live);
        assert_eq!(decide(&session, &store, 3, "calendar::find-slot", &json!({}), &read_only()), Decision::Live);
    }

    #[test]
    fn a_live_check_fills_an_irreversible_call_from_another_run() {
        let session = live_check("run-1");
        let store = runs_where_one_sent_an_invite();
        let send = json!({ "to": "dana@example.com" });
        let Decision::Fill(step, from_run_id) = decide(&session, &store, 5, "email::send", &send, &effects(&["irreversible"])) else {
            panic!("expected another run's answer");
        };
        assert_eq!(from_run_id, "run-2");
        assert_eq!(step.call.seq, 5);
        assert_eq!(step.call.answer, Answer::value(json!({ "status": "accepted", "id": "msg_2" })));
        assert_eq!(step.call.invocation_id.as_deref(), Some("send-2"));
        assert_eq!(step.hold, None);
    }

    #[test]
    fn a_live_check_never_runs_a_write_or_an_undeclared_call() {
        let session = live_check("run-1");
        let store = runs_where_one_sent_an_invite();
        for declared in [effects(&["writes"]), effects(&["external", "irreversible"]), Vec::new()] {
            let decision = decide(&session, &store, 5, "email::send", &json!({}), &declared);
            assert!(matches!(decision, Decision::Fill(..)), "{declared:?} gave {decision:?}");
        }
    }

    const HOLIDAYS: &str = "fetch GET http://127.0.0.1:49335/holidays?from=2026-11-03&weeks=2";

    fn holiday_request(url: &str, traceparent: &str) -> Value {
        json!({ "method": "GET", "url": url, "headers": { "traceparent": traceparent }, "body": null })
    }

    fn session_with_a_fetch(policy: Policy) -> Session {
        let url = "http://127.0.0.1:49335/holidays?from=2026-11-03&weeks=2";
        let mut recorded = recording();
        let response = Answer::value(json!({ "status": 200, "headers": {}, "body": "{\"holidays\":[]}" }));
        recorded.push(step(2, HOLIDAYS, outside::normalize_request(&holiday_request(url, "00-a-b-01")), response, Source::Recorded));
        Session::new(policy, recorded, BTreeMap::new())
    }

    #[test]
    fn a_fetch_gets_the_recorded_response_whatever_its_trace_headers() {
        let session = session_with_a_fetch(session(Mode::Debug, false, BTreeMap::new()).policy);
        let url = "http://127.0.0.1:49335/holidays?from=2026-11-03&weeks=2";
        let traced = outside::normalize_request(&holiday_request(url, "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"));
        let Decision::Answer(found) = decide(&session, &no_runs(), 2, HOLIDAYS, &traced, &read_only()) else {
            panic!("expected the recorded response");
        };
        assert_eq!(found.call.origin.kind, Kind::Fetch);
        assert!(found.call.origin.outside_iii);
    }

    #[test]
    fn a_fetch_for_another_day_pauses_as_read_only_and_runs_live_with_auto_read() {
        let other_day = "http://127.0.0.1:49335/holidays?from=2026-11-11&weeks=2";
        let function_id = outside::request_id(Kind::Fetch, "GET", other_day);
        let request = outside::normalize_request(&holiday_request(other_day, "00-a-b-01"));
        let effects = outside::effects(&function_id).unwrap();
        assert_eq!(effects, read_only());

        let paused = session_with_a_fetch(session(Mode::Debug, false, BTreeMap::new()).policy);
        assert_eq!(decide(&paused, &no_runs(), 2, &function_id, &request, &effects), NO_ANSWER);
        let auto_read = session_with_a_fetch(session(Mode::Debug, true, BTreeMap::new()).policy);
        assert_eq!(decide(&auto_read, &no_runs(), 2, &function_id, &request, &effects), Decision::Live);
    }

    #[test]
    fn a_request_whose_body_was_cut_is_never_run_live_and_live_is_not_offered() {
        let other_day = "http://127.0.0.1:49335/holidays?from=2026-11-11&weeks=2";
        let function_id = outside::request_id(Kind::Fetch, "GET", other_day);
        let mut request = outside::normalize_request(&holiday_request(other_day, "00-a-b-01"));
        request["body"] = json!("{\"days\":[");
        request["body_truncated"] = json!({ "bytes": 90_000, "sha256": "aaaa" });
        let auto_read = session_with_a_fetch(session(Mode::Debug, true, BTreeMap::new()).policy);
        assert_eq!(decide(&auto_read, &no_runs(), 2, &function_id, &request, &read_only()), NO_ANSWER);
        let recovery = Session::new(Policy::new(Mode::Recover, false, Unanswered::LiveUnasked), recording(), BTreeMap::new());
        assert_eq!(decide(&recovery, &no_runs(), 2, &function_id, &request, &read_only()), NO_ANSWER);

        let pending = Pending {
            at: top(2),
            function_id,
            input: request,
            reason: PauseReason::NoAnswer,
            span: (None, None),
        };
        let choices = need_of(&pending, Mode::Recover, read_only(), None).choices;
        assert_eq!(choices, [Choice::Typed, Choice::Inject, Choice::Stop]);
    }

    #[test]
    fn a_live_check_runs_a_new_get_but_never_a_new_post() {
        let session = live_check("run-1");
        let get = "fetch GET http://x/holidays?from=2026-11-11";
        let post = "fetch POST http://x/send";
        let request = json!({ "method": "POST", "url": "http://x/send", "body": "{}" });
        assert_eq!(decide(&session, &no_runs(), 2, get, &json!({}), &outside::effects(get).unwrap()), Decision::Live);
        assert_eq!(decide(&session, &no_runs(), 2, post, &request, &outside::effects(post).unwrap()), NO_ANSWER);
    }

    #[test]
    fn a_pause_carries_the_span_of_the_stub_call_that_paused() {
        let pending = Pending {
            at: top(2),
            function_id: HOLIDAYS.into(),
            input: json!({ "method": "GET" }),
            reason: PauseReason::Stop,
            span: (Some("0af7651916cd43dd8448eb211c80319c".into()), Some("b7ad6b7169203331".into())),
        };
        let need = need_of(&pending, Mode::Debug, read_only(), None);
        assert_eq!(need.trace_id.as_deref(), Some("0af7651916cd43dd8448eb211c80319c"));
        assert_eq!(need.span_id.as_deref(), Some("b7ad6b7169203331"));
        assert_eq!(need.choices, [Choice::Live, Choice::Typed, Choice::Inject, Choice::Stop]);
        let shown = serde_json::to_value(&need).unwrap();
        assert_eq!(shown["span_id"], "b7ad6b7169203331");
        assert_eq!(shown["reason"], "stop");
        assert_eq!(shown["choices"], json!(["live", "typed", "inject", "stop"]));
    }

    #[test]
    fn a_live_check_stops_at_a_call_no_other_run_got_through() {
        let store = runs_where_one_sent_an_invite();
        let irreversible = effects(&["irreversible"]);
        assert_eq!(decide(&live_check("run-2"), &store, 5, "email::send", &json!({}), &irreversible), NO_ANSWER);
        assert_eq!(decide(&live_check("run-1"), &store, 5, "billing::charge", &json!({}), &irreversible), NO_ANSWER);
    }

    #[test]
    fn an_auto_fork_pauses_at_a_stop_before_it_tries_anything_else() {
        let session = auto_fork(&["calendar::find-slot", "email::send"], BTreeMap::new());
        let store = runs_where_one_sent_an_invite();
        assert_eq!(decide(&session, &store, 2, "calendar::find-slot", &json!({}), &read_only()), STOPPED);
        assert_eq!(decide(&session, &store, 3, "email::send", &json!({}), &effects(&["irreversible"])), STOPPED);
    }

    #[test]
    fn an_auto_fork_runs_live_what_a_person_could_run_live() {
        let session = auto_fork(&[], BTreeMap::new());
        let store = runs_where_one_sent_an_invite();
        for allowed in [effects(&["pure"]), read_only(), effects(&["external"])] {
            let decision = decide(&session, &store, 2, "model::complete", &json!({ "turn": 2 }), &allowed);
            assert_eq!(decision, Decision::Live, "{allowed:?}");
        }

        let other_day = "http://127.0.0.1:49335/holidays?from=2026-11-11&weeks=2";
        let fetch = outside::request_id(Kind::Fetch, "GET", other_day);
        let request = outside::normalize_request(&holiday_request(other_day, "00-a-b-01"));
        assert_eq!(decide(&session, &store, 2, &fetch, &request, &outside::effects(&fetch).unwrap()), Decision::Live);
    }

    #[test]
    fn an_auto_fork_fills_an_irreversible_writing_or_undeclared_call_from_another_run() {
        let session = auto_fork(&[], BTreeMap::new());
        let store = runs_where_one_sent_an_invite();
        for declared in [effects(&["irreversible"]), effects(&["external", "irreversible"]), effects(&["writes"]), Vec::new()] {
            let Decision::Fill(step, from_run_id) = decide(&session, &store, 4, "email::send", &json!({}), &declared) else {
                panic!("{declared:?} should get another run's answer");
            };
            assert_eq!(from_run_id, "run-2");
            assert_eq!(step.call.source, Source::Filled);
            assert_eq!(step.call.filled_from.as_deref(), Some("run-2"));
            assert_eq!(step.call.answer, Answer::value(json!({ "status": "accepted", "id": "msg_2" })));
            assert!(step.unasked);
        }
    }

    #[test]
    fn an_auto_fork_pauses_when_no_other_run_has_an_answer() {
        let session = auto_fork(&[], BTreeMap::new());
        let store = runs_where_one_sent_an_invite();
        let irreversible = effects(&["irreversible"]);
        assert_eq!(decide(&session, &store, 4, "billing::charge", &json!({}), &irreversible), NO_ANSWER);
        let post = "fetch POST http://127.0.0.1:49335/email";
        let request = json!({ "method": "POST", "url": "http://127.0.0.1:49335/email", "body": "{}" });
        assert_eq!(decide(&session, &store, 4, post, &request, &outside::effects(post).unwrap()), NO_ANSWER);
    }

    #[test]
    fn a_stop_on_a_call_the_recording_answers_changes_nothing() {
        let turn_one = json!({ "turn": 1 });
        let external = effects(&["external"]);
        let mut asking = session(Mode::Debug, false, BTreeMap::new());
        asking.policy.stops = vec!["model::complete".into()];
        for fork in [auto_fork(&["model::complete"], BTreeMap::new()), asking] {
            let Decision::Answer(found) = decide(&fork, &no_runs(), 1, "model::complete", &turn_one, &external) else {
                panic!("expected the recorded answer");
            };
            assert_eq!(found.call.source, Source::Recorded);
            assert_eq!(decide(&fork, &no_runs(), 2, "model::complete", &turn_one, &external), STOPPED);
        }
    }

    #[test]
    fn a_stop_pauses_a_call_that_auto_read_would_run_live() {
        let mut session = session(Mode::Debug, true, BTreeMap::new());
        session.policy.stops = vec!["calendar::find-slot".into()];
        assert_eq!(decide(&session, &no_runs(), 2, "calendar::find-slot", &json!({}), &read_only()), STOPPED);
    }

    fn unasked(seq: u32, function_id: &str, declared: &[&str], source: Source) -> Step {
        let mut chosen = step(seq, function_id, json!({}), Answer::value(json!({ "ok": true })), source);
        chosen.call.effects = effects(declared);
        chosen.call.filled_from = (source == Source::Filled).then(|| "run-2".to_string());
        chosen.unasked = true;
        chosen
    }

    /// What Rewind chose by itself in an auto fork: a fetch and a model call it ran live, and a send it filled.
    fn chosen_by_rewind() -> BTreeMap<u32, Step> {
        BTreeMap::from([
            (2, unasked(2, HOLIDAYS, &["read-only"], Source::Live)),
            (3, unasked(3, "model::complete", &["external"], Source::Live)),
            (4, unasked(4, "email::send", &["irreversible"], Source::Filled)),
        ])
    }

    fn kept_seqs(answers: BTreeMap<u32, Step>, policy: &Policy) -> Vec<u32> {
        answers_to_keep(placed(answers), policy).into_keys().map(|at| at.seq()).collect()
    }

    #[test]
    fn changing_a_forks_settings_keeps_every_answer_a_person_or_the_recording_gave() {
        let mut fetched = step(2, HOLIDAYS, json!({}), Answer::value(json!({ "status": 200 })), Source::Live);
        fetched.call.effects = read_only();
        let given = BTreeMap::from([
            (0, recording()[0].clone()),
            (1, step(1, "model::complete", json!({ "turn": 1 }), Answer::value(json!({ "text": "fixed" })), Source::Edited)),
            (2, fetched),
            (3, step(3, "email::send", json!({}), Answer::value(json!({ "status": "accepted" })), Source::Typed)),
        ]);
        let mut asking = Policy::new(Mode::Debug, false, Unanswered::LiveUnasked);
        asking.stops = vec!["clock::now".into(), "model::complete".into(), HOLIDAYS.into(), "email::send".into()];
        assert_eq!(kept_seqs(given.clone(), &asking), [0, 1, 2, 3]);
        assert_eq!(kept_seqs(given, &auto_policy(Mode::Debug, &[])), [0, 1, 2, 3]);
    }

    #[test]
    fn changing_a_forks_settings_drops_what_rewind_chose_that_it_would_now_choose_differently() {
        assert_eq!(kept_seqs(chosen_by_rewind(), &auto_policy(Mode::Debug, &[])), [2, 3, 4]);
        assert_eq!(kept_seqs(chosen_by_rewind(), &auto_policy(Mode::Debug, &["email::send"])), [2, 3]);
        assert_eq!(kept_seqs(chosen_by_rewind(), &auto_policy(Mode::Debug, &["model::complete"])), [2, 4]);
        let auto_read = Policy::new(Mode::Debug, true, Unanswered::LiveUnasked);
        assert_eq!(kept_seqs(chosen_by_rewind(), &auto_read), [2]);
        let asking = Policy::new(Mode::Debug, false, Unanswered::LiveUnasked);
        assert!(kept_seqs(chosen_by_rewind(), &asking).is_empty());
    }

    #[test]
    fn a_recovery_pauses_at_its_lost_call_as_lost_unless_it_only_reads_even_with_auto_on() {
        let store = runs_where_one_sent_an_invite();
        let irreversible = effects(&["irreversible"]);
        let mut asking = Policy::new(Mode::Recover, false, Unanswered::LiveUnasked);
        asking.lost_at = Some(2);
        let mut auto = auto_policy(Mode::Recover, &[]);
        auto.lost_at = Some(2);
        let cut = json!({ "method": "GET", "url": "http://x/", "body": "{", "body_truncated": { "bytes": 70_000, "sha256": "aaaa" } });
        for policy in [asking.clone(), auto.clone()] {
            let recovery = Session::new(policy, recording(), BTreeMap::new());
            let kept_back = [irreversible.clone(), effects(&["external"]), effects(&["writes"]), effects(&["read-onyl"]), Vec::new()];
            for declared in kept_back {
                let lost = decide(&recovery, &store, 2, "email::send", &json!({}), &declared);
                assert_eq!(lost, Decision::Pause(PauseReason::Lost), "{declared:?}");
            }

            for reads in [read_only(), effects(&["pure"]), effects(&["pure", "read-only"])] {
                let lost_read = decide(&recovery, &store, 2, "calendar::find-slot", &json!({}), &reads);
                assert_eq!(lost_read, Decision::Live, "{reads:?}");
            }

            let inside = decide_at(&recovery, &store, &At(vec![2, 0]), None, "http_out GET http://x/", &json!({}), &read_only());
            assert_eq!(inside, Decision::Live);
            let inside_post = decide_at(&recovery, &store, &At(vec![2, 1]), None, "http_out POST http://x/", &json!({}), &irreversible);
            assert_eq!(inside_post, Decision::Pause(PauseReason::Lost));
            let cut_get = decide_at(&recovery, &store, &At(vec![2, 2]), None, "http_out GET http://x/", &cut, &read_only());
            assert_eq!(cut_get, Decision::Pause(PauseReason::Lost));
            assert_eq!(decide(&recovery, &store, 3, "calendar::find-slot", &json!({}), &read_only()), Decision::Live);
        }

        let mut stopped = asking.clone();
        stopped.stops = vec!["calendar::find-slot".into()];
        let stopped = Session::new(stopped, recording(), BTreeMap::new());
        assert_eq!(decide(&stopped, &store, 2, "calendar::find-slot", &json!({}), &read_only()), STOPPED);

        let asking = Session::new(asking, recording(), BTreeMap::new());
        assert_eq!(decide(&asking, &store, 3, "email::send", &json!({}), &irreversible), NO_ANSWER);
        let auto = Session::new(auto, recording(), BTreeMap::new());
        let later = decide(&auto, &store, 3, "email::send", &json!({}), &irreversible);
        assert!(matches!(later, Decision::Fill(..)), "{later:?}");
    }

    #[test]
    fn a_recovery_pause_on_a_call_with_no_declared_effects_says_so() {
        let recovery = Session::new(Policy::new(Mode::Recover, false, Unanswered::LiveUnasked), recording(), BTreeMap::new());
        assert_eq!(decide(&recovery, &no_runs(), 3, "billing::charge", &json!({}), &[]), NO_ANSWER);
        let pending = Pending {
            at: top(3),
            function_id: "billing::charge".into(),
            input: json!({}),
            reason: PauseReason::NoAnswer,
            span: (None, None),
        };
        let shown = serde_json::to_value(need_of(&pending, Mode::Recover, Vec::new(), None)).unwrap();
        assert_eq!(shown["effects"], json!([]));
        assert_eq!(shown["reason"], "no_answer");
        assert!(shown.get("response_format").is_none());
    }

    #[test]
    fn a_pause_shows_the_response_format_it_was_given_as_it_came() {
        let format = json!({ "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] });
        let pending = Pending {
            at: top(5),
            function_id: "email::send".into(),
            input: json!({}),
            reason: PauseReason::Stop,
            span: (None, None),
        };
        let shown = serde_json::to_value(need_of(&pending, Mode::Debug, effects(&["irreversible"]), Some(format.clone()))).unwrap();
        assert_eq!(shown["response_format"], format);
        let stored: Need = serde_json::from_value(json!({
            "seq": 5, "function_id": "email::send", "input": {}, "effects": [], "choices": []
        }))
        .unwrap();
        assert_eq!(stored.response_format, None);
    }
}
