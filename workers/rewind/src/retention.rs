//! Drops calls that started more than `REWIND_KEEP_DAYS` ago or before the newest
//! `REWIND_KEEP_RUNS` runs, with the worker changes from then and the forks of the runs that
//! went, so the store does not grow for as long as Rewind runs.

use std::{sync::Arc, time::Duration};

use crate::{app::App, error::Result, time::now_ms};

// Old data is never urgent to drop, and each pass reads every call once.
const PRUNE_EVERY: Duration = Duration::from_secs(600);

/// The start time before which calls are too old to keep. A zero age keeps calls however old.
fn age_cutoff_ms(now_ms: u64, keep_for: Duration) -> u64 {
    if keep_for.is_zero() {
        return 0;
    }

    now_ms.saturating_sub(keep_for.as_millis() as u64)
}

/// The start time before which nothing is kept: the later of the age limit and the start of the
/// oldest run kept.
pub fn cutoff_ms(now_ms: u64, keep_for: Duration, oldest_run_kept_ms: Option<u64>) -> u64 {
    age_cutoff_ms(now_ms, keep_for).max(oldest_run_kept_ms.unwrap_or(0))
}

fn prune(app: &App) -> Result<()> {
    let oldest_kept = app.store.start_of_nth_newest_run(&app.config.entry, app.config.keep_runs)?;
    let cutoff = cutoff_ms(now_ms(), app.config.keep_for, oldest_kept);
    if cutoff == 0 {
        return Ok(());
    }

    let deleted = app.store.delete_before(cutoff)?;
    if deleted.events + deleted.forks + deleted.worker_changes > 0 {
        eprintln!(
            "rewind: dropped {} calls, {} forks and {} worker changes from before {cutoff}",
            deleted.events, deleted.forks, deleted.worker_changes
        );
    }

    Ok(())
}

pub fn start(app: &Arc<App>) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            if let Err(error) = prune(&app) {
                eprintln!("rewind: could not drop old recordings: {error}");
            }

            std::thread::sleep(PRUNE_EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    #[test]
    fn the_cutoff_is_the_later_of_the_age_limit_and_the_oldest_run_kept() {
        let now = 30 * DAY_MS;
        let week = Duration::from_millis(7 * DAY_MS);
        assert_eq!(cutoff_ms(now, week, None), 23 * DAY_MS);
        assert_eq!(cutoff_ms(now, week, Some(25 * DAY_MS)), 25 * DAY_MS);
        assert_eq!(cutoff_ms(now, week, Some(DAY_MS)), 23 * DAY_MS);
    }

    #[test]
    fn zero_days_and_no_run_limit_keep_everything() {
        assert_eq!(cutoff_ms(30 * DAY_MS, Duration::ZERO, None), 0);
        assert_eq!(cutoff_ms(30 * DAY_MS, Duration::ZERO, Some(5)), 5);
        assert_eq!(cutoff_ms(DAY_MS, Duration::from_millis(7 * DAY_MS), None), 0);
    }
}
