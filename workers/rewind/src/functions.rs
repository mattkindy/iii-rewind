//! The `rewind::*` functions the UI calls. Each one parses its input, does its
//! work on Rewind's own runtime, and returns JSON.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::Arc,
};

use iii_sdk::RegisterFunction;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    app::App,
    catalog::{self, Formats},
    checks,
    effects::Effect,
    error::{Error, Result},
    fixtures, forks, inbound,
    outside::Kind,
    recording,
    recovery,
    runs::{RunDetail, RunFilter, RunQuery, summarize, with_inner},
    store::{Event, Window},
    traces,
    types::{Answer, Source},
    workers,
};

const DEFAULT_RUNS_LIMIT: usize = 50;
const MAX_RUNS_LIMIT: usize = 500;
// Filters and queries look through this many of the newest runs.
const RUNS_SCAN_LIMIT: usize = 2000;

#[derive(Deserialize)]
struct Empty {}

#[derive(Deserialize)]
struct RunsInput {
    #[serde(default)]
    filter: Option<RunFilter>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    root: Option<Root>,
    /// Only the runs whose root is this function. `root` is ignored then.
    #[serde(default)]
    function_id: Option<String>,
    /// Runs that started before this, not counting it, for the next page.
    #[serde(default)]
    before_ms: Option<u64>,
    #[serde(default)]
    since_ms: Option<u64>,
}

#[derive(Deserialize)]
struct RunInput {
    run_id: String,
}

#[derive(Deserialize)]
struct ReplayInput {
    run_id: String,
    #[serde(default)]
    auto_read: Option<bool>,
    #[serde(default)]
    auto: Option<bool>,
    #[serde(default)]
    stops: Option<Vec<String>>,
    /// Workers to copy besides the root's own, such as `["tools"]`.
    #[serde(default)]
    copy: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ForkInput {
    run_id: String,
    #[serde(default)]
    base: Option<String>,
    at_seq: u32,
    answer: Answer,
    source: Source,
    #[serde(default)]
    auto_read: Option<bool>,
    /// Left out, a fork takes its base's setting, or off when it has no base.
    #[serde(default)]
    auto: Option<bool>,
    #[serde(default)]
    stops: Option<Vec<String>>,
    #[serde(default)]
    copy: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RecoverInput {
    run_id: String,
    #[serde(default)]
    auto: Option<bool>,
    #[serde(default)]
    stops: Option<Vec<String>>,
    #[serde(default)]
    copy: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ForkGetInput {
    fork_id: String,
}

/// Each setting left out keeps the fork's own.
#[derive(Deserialize)]
struct ForkSetInput {
    fork_id: String,
    #[serde(default)]
    auto: Option<bool>,
    #[serde(default)]
    stops: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct AnswerInput {
    fork_id: String,
    choice: String,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    auto_read: Option<bool>,
}

#[derive(Deserialize)]
struct ToggleInput {
    function_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct SaveTestInput {
    fork_id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct TestInput {
    path: String,
}

#[derive(Deserialize)]
struct SpansInput {
    invocation_id: String,
}

#[derive(Deserialize)]
struct CheckInput {
    run_ids: Vec<String>,
    #[serde(default)]
    live: bool,
    #[serde(default)]
    copy: Vec<String>,
}

fn json_of(value: impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| Error::Internal(error.to_string()))
}

/// Registers one function. Its work runs on Rewind's runtime, so a slow fork
/// never blocks the connection that delivers recorded events.
fn register<I, F, Fut>(app: &Arc<App>, id: &str, description: &str, effects: &[Effect], handler: F)
where
    I: DeserializeOwned + Send + 'static,
    F: Fn(Arc<App>, I) -> Fut + Send + Sync + Clone + 'static,
    Fut: Future<Output = Result<Value>> + Send + 'static,
{
    let shared = app.clone();
    app.iii.register_function(
        id,
        RegisterFunction::new_async(move |input: Value| {
            let app = shared.clone();
            let handler = handler.clone();
            async move { handle(app, input, handler).await.map_err(iii_sdk::Error::from) }
        })
        .description(description)
        .metadata(json!({ "effects": effects })),
    );
}

/// Parses a call's input and runs its handler on Rewind's runtime.
async fn handle<I, F, Fut>(app: Arc<App>, input: Value, handler: F) -> Result<Value>
where
    I: DeserializeOwned,
    F: Fn(Arc<App>, I) -> Fut,
    Fut: Future<Output = Result<Value>> + Send + 'static,
{
    let input = match input {
        Value::Null => json!({}),
        other => other,
    };
    let parsed: I = serde_json::from_value(input).map_err(|error| Error::BadInput(error.to_string()))?;
    app.rt
        .clone()
        .spawn(handler(app.clone(), parsed))
        .await
        .map_err(|error| Error::Internal(error.to_string()))?
}

fn run_query(app: &App, q: Option<&str>) -> Result<RunQuery> {
    let text = q.unwrap_or_default().trim();
    if text.is_empty() {
        return Ok(RunQuery::new(text, HashSet::new()));
    }

    Ok(RunQuery::new(text, app.store.runs_with_call_prefix(text)?))
}

/// The newest roots of the kind asked for. Other roots are listed only when asked for, so the
/// entry function's runs stay what every other caller gets. Every fetch the agent makes also
/// arrives at the clock worker as a request of its own, which would bury the agent's runs.
fn roots(app: &App, root: Root, function_id: Option<&str>, window: Window) -> Result<Vec<Event>> {
    if let Some(function_id) = function_id {
        return roots_of(app, function_id, window);
    }

    let entry_runs = || app.store.runs_in(&app.config.entry, window, RUNS_SCAN_LIMIT);
    match root {
        Root::Entry => entry_runs(),
        Root::HttpIn => app.store.inbound_runs(window, RUNS_SCAN_LIMIT),
        Root::All => Ok(newest([entry_runs()?, app.store.inbound_runs(window, RUNS_SCAN_LIMIT)?])),
        Root::Any => Ok(newest([entry_runs()?, app.store.uncalled_in(None, window, RUNS_SCAN_LIMIT)?])),
    }
}

/// Which roots `rewind::runs` lists when it is not given a function.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
enum Root {
    /// Runs of the entry function.
    #[default]
    Entry,
    /// Requests that arrived at a worker's own HTTP server.
    HttpIn,
    /// Both of those.
    All,
    /// The entry's runs and every call nothing recorded called.
    Any,
}

impl TryFrom<String> for Root {
    type Error = String;

    fn try_from(text: String) -> std::result::Result<Self, Self::Error> {
        match text.as_str() {
            "entry" => Ok(Root::Entry),
            "http_in" => Ok(Root::HttpIn),
            "all" => Ok(Root::All),
            "any" => Ok(Root::Any),
            other => Err(format!("root must be entry, http_in, all or any, not {other}")),
        }
    }
}

/// The entry is a root even when something recorded called it. Any other function is a root
/// only where nothing recorded called it.
fn roots_of(app: &App, function_id: &str, window: Window) -> Result<Vec<Event>> {
    if function_id == app.config.entry {
        return app.store.runs_in(function_id, window, RUNS_SCAN_LIMIT);
    }

    app.store.uncalled_in(Some(function_id), window, RUNS_SCAN_LIMIT)
}

/// Lists of roots merged newest first. An entry run that nothing called is in two of them.
fn newest<const N: usize>(lists: [Vec<Event>; N]) -> Vec<Event> {
    let mut seen = HashSet::new();
    let mut merged: Vec<Event> = lists
        .into_iter()
        .flatten()
        .filter(|root| seen.insert(root.invocation_id.clone()))
        .collect();
    merged.sort_by_key(|root| std::cmp::Reverse(root.started_at_ms));
    merged.truncate(RUNS_SCAN_LIMIT);
    merged
}

#[derive(Serialize)]
struct FunctionView {
    function_id: String,
    worker: String,
    effects: Vec<Effect>,
    recording: bool,
    #[serde(flatten)]
    formats: Formats,
}

/// A row for each function, with the formats the engine has for it. The function list has no
/// formats, so they come from one more lookup, and a lookup that fails leaves them out.
async fn function_rows(app: &App, function_ids: &[String]) -> Vec<FunctionView> {
    let mut formats = catalog::formats(&app.iii, function_ids).await.unwrap_or_else(|error| {
        eprintln!("rewind: could not look up function formats: {error}");
        HashMap::new()
    });
    function_ids
        .iter()
        .map(|function_id| {
            let (worker, effects) = app.catalog.describe(function_id);
            FunctionView {
                function_id: function_id.clone(),
                worker,
                effects,
                recording: app.recorder.is_recording(function_id),
                formats: formats.remove(function_id).unwrap_or_default(),
            }
        })
        .collect()
}

const READS: &[Effect] = &[Effect::ReadOnly];
const WRITES: &[Effect] = &[Effect::Writes];

/// Every `rewind::*` function the page calls, with its description and effects. Each handler
/// below takes its parsed input and returns the JSON the page gets.
pub fn register_all(app: &Arc<App>) {
    register(app, "rewind::status", "What Rewind is recording, how many runs and forks it has, and the version of the code under test", READS, status);
    register(app, "rewind::functions", "Every function in default, its effects, and whether Rewind records it", READS, functions);
    register(app, "rewind::record-toggle", "Turns recording on or off for one function", WRITES, record_toggle);
    register(app, "rewind::runs", "Recorded runs, newest first: the entry function's unless root or function_id asks for others", READS, runs);
    register(app, "rewind::run", "One run with its calls and its forks", READS, run);
    register(app, "rewind::replay", "Replays a run as recorded, in a fork with no edits", WRITES, replay);
    register(app, "rewind::fork", "Forks a run by changing the answer at one seq", WRITES, fork);
    register(app, "rewind::fork-set", "Changes whether a fork runs on safe defaults and where it stops, then runs it again", WRITES, fork_set);
    register(app, "rewind::fork-get", "One fork", READS, fork_get);
    register(app, "rewind::spans", "The function spans recorded inside one iii call, in start order", READS, spans);
    register(app, "rewind::answer", "Answers a paused fork's pending call and runs the fork again", WRITES, answer);
    register(app, "rewind::lost", "Runs a dead worker stopped, each with its recovery fork", READS, lost);
    register(app, "rewind::recover", "Recovers a stopped run in a fork that runs the rest live", WRITES, recover);
    register(app, "rewind::save-test", "Saves a fork as a test in tests/rewind", WRITES, save_test);
    register(app, "rewind::test", "Runs a saved test and compares how it ends", READS, test);
    register(app, "rewind::check", "Replays runs against the current code, with live calls only if live is set, and says whether each ends the same", &[Effect::External], check);
}

async fn status(app: Arc<App>, _: Empty) -> Result<Value> {
    let target_code = app
        .target_code
        .now()
        .await
        .inspect_err(|error| eprintln!("rewind: {error}"))
        .ok();
    Ok(json!({
        "engine": app.config.url,
        "entry": app.config.entry,
        "recording": app.recorder.recording(),
        "runs": app.store.count_runs(&app.config.entry)?,
        "inbound_runs": app.store.count_inbound_runs()?,
        "forks": app.store.count_forks()?,
        "target_code": target_code,
    }))
}

async fn functions(app: Arc<App>, _: Empty) -> Result<Value> {
    let function_ids: Vec<String> = app
        .catalog
        .all()
        .into_iter()
        .map(|row| row.function_id)
        .filter(|function_id| !function_id.starts_with("rewind::"))
        .collect();
    json_of(function_rows(&app, &function_ids).await)
}

async fn record_toggle(app: Arc<App>, input: ToggleInput) -> Result<Value> {
    if app.catalog.get(&input.function_id).is_none() {
        return Err(Error::NotFound(format!("no function {} in default", input.function_id)));
    }

    app.store.set_toggle(&input.function_id, input.enabled)?;
    recording::sync(&app).await?;
    json_of(&function_rows(&app, std::slice::from_ref(&input.function_id)).await[0])
}

async fn runs(app: Arc<App>, input: RunsInput) -> Result<Value> {
    let filter = input.filter.unwrap_or_default();
    let limit = input.limit.unwrap_or(DEFAULT_RUNS_LIMIT).min(MAX_RUNS_LIMIT);
    let query = run_query(&app, input.q.as_deref())?;
    let known = app.known_functions();
    let mut found = Vec::new();
    let window = Window {
        before_ms: input.before_ms,
        since_ms: input.since_ms,
    };
    for run in roots(&app, input.root.unwrap_or_default(), input.function_id.as_deref(), window)? {
        if found.len() >= limit {
            break;
        }

        if !query.matches(&run) {
            continue;
        }

        let steps = app.steps_of(&run)?;
        if filter.keeps(&run, &steps, &known) {
            found.push(summarize(&run, &steps, &known));
        }
    }

    json_of(found)
}

async fn run(app: Arc<App>, input: RunInput) -> Result<Value> {
    let (run, steps) = app.root(&input.run_id)?;
    let forks = app
        .store
        .forks_of_run(&input.run_id)?
        .iter()
        .map(|fork| fork.listed())
        .collect();
    let mut calls = with_inner(steps.iter().map(|step| step.call.clone()).collect(), &app.store)?;
    let mut summary = summarize(&run, &steps, &app.known_functions());
    // The trace store is the engine's, so a lookup that fails leaves the ids out and nothing else.
    if let Err(error) = traces::resolve_calls(&app, &mut calls).await {
        eprintln!("rewind: could not look up the spans of run {}: {error}", run.invocation_id);
    }

    if summary.span_id.is_none()
        && let Some(trace_id) = summary.trace_id.clone()
    {
        summary.span_id = traces::resolve_run(&app, &run, &trace_id).await.unwrap_or_default();
    }

    let (from_ms, to_ms) = workers::window(&run);
    json_of(RunDetail {
        run: summary,
        calls,
        forks,
        worker_changes: app.store.worker_changes_between(from_ms, to_ms)?,
    })
}

async fn replay(app: Arc<App>, input: ReplayInput) -> Result<Value> {
    let (run, _) = app.root(&input.run_id)?;
    if Kind::parse(run.kind.as_deref()) == Kind::HttpIn {
        return json_of(inbound::replay(&app, &run).await?.view());
    }

    let settings = forks::Replay {
        auto_read: input.auto_read.unwrap_or(false),
        auto: input.auto.unwrap_or(false),
        stops: input.stops.unwrap_or_default(),
        copy: input.copy.unwrap_or_default(),
    };
    json_of(forks::replay(&app, &input.run_id, settings).await?.view())
}

async fn fork(app: Arc<App>, input: ForkInput) -> Result<Value> {
    let edit = forks::Edit {
        run_id: input.run_id,
        base: input.base,
        at_seq: input.at_seq,
        answer: input.answer,
        source: input.source,
        auto_read: input.auto_read,
        auto: input.auto,
        stops: input.stops,
        copy: input.copy,
    };
    json_of(forks::fork(&app, edit).await?.view())
}

async fn fork_set(app: Arc<App>, input: ForkSetInput) -> Result<Value> {
    json_of(forks::set(&app, &input.fork_id, input.auto, input.stops).await?.view())
}

/// A fork's root span is in the engine's trace store only once the copy has sent its spans, so
/// it is looked up the first time someone reads the fork and stored once found.
async fn fork_get(app: Arc<App>, input: ForkGetInput) -> Result<Value> {
    let mut record = app.fork_record(&input.fork_id)?;
    if let (Some(trace_id), None) = (record.trace_id.clone(), &record.span_id) {
        let root = app.store.event(&record.run_id)?.map(|run| run.function_id).unwrap_or_else(|| app.config.entry.clone());
        record.span_id = traces::root_span(&app, &trace_id, &root).await.unwrap_or_default();
        if record.span_id.is_some() {
            app.store.put_fork(&record)?;
        }
    }

    json_of(record.view())
}

async fn spans(app: Arc<App>, input: SpansInput) -> Result<Value> {
    json_of(app.spans.of_invocation(&input.invocation_id)?)
}

async fn answer(app: Arc<App>, input: AnswerInput) -> Result<Value> {
    let fork = forks::answer(&app, &input.fork_id, &input.choice, input.value, input.auto_read).await?;
    json_of(fork.view())
}

async fn lost(app: Arc<App>, _: Empty) -> Result<Value> {
    json_of(recovery::lost(&app)?)
}

async fn recover(app: Arc<App>, input: RecoverInput) -> Result<Value> {
    let auto = input.auto.unwrap_or(false);
    let (stops, copy) = (input.stops.unwrap_or_default(), input.copy.unwrap_or_default());
    json_of(recovery::recover(&app, &input.run_id, auto, stops, copy).await?.view())
}

async fn save_test(app: Arc<App>, input: SaveTestInput) -> Result<Value> {
    fixtures::save(&app, &input.fork_id, input.name.as_deref()).await
}

async fn test(app: Arc<App>, input: TestInput) -> Result<Value> {
    fixtures::run(&app, &input.path).await
}

async fn check(app: Arc<App>, input: CheckInput) -> Result<Value> {
    json_of(checks::check(&app, &input.run_ids, input.live, &input.copy).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(input: Value) -> String {
        serde_json::from_value::<RunsInput>(input).err().map(|error| error.to_string()).unwrap_or_default()
    }

    #[test]
    fn a_runs_filter_or_root_rewind_does_not_know_is_refused_with_its_own_message() {
        assert_eq!(refused(json!({ "filter": "odd" })), "filter must be all, failed or stopped");
        assert_eq!(refused(json!({ "root": "odd" })), "root must be entry, http_in, all or any, not odd");
        let given: RunsInput = serde_json::from_value(json!({ "filter": "stopped", "root": "http_in", "q": null })).unwrap();
        assert_eq!((given.filter, given.root), (Some(RunFilter::Stopped), Some(Root::HttpIn)));
        let empty: RunsInput = serde_json::from_value(json!({ "filter": null })).unwrap();
        assert_eq!((empty.filter.unwrap_or_default(), empty.root.unwrap_or_default()), (RunFilter::All, Root::Entry));
    }
}
