//! Recording: one observer per function on the record list, all delivering to
//! `rewind::record`, which stores each envelope as a row. The list follows the
//! engine's functions and any toggles a person set.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, MutexGuard,
        mpsc::{self, Receiver, Sender},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use iii_sdk::{
    CallRequest, Capture, ObserverHandle, ObserverState, RegisterFunction, Source, Target,
    engine::EngineFunctions,
};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::{
    app::{App, REWIND_WORKER},
    catalog::{self, DEFAULT_NAMESPACE, FunctionRow},
    copies::STUB_WORKER,
    error::Result,
    runs::is_root,
    store::{Event, Status},
    traces,
};

pub const RECORD_TARGET: &str = "rewind::record";
const FUNCTIONS_CHANGED_TARGET: &str = "rewind::on-functions-changed";
const RESYNC_EVERY: Duration = Duration::from_secs(10);
// A burst delivers calls faster than one commit each, so the writer stores up to this many at once.
const BATCH_MOST: usize = 500;

#[derive(Default)]
pub struct Recorder {
    observers: Mutex<HashMap<String, ObserverHandle>>,
    functions_changed: Mutex<Option<ObserverHandle>>,
    resync: Notify,
    /// `rewind::record` runs on the SDK's connection thread, so it hands each call to a thread
    /// of its own that stores it.
    writer: Mutex<Option<Sender<Event>>>,
    writing: Mutex<Option<JoinHandle<()>>>,
}

impl Recorder {
    pub fn recording(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .observers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    pub fn is_recording(&self, function_id: &str) -> bool {
        self.observers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(function_id)
    }

    pub fn resync_soon(&self) {
        self.resync.notify_one();
    }
}

pub fn should_record(row: &FunctionRow, toggles: &HashMap<String, bool>, entry: &str) -> bool {
    if row.namespace != DEFAULT_NAMESPACE || row.function_id.starts_with("rewind::") || row.internal {
        return false;
    }

    if let Some(enabled) = toggles.get(&row.function_id) {
        return *enabled;
    }

    // Runs are events of the entry function, so it is recorded even if it declares nothing.
    row.declares_effects || row.function_id == entry
}

pub fn parse_envelope(envelope: &Value) -> Option<Event> {
    let caller = &envelope["caller"];
    let text = |value: &Value| value.as_str().map(str::to_string);
    Some(Event {
        invocation_id: text(&envelope["invocation_id"])?,
        function_id: text(&envelope["function_id"])?,
        namespace: text(&envelope["namespace"]).unwrap_or_else(|| DEFAULT_NAMESPACE.to_string()),
        status: envelope["status"].as_str().map(Status::parse).unwrap_or(Status::Success),
        input: envelope.get("input").cloned(),
        output: envelope.get("output").cloned(),
        error: envelope.get("error").cloned(),
        caller_worker: text(&caller["worker_name"]),
        caller_function_id: text(&caller["function_id"]),
        caller_invocation_id: text(&caller["invocation_id"]),
        started_at_ms: envelope["started_at_ms"].as_u64().unwrap_or(0),
        duration_ms: envelope["duration_ms"].as_f64().unwrap_or(0.0),
        code_version: None,
        kind: None,
        trace_id: None,
        span_id: None,
    })
}

/// Live calls Rewind makes for a fork go to `default` and get observed like any other call.
pub fn made_by_rewind(event: &Event) -> bool {
    matches!(event.caller_worker.as_deref(), Some(REWIND_WORKER | STUB_WORKER))
}

fn is_run(app: &App, event: &Event) -> bool {
    event.function_id == app.config.entry && event.namespace == DEFAULT_NAMESPACE
}

/// The row for an observed call, or `None` for one Rewind made itself. It runs in the handler,
/// because the trace comes from the handler's own span.
fn event_of(app: &App, envelope: &Value) -> Option<Event> {
    let Some(mut event) = parse_envelope(envelope) else {
        eprintln!("rewind: skipped an envelope without ids: {envelope}");
        return None;
    };
    if made_by_rewind(&event) {
        return None;
    }

    // This handler's span is a child of the observed call's caller, so it is in the call's trace.
    // A run started with no trace context has no caller span, so a run takes its calls' trace.
    event.trace_id = traces::current().0;
    if is_run(app, &event) {
        event.code_version = app.target_code.latest().map(|code| code.version);
    }

    Some(event)
}

fn record(app: &App, envelope: &Value) {
    let Some(event) = event_of(app, envelope) else {
        return;
    };

    let writer = guarded(&app.recorder.writer);
    let Some(writer) = writer.as_ref() else {
        eprintln!("rewind: dropped {} because Rewind is stopping", event.invocation_id);
        return;
    };

    if let Err(unsent) = writer.send(event) {
        eprintln!("rewind: dropped {} because the writer has stopped", unsent.0.invocation_id);
    }
}

/// Hands `store` everything that has arrived since it last ran, until every sender is gone.
fn in_batches(received: &Receiver<Event>, mut store: impl FnMut(&[Event])) {
    while let Ok(first) = received.recv() {
        let mut batch = vec![first];
        while batch.len() < BATCH_MOST
            && let Ok(next) = received.try_recv()
        {
            batch.push(next);
        }

        store(&batch);
    }
}

fn store_batch(app: &App, batch: &[Event]) {
    if let Err(error) = app.store.insert_events(batch) {
        eprintln!("rewind: could not store {} recorded calls: {error}", batch.len());
        return;
    }

    let now = Instant::now();
    for event in batch {
        arrived(app, event, now);
    }
}

/// Tells the runs list a stored call is there. A run's event waits for its calls to arrive.
fn arrived(app: &App, event: &Event, now: Instant) {
    if is_run(app, event) || is_root(event, &app.config.entry, &app.catalog) {
        app.settling.run_arrived(&event.invocation_id, now);
        return;
    }

    if let Some(run_id) = &event.caller_invocation_id {
        app.settling.call_arrived(run_id, now);
    }
}

fn guarded<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn start_writer(app: &Arc<App>) {
    let (sender, received) = mpsc::channel();
    *guarded(&app.recorder.writer) = Some(sender);
    let writer_app = app.clone();
    let writing = std::thread::spawn(move || in_batches(&received, |batch| store_batch(&writer_app, batch)));
    *guarded(&app.recorder.writing) = Some(writing);
}

/// Stores the calls still waiting, once nothing delivers any more.
pub async fn finish_writing(app: &App) {
    guarded(&app.recorder.writer).take();
    let writing = guarded(&app.recorder.writing).take();
    if let Some(writing) = writing {
        let _ = tokio::task::spawn_blocking(move || writing.join()).await;
    }
}

pub fn register(app: &Arc<App>) {
    start_writer(app);
    let recorder_app = app.clone();
    app.iii.register_function(
        RECORD_TARGET,
        RegisterFunction::new_async(move |envelope: Value| {
            let app = recorder_app.clone();
            async move {
                record(&app, &envelope);
                Ok(Value::Null)
            }
        })
        .description("Stores each observed call for Rewind")
        .metadata(json!({ "internal": true })),
    );

    let changed_app = app.clone();
    app.iii.register_function(
        FUNCTIONS_CHANGED_TARGET,
        RegisterFunction::new_async(move |_event: Value| {
            changed_app.recorder.resync_soon();
            async { Ok(Value::Null) }
        })
        .description("Tells Rewind to look at the function list again")
        .metadata(json!({ "internal": true })),
    );
}

/// Exits if another worker owns `rewind::record`: observers deliver to whoever owns the target id.
pub async fn confirm_target_owner(app: &App) -> std::result::Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let mut request = CallRequest::new(
            EngineFunctions::LIST_FUNCTIONS,
            json!({ "prefix": RECORD_TARGET, "include_internal": true }),
        );
        request.timeout_ms = Some(10_000);
        let listed = app
            .iii
            .call(request)
            .await
            .map_err(|error| format!("could not check who owns {RECORD_TARGET}: {error}"))?;
        let owner = listed["functions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["function_id"] == RECORD_TARGET && row["namespace"].as_str().unwrap_or(DEFAULT_NAMESPACE) == DEFAULT_NAMESPACE)
            .map(|row| row["worker_name"].as_str().unwrap_or_default().to_string());
        match owner {
            Some(worker) if worker == REWIND_WORKER => return Ok(()),
            Some(worker) => {
                return Err(format!(
                    "{RECORD_TARGET} is already owned by worker {worker:?} (FUNCTION_NAMESPACE_CONFLICT), so its observers would deliver there"
                ));
            }
            None if Instant::now() > deadline => {
                return Err(format!("{RECORD_TARGET} never showed up in the function list"));
            }
            None => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

/// The default capture fires on success only. With `error` next to `input` and `output`, the
/// observer fires after every finished call, whether it succeeded or failed.
fn observe(app: &App, function_id: &str) -> ObserverHandle {
    app.iii.observe(
        Source::function(function_id)
            .namespace(DEFAULT_NAMESPACE)
            .capture([Capture::Input, Capture::Output, Capture::Error, Capture::Caller, Capture::Metadata]),
        Target::function(RECORD_TARGET).namespace(DEFAULT_NAMESPACE),
    )
}

/// Observes what is on the record list and stops observing what a person turned off.
/// An observer is kept while its function is away, so it resumes when the worker returns.
pub async fn sync(app: &App) -> Result<()> {
    let rows = catalog::list(&app.iii).await?;
    app.catalog.replace(&rows);
    let toggles = app.store.toggles()?;
    let wanted: HashSet<String> = app
        .catalog
        .all()
        .iter()
        .filter(|row| should_record(row, &toggles, &app.config.entry))
        .map(|row| row.function_id.clone())
        .collect();

    let mut observers = app.recorder.observers.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let turned_off: Vec<String> = observers
        .keys()
        .filter(|id| toggles.get(*id) == Some(&false))
        .cloned()
        .collect();
    for function_id in turned_off {
        if let Some(handle) = observers.remove(&function_id) {
            app.rt.spawn(async move {
                let _ = handle.dispose().await;
            });
        }
    }

    for function_id in wanted {
        let usable = observers
            .get(&function_id)
            .is_some_and(|handle| !matches!(handle.state(), ObserverState::Error | ObserverState::Disposed));
        if usable {
            continue;
        }

        eprintln!("rewind: recording {function_id}");
        observers.insert(function_id.clone(), observe(app, &function_id));
    }

    Ok(())
}

pub fn start(app: &Arc<App>) {
    let watcher = app.iii.observe(
        Source::function("engine::on-functions-changed"),
        Target::function(FUNCTIONS_CHANGED_TARGET),
    );
    *app.recorder.functions_changed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(watcher);

    let app = app.clone();
    app.rt.clone().spawn(async move {
        loop {
            if let Err(error) = sync(&app).await {
                eprintln!("rewind: could not refresh the record list: {error}");
            }

            tokio::select! {
                _ = app.recorder.resync.notified() => {
                    // A burst of registrations, such as a fork's stubs, settles into one refresh.
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
                _ = tokio::time::sleep(RESYNC_EVERY) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(function_id: &str, declares_effects: bool) -> FunctionRow {
        FunctionRow {
            function_id: function_id.into(),
            namespace: DEFAULT_NAMESPACE.into(),
            worker: "tools".into(),
            effects: Vec::new(),
            declares_effects,
            internal: false,
        }
    }

    #[test]
    fn records_functions_that_declare_effects_but_not_rewinds_own() {
        let toggles = HashMap::new();
        assert!(should_record(&row("email::send", true), &toggles, "agent::run"));
        assert!(!should_record(&row("console::workspace::get", false), &toggles, "agent::run"));
        assert!(!should_record(&row("rewind::runs", true), &toggles, "agent::run"));
    }

    #[test]
    fn always_records_the_entry() {
        assert!(should_record(&row("agent::run", false), &HashMap::new(), "agent::run"));
    }

    #[test]
    fn a_toggle_wins_over_the_declared_effects() {
        let toggles = HashMap::from([("email::send".to_string(), false), ("console::x".to_string(), true)]);
        assert!(!should_record(&row("email::send", true), &toggles, "agent::run"));
        assert!(should_record(&row("console::x", false), &toggles, "agent::run"));
    }

    #[test]
    fn functions_in_other_namespaces_are_not_recorded() {
        let mut stub = row("email::send", true);
        stub.namespace = "rewind-f1".into();
        assert!(!should_record(&stub, &HashMap::new(), "agent::run"));
    }

    #[test]
    fn an_envelope_becomes_a_row() {
        let envelope = json!({
            "observer_id": "o", "activation_id": "a",
            "function_id": "calendar::find-slot", "namespace": "default",
            "invocation_id": "inv-1", "status": "error",
            "input": { "duration": "30" },
            "error": { "code": "invocation_failed", "message": "unsupported type" },
            "caller": { "worker_id": "w", "worker_name": "agent", "function_id": "agent::run", "invocation_id": "run-1" },
            "started_at_ms": 1793403372720u64, "duration_ms": 2.41,
        });
        let event = parse_envelope(&envelope).unwrap();
        assert_eq!(event.function_id, "calendar::find-slot");
        assert_eq!(event.caller_invocation_id.as_deref(), Some("run-1"));
        assert_eq!(event.caller_worker.as_deref(), Some("agent"));
        assert_eq!(event.status, Status::Error);
        assert!(!made_by_rewind(&event));
    }

    fn call(id: &str) -> Event {
        parse_envelope(&json!({ "function_id": "clock::now", "invocation_id": id })).unwrap()
    }

    #[test]
    fn calls_that_arrive_together_are_stored_together_and_none_is_lost() {
        let (sender, received) = mpsc::channel();
        for id in 0..(BATCH_MOST + 20) {
            sender.send(call(&format!("inv-{id}"))).unwrap();
        }

        drop(sender);
        let mut batches = Vec::new();
        in_batches(&received, |batch| batches.push(batch.len()));
        assert_eq!(batches, [BATCH_MOST, 20]);
    }

    #[test]
    fn a_call_sent_after_a_batch_is_stored_in_the_next_one() {
        let (sender, received) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let mut stored = Vec::new();
            in_batches(&received, |batch| stored.extend(batch.iter().map(|event| event.invocation_id.clone())));
            stored
        });
        sender.send(call("first")).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        sender.send(call("second")).unwrap();
        drop(sender);
        assert_eq!(writer.join().unwrap(), ["first", "second"]);
    }

    #[test]
    fn calls_rewind_made_itself_are_left_out() {
        let envelope = json!({
            "function_id": "calendar::find-slot", "invocation_id": "inv-2", "status": "success",
            "caller": { "worker_name": "rewind" }, "started_at_ms": 1, "duration_ms": 1.0,
        });
        assert!(made_by_rewind(&parse_envelope(&envelope).unwrap()));
    }
}
