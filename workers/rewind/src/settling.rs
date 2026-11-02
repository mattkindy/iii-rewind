//! Waits to send a run's `run` event until its calls have arrived. In-process calls are
//! reported in batches after their parent, so the event goes out once no call for the run has
//! come for `QUIET`, and never later than `LONGEST` after the run itself arrived.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::{app::App, runs::is_stopped};

const QUIET: Duration = Duration::from_millis(300);
const LONGEST: Duration = Duration::from_secs(2);
const LOOK_EVERY: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy)]
struct Waiting {
    arrived: Instant,
    last_call: Instant,
}

impl Waiting {
    fn due(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last_call) >= QUIET || now.saturating_duration_since(self.arrived) >= LONGEST
    }
}

#[derive(Default)]
pub struct Settling {
    runs: Mutex<HashMap<String, Waiting>>,
}

impl Settling {
    pub fn run_arrived(&self, run_id: &str, at: Instant) {
        self.runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(run_id.to_string(), Waiting { arrived: at, last_call: at });
    }

    /// Whether the run's event is still waiting, and if it is, the call pushes it back.
    pub fn call_arrived(&self, run_id: &str, at: Instant) -> bool {
        let mut runs = self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(waiting) = runs.get_mut(run_id) else {
            return false;
        };

        waiting.last_call = waiting.last_call.max(at);
        true
    }

    /// The runs whose events are due at `now`, which stop waiting.
    pub fn take_due(&self, now: Instant) -> Vec<String> {
        let mut runs = self.runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let due: Vec<String> = runs.iter().filter(|(_, waiting)| waiting.due(now)).map(|(id, _)| id.clone()).collect();
        for run_id in &due {
            runs.remove(run_id);
        }

        due
    }
}

fn send(app: &App, run_id: &str) {
    app.changes.emit("run", run_id);
    let stopped = app
        .run(run_id)
        .is_ok_and(|(run, steps)| is_stopped(&run, &steps, &app.known_functions()));
    if stopped {
        app.changes.emit("lost", run_id);
    }
}

pub fn start(app: &Arc<App>) {
    let app = app.clone();
    app.rt.clone().spawn(async move {
        loop {
            tokio::time::sleep(LOOK_EVERY).await;
            for run_id in app.settling.take_due(Instant::now()) {
                send(&app, &run_id);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(count: u64) -> Duration {
        Duration::from_millis(count)
    }

    #[test]
    fn a_run_is_sent_once_its_calls_have_been_quiet_for_300_ms() {
        let settling = Settling::default();
        let start = Instant::now();
        settling.run_arrived("run-1", start);
        assert!(settling.call_arrived("run-1", start + ms(100)));
        assert!(settling.take_due(start + ms(350)).is_empty());
        assert_eq!(settling.take_due(start + ms(400)), ["run-1"]);
        assert!(!settling.call_arrived("run-1", start + ms(450)));
    }

    #[test]
    fn a_run_whose_calls_keep_coming_is_sent_two_seconds_after_it_arrived() {
        let settling = Settling::default();
        let start = Instant::now();
        settling.run_arrived("run-1", start);
        for step in 1..=19 {
            settling.call_arrived("run-1", start + ms(step * 100));
            assert!(settling.take_due(start + ms(step * 100 + 50)).is_empty(), "sent early at step {step}");
        }

        assert_eq!(settling.take_due(start + ms(2_000)), ["run-1"]);
    }

    #[test]
    fn a_call_for_a_run_that_is_not_waiting_changes_nothing() {
        let settling = Settling::default();
        assert!(!settling.call_arrived("run-9", Instant::now()));
        assert!(settling.take_due(Instant::now() + ms(5_000)).is_empty());
    }
}
