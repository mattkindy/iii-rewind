//! Forks: a recorded run replayed with answers of its own, in a namespace of its own. Every
//! change, whether a new answer or new settings, reruns the copy from the start, so nothing waits
//! on a person between reruns. `record` has what the store keeps of a fork and what the page sees.

mod record;

use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

use serde_json::Value;

pub use record::{ForkRecord, ListedFork};

use crate::{
    app::App,
    copies,
    error::{Error, Result},
    json::normalize_input,
    namespaces,
    replay::{self, Choice, Policy, Session},
    runs::{lost_mid_call_at, recorded_below},
    store::Event,
    time::now_ms,
    types::{Answer, At, Call, ErrorAnswer, Mode, Need, Outcome, Source, Step},
};

/// A fork to start: the run it replays, the answers it starts with, and its settings.
pub struct NewFork {
    pub run_id: String,
    pub parent: Option<String>,
    pub edit_at: Option<u32>,
    pub answers: BTreeMap<At, Step>,
    pub mode: Mode,
    pub auto_read: bool,
    pub auto: bool,
    pub stops: Vec<String>,
    /// The workers to copy besides the root's own.
    pub copy: Vec<String>,
}

pub struct Edit {
    pub run_id: String,
    pub base: Option<String>,
    pub at_seq: u32,
    pub answer: Answer,
    pub source: Source,
    pub auto_read: Option<bool>,
    pub auto: Option<bool>,
    pub stops: Option<Vec<String>>,
    pub copy: Option<Vec<String>>,
}

pub struct Replay {
    pub auto_read: bool,
    pub auto: bool,
    pub stops: Vec<String>,
    pub copy: Vec<String>,
}

pub async fn replay(app: &Arc<App>, run_id: &str, settings: Replay) -> Result<ForkRecord> {
    app.run(run_id)?;
    start(
        app,
        NewFork {
            run_id: run_id.to_string(),
            parent: None,
            edit_at: None,
            answers: BTreeMap::new(),
            mode: Mode::Debug,
            auto_read: settings.auto_read,
            auto: settings.auto,
            stops: settings.stops,
            copy: settings.copy,
        },
    )
    .await
}

pub async fn fork(app: &Arc<App>, edit: Edit) -> Result<ForkRecord> {
    if !matches!(edit.source, Source::Edited | Source::Injected) {
        return Err(Error::BadInput("source must be edited or injected".into()));
    }

    let (_, recording) = app.run(&edit.run_id)?;
    let base = edit.base.as_deref().map(|id| app.fork_record(id)).transpose()?;
    if let Some(base) = &base
        && base.run_id != edit.run_id
    {
        return Err(Error::BadInput(format!(
            "fork {} is a fork of run {}, not {}",
            base.fork_id, base.run_id, edit.run_id
        )));
    }

    let reference = base.as_ref().map(|base| base.steps.clone()).unwrap_or(recording);
    let target = reference
        .iter()
        .find(|step| step.call.at() == At::top(edit.at_seq))
        .ok_or_else(|| Error::BadSeq(format!("there is no call at seq {}", edit.at_seq)))?;
    let edited_at = At::top(edit.at_seq);
    let mut answers: BTreeMap<At, Step> = base
        .as_ref()
        .map(|base| base.answers.range(..edited_at.clone()).map(|(at, step)| (at.clone(), step.clone())).collect())
        .unwrap_or_default();
    let mut edited = target.clone();
    edited.call.answer = edit.answer;
    edited.call.source = edit.source;
    edited.call.inferred = None;
    edited.call.invocation_id = None;
    edited.call.started_at_ms = None;
    edited.call.duration_ms = None;
    edited.hold = None;
    answers.insert(edited_at, edited);

    start(
        app,
        NewFork {
            run_id: edit.run_id,
            parent: base.as_ref().map(|base| base.fork_id.clone()),
            edit_at: Some(edit.at_seq),
            answers,
            mode: base.as_ref().map(|base| base.mode).unwrap_or(Mode::Debug),
            auto_read: edit
                .auto_read
                .or(base.as_ref().map(|base| base.auto_read))
                .unwrap_or(false),
            auto: edit.auto.or(base.as_ref().map(|base| base.auto)).unwrap_or(false),
            stops: edit
                .stops
                .or(base.as_ref().map(|base| base.stops.clone()))
                .unwrap_or_default(),
            copy: edit
                .copy
                .or(base.as_ref().map(|base| base.copy.clone()))
                .unwrap_or_default(),
        },
    )
    .await
}

/// Makes a fork and runs it for the first time. The fork takes a spare copy when its root runs in
/// the worker under test, is stored once it has run, and closes its namespace if the run fails.
pub async fn start(app: &Arc<App>, new: NewFork) -> Result<ForkRecord> {
    let (recorded, _) = app.run(&new.run_id)?;
    let copy = app.copies_for(&recorded.function_id, &new.copy)?;
    let number = copies::claim(app, &copy).await?;
    let record = ForkRecord {
        fork_id: format!("f{number}"),
        number,
        run_id: new.run_id,
        parent: new.parent,
        edit_at: new.edit_at,
        namespace: namespaces::fork(number),
        mode: new.mode,
        auto_read: new.auto_read,
        auto: new.auto,
        stops: new.stops,
        copy,
        answers: new.answers,
        steps: Vec::new(),
        outcome: Outcome::Crashed {
            error: ErrorAnswer {
                code: Some("REWIND_NOT_RUN".to_string()),
                message: "the fork has not run yet".to_string(),
            },
        },
        created_at_ms: now_ms(),
        code: None,
        trace_id: None,
        span_id: None,
        rerun: None,
    };
    let _guard = app.lock(&record.fork_id).await;
    let namespace = record.namespace.clone();
    let ran = run(app, record).await;
    // The fork may have taken a spare whose namespace is already open.
    if ran.is_err() {
        app.spaces.close(&namespace).await;
    }

    ran
}

/// In a recovery, the seq of the call the run's worker died while running.
fn lost_mid_call(app: &App, record: &ForkRecord, run: &Event, recording: &[Step]) -> Option<u32> {
    if record.mode != Mode::Recover {
        return None;
    }

    lost_mid_call_at(run, recording, &app.known_functions())
}

fn policy_of(app: &App, record: &ForkRecord, run: &Event, recording: &[Step]) -> Policy {
    Policy::of_fork(record, lost_mid_call(app, record, run, recording))
}

/// The workers a fork copies. A fork with none listed copies its root's worker.
fn copies_of(app: &App, record: &ForkRecord, run: &Event) -> Result<Vec<String>> {
    if record.copy.is_empty() {
        return app.copies_for(&run.function_id, &[]);
    }

    Ok(record.copy.clone())
}

/// Only a replay that copies another worker matches calls below the run's own, so only it reads them.
fn below_if_copied(app: &App, recording: &[Step], copies: usize) -> Result<HashMap<String, Vec<Step>>> {
    if copies <= 1 {
        return Ok(HashMap::new());
    }

    recorded_below(recording, &app.store, &app.catalog)
}

/// A session for one rerun of `run` with `copies` workers copied.
pub fn session_for(app: &App, run: &Event, recording: Vec<Step>, policy: Policy, answers: BTreeMap<At, Step>, copies: usize) -> Result<Session> {
    let below = below_if_copied(app, &recording, copies)?;
    Ok(Session::new(policy, recording, answers).of_run(run, below))
}

/// Runs a fork from the start. Whoever calls this has taken the fork's lock first.
async fn run(app: &Arc<App>, mut record: ForkRecord) -> Result<ForkRecord> {
    let (run, recording) = app.run(&record.run_id)?;
    let input = normalize_input(run.input.as_ref().unwrap_or(&Value::Null));
    let policy = policy_of(app, &record, &run, &recording);
    let copies = copies_of(app, &record, &run)?;
    let session = session_for(app, &run, recording, policy, record.answers.clone(), copies.len())?;
    let space = app.spaces.open(app, &record.namespace, &copies).await?;
    let ran = match replay::run_in(app, &space, &run.function_id, input, session).await {
        Ok(ran) => ran,
        Err(error) => {
            app.spaces.close(&record.namespace).await;
            return Err(error);
        }
    };

    record.answers = ran.answers;
    record.steps = ran.steps;
    record.outcome = ran.outcome;
    record.code = Some(ran.code);
    // Every stub in one rerun runs inside the copy's call, so they share its trace.
    record.trace_id = record.steps.iter().find_map(|step| step.call.trace_id.clone());
    record.span_id = None;
    record.rerun = Some(ran.rerun);
    app.store.put_fork(&record)?;
    // A paused fork keeps its copy for a while, so the next answer reruns in milliseconds.
    if record.outcome.is_paused() {
        copies::park(app, &record.namespace);
    } else {
        app.spaces.close_later(&record.namespace).await;
    }

    app.changes.emit_fork(&record.fork_id, record.trace_id.as_deref());
    Ok(record)
}

pub async fn answer(
    app: &Arc<App>,
    fork_id: &str,
    choice: &str,
    value: Option<Value>,
    auto_read: Option<bool>,
) -> Result<ForkRecord> {
    let _guard = app.lock(fork_id).await;
    let mut record = app.fork_record(fork_id)?;
    let Outcome::Paused { need } = record.outcome.clone() else {
        return Err(Error::NotPaused(format!("fork {fork_id} is not waiting for an answer")));
    };
    let Some(choice) = need.choices.iter().copied().find(|allowed| allowed.as_str() == choice) else {
        let allowed: Vec<&str> = need.choices.iter().map(|allowed| allowed.as_str()).collect();
        return Err(Error::ChoiceNotAllowed(format!(
            "{choice} is not allowed for {}; choose one of {allowed:?}",
            need.function_id
        )));
    };

    if let Some(flag) = auto_read {
        record.auto_read = flag;
    }

    let Some(step) = chosen_step(app, &record.run_id, &need, choice, value).await? else {
        return stop(app, record).await;
    };
    record.answers.insert(need.at(), step);
    run(app, record).await
}

/// Changes how a fork treats calls that have no answer yet, and runs it again from the start.
pub async fn set(app: &Arc<App>, fork_id: &str, auto: Option<bool>, stops: Option<Vec<String>>) -> Result<ForkRecord> {
    let _guard = app.lock(fork_id).await;
    let mut record = app.fork_record(fork_id)?;
    if let Some(auto) = auto {
        record.auto = auto;
    }

    if let Some(stops) = stops {
        record.stops = stops;
    }

    let (run_event, recording) = app.run(&record.run_id)?;
    let policy = policy_of(app, &record, &run_event, &recording);
    record.answers = replay::answers_to_keep(record.answers, &policy);
    run(app, record).await
}

/// The answer a choice gives the pending call, or `None` for stop. A live send goes out with the
/// same idempotency key from every recovery or fork of `run_id`, so picking it again sends nothing new.
async fn chosen_step(app: &App, run_id: &str, need: &Need, choice: Choice, value: Option<Value>) -> Result<Option<Step>> {
    let (worker, effects) = app.catalog.describe(&need.function_id);
    let at = need.at();
    let with = |answer: Answer, source: Source| {
        let call = Call {
            worker: worker.clone(),
            effects: effects.clone(),
            input: need.input.clone(),
            started_at_ms: Some(now_ms()),
            ..Call::new(&at, need.function_id.clone(), answer, source)
        };
        Some(Step::new(call.with_origin()))
    };
    match choice {
        Choice::Live => Ok(Some(
            replay::live_step(app, run_id, &at, &need.function_id, worker.clone(), effects.clone(), need.input.clone()).await,
        )),
        Choice::Typed => {
            let value = value.ok_or_else(|| Error::BadInput("typed needs a value".into()))?;
            Ok(with(Answer::value(value), Source::Typed))
        }
        Choice::Inject => Ok(with(
            Answer::error(Some("UNAVAILABLE"), "injected by rewind"),
            Source::Injected,
        )),
        Choice::Stop => Ok(None),
    }
}

async fn stop(app: &App, mut record: ForkRecord) -> Result<ForkRecord> {
    app.spaces.close(&record.namespace).await;
    app.store.delete_fork(&record.fork_id)?;
    record.outcome = Outcome::Crashed {
        error: ErrorAnswer {
            code: Some("REWIND_STOPPED".to_string()),
            message: "stopped by a person; the fork was deleted".to_string(),
        },
    };
    app.changes.emit("fork", &record.fork_id);
    Ok(record)
}
