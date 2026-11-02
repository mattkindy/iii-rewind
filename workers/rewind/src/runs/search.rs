//! What the runs list keeps: the filter a person picks, and what they typed in the search box.

use std::collections::HashSet;

use serde::Deserialize;

use super::is_stopped;
use crate::{
    store::{Event, Status},
    types::Step,
};

/// Which runs `rewind::runs` lists, read from its `filter`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub enum RunFilter {
    #[default]
    All,
    Failed,
    Stopped,
}

impl TryFrom<String> for RunFilter {
    type Error = &'static str;

    fn try_from(text: String) -> std::result::Result<Self, Self::Error> {
        match text.as_str() {
            "all" => Ok(RunFilter::All),
            "failed" => Ok(RunFilter::Failed),
            "stopped" => Ok(RunFilter::Stopped),
            _ => Err("filter must be all, failed or stopped"),
        }
    }
}

impl RunFilter {
    pub fn keeps(self, run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> bool {
        match self {
            RunFilter::All => true,
            RunFilter::Failed => is_failed(run, steps, known),
            RunFilter::Stopped => is_stopped(run, steps, known),
        }
    }
}

/// A run failed when it or any of its calls ended in an error, or a dead worker cut it short.
fn is_failed(run: &Event, steps: &[Step], known: &dyn Fn(&str) -> bool) -> bool {
    run.status == Status::Error || steps.iter().any(|step| step.call.answer.is_error()) || is_stopped(run, steps, known)
}

/// What someone typed in the search box. An id copied from the traces view is
/// often one of the run's calls, so call ids match by prefix as well as the run's own.
pub struct RunQuery {
    text: String,
    /// The runs that made a call whose invocation id starts with the text.
    by_call: HashSet<String>,
}

impl RunQuery {
    pub fn new(text: &str, by_call: HashSet<String>) -> Self {
        Self {
            text: text.trim().to_lowercase(),
            by_call,
        }
    }

    pub fn matches(&self, run: &Event) -> bool {
        if self.text.is_empty()
            || run.invocation_id.to_lowercase().starts_with(&self.text)
            || self.by_call.contains(&run.invocation_id)
        {
            return true;
        }

        [&run.input, &run.output, &run.error]
            .into_iter()
            .flatten()
            .any(|value| value.to_string().to_lowercase().contains(&self.text))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runs::testing::run;

    #[test]
    fn a_query_matches_the_run_id_prefix_or_any_payload_text() {
        let booked = run(json!({ "status": "booked", "reply": "Booked with Dana" }));
        let query = |text: &str| RunQuery::new(text, HashSet::new());
        assert!(query("RUN-").matches(&booked));
        assert!(query(" dana ").matches(&booked));
        assert!(!query("priya").matches(&booked));
    }

    #[test]
    fn a_query_matches_a_run_found_by_one_of_its_calls() {
        let booked = run(json!({ "status": "booked" }));
        let by_call = RunQuery::new("9c41", HashSet::from(["run-1".to_string()]));
        assert!(by_call.matches(&booked));
        assert!(!RunQuery::new("9c41", HashSet::from(["run-2".to_string()])).matches(&booked));
    }
}
