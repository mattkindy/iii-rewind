//! Which fork namespaces are open. A paused fork's namespace is parked, so its next answer reruns
//! without starting a copy, and parked namespaces close once idle for `REWIND_PAUSED_IDLE_SECS` or
//! beyond the newest `REWIND_PAUSED_OPEN`. A finished fork's copies stop without its caller waiting.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use tokio::task::JoinHandle;

use super::space::ForkSpace;
use crate::{app::App, error::Result, locks::KeyedLocks};

const IDLE_CHECK_EVERY: Duration = Duration::from_secs(5);

struct Opened {
    space: Arc<ForkSpace>,
    /// When a paused fork last left the namespace waiting for its next answer, or `None` while a
    /// run uses it and for namespaces that are not a paused fork's.
    parked_at: Option<Instant>,
}

#[derive(Default)]
pub struct Spaces {
    /// One lock per namespace, so a fork never waits for another fork's copies to start or stop.
    locks: KeyedLocks,
    open: Mutex<HashMap<String, Opened>>,
    /// Namespaces whose copies are still stopping after `close_later`.
    closing: Mutex<HashMap<String, JoinHandle<()>>>,
}

fn guarded<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Paused namespaces to close, given when each was parked: each one idle for `idle_after` or
/// longer, and the least recently parked beyond the newest `keep_open`.
fn to_close(parked: &[(String, Instant)], now: Instant, idle_after: Duration, keep_open: usize) -> Vec<String> {
    let mut newest_first = parked.to_vec();
    newest_first.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
    newest_first
        .into_iter()
        .enumerate()
        .filter(|(rank, (_, at))| *rank >= keep_open || now.saturating_duration_since(*at) >= idle_after)
        .map(|(_, (namespace, _))| namespace)
        .collect()
}

fn parked(open: &HashMap<String, Opened>) -> Vec<(String, Instant)> {
    open.iter()
        .filter_map(|(namespace, opened)| opened.parked_at.map(|at| (namespace.clone(), at)))
        .collect()
}

impl Spaces {
    /// The fork's namespaces, opened with copies of `workers` the first time. The root's worker comes first.
    pub async fn open(&self, app: &App, namespace: &str, workers: &[String]) -> Result<Arc<ForkSpace>> {
        let _namespace = self.locks.lock(namespace).await;
        if let Some(space) = self.take_up(namespace) {
            return Ok(space);
        }

        // A new copy would register its functions next to the old one's while the old one stops.
        self.finish_closing(namespace).await;
        let space = Arc::new(ForkSpace::open(app, namespace, workers).await?);
        self.insert(namespace, space.clone());
        Ok(space)
    }

    /// The namespace's space if it is open. A run is about to use it, so it is no longer parked.
    fn take_up(&self, namespace: &str) -> Option<Arc<ForkSpace>> {
        let mut open = guarded(&self.open);
        let opened = open.get_mut(namespace)?;
        opened.parked_at = None;
        Some(opened.space.clone())
    }

    fn insert(&self, namespace: &str, space: Arc<ForkSpace>) {
        guarded(&self.open).insert(namespace.to_string(), Opened { space, parked_at: None });
    }

    fn remove(&self, namespace: &str) -> Option<Arc<ForkSpace>> {
        guarded(&self.open).remove(namespace).map(|opened| opened.space)
    }

    /// A spare a fork took from the pool, so the fork's first run finds its namespace open.
    pub(super) async fn adopt(&self, space: ForkSpace) {
        let namespace = space.namespace.clone();
        let _namespace = self.locks.lock(&namespace).await;
        self.insert(&namespace, Arc::new(space));
    }

    pub async fn close(&self, namespace: &str) {
        let _namespace = self.locks.lock(namespace).await;
        if let Some(space) = self.remove(namespace) {
            space.close().await;
        }
    }

    /// Closes the namespace without waiting. Stopping a copy gives it up to 3 s to send its spans,
    /// and a fork that has finished shouldn't make its caller wait for that.
    pub async fn close_later(&self, namespace: &str) {
        let _namespace = self.locks.lock(namespace).await;
        self.stop_later(namespace).await;
    }

    /// Whoever calls this has the namespace's lock.
    async fn stop_later(&self, namespace: &str) {
        let Some(space) = self.remove(namespace) else {
            return;
        };

        let stopping = tokio::spawn(async move { space.close().await });
        let earlier = {
            let mut closing = guarded(&self.closing);
            closing.retain(|_, task| !task.is_finished());
            closing.insert(namespace.to_string(), stopping)
        };
        if let Some(earlier) = earlier {
            let _ = earlier.await;
        }
    }

    async fn finish_closing(&self, namespace: &str) {
        let stopping = guarded(&self.closing).remove(namespace);
        if let Some(stopping) = stopping {
            let _ = stopping.await;
        }
    }

    /// Leaves a paused fork's namespace open for its next answer, and returns the paused
    /// namespaces beyond the newest `keep_open`.
    fn park(&self, namespace: &str, keep_open: usize) -> Vec<String> {
        let mut open = guarded(&self.open);
        if let Some(opened) = open.get_mut(namespace) {
            opened.parked_at = Some(Instant::now());
        }

        to_close(&parked(&open), Instant::now(), Duration::MAX, keep_open)
    }

    fn idle(&self, idle_after: Duration, keep_open: usize) -> Vec<String> {
        to_close(&parked(&guarded(&self.open)), Instant::now(), idle_after, keep_open)
    }

    /// Closes a paused fork's namespace, unless a rerun has taken it up since, and says whether it did.
    async fn close_parked(&self, namespace: &str) -> bool {
        let _namespace = self.locks.lock(namespace).await;
        let still_parked = guarded(&self.open)
            .get(namespace)
            .is_some_and(|opened| opened.parked_at.is_some());
        if !still_parked {
            return false;
        }

        self.stop_later(namespace).await;
        true
    }

    pub async fn close_all(&self) {
        let spaces: Vec<Arc<ForkSpace>> = guarded(&self.open).drain().map(|(_, opened)| opened.space).collect();
        for space in spaces {
            space.close().await;
        }

        let stopping: Vec<_> = guarded(&self.closing).drain().map(|(_, task)| task).collect();
        for task in stopping {
            let _ = task.await;
        }
    }
}

/// Keeps a paused fork's copies running for its next answer, and closes the copies of the least
/// recently paused forks beyond `REWIND_PAUSED_OPEN` without making the caller wait.
pub fn park(app: &Arc<App>, namespace: &str) {
    let over = app.spaces.park(namespace, app.config.paused_open);
    if over.is_empty() {
        return;
    }

    let app = app.clone();
    app.rt.clone().spawn(async move { close_paused(&app, over).await });
}

async fn close_paused(app: &App, namespaces: Vec<String>) {
    for namespace in namespaces {
        if app.spaces.close_parked(&namespace).await {
            eprintln!("rewind: closed the copies of the paused fork in {namespace}; its next answer starts them again");
        }
    }
}

/// Closes the copies of paused forks nobody has answered for `REWIND_PAUSED_IDLE_SECS`.
pub fn start_idle_close(app: &Arc<App>) {
    let app = app.clone();
    app.rt.clone().spawn(async move {
        loop {
            tokio::time::sleep(IDLE_CHECK_EVERY).await;
            let idle = app.spaces.idle(app.config.paused_idle, app.config.paused_open);
            close_paused(&app, idle).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parked_ago(now: Instant, seconds: &[(&str, u64)]) -> Vec<(String, Instant)> {
        seconds
            .iter()
            .map(|(namespace, ago)| (namespace.to_string(), now - Duration::from_secs(*ago)))
            .collect()
    }

    fn sorted(mut namespaces: Vec<String>) -> Vec<String> {
        namespaces.sort();
        namespaces
    }

    #[test]
    fn a_paused_fork_left_idle_long_enough_closes_and_a_newer_one_stays() {
        let now = Instant::now();
        let parked = parked_ago(now, &[("rewind-f1", 400), ("rewind-f2", 299), ("rewind-f3", 10)]);
        assert_eq!(to_close(&parked, now, Duration::from_secs(300), 8), ["rewind-f1"]);
        assert!(to_close(&parked, now, Duration::from_secs(500), 8).is_empty());
    }

    #[test]
    fn past_the_cap_the_least_recently_paused_forks_close_first() {
        let now = Instant::now();
        let parked = parked_ago(now, &[("rewind-f1", 50), ("rewind-f2", 40), ("rewind-f3", 30), ("rewind-f4", 20), ("rewind-f5", 10)]);
        assert_eq!(sorted(to_close(&parked, now, Duration::MAX, 3)), ["rewind-f1", "rewind-f2"]);
        assert!(to_close(&parked, now, Duration::MAX, 5).is_empty());
        assert_eq!(to_close(&parked, now, Duration::MAX, 0).len(), 5);
        assert_eq!(sorted(to_close(&parked, now, Duration::from_secs(25), 4)), ["rewind-f1", "rewind-f2", "rewind-f3"]);
    }

    #[test]
    fn nothing_paused_closes_nothing() {
        assert!(to_close(&[], Instant::now(), Duration::ZERO, 0).is_empty());
    }
}
