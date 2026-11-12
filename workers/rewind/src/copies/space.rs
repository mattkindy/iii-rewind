//! A fork's namespaces, one per copied worker, each with a connection on which Rewind registers a
//! handler for every function that worker's copy does not run itself. A handler stubs the call or
//! passes it on to the copy that runs it. The copy in each namespace restarts when its code changes.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use iii_sdk::{IIIClient, RegisterFunction, runtime::FunctionRef};
use serde_json::{Value, json};

use super::process::Copy;
use crate::{
    app::{App, connect},
    catalog::{self, FunctionRow},
    code::CodeVersion,
    error::{Error, Result},
    namespaces,
    outside::{self, OUTSIDE_FUNCTION},
    replay::{self, CalledBy, Session, SessionSlot},
    runs::NOT_ROOTS,
    sources::WorkerSource,
};

/// The worker name of every connection Rewind opens in a fork's namespaces.
pub const STUB_WORKER: &str = "rewind-stubs";

const STUBS_TIMEOUT: Duration = Duration::from_secs(20);
// A cold Node start with tsx takes a few seconds, more on a busy machine.
const COPY_START_TIMEOUT: Duration = Duration::from_secs(90);
const COPY_STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// How a function is handled in one copy's namespace.
#[derive(Debug, Clone, PartialEq)]
pub enum Handler {
    /// The copy registers it itself.
    Own,
    Stub,
    /// Another copied worker's function, passed on to that copy's namespace.
    Copied { namespace: String },
}

/// What a copy of `worker` finds when it calls `row`'s function.
pub fn handler_for(row: &FunctionRow, worker: &str, copied: &[(String, String)]) -> Handler {
    if row.worker == worker {
        return Handler::Own;
    }

    match copied.iter().find(|(name, _)| name == &row.worker) {
        Some((_, namespace)) => Handler::Copied {
            namespace: namespace.clone(),
        },
        None => Handler::Stub,
    }
}

/// One copied worker: its namespace, the connection Rewind registers its handlers on there, and the copy.
struct CopySpace {
    worker: String,
    namespace: String,
    source: WorkerSource,
    client: IIIClient,
    handlers: Mutex<HashMap<String, FunctionRef>>,
    /// The engine has listed every handler registered so far.
    stubs_listed: AtomicBool,
    copy: tokio::sync::Mutex<Option<Copy>>,
}

impl CopySpace {
    async fn open(app: &App, fork_namespace: &str, worker: &str, index: usize) -> Result<Self> {
        let source = app.worker_source(worker)?;
        let namespace = namespaces::copied(fork_namespace, worker, index);
        let client = connect(&app.config.url, STUB_WORKER, Some(&namespace));
        client.wait_until_registered(Duration::from_secs(15)).await?;
        Ok(Self {
            worker: worker.to_string(),
            namespace,
            source,
            client,
            handlers: Mutex::new(HashMap::new()),
            stubs_listed: AtomicBool::new(false),
            copy: tokio::sync::Mutex::new(None),
        })
    }

    async fn ensure_copy(&self, app: &App, functions: &[String]) -> Result<CodeVersion> {
        let current = app.code_versions.of(&self.source.dir).await?;
        let mut copy = self.copy.lock().await;
        let usable = copy
            .as_mut()
            .is_some_and(|copy| copy.exit_status().is_none() && copy.code.version == current.version);
        if !usable {
            if let Some(old) = copy.take() {
                if old.code.version != current.version {
                    eprintln!(
                        "rewind: the code of {} changed from {} to {}, so the copy in {} restarts",
                        self.worker, old.code.version, current.version, self.namespace
                    );
                }

                old.stop().await;
                catalog::wait_until_gone(&app.iii, &self.namespace, functions, COPY_STOP_TIMEOUT).await?;
            }

            *copy = Some(Copy::spawn_worker(app, &self.source, &self.namespace, current)?);
        }

        let Some(running) = copy.as_mut() else {
            return Err(Error::Internal("the copy went missing".into()));
        };
        // A copy that is still running keeps the functions the engine already listed for it.
        if functions.iter().all(|id| running.listed.contains(id)) {
            return Ok(running.code.clone());
        }

        catalog::wait_for(&app.iii, &self.namespace, functions, COPY_START_TIMEOUT, || {
            match running.exit_status() {
                Some(status) => Err(Error::CopyExited(format!(
                    "the copy in {} exited ({status}) before it registered",
                    self.namespace
                ))),
                None => Ok(()),
            }
        })
        .await?;
        running.listed.extend(functions.iter().cloned());
        Ok(running.code.clone())
    }
}

/// Each copied worker and the namespace its copy runs in, which the handlers read on every call.
type Routes = Arc<Mutex<Vec<(String, String)>>>;

/// The namespaces one fork, check or replayed request runs in: one per copied worker, the root's
/// worker first, and the session slot every handler in them answers from.
pub struct ForkSpace {
    /// The namespace of the root's worker, where a rerun starts.
    pub namespace: String,
    copies: Vec<CopySpace>,
    routes: Routes,
    slot: SessionSlot,
    /// Taken for a whole rerun, so two reruns never share the slot.
    pub run_lock: tokio::sync::Mutex<()>,
}

impl ForkSpace {
    /// `workers` start with the root's worker, the one the rerun is called in.
    pub(super) async fn open(app: &App, namespace: &str, workers: &[String]) -> Result<Self> {
        let mut space = Self {
            namespace: namespace.to_string(),
            copies: Vec::new(),
            routes: Arc::new(Mutex::new(Vec::new())),
            slot: Arc::new(Mutex::new(None)),
            run_lock: tokio::sync::Mutex::new(()),
        };
        space.add_workers(app, workers).await?;
        Ok(space)
    }

    /// Opens a namespace for each of `workers` after the ones the space already copies.
    pub(super) async fn add_workers(&mut self, app: &App, workers: &[String]) -> Result<()> {
        for worker in workers {
            let index = self.copies.len();
            self.copies.push(CopySpace::open(app, &self.namespace, worker, index).await?);
        }

        let routes: Vec<(String, String)> = self
            .copies
            .iter()
            .map(|copy| (copy.worker.clone(), copy.namespace.clone()))
            .collect();
        *self.routes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = routes;
        Ok(())
    }

    /// The worker whose copy a rerun starts in.
    pub(super) fn root_worker(&self) -> Option<&str> {
        self.copies.first().map(|copy| copy.worker.as_str())
    }

    pub fn install(&self, session: Session) {
        *self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(session);
    }

    pub fn take(&self) -> Option<Session> {
        self.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
    }

    fn copied(&self) -> Vec<(String, String)> {
        self.routes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// Nothing falls back to `default`, so each namespace gets a handler for every function in
    /// `default` its copy does not run, and for the function the copy's preload asks about its calls
    /// around iii. New functions are added on each run, and the engine lists each before a call.
    pub async fn ensure_stubs(&self, app: &Arc<App>) -> Result<()> {
        let copied = self.copied();
        let rows: Vec<FunctionRow> = app
            .catalog
            .all()
            .into_iter()
            .filter(|row| !NOT_ROOTS.iter().any(|prefix| row.function_id.starts_with(prefix)))
            .collect();
        for space in &self.copies {
            let mut wanted = vec![OUTSIDE_FUNCTION.to_string()];
            let mut added = false;
            {
                let mut handlers = space.handlers.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if !handlers.contains_key(OUTSIDE_FUNCTION) {
                    let handler = space.client.register_function(OUTSIDE_FUNCTION, outside_stub(app, &self.slot));
                    handlers.insert(OUTSIDE_FUNCTION.to_string(), handler);
                    added = true;
                }

                for row in &rows {
                    if handler_for(row, &space.worker, &copied) == Handler::Own {
                        continue;
                    }

                    wanted.push(row.function_id.clone());
                    if !handlers.contains_key(&row.function_id) {
                        let handler = routed(app, &self.slot, &self.routes, &space.worker, &row.function_id);
                        handlers.insert(row.function_id.clone(), space.client.register_function(row.function_id.clone(), handler));
                        added = true;
                    }
                }
            }

            // Once the engine has listed every handler, a rerun that adds none has nothing to wait for.
            if added {
                space.stubs_listed.store(false, Ordering::SeqCst);
            }

            if space.stubs_listed.load(Ordering::SeqCst) {
                continue;
            }

            catalog::wait_for(&app.iii, &space.namespace, &wanted, STUBS_TIMEOUT, || Ok(())).await?;
            space.stubs_listed.store(true, Ordering::SeqCst);
        }

        Ok(())
    }

    /// Starts each copy, or restarts one whose code has changed on disk since it started, and
    /// returns the code the root's copy loaded. Every copy has registered its functions before
    /// this returns, so the rerun never reaches a copy that is still starting.
    pub async fn ensure_copies(&self, app: &App, root: &str) -> Result<CodeVersion> {
        let mut root_code = None;
        for (index, space) in self.copies.iter().enumerate() {
            let mut functions = functions_of(app, &space.worker);
            if index == 0 && !functions.iter().any(|id| id == root) {
                functions.push(root.to_string());
            }

            let code = space.ensure_copy(app, &functions).await?;
            root_code.get_or_insert(code);
        }

        root_code.ok_or_else(|| Error::Internal("a fork has no copies".into()))
    }

    /// Starts the root's copy for a request sent to its own HTTP server, and returns the address
    /// the server listens on and the code the copy loaded.
    pub async fn serving(&self, app: &App, timeout: Duration) -> Result<(String, CodeVersion)> {
        let Some(space) = self.copies.first() else {
            return Err(Error::Internal("a fork has no copies".into()));
        };

        let code = space.ensure_copy(app, &functions_of(app, &space.worker)).await?;
        let mut copy = space.copy.lock().await;
        let Some(running) = copy.as_mut() else {
            return Err(Error::Internal("the copy went missing".into()));
        };

        Ok((running.listening(timeout).await?, code))
    }

    pub async fn close(&self) {
        for space in &self.copies {
            if let Some(copy) = space.copy.lock().await.take() {
                copy.stop().await;
            }

            let client = space.client.clone();
            let _ = tokio::task::spawn_blocking(move || client.shutdown()).await;
        }
    }
}

/// The functions `worker` has in `default`, which its copy registers in its own namespace.
fn functions_of(app: &App, worker: &str) -> Vec<String> {
    app.catalog
        .all()
        .into_iter()
        .filter(|row| row.worker == worker)
        .map(|row| row.function_id)
        .collect()
}

/// Where a call from `worker`'s copy goes, from the routes as they are when the call arrives.
fn route(app: &App, routes: &Routes, worker: &str, function_id: &str) -> Handler {
    let Some(row) = app.catalog.get(function_id) else {
        return Handler::Stub;
    };

    let copied = routes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    handler_for(&row, worker, &copied)
}

/// A spare registers its handlers before a fork takes it and says which other workers it copies,
/// so each handler decides on every call whether to stub it or pass it on to another copy.
fn routed(app: &Arc<App>, slot: &SessionSlot, routes: &Routes, worker: &str, function_id: &str) -> RegisterFunction {
    let (app, slot, routes, worker, id) = (app.clone(), slot.clone(), routes.clone(), worker.to_string(), function_id.to_string());
    RegisterFunction::new_async(move |input: Value| {
        let (app, slot, id) = (app.clone(), slot.clone(), id.clone());
        let handler = route(&app, &routes, &worker, &id);
        async move {
            match handler {
                Handler::Copied { namespace } => replay::copied_call(app, slot, id, input, namespace).await,
                Handler::Own | Handler::Stub => replay::stub_call(app, slot, id, input, None, CalledBy::current()).await,
            }
        }
    })
    .description(format!("Rewind's stub for {function_id}, or its way to the copy that runs it"))
    .metadata(json!({ "rewind": { "stub_of": function_id } }))
}

/// Takes the next place under its caller for a request the copy's preload caught, so it is
/// answered in run order. The preload says which invocation made the request, because a Python
/// copy asks from a thread the SDK's own caller does not reach.
fn outside_stub(app: &Arc<App>, slot: &SessionSlot) -> RegisterFunction {
    let (app, slot) = (app.clone(), slot.clone());
    RegisterFunction::new_async(move |payload: Value| {
        let (app, slot) = (app.clone(), slot.clone());
        async move {
            let (function_id, input, worker) = outside::stub_request(&payload)?;
            let called_by = outside::called_by(&payload).unwrap_or_else(CalledBy::current);
            replay::stub_call(app, slot, function_id, input, Some(worker), called_by).await
        }
    })
    .description("Rewind's answer for a request the copy made around iii")
    // Not marked internal: the engine's list leaves internal functions out, and Rewind waits for this one there.
    .metadata(json!({ "rewind": { "outside": true } }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(function_id: &str, worker: &str) -> FunctionRow {
        FunctionRow {
            function_id: function_id.into(),
            namespace: "default".into(),
            worker: worker.into(),
            effects: Vec::new(),
            declares_effects: true,
            internal: false,
            takes_key: false,
        }
    }

    #[test]
    fn each_copy_runs_its_own_functions_passes_on_other_copies_and_stubs_the_rest() {
        let copied = vec![
            ("agent".to_string(), namespaces::copied("rewind-f3", "agent", 0)),
            ("tools".to_string(), namespaces::copied("rewind-f3", "tools", 1)),
        ];
        assert_eq!(copied[0].1, "rewind-f3");
        assert_eq!(copied[1].1, "rewind-f3-tools");
        let in_tools = || Handler::Copied { namespace: "rewind-f3-tools".into() };
        assert_eq!(handler_for(&row("agent::run", "agent"), "agent", &copied), Handler::Own);
        assert_eq!(handler_for(&row("email::send", "tools"), "agent", &copied), in_tools());
        assert_eq!(handler_for(&row("model::complete", "model"), "agent", &copied), Handler::Stub);
        assert_eq!(handler_for(&row("email::send", "tools"), "tools", &copied), Handler::Own);
        assert_eq!(
            handler_for(&row("agent::run", "agent"), "tools", &copied),
            Handler::Copied { namespace: "rewind-f3".into() }
        );
        assert_eq!(handler_for(&row("email::send", "tools"), "agent", &copied[..1]), Handler::Stub);
    }
}
