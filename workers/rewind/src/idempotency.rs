//! The idempotency key a live call goes out with when its function's metadata says it takes one. It
//! is the recorded run, the call's place in it and a hash of its input, so every recovery or fork of
//! the run that sends the same call sends the same key, and a send with another input still goes out.

use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::{
    catalog::Catalog,
    json::{canonical, normalize_input},
    types::At,
};

// The prefix keeps these apart from the journal's keys, whose step numbers leave out the requests
// around iii that Rewind counts, so the same number can be another call.
pub fn key(run_id: &str, at: &At, input: &Value) -> String {
    format!("rewind:{run_id}:{at}:{}", input_hash(input))
}

/// The same for two inputs a replay counts as the same call.
fn input_hash(input: &Value) -> String {
    let digest = Sha1::digest(canonical(&normalize_input(input)).as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The metadata a live call to `function_id` at `at` in `run_id` goes out with: its key, in the
/// field the journal's durable steps use, when the function takes one.
pub fn metadata(catalog: &Catalog, run_id: &str, at: &At, function_id: &str, input: &Value) -> Option<Value> {
    catalog
        .takes_key(function_id)
        .then(|| json!({ "idempotency_key": key(run_id, at, input) }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::catalog::FunctionRow;

    /// `email::send` as the tools worker runs it: a key it has seen sends nothing, and a call
    /// without a key always sends.
    #[derive(Default)]
    struct Provider {
        seen: HashSet<String>,
        sent: usize,
    }

    impl Provider {
        fn receive(&mut self, metadata: Option<Value>) {
            let key = metadata.as_ref().and_then(|metadata| metadata["idempotency_key"].as_str());
            if let Some(key) = key
                && !self.seen.insert(key.to_string())
            {
                return;
            }

            self.sent += 1;
        }
    }

    fn row(function_id: &str, metadata: Value) -> FunctionRow {
        FunctionRow::from_listing(&json!({ "function_id": function_id, "worker_name": "tools", "metadata": metadata })).unwrap()
    }

    fn tools() -> Catalog {
        let catalog = Catalog::default();
        catalog.replace(&[
            row("email::send", json!({ "effects": ["irreversible"], "idempotency_key": true })),
            row("calendar::find-slot", json!({ "effects": ["read-only"] })),
        ]);
        catalog
    }

    fn invite() -> Value {
        json!({ "to": "sofia@example.com", "subject": "60 minutes, Tuesday", "start": "2026-11-17T15:00:00-06:00" })
    }

    #[test]
    fn a_resend_made_twice_sends_once() {
        let mut provider = Provider::default();
        for _ in 0..2 {
            provider.receive(metadata(&tools(), "run-1", &At::top(5), "email::send", &invite()));
        }

        assert_eq!(provider.sent, 1);
    }

    #[test]
    fn a_send_with_another_input_at_the_same_place_still_goes_out() {
        let mut provider = Provider::default();
        let moved = json!({ "to": "sofia@example.com", "subject": "60 minutes, Tuesday", "start": "2026-11-17T16:00:00-06:00" });
        provider.receive(metadata(&tools(), "run-1", &At::top(5), "email::send", &invite()));
        provider.receive(metadata(&tools(), "run-1", &At::top(5), "email::send", &moved));
        assert_eq!(provider.sent, 2);
    }

    #[test]
    fn the_key_is_the_same_for_the_same_call_in_any_recovery_or_fork_of_the_run() {
        let routed = json!({ "start": "2026-11-17T15:00:00-06:00", "_caller_worker_id": "w-9", "to": "sofia@example.com", "subject": "60 minutes, Tuesday" });
        let first = key("run-1", &At::top(5), &invite());
        assert_eq!(first, key("run-1", &At::top(5), &routed));
        assert!(first.starts_with("rewind:run-1:5:"), "{first}");
        assert_eq!(key("run-1", &At(vec![5, 0]), &invite()), key("run-1", &At(vec![5, 0]), &invite()));
    }

    #[test]
    fn another_run_or_place_gets_another_key() {
        let first = key("run-1", &At::top(5), &invite());
        for other in [key("run-2", &At::top(5), &invite()), key("run-1", &At::top(6), &invite()), key("run-1", &At(vec![5, 0]), &invite())] {
            assert_ne!(first, other);
        }
    }

    #[test]
    fn only_a_function_that_takes_a_key_gets_one() {
        let sent = metadata(&tools(), "run-1", &At::top(5), "email::send", &invite()).unwrap();
        assert_eq!(sent, json!({ "idempotency_key": key("run-1", &At::top(5), &invite()) }));
        assert_eq!(metadata(&tools(), "run-1", &At::top(3), "calendar::find-slot", &json!({})), None);
        assert_eq!(metadata(&tools(), "run-1", &At::top(3), "billing::charge", &json!({})), None);
    }
}
