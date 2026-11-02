//! What every part of Rewind shares: the settings, the store, the connection to
//! `default`, the function catalog, the code under test, and the namespaces forks run in.

use std::sync::Arc;

use iii_sdk::{IIIClient, InitOptions, WorkerIdentityMode, register_worker, runtime::WorkerMetadata};
use tokio::runtime::Handle;

use crate::{
    catalog::Catalog,
    changes::Changes,
    code::{TargetCode, Versions},
    config::Config,
    copies::{ForkSpace, Spaces},
    error::{Error, Result},
    locks::{KeyGuard, KeyedLocks},
    outside::Kind,
    pool::Pool,
    recording::Recorder,
    runs::{is_root, pick_calls, recorded_steps},
    settling::Settling,
    sources::{self, WorkerSource},
    spans::Spans,
    store::{Event, Store},
    forks::ForkRecord,
    types::Step,
    workers::Workers,
};

/// The worker name of Rewind's connection to `default`. Calls it makes are left out of the recording.
pub const REWIND_WORKER: &str = "rewind";

pub struct App {
    pub config: Config,
    pub iii: IIIClient,
    pub store: Store,
    pub spans: Spans,
    /// Rewind's own multi-threaded runtime. Handlers move their work here, off
    /// the SDK's single-threaded connection runtime.
    pub rt: Handle,
    pub catalog: Catalog,
    pub recorder: Recorder,
    pub spaces: Spaces,
    /// Spare fork namespaces, each with a copy of the worker under test already started.
    pub pool: Pool<ForkSpace>,
    pub changes: Arc<Changes>,
    pub target_code: Arc<TargetCode>,
    /// The code version of each folder copies start from, as read lately.
    pub code_versions: Arc<Versions>,
    pub workers: Workers,
    pub settling: Settling,
    locks: KeyedLocks,
}

/// One connection per namespace. `Explicit` keeps `III_WORKER_NAME` and `III_NAMESPACE` from
/// renaming every connection in the process to the same identity.
pub fn connect(url: &str, name: &str, namespace: Option<&str>) -> IIIClient {
    register_worker(
        url,
        InitOptions {
            metadata: Some(WorkerMetadata {
                name: name.to_string(),
                description: Some("Rewind: records, replays and forks calls between functions".to_string()),
                ..Default::default()
            }),
            namespace: namespace.map(str::to_string),
            identity: WorkerIdentityMode::Explicit,
            ..Default::default()
        },
    )
}

impl App {
    pub fn new(config: Config, iii: IIIClient, store: Store, spans: Spans, rt: Handle) -> Self {
        let code_versions = Arc::new(Versions::default());
        Self {
            target_code: Arc::new(TargetCode::new(&config.target_dir, code_versions.clone())),
            code_versions,
            pool: Pool::new(config.pool_size),
            config,
            iii,
            store,
            spans,
            rt,
            catalog: Catalog::default(),
            recorder: Recorder::default(),
            spaces: Spaces::default(),
            changes: Arc::new(Changes::default()),
            workers: Workers::default(),
            settling: Settling::default(),
            locks: KeyedLocks::default(),
        }
    }

    /// Serializes work on one key, such as a fork id, across handlers.
    pub async fn lock(&self, key: &str) -> KeyGuard {
        self.locks.lock(key).await
    }

    /// A run whose root is an iii call, which a fork replays against stubs.
    pub fn run(&self, run_id: &str) -> Result<(Event, Vec<Step>)> {
        let (run, steps) = self.root(run_id)?;
        if Kind::parse(run.kind.as_deref()) != Kind::Iii {
            return Err(Error::NotFound(format!("no recorded run {run_id} of an iii function")));
        }

        Ok((run, steps))
    }

    /// Any root: a call of the entry function, a call nothing recorded made, or a request that
    /// arrived at a worker's own HTTP server.
    pub fn root(&self, run_id: &str) -> Result<(Event, Vec<Step>)> {
        let run = self
            .store
            .event(run_id)?
            .filter(|event| is_root(event, &self.config.entry, &self.catalog))
            .ok_or_else(|| Error::NotFound(format!("no recorded run {run_id}")))?;
        let steps = self.steps_of(&run)?;
        Ok((run, steps))
    }

    /// The worker that owns `function_id` in `default`, from the latest listing.
    pub fn worker_of(&self, function_id: &str) -> Result<String> {
        self.catalog
            .get(function_id)
            .map(|row| row.worker)
            .filter(|worker| !worker.is_empty())
            .ok_or_else(|| Error::NotFound(format!("no worker in default has {function_id}, so there is nothing to copy")))
    }

    /// Where a worker's code is and how to start it. The entry's worker is the code under test,
    /// so it keeps `REWIND_TARGET_DIR` and `REWIND_TARGET_START`.
    pub fn worker_source(&self, worker: &str) -> Result<WorkerSource> {
        let entry_worker = self.catalog.get(&self.config.entry).map(|row| row.worker);
        if entry_worker.as_deref() == Some(worker) {
            return Ok(WorkerSource {
                names: vec![worker.to_string()],
                dir: self.config.target_dir.clone(),
                start: self.config.target_start.clone(),
            });
        }

        sources::find(sources::read(&self.config.compose_file, &self.config.project_dir)?, worker)
    }

    /// The workers a replay of a `root` call copies: the root's own first, then each asked for.
    pub fn copies_for(&self, root: &str, asked: &[String]) -> Result<Vec<String>> {
        let mut workers = vec![self.worker_of(root)?];
        for worker in asked {
            if !workers.contains(worker) {
                self.worker_source(worker)?;
                workers.push(worker.clone());
            }
        }

        Ok(workers)
    }

    pub fn steps_of(&self, run: &Event) -> Result<Vec<Step>> {
        let children = self.store.children(&run.invocation_id)?;
        Ok(recorded_steps(
            &pick_calls(&run.invocation_id, &children),
            &self.catalog,
        ))
    }

    /// Whether Rewind has seen a function in `default`. A dead worker's functions drop out of the
    /// listing until it is back, so what Rewind recorded counts as well.
    pub fn known_functions(&self) -> impl Fn(&str) -> bool + '_ {
        |function_id| self.catalog.get(function_id).is_some() || self.store.has_recorded(function_id).unwrap_or(false)
    }

    pub fn fork_record(&self, fork_id: &str) -> Result<ForkRecord> {
        self.store
            .fork(fork_id)?
            .ok_or_else(|| Error::NotFound(format!("no fork {fork_id}")))
    }
}
