//! Runs a dead worker cut short, and recovering them. A recovery is a fork that uses the recorded
//! answers for the calls that finished and runs pure, read-only and external calls live. Every other
//! call waits for a person, and so does the call the worker died in unless it only reads.

use std::{collections::BTreeMap, sync::Arc};

use serde::Serialize;

use crate::{
    app::App,
    error::Result,
    forks::{self, ForkRecord, ListedFork, NewFork},
    runs::{RunSummary, lost_call, summarize},
    types::Mode,
};

// Lost runs come from recent bursts, so the scan stops at the newest runs.
const LOST_SCAN_LIMIT: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct LostRun {
    #[serde(flatten)]
    pub run: RunSummary,
    /// Where the lost call would have been in the run's calls.
    pub lost_at: u32,
    /// The worker died while it ran the lost call. False when the call failed with
    /// `function_not_found` because the worker was already gone, so it never ran.
    pub mid_call: bool,
    pub recovery: Option<ListedFork>,
}

fn recovery_of(app: &App, run_id: &str) -> Result<Option<ForkRecord>> {
    Ok(app
        .store
        .forks_of_run(run_id)?
        .into_iter()
        .find(|fork| fork.mode == Mode::Recover))
}

pub fn lost(app: &App) -> Result<Vec<LostRun>> {
    let known = app.known_functions();
    let mut found = Vec::new();
    for run in app.store.runs(&app.config.entry, LOST_SCAN_LIMIT)? {
        let steps = app.steps_of(&run)?;
        let Some(lost) = lost_call(&run, &steps, &known) else {
            continue;
        };

        found.push(LostRun {
            run: summarize(&run, &steps, &known),
            lost_at: lost.seq,
            mid_call: lost.mid_call,
            recovery: recovery_of(app, &run.invocation_id)?.map(|fork| fork.listed()),
        });
    }

    Ok(found)
}

/// Starts the run's recovery fork, or returns the one already there as it is.
pub async fn recover(app: &Arc<App>, run_id: &str, auto: bool, stops: Vec<String>, copy: Vec<String>) -> Result<ForkRecord> {
    app.run(run_id)?;
    let _guard = app.lock(&format!("recover {run_id}")).await;
    if let Some(existing) = recovery_of(app, run_id)? {
        return Ok(existing);
    }

    forks::start(
        app,
        NewFork {
            run_id: run_id.to_string(),
            parent: None,
            edit_at: None,
            answers: BTreeMap::new(),
            mode: Mode::Recover,
            auto_read: false,
            auto,
            stops,
            copy,
        },
    )
    .await
}
