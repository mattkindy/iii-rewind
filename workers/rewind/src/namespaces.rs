//! The names of the namespaces Rewind opens beside `default`. A fork, a check and a replayed
//! request each get one from a number Rewind counts up, and every worker a fork copies besides
//! its root's gets one more, named after the fork's.

pub fn fork(number: u64) -> String {
    format!("rewind-f{number}")
}

pub fn check(number: u64) -> String {
    format!("rewind-c{number}")
}

/// A request sent again to a copy of the worker whose HTTP server received it.
pub fn inbound(number: u64) -> String {
    format!("rewind-h{number}")
}

/// The namespace a copied worker runs in. The root's worker, the first, runs in the fork's own.
pub fn copied(fork_namespace: &str, worker: &str, index: usize) -> String {
    if index == 0 {
        return fork_namespace.to_string();
    }

    let safe: String = worker
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("{fork_namespace}-{safe}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_kind_of_namespace_has_its_own_letter_and_a_copied_worker_follows_its_fork() {
        assert_eq!((fork(3), check(3), inbound(3)), ("rewind-f3".into(), "rewind-c3".into(), "rewind-h3".into()));
        assert_eq!(copied("rewind-f3", "agent", 0), "rewind-f3");
        assert_eq!(copied("rewind-f3", "My_Tools", 1), "rewind-f3-my-tools");
    }
}
