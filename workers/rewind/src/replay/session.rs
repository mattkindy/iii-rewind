//! One rerun's state. Each call a copy makes takes the next place under the call that made it, so
//! it is matched with the recorded call at the same place, and the session keeps what each stub
//! gave. Rewind knows the invocations it starts, and places any other by the invocation that made it.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use iii_sdk::{InvocationCtx, current_invocation};
use serde::Serialize;
use serde_json::Value;

use super::decision::{self, Asked, Decision, Policy, recorded_match};
use crate::{
    effects::Effect,
    json::replace_text,
    store::{Event, Store},
    time::now_ms,
    types::{Answer, At, Call, PauseReason, Rerun, Source, Step},
};

/// The function the copy sees as its caller when Rewind starts a rerun.
const REPLAY_CALLER: &str = "rewind::replay";

/// What the copy shows for a copied call that has not come back by the end of the rerun.
const STILL_RUNNING: &str = "REWIND_STILL_RUNNING";

static GENERATION: AtomicU64 = AtomicU64::new(1);

/// A call a live check or an auto fork answered with another run's answer, because it may not run it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Filled {
    pub seq: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
    pub from_run_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CallAt {
    pub seq: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<u32>,
    pub function_id: String,
}

/// The call a rerun paused at, which becomes the fork's `Need`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pending {
    pub at: At,
    pub function_id: String,
    pub input: Value,
    pub reason: PauseReason,
    /// The stub call that paused, so the page can select its span.
    pub span: (Option<String>, Option<String>),
}

/// The invocation that made a call and the one that made that, as a stub learns them from
/// the SDK's caller or, for a request around iii, from what the copy's preload sends.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CalledBy {
    pub invocation_id: Option<String>,
    pub parent_invocation_id: Option<String>,
}

impl CalledBy {
    /// The caller of the handler running now, which for a stub is the copy's call.
    pub fn current() -> Self {
        let caller = current_invocation().and_then(|invocation| invocation.caller);
        let Some(caller) = caller else {
            return Self::default();
        };

        Self {
            invocation_id: caller.invocation_id,
            parent_invocation_id: caller.parent.and_then(|parent| parent.invocation_id),
        }
    }
}

/// Where a call in the fork is, and the recorded call it replays: that call's invocation id,
/// or none when the fork's call matched nothing in the recording.
#[derive(Debug, Clone, PartialEq)]
struct Node {
    at: At,
    recorded: Option<String>,
}

/// Which recorded call each invocation in the fork replays. Rewind knows the rerun, whose caller is
/// a token of its own, and each call it passes to a copied worker. Others are placed by their parent.
#[derive(Debug, Default)]
struct Tree {
    nodes: HashMap<String, Node>,
    /// How many calls each place has made so far in this rerun.
    made: HashMap<At, u32>,
    /// Each fork invocation id and the recorded id it replaces. The email body quotes its
    /// caller's id, so an input is compared with these swapped in.
    ids: Vec<(String, String)>,
}

/// One rerun of a recorded run: the policy, the recording, every answer the fork has collected,
/// what this rerun gave each call, and the call it paused at. Stubs reach it through a `SessionSlot`.
#[derive(Debug)]
pub struct Session {
    pub(super) generation: u64,
    pub(super) policy: Policy,
    pub(super) recording: Vec<Step>,
    /// The recorded calls below the run's own, keyed by the recorded call that made them.
    below: HashMap<String, Vec<Step>>,
    run_id: String,
    /// Every answer the fork has, which a later rerun uses before the recording.
    pub(super) answers: BTreeMap<At, Step>,
    /// The calls this rerun made, in place order.
    pub(super) steps: BTreeMap<At, Step>,
    pub(super) pending: Option<Pending>,
    pub(super) filled: Vec<Filled>,
    tree: Tree,
    /// The invocation id the rerun is started with, so Rewind can tell the copy's run apart.
    pub(super) root_token: String,
    /// When the rerun started, which `begin` sets right before the entry call.
    pub(super) started: Instant,
    started_at_ms: u64,
}

/// The rerun a namespace's stubs answer for, or none between reruns. A std Mutex is enough,
/// because no stub holds it across an await, and the SDK calls handlers from its own runtime.
pub type SessionSlot = Arc<Mutex<Option<Session>>>;

/// What the copy's call looked like when it reached the stub, and the stub's own trace and span.
pub(super) struct Made {
    pub input: Value,
    pub worker: String,
    pub effects: Vec<Effect>,
    pub span: (Option<String>, Option<String>),
    pub received: Instant,
}

/// What a call to a copied worker's function does: return the fork's own answer, or run in the copy.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Copied {
    Own(Box<Step>),
    /// `hold_ms` is how long the recorded call took when its caller gave up on it.
    Runs { hold_ms: Option<u64> },
}

impl Session {
    pub fn new(policy: Policy, recording: Vec<Step>, answers: BTreeMap<At, Step>) -> Self {
        let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
        let root_token = format!("rewind-rerun-{}-{generation}", std::process::id());
        let mut tree = Tree::default();
        tree.nodes.insert(root_token.clone(), Node { at: At::default(), recorded: None });
        Self {
            generation,
            policy,
            recording,
            below: HashMap::new(),
            run_id: String::new(),
            answers,
            steps: BTreeMap::new(),
            pending: None,
            filled: Vec::new(),
            tree,
            root_token,
            started: Instant::now(),
            started_at_ms: now_ms(),
        }
    }

    /// The recorded run this session replays, and the recorded calls below its own, which a
    /// fork that copies more than the run's worker matches the copies' calls against.
    pub fn of_run(mut self, run: &Event, below: HashMap<String, Vec<Step>>) -> Self {
        self.run_id = run.invocation_id.clone();
        self.below = below;
        self.tree.nodes.insert(
            self.root_token.clone(),
            Node {
                at: At::default(),
                recorded: Some(run.invocation_id.clone()),
            },
        );
        if let Some(caller) = &run.caller_invocation_id {
            self.tree.ids.push((self.root_token.clone(), caller.clone()));
        }

        self
    }

    /// The recorded run this session replays, or empty for a saved test, which has none.
    pub(super) fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The calls this rerun made, in place order.
    pub fn into_steps(self) -> Vec<Step> {
        self.steps.into_values().collect()
    }

    /// Places an invocation Rewind has not seen by the one that made it. Without either, the
    /// call counts as the run's own.
    fn node_of(&mut self, called_by: &CalledBy) -> Node {
        let Some(invocation_id) = &called_by.invocation_id else {
            return self.root_node();
        };

        if let Some(node) = self.tree.nodes.get(invocation_id) {
            return node.clone();
        }

        let parent = called_by
            .parent_invocation_id
            .as_ref()
            .and_then(|parent| self.tree.nodes.get(parent))
            .cloned();
        let Some(parent) = parent else {
            return self.root_node();
        };

        self.bind(invocation_id, parent.clone());
        parent
    }

    fn root_node(&self) -> Node {
        let recorded = (!self.run_id.is_empty()).then(|| self.run_id.clone());
        Node { at: At::default(), recorded }
    }

    fn bind(&mut self, invocation_id: &str, node: Node) {
        if let Some(recorded) = &node.recorded {
            self.tree.ids.push((invocation_id.to_string(), recorded.clone()));
        }

        self.tree.nodes.insert(invocation_id.to_string(), node);
    }

    /// The next place under whoever made the call, and the node that made it.
    fn place(&mut self, called_by: &CalledBy) -> (At, Node) {
        let node = self.node_of(called_by);
        let made = self.tree.made.entry(node.at.clone()).or_insert(0);
        let at = node.at.child(*made);
        *made += 1;
        (at, node)
    }

    /// The recorded calls the node's recorded call made, or none when it matched nothing.
    fn recorded_under(&self, node: &Node) -> Option<&[Step]> {
        if node.at.0.is_empty() {
            return Some(&self.recording);
        }

        let recorded = node.recorded.as_ref()?;
        self.below.get(recorded).map(Vec::as_slice)
    }

    /// The input with each fork invocation id it quotes replaced by the recorded one.
    fn as_recorded(&self, input: &Value) -> Value {
        replace_text(input, &self.tree.ids)
    }

    /// Starts the rerun's clock. Starting a copy can take seconds, so this comes right before the entry call.
    pub(super) fn begin(&mut self) {
        self.started = Instant::now();
        self.started_at_ms = now_ms();
    }

    /// When the rerun started and how long it has taken so far.
    pub(super) fn rerun(&self) -> Rerun {
        Rerun {
            started_at_ms: self.started_at_ms,
            duration_ms: self.started.elapsed().as_secs_f64() * 1000.0,
        }
    }

    pub(super) fn since_start_ms(&self, at: Instant) -> f64 {
        at.saturating_duration_since(self.started).as_secs_f64() * 1000.0
    }

    /// How long the stub took to answer the call at `at` in this rerun, once it has.
    pub(super) fn answered(&mut self, at: &At, received: Instant) {
        let took_ms = received.elapsed().as_secs_f64() * 1000.0;
        if let Some(step) = self.steps.get_mut(at) {
            step.call.rerun_ms = Some(took_ms);
        }
    }

    pub(super) fn live_calls(&self) -> Vec<CallAt> {
        self.steps
            .values()
            .filter(|step| step.call.source == Source::Live)
            .map(|step| CallAt {
                seq: step.call.seq,
                path: step.call.path.clone(),
                function_id: step.call.function_id.clone(),
            })
            .collect()
    }

    /// Keeps the answer a stub gives, with the input, worker, effects and stub span of the call the copy made.
    pub(super) fn keep(&mut self, at: &At, step: &Step, made: &Made) {
        let step = self.shown(at, step, made);
        self.answers.insert(at.clone(), step.clone());
        self.steps.insert(at.clone(), step);
    }

    /// A step as this rerun shows it, at its place, with what the copy sent and when.
    fn shown(&self, at: &At, step: &Step, made: &Made) -> Step {
        let mut step = step.clone();
        step.call.input = made.input.clone();
        step.call.worker = made.worker.clone();
        step.call.effects = made.effects.clone();
        (step.call.trace_id, step.call.span_id) = made.span.clone();
        step.call.rerun_at_ms = Some(self.since_start_ms(made.received));
        // A held call can outlast the rerun, and it takes as long as its hold.
        step.call.rerun_ms = step.hold.as_ref().map(|hold| hold.ms as f64);
        step.call = step.call.with_origin().placed(at);
        step
    }

    /// The token the rerun's entry call is made with, as the copy's caller.
    pub(super) fn rerun_caller(&self) -> InvocationCtx {
        InvocationCtx {
            function_id: REPLAY_CALLER.to_string(),
            invocation_id: self.root_token.clone(),
            caller: None,
            activation: None,
            observe_depth: 0,
            metadata: None,
            traceparent: None,
            baggage: None,
        }
    }

    /// Places a stub call under whoever made it and decides its answer, keeping what it decides.
    pub(super) fn stub_reached(&mut self, store: &Store, called_by: &CalledBy, function_id: &str, made: &Made) -> (At, Decision) {
        let (at, node) = self.place(called_by);
        let compared = self.as_recorded(&made.input);
        let asked = Asked {
            at: &at,
            recorded: self.recorded_under(&node),
            function_id,
            input: &compared,
            effects: &made.effects,
        };
        let decision = decision::decide(&self.answers, &self.policy, store, &asked);
        match &decision {
            Decision::Answer(step) => self.keep(&at, step, made),
            Decision::Fill(step, from_run_id) => {
                self.keep(&at, step, made);
                self.filled.push(Filled {
                    seq: at.seq(),
                    path: at.shown_path(),
                    function_id: function_id.to_string(),
                    from_run_id: from_run_id.clone(),
                });
            }
            Decision::Pause(reason) => {
                self.pending = Some(Pending {
                    at: at.clone(),
                    function_id: function_id.to_string(),
                    input: made.input.clone(),
                    reason: *reason,
                    span: made.span.clone(),
                });
            }
            Decision::Live => {}
        }

        (at, decision)
    }

    /// Places a call to a copied worker's function. An answer a person edited, typed or injected
    /// there comes first. Otherwise `handler`, the invocation passing the call on, is placed
    /// there, so the calls the copy makes inside it are placed under it.
    pub(super) fn copied_reached(&mut self, called_by: &CalledBy, handler: Option<&str>, function_id: &str, made: &Made) -> (At, Copied) {
        let (at, node) = self.place(called_by);
        let by_a_person = |source: Source| matches!(source, Source::Edited | Source::Typed | Source::Injected);
        let own = self
            .answers
            .get(&at)
            .filter(|step| step.call.function_id == function_id && by_a_person(step.call.source))
            .cloned();
        if let Some(step) = own {
            self.keep(&at, &step, made);
            return (at, Copied::Own(Box::new(step)));
        }

        let compared = self.as_recorded(&made.input);
        let recorded = recorded_match(self.recorded_under(&node), &at, function_id, &compared).cloned();
        if let Some(handler) = handler {
            self.place_copied(handler, &at, recorded.as_ref(), &node);
        }

        let running = copied_step(&at, function_id, Answer::error(Some(STILL_RUNNING), "the copy had not answered when the rerun ended"));
        let shown = self.shown(&at, &running, made);
        self.steps.insert(at.clone(), shown);
        let hold_ms = recorded.and_then(|step| step.hold).map(|hold| hold.ms);
        (at, Copied::Runs { hold_ms })
    }

    /// The copy sees the handler as its call's caller, so an input that quotes the handler's id
    /// is compared as if it quoted the recorded caller's.
    fn place_copied(&mut self, handler: &str, at: &At, recorded: Option<&Step>, caller: &Node) {
        let recorded_id = recorded.and_then(|step| step.call.invocation_id.clone());
        self.tree.nodes.insert(handler.to_string(), Node { at: at.clone(), recorded: recorded_id });
        if let Some(caller_id) = &caller.recorded {
            self.tree.ids.push((handler.to_string(), caller_id.clone()));
        }
    }
}

fn copied_step(at: &At, function_id: &str, answer: Answer) -> Step {
    Step::new(Call {
        started_at_ms: Some(now_ms()),
        ..Call::new(at, function_id, answer, Source::Copy)
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::{
        outside,
        replay::{
            decision::need_of,
            testing::{auto_fork, decide, effects, event, no_runs, recording, runs_where_one_sent_an_invite, seqs, session, step, top},
        },
        types::{Hold, Mode},
    };

    fn made_at(session: &Session, after_ms: u64) -> Made {
        Made {
            input: json!({ "turn": 1 }),
            worker: "model".into(),
            effects: vec![Effect::External],
            span: (Some("0af7651916cd43dd8448eb211c80319c".into()), Some("b7ad6b7169203331".into())),
            received: session.started + Duration::from_millis(after_ms),
        }
    }

    #[test]
    fn a_kept_call_is_timed_from_the_start_of_this_rerun() {
        let mut session = session(Mode::Debug, false, BTreeMap::new());
        session.begin();
        let made = made_at(&session, 30);
        session.keep(&top(1), &recording()[1], &made);
        let kept = &session.steps[&top(1)].call;
        assert!((kept.rerun_at_ms.unwrap() - 30.0).abs() < 0.5);
        assert_eq!(kept.rerun_ms, None);
        assert_eq!(kept.span_id.as_deref(), Some("b7ad6b7169203331"));

        session.answered(&top(1), Instant::now());
        assert!(session.steps[&top(1)].call.rerun_ms.unwrap() < 50.0);
    }

    #[test]
    fn an_answer_kept_from_an_earlier_rerun_gets_this_reruns_timing() {
        let mut first = session(Mode::Debug, false, BTreeMap::new());
        first.begin();
        first.keep(&top(1), &recording()[1], &made_at(&first, 400));
        first.answered(&top(1), first.started + Duration::from_millis(400));

        let mut second = session(Mode::Debug, false, seqs(&first.answers));
        second.begin();
        let earlier = second.answers[&top(1)].clone();
        second.keep(&top(1), &earlier, &made_at(&second, 5));
        let kept = &second.steps[&top(1)].call;
        assert!((kept.rerun_at_ms.unwrap() - 5.0).abs() < 0.5);
        assert_eq!(kept.rerun_ms, None);
    }

    #[test]
    fn a_held_call_takes_as_long_as_its_hold_even_if_the_rerun_ends_first() {
        let mut session = session(Mode::Debug, false, BTreeMap::new());
        session.begin();
        let mut held = recording()[1].clone();
        held.hold = Some(Hold { ms: 2_505, reply: Answer::value(json!({})) });
        session.keep(&top(1), &held, &made_at(&session, 1_000));
        assert_eq!(session.steps[&top(1)].call.rerun_ms, Some(2_505.0));
    }

    fn made_with(session: &Session, effects: Vec<Effect>) -> Made {
        Made { effects, ..made_at(session, 5) }
    }

    #[test]
    fn a_filled_call_keeps_its_source_and_run_across_a_rerun() {
        let irreversible = effects(&["irreversible"]);
        let mut first = auto_fork(&[], BTreeMap::new());
        first.begin();
        let decision = decide(&first, &runs_where_one_sent_an_invite(), 2, "email::send", &json!({}), &irreversible);
        let Decision::Fill(step, _) = decision else {
            panic!("expected another run's answer");
        };
        first.keep(&top(2), &step, &made_with(&first, irreversible.clone()));

        // No other runs this time, so the answer can only come from the fork's own.
        let mut second = auto_fork(&[], seqs(&first.answers));
        second.begin();
        let Decision::Answer(again) = decide(&second, &no_runs(), 2, "email::send", &json!({}), &irreversible) else {
            panic!("expected the fork's own answer");
        };
        second.keep(&top(2), &again, &made_with(&second, irreversible.clone()));
        let kept = &second.steps[&top(2)];
        assert_eq!(kept.call.source, Source::Filled);
        assert_eq!(kept.call.filled_from.as_deref(), Some("run-2"));
        assert!(kept.unasked);
    }

    const EMAIL: &str = "http_out POST http://127.0.0.1:49335/email";

    fn email_post(caller: &str) -> Value {
        let body = format!("{{\"to\": \"dana@example.com\", \"caller_invocation_id\": \"{caller}\"}}");
        json!({ "method": "POST", "url": "http://127.0.0.1:49335/email", "headers": {}, "body": body })
    }

    /// A run that read the clock, asked the model, sent an invite whose worker POSTed it, and asked the model again.
    fn recorded_send() -> Session {
        let mut sent = step(2, "email::send", json!({ "to": "dana@example.com" }), Answer::value(json!({ "status": "accepted" })), Source::Recorded);
        sent.call.invocation_id = Some("send-1".into());
        let mut post = step(2, EMAIL, email_post("run-1"), Answer::value(json!({ "status": 200 })), Source::Recorded);
        post.call = post.call.placed(&At(vec![2, 0]));
        let mut top = recording();
        top.push(sent);
        top.push(step(3, "model::complete", json!({ "turn": 2 }), Answer::value(json!({ "text": "Booked" })), Source::Recorded));
        let run = event("run-1", "agent::run", None, json!({ "status": "booked" }));
        let policy = Policy::new(Mode::Debug, false, decision::Unanswered::LiveUnasked);
        Session::new(policy, top, BTreeMap::new()).of_run(&run, HashMap::from([("send-1".to_string(), vec![post])]))
    }

    fn called_by(invocation_id: &str, parent: &str) -> CalledBy {
        CalledBy {
            invocation_id: Some(invocation_id.into()),
            parent_invocation_id: Some(parent.into()),
        }
    }

    fn made_with_input(session: &Session, input: Value) -> Made {
        Made { input, ..made_at(session, 5) }
    }

    fn reached(session: &mut Session, by: &CalledBy, function_id: &str, input: Value) -> (At, Decision) {
        let made = made_with_input(session, input);
        session.stub_reached(&no_runs(), by, function_id, &made)
    }

    fn recorded_source(decision: &Decision) -> Option<Source> {
        match decision {
            Decision::Answer(step) => Some(step.call.source),
            _ => None,
        }
    }

    const NO_ANSWER: Decision = Decision::Pause(PauseReason::NoAnswer);

    #[test]
    fn a_call_inside_a_copied_call_matches_the_recording_by_its_place_under_that_call() {
        let mut session = recorded_send();
        let run = called_by("run-in-copy", &session.root_token.clone());
        assert_eq!(reached(&mut session, &run, "clock::now", json!({})).0, top(0));
        assert_eq!(reached(&mut session, &run, "model::complete", json!({ "turn": 1 })).0, top(1));

        let made = made_with_input(&session, json!({ "to": "dana@example.com" }));
        let (at, copied) = session.copied_reached(&run, Some("handler-1"), "email::send", &made);
        assert_eq!((at.clone(), copied), (top(2), Copied::Runs { hold_ms: None }));
        assert_eq!(session.steps[&at].call.source, Source::Copy);

        // The copy's send quotes its caller, the handler, where the recording quoted the run.
        let send = called_by("send-in-copy", "handler-1");
        let (at, decision) = reached(&mut session, &send, EMAIL, email_post("handler-1"));
        assert_eq!(at, At(vec![2, 0]));
        assert_eq!(recorded_source(&decision), Some(Source::Recorded));
        assert_eq!(session.steps[&at].call.path, [2, 0]);
        assert_eq!(session.steps[&at].call.seq, 2);

        let (at, decision) = reached(&mut session, &run, "model::complete", json!({ "turn": 2 }));
        assert_eq!(at, top(3));
        assert_eq!(recorded_source(&decision), Some(Source::Recorded));
    }

    #[test]
    fn a_second_call_inside_a_copied_call_has_no_recording_there_and_pauses_with_its_path() {
        let mut session = recorded_send();
        let run = called_by("run-in-copy", &session.root_token.clone());
        reached(&mut session, &run, "clock::now", json!({}));
        reached(&mut session, &run, "model::complete", json!({ "turn": 1 }));
        let made = made_with_input(&session, json!({ "to": "dana@example.com" }));
        session.copied_reached(&run, Some("handler-1"), "email::send", &made);
        let send = called_by("send-in-copy", "handler-1");
        reached(&mut session, &send, EMAIL, email_post("handler-1"));

        let (at, decision) = reached(&mut session, &send, EMAIL, email_post("handler-1"));
        assert_eq!((at, decision), (At(vec![2, 1]), NO_ANSWER));
        let pending = session.pending.clone().unwrap();
        let need = need_of(&pending, Mode::Debug, outside::effects(EMAIL).unwrap(), None);
        assert_eq!((need.seq, need.path), (2, vec![2, 1]));
    }

    #[test]
    fn a_copied_call_with_a_different_input_runs_but_its_calls_match_nothing() {
        let mut session = recorded_send();
        let run = called_by("run-in-copy", &session.root_token.clone());
        reached(&mut session, &run, "clock::now", json!({}));
        reached(&mut session, &run, "model::complete", json!({ "turn": 1 }));
        let made = made_with_input(&session, json!({ "to": "priya@example.com" }));
        session.copied_reached(&run, Some("handler-1"), "email::send", &made);
        let (at, decision) = reached(&mut session, &called_by("send-in-copy", "handler-1"), EMAIL, email_post("handler-1"));
        assert_eq!((at, decision), (At(vec![2, 0]), NO_ANSWER));
    }

    #[test]
    fn a_copied_call_returns_an_answer_a_person_typed_there_instead_of_running() {
        let mut session = recorded_send();
        let typed = step(2, "email::send", json!({}), Answer::value(json!({ "status": "accepted", "id": "typed" })), Source::Typed);
        session.answers.insert(top(2), typed.clone());
        session.answers.insert(top(1), step(1, "model::complete", json!({}), Answer::value(json!({})), Source::Recorded));
        let run = called_by("run-in-copy", &session.root_token.clone());
        reached(&mut session, &run, "clock::now", json!({}));
        let made = made_with_input(&session, json!({}));
        let (_, copied) = session.copied_reached(&run, Some("handler-0"), "model::complete", &made);
        assert_eq!(copied, Copied::Runs { hold_ms: None }, "a recorded answer never takes the copy's place");
        let (_, copied) = session.copied_reached(&run, Some("handler-1"), "email::send", &made);
        assert!(matches!(copied, Copied::Own(step) if step.call.answer == typed.call.answer));
    }

    #[test]
    fn calls_that_say_nothing_about_their_caller_take_the_next_place_in_the_run() {
        let mut session = recorded_send();
        let unknown = CalledBy::default();
        let stranger = called_by("someone", "no-one-rewind-knows");
        assert_eq!(reached(&mut session, &unknown, "clock::now", json!({})).0, top(0));
        assert_eq!(reached(&mut session, &stranger, "model::complete", json!({ "turn": 1 })).0, top(1));
        let made = made_with_input(&session, json!({ "to": "dana@example.com" }));
        assert_eq!(session.copied_reached(&unknown, None, "email::send", &made).0, top(2));
    }

    #[test]
    fn a_held_copied_call_waits_as_long_as_the_recorded_call_took() {
        let mut session = recorded_send();
        session.recording[2].hold = Some(Hold { ms: 2_505, reply: Answer::value(json!({})) });
        let run = called_by("run-in-copy", &session.root_token.clone());
        reached(&mut session, &run, "clock::now", json!({}));
        reached(&mut session, &run, "model::complete", json!({ "turn": 1 }));
        let made = made_with_input(&session, json!({ "to": "dana@example.com" }));
        let (_, copied) = session.copied_reached(&run, Some("handler-1"), "email::send", &made);
        assert_eq!(copied, Copied::Runs { hold_ms: Some(2_505) });
    }
}
