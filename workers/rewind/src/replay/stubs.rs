//! The handlers that answer a copy's calls, and `run_in`, which starts one rerun in a fork's
//! namespace and collects what it did. A stub call is placed and decided in the session, and a
//! call to a copied worker's function runs in that worker's copy.

use std::{
    collections::BTreeMap,
    sync::{Arc, MutexGuard},
    time::{Duration, Instant},
};

use iii_sdk::{current_invocation, protocol::CallRequest};
use serde_json::Value;

use super::{
    decision::{Decision, need_of},
    session::{CallAt, CalledBy, Copied, Filled, Made, Session, SessionSlot},
};
use crate::{
    app::App,
    catalog::{self, DEFAULT_NAMESPACE},
    code::CodeVersion,
    copies::ForkSpace,
    effects::Effect,
    error::{Error, Result},
    idempotency,
    json::normalize_input,
    outside::{self, Kind},
    traces,
    time::now_ms,
    types::{Answer, At, Call, Outcome, Rerun, Source, Step, error_answer},
};

// Long enough for a run that waits on live calls. A paused run ends in milliseconds.
const ENTRY_TIMEOUT_MS: u64 = 120_000;
const LIVE_TIMEOUT_MS: u64 = 30_000;

/// What the SDK hands back to a copy: a reply, or an error with the code the copy's SDK shows.
type Reply = std::result::Result<Value, iii_sdk::Error>;

fn lock(slot: &SessionSlot) -> MutexGuard<'_, Option<Session>> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn paused_at(at: &At, function_id: &str) -> Error {
    Error::Paused(format!(
        "rewind paused this run at seq {at} ({function_id}) until someone chooses an answer"
    ))
}

/// The session a stub call belongs to, or the error that ends the copy's run quickly: no run is
/// in progress, or the run already paused, in which case every later call fails too.
fn running<'a>(guard: &'a mut MutexGuard<'_, Option<Session>>, function_id: &str) -> Result<&'a mut Session> {
    let Some(session) = guard.as_mut() else {
        return Err(Error::Paused(format!("no run is in progress for {function_id}")));
    };
    if let Some(pending) = &session.pending {
        return Err(paused_at(&pending.at, &pending.function_id));
    }

    Ok(session)
}

/// Runs `work` on the session when it is still the rerun a call started in.
fn in_generation(slot: &SessionSlot, generation: u64, work: impl FnOnce(&mut Session)) {
    if let Some(session) = lock(slot).as_mut()
        && session.generation == generation
    {
        work(session);
    }
}

/// What a call the copy made gets back. `made_by` is the worker that made a call
/// around iii, which has no owner in the catalog.
pub async fn stub_call(
    app: Arc<App>,
    slot: SessionSlot,
    function_id: String,
    input: Value,
    made_by: Option<String>,
    called_by: CalledBy,
) -> Reply {
    let input = normalize_input(&input);
    let (owner, effects) = app.catalog.describe(&function_id);
    let made = Made {
        input,
        worker: made_by.unwrap_or(owner),
        effects,
        span: traces::current(),
        received: Instant::now(),
    };
    let received = made.received;
    let (at, generation, run_id, decision) = {
        let mut guard = lock(&slot);
        let session = running(&mut guard, &function_id)?;
        let (at, decision) = session.stub_reached(&app.store, &called_by, &function_id, &made);
        (at, session.generation, session.run_id().to_string(), decision)
    };

    let reply = match decision {
        Decision::Answer(step) | Decision::Fill(step, _) => replay_step(*step).await,
        Decision::Pause(_) => return Err(paused_at(&at, &function_id).into()),
        Decision::Live => {
            let mut step = live_step(&app, &run_id, &at, &function_id, made.worker, made.effects, made.input).await;
            (step.call.trace_id, step.call.span_id) = made.span;
            step.unasked = true;
            let answer = step.call.answer.clone();
            in_generation(&slot, generation, |session| {
                step.call.rerun_at_ms = Some(session.since_start_ms(received));
                session.answers.insert(at.clone(), step.clone());
                session.steps.insert(at.clone(), step);
            });
            answer.into_reply()
        }
    };

    in_generation(&slot, generation, |session| session.answered(&at, received));
    reply
}

/// A call to a function of a worker the fork copies, which runs in that worker's copy in
/// `namespace` unless the fork has an answer of its own there. When the recording shows the
/// caller gave up on the call, the reply waits as long as the recorded call took.
pub async fn copied_call(app: Arc<App>, slot: SessionSlot, function_id: String, input: Value, namespace: String) -> Reply {
    let input = normalize_input(&input);
    let (worker, effects) = app.catalog.describe(&function_id);
    let handler = current_invocation().map(|invocation| invocation.invocation_id);
    let made = Made {
        input,
        worker,
        effects,
        span: traces::current(),
        received: Instant::now(),
    };
    let received = made.received;
    let (at, generation, copied) = {
        let mut guard = lock(&slot);
        let session = running(&mut guard, &function_id)?;
        let (at, copied) = session.copied_reached(&CalledBy::current(), handler.as_deref(), &function_id, &made);
        (at, session.generation, copied)
    };

    let hold_ms = match copied {
        Copied::Own(step) => {
            let reply = replay_step(*step).await;
            in_generation(&slot, generation, |session| session.answered(&at, received));
            return reply;
        }
        Copied::Runs { hold_ms } => hold_ms,
    };

    let mut request = CallRequest::new(&function_id, made.input.clone());
    request.timeout_ms = Some(ENTRY_TIMEOUT_MS);
    let result = app.iii.call(request.namespace(namespace)).await;
    if let Some(ms) = hold_ms {
        tokio::time::sleep_until(tokio::time::Instant::from_std(received + Duration::from_millis(ms))).await;
    }

    let answer = Answer::from_result(result);
    in_generation(&slot, generation, |session| {
        if let Some(step) = session.steps.get_mut(&at) {
            step.call.answer = answer.clone();
        }

        session.answered(&at, received);
    });
    answer.into_reply()
}

async fn replay_step(step: Step) -> Reply {
    let Some(hold) = step.hold else {
        return step.call.answer.into_reply();
    };

    tokio::time::sleep(Duration::from_millis(hold.ms)).await;
    hold.reply.into_reply()
}

/// Calls the function in `default` for the call at `at` in a replay of `run_id`.
pub async fn live_call(app: &App, run_id: &str, at: &At, function_id: &str, input: &Value) -> Answer {
    if Kind::of_id(function_id).is_request() {
        return outside::live_request(input).await;
    }

    let mut request = CallRequest::new(function_id, input.clone());
    request.timeout_ms = Some(LIVE_TIMEOUT_MS);
    let mut request = request.namespace(DEFAULT_NAMESPACE);
    if let Some(metadata) = idempotency::metadata(&app.catalog, run_id, at, function_id, input) {
        request = request.metadata(metadata);
    }

    Answer::from_result(app.iii.call(request).await)
}

pub async fn live_step(app: &App, run_id: &str, at: &At, function_id: &str, worker: String, effects: Vec<Effect>, input: Value) -> Step {
    let started_at_ms = now_ms();
    let clock = Instant::now();
    let answer = live_call(app, run_id, at, function_id, &input).await;
    let call = Call {
        worker,
        effects,
        input,
        started_at_ms: Some(started_at_ms),
        duration_ms: Some(clock.elapsed().as_secs_f64() * 1000.0),
        ..Call::new(at, function_id, answer, Source::Live)
    };
    Step::new(call.with_origin())
}

/// What one rerun did: how it ended, the code it ran, and what its stubs gave.
pub struct Ran {
    pub outcome: Outcome,
    pub code: CodeVersion,
    pub rerun: Rerun,
    /// Every answer the fork has now, including the ones this rerun added.
    pub answers: BTreeMap<At, Step>,
    /// The calls this rerun made, in place order.
    pub steps: Vec<Step>,
    pub live: Vec<CallAt>,
    pub filled: Vec<Filled>,
}

/// Runs `root` in the fork's namespace once every copy runs the code on disk. The entry call
/// is made with the session's token as its caller, so the copy's run is placed as the run.
pub async fn run_in(app: &Arc<App>, space: &Arc<ForkSpace>, root: &str, input: Value, mut session: Session) -> Result<Ran> {
    let _running = space.run_lock.lock().await;
    let rows = catalog::list(&app.iii).await?;
    app.catalog.replace(&rows);
    space.ensure_stubs(app).await?;
    let code = space.ensure_copies(app, root).await?;

    let mode = session.policy.mode;
    session.begin();
    let caller = session.rerun_caller();
    space.install(session);
    let mut request = CallRequest::new(root, input);
    request.timeout_ms = Some(ENTRY_TIMEOUT_MS);
    let result = iii_sdk::scope(caller, app.iii.call(request.namespace(space.namespace.clone()))).await;
    let session = space
        .take()
        .ok_or_else(|| Error::Internal("the run's session went missing".into()))?;
    let rerun = session.rerun();

    let outcome = match &session.pending {
        Some(pending) => {
            let (_, effects) = app.catalog.describe(&pending.function_id);
            let response_format = catalog::response_format(&app.iii, &pending.function_id).await;
            Outcome::Paused {
                need: need_of(pending, mode, effects, response_format),
            }
        }
        None => match result {
            Ok(output) => Outcome::Done { output },
            Err(error) => Outcome::Crashed {
                error: error_answer(error),
            },
        },
    };
    let live = session.live_calls();
    let Session { answers, steps, filled, .. } = session;
    Ok(Ran {
        outcome,
        code,
        rerun,
        answers,
        steps: steps.into_values().collect(),
        live,
        filled,
    })
}
