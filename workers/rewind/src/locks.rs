//! Locks taken by key, such as a fork id or a namespace. A key's lock stays in the shared map
//! only while someone holds it or waits for it, so the map does not keep every key ever used.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::OwnedMutexGuard;

type Lock = Arc<tokio::sync::Mutex<()>>;
type Map = Arc<Mutex<HashMap<String, Lock>>>;

#[derive(Default)]
pub struct KeyedLocks {
    map: Map,
}

/// Holds one key's lock. Dropping it lets the next waiter in, or forgets the key when nobody waits.
pub struct KeyGuard {
    map: Map,
    key: String,
    held: OwnedMutexGuard<()>,
}

fn entries(map: &Map) -> std::sync::MutexGuard<'_, HashMap<String, Lock>> {
    map.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl KeyedLocks {
    pub async fn lock(&self, key: &str) -> KeyGuard {
        let lock = {
            let mut map = entries(&self.map);
            // A waiter that gave up leaves its key behind with nobody holding it.
            map.retain(|_, lock| Arc::strong_count(lock) > 1);
            map.entry(key.to_string()).or_default().clone()
        };
        KeyGuard {
            map: self.map.clone(),
            key: key.to_string(),
            held: lock.lock_owned().await,
        }
    }

    #[cfg(test)]
    pub fn keys(&self) -> usize {
        entries(&self.map).len()
    }
}

impl Drop for KeyGuard {
    fn drop(&mut self) {
        let mut map = entries(&self.map);
        // The map and this guard each have the lock. Anyone else with it is waiting for it.
        let unused = map
            .get(&self.key)
            .is_some_and(|lock| Arc::ptr_eq(lock, OwnedMutexGuard::mutex(&self.held)) && Arc::strong_count(lock) == 2);
        if unused {
            map.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::atomic::{AtomicUsize, Ordering}, time::Duration};

    use super::*;

    #[tokio::test]
    async fn a_key_is_forgotten_once_nobody_holds_it() {
        let locks = KeyedLocks::default();
        for fork in 0..100 {
            let _guard = locks.lock(&format!("f{fork}")).await;
            assert_eq!(locks.keys(), 1);
        }

        assert_eq!(locks.keys(), 0);
    }

    #[tokio::test]
    async fn one_key_is_held_by_one_task_at_a_time_and_kept_while_others_wait() {
        let locks = Arc::new(KeyedLocks::default());
        let inside = Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let (locks, inside) = (locks.clone(), inside.clone());
                tokio::spawn(async move {
                    let _guard = locks.lock("recover run-1").await;
                    assert_eq!(inside.fetch_add(1, Ordering::SeqCst), 0);
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    inside.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }

        assert_eq!(locks.keys(), 0);
    }

    #[tokio::test]
    async fn a_waiter_that_gives_up_leaves_nothing_behind() {
        let locks = KeyedLocks::default();
        let held = locks.lock("f1").await;
        let mut waiting = Box::pin(locks.lock("f1"));
        assert!(tokio::time::timeout(Duration::from_millis(5), &mut waiting).await.is_err());
        drop(held);
        drop(waiting);
        let _other = locks.lock("f2").await;
        assert_eq!(locks.keys(), 1);
    }

    #[tokio::test]
    async fn different_keys_do_not_wait_on_each_other() {
        let locks = KeyedLocks::default();
        let _first = locks.lock("rewind-f1").await;
        let second = tokio::time::timeout(Duration::from_millis(50), locks.lock("rewind-f2")).await;
        assert!(second.is_ok());
    }
}
