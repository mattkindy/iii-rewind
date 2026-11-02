//! Spare fork namespaces, each with a fork number, Rewind's stubs and a started copy of the worker
//! under test, so a new fork does not wait for a copy to start. The pool knows nothing about iii:
//! `Prepare` says how to start, restart and close a spare.

use std::{
    collections::VecDeque,
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use tokio::{sync::Mutex, task::JoinHandle};

use crate::error::Error;

// Long enough that a worker that cannot start does not restart every spare each second.
const RETRY_AFTER: Duration = Duration::from_secs(10);

pub trait Prepare: Clone + Send + Sync + 'static {
    type Spare: Send + 'static;

    /// A fork number no other fork or spare has.
    fn reserve(&self) -> Result<u64, Error>;

    /// The version of the code on disk, or `None` when it could not be read.
    fn version(&self) -> Option<String>;

    fn prepare(&self, number: u64) -> impl Future<Output = Result<Self::Spare, Error>> + Send + 'static;

    /// Brings the spare's copy up to the code on disk. A spare that is already there is left alone.
    fn restart(&self, spare: Self::Spare) -> impl Future<Output = Result<Self::Spare, Error>> + Send + 'static;

    fn close(&self, spare: Self::Spare) -> impl Future<Output = ()> + Send + 'static;
}

enum State<T> {
    Starting(JoinHandle<Result<T, Error>>),
    Ready(T),
    Failed(Instant),
}

struct Entry<T> {
    number: u64,
    /// The code version the spare was last started or restarted for.
    version: Option<String>,
    state: State<T>,
}

pub enum Claim<T> {
    Spare { number: u64, spare: T },
    /// There was no spare to give. The fork opens its namespace itself, under this number.
    Cold { number: u64 },
}

pub struct Pool<T> {
    size: usize,
    retry_after: Duration,
    entries: Mutex<VecDeque<Entry<T>>>,
    closed: AtomicBool,
}

fn joined<T>(result: Result<Result<T, Error>, tokio::task::JoinError>) -> Result<T, Error> {
    result.map_err(|error| Error::Internal(format!("a spare's start was cancelled: {error}")))?
}

impl<T: Send + 'static> Pool<T> {
    pub fn new(size: usize) -> Self {
        Self::with_retry(size, RETRY_AFTER)
    }

    fn with_retry(size: usize, retry_after: Duration) -> Self {
        Self {
            size,
            retry_after,
            entries: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
        }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    /// The oldest spare, once it has started, and a new one starting in its place.
    pub async fn claim<P: Prepare<Spare = T>>(&self, prepare: &P) -> Result<Claim<T>, Error> {
        let taken = {
            let mut entries = self.entries.lock().await;
            self.top_up(&mut entries, prepare);
            let taken = entries.pop_front();
            self.top_up(&mut entries, prepare);
            taken
        };
        let Some(entry) = taken else {
            return Ok(Claim::Cold { number: prepare.reserve()? });
        };

        let number = entry.number;
        let spare = match entry.state {
            State::Ready(spare) => Ok(spare),
            State::Starting(task) => joined(task.await),
            State::Failed(_) => return Ok(Claim::Cold { number }),
        };
        match spare {
            Ok(spare) => Ok(Claim::Spare { number, spare }),
            Err(error) => {
                eprintln!("rewind: the spare for fork {number} did not start, so the fork starts its own copy: {error}");
                Ok(Claim::Cold { number })
            }
        }
    }

    /// Notes which spares have started, restarts each one whose code is out of date, tries failed
    /// ones again, and starts new spares until there are enough.
    pub async fn tend<P: Prepare<Spare = T>>(&self, prepare: &P) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }

        let version = prepare.version();
        let mut entries = self.entries.lock().await;
        for entry in entries.iter_mut() {
            settle(entry).await;
            let stale = version.is_some() && entry.version != version;
            let retry = matches!(entry.state, State::Failed(at) if at.elapsed() >= self.retry_after);
            if stale || retry {
                restart(entry, prepare, version.clone());
            }
        }

        self.top_up(&mut entries, prepare);
    }

    /// Stops every spare. Nothing new starts afterwards.
    pub async fn close_all<P: Prepare<Spare = T>>(&self, prepare: &P) {
        self.closed.store(true, Ordering::SeqCst);
        let entries: Vec<Entry<T>> = self.entries.lock().await.drain(..).collect();
        let mut closing = Vec::new();
        for entry in entries {
            match entry.state {
                // Dropping a spare that is still starting kills its copy.
                State::Starting(task) => task.abort(),
                State::Ready(spare) => closing.push(tokio::spawn(prepare.close(spare))),
                State::Failed(_) => {}
            }
        }

        for task in closing {
            let _ = task.await;
        }
    }

    fn top_up<P: Prepare<Spare = T>>(&self, entries: &mut VecDeque<Entry<T>>, prepare: &P) {
        while entries.len() < self.size && !self.closed.load(Ordering::SeqCst) {
            let number = match prepare.reserve() {
                Ok(number) => number,
                Err(error) => {
                    eprintln!("rewind: could not reserve a fork number for a spare: {error}");
                    return;
                }
            };
            entries.push_back(Entry {
                number,
                version: prepare.version(),
                state: State::Starting(tokio::spawn(prepare.prepare(number))),
            });
        }
    }
}

async fn settle<T>(entry: &mut Entry<T>) {
    let finished = matches!(&entry.state, State::Starting(task) if task.is_finished());
    if !finished {
        return;
    }

    let State::Starting(task) = std::mem::replace(&mut entry.state, State::Failed(Instant::now())) else {
        return;
    };
    match joined(task.await) {
        Ok(spare) => entry.state = State::Ready(spare),
        Err(error) => eprintln!("rewind: the spare for fork {} did not start: {error}", entry.number),
    }
}

fn restart<P: Prepare>(entry: &mut Entry<P::Spare>, prepare: &P, version: Option<String>) {
    let previous = std::mem::replace(&mut entry.state, State::Failed(Instant::now()));
    let prepare = prepare.clone();
    let number = entry.number;
    let task = match previous {
        State::Ready(spare) => tokio::spawn(prepare.restart(spare)),
        State::Starting(task) => tokio::spawn(async move {
            let spare = joined(task.await)?;
            prepare.restart(spare).await
        }),
        State::Failed(_) => tokio::spawn(prepare.prepare(number)),
    };
    entry.state = State::Starting(task);
    entry.version = version;
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    };

    use super::*;

    /// A spare is its number and the code version its copy runs.
    #[derive(Debug, Clone, PartialEq)]
    struct Fake {
        number: u64,
        version: String,
    }

    #[derive(Clone, Default)]
    struct Fakes {
        next: Arc<AtomicU64>,
        version: Arc<StdMutex<String>>,
        failing: Arc<AtomicBool>,
        prepared: Arc<StdMutex<Vec<u64>>>,
        restarted: Arc<StdMutex<Vec<u64>>>,
        closed: Arc<StdMutex<Vec<u64>>>,
    }

    impl Fakes {
        fn set_version(&self, version: &str) {
            *self.version.lock().unwrap() = version.to_string();
        }

        fn list(list: &Arc<StdMutex<Vec<u64>>>) -> Vec<u64> {
            let mut numbers = list.lock().unwrap().clone();
            numbers.sort();
            numbers
        }
    }

    impl Prepare for Fakes {
        type Spare = Fake;

        fn reserve(&self) -> Result<u64, Error> {
            Ok(self.next.fetch_add(1, Ordering::SeqCst) + 1)
        }

        fn version(&self) -> Option<String> {
            Some(self.version.lock().unwrap().clone())
        }

        fn prepare(&self, number: u64) -> impl Future<Output = Result<Fake, Error>> + Send + 'static {
            let this = self.clone();
            async move {
                this.prepared.lock().unwrap().push(number);
                if this.failing.load(Ordering::SeqCst) {
                    return Err(Error::CopyExited("the copy exited".into()));
                }

                let version = this.version.lock().unwrap().clone();
                Ok(Fake { number, version })
            }
        }

        fn restart(&self, spare: Fake) -> impl Future<Output = Result<Fake, Error>> + Send + 'static {
            let this = self.clone();
            async move {
                this.restarted.lock().unwrap().push(spare.number);
                let version = this.version.lock().unwrap().clone();
                Ok(Fake { version, ..spare })
            }
        }

        fn close(&self, spare: Fake) -> impl Future<Output = ()> + Send + 'static {
            let this = self.clone();
            async move {
                this.closed.lock().unwrap().push(spare.number);
            }
        }
    }

    /// Lets the spares' tasks finish, then tends the pool once.
    async fn settled(pool: &Pool<Fake>, fakes: &Fakes) {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }

        pool.tend(fakes).await;
    }

    fn spare(claim: Claim<Fake>) -> Fake {
        match claim {
            Claim::Spare { number, spare } => {
                assert_eq!(number, spare.number);
                spare
            }
            Claim::Cold { number } => panic!("fork {number} got no spare"),
        }
    }

    fn cold(claim: Claim<Fake>) -> u64 {
        match claim {
            Claim::Spare { number, .. } => panic!("fork {number} got a spare"),
            Claim::Cold { number } => number,
        }
    }

    #[tokio::test]
    async fn forks_take_the_oldest_spare_and_the_pool_refills() {
        let fakes = Fakes::default();
        fakes.set_version("v1");
        let pool = Pool::new(2);
        pool.tend(&fakes).await;
        settled(&pool, &fakes).await;
        assert_eq!(Fakes::list(&fakes.prepared), vec![1, 2]);

        assert_eq!(spare(pool.claim(&fakes).await.unwrap()).number, 1);
        assert_eq!(spare(pool.claim(&fakes).await.unwrap()).number, 2);
        settled(&pool, &fakes).await;
        assert_eq!(Fakes::list(&fakes.prepared), vec![1, 2, 3, 4]);
        assert_eq!(spare(pool.claim(&fakes).await.unwrap()).number, 3);
    }

    #[tokio::test]
    async fn two_forks_at_once_never_get_the_same_spare() {
        let fakes = Fakes::default();
        fakes.set_version("v1");
        let pool = Arc::new(Pool::new(4));
        pool.tend(&fakes).await;
        let claims: Vec<_> = (0..6)
            .map(|_| {
                let (pool, fakes) = (pool.clone(), fakes.clone());
                tokio::spawn(async move { spare(pool.claim(&fakes).await.unwrap()).number })
            })
            .collect();
        let mut numbers = Vec::new();
        for claim in claims {
            numbers.push(claim.await.unwrap());
        }

        numbers.sort();
        numbers.dedup();
        assert_eq!(numbers.len(), 6);
    }

    #[tokio::test]
    async fn a_pool_of_zero_starts_nothing() {
        let fakes = Fakes::default();
        let pool = Pool::new(0);
        pool.tend(&fakes).await;
        assert_eq!(cold(pool.claim(&fakes).await.unwrap()), 1);
        assert_eq!(cold(pool.claim(&fakes).await.unwrap()), 2);
        assert!(Fakes::list(&fakes.prepared).is_empty());
    }

    #[tokio::test]
    async fn a_code_change_restarts_each_spare_once_and_keeps_its_number() {
        let fakes = Fakes::default();
        fakes.set_version("v1");
        let pool = Pool::new(2);
        pool.tend(&fakes).await;
        settled(&pool, &fakes).await;
        assert!(Fakes::list(&fakes.restarted).is_empty());

        fakes.set_version("v2");
        settled(&pool, &fakes).await;
        settled(&pool, &fakes).await;
        assert_eq!(Fakes::list(&fakes.restarted), vec![1, 2]);
        assert_eq!(Fakes::list(&fakes.prepared), vec![1, 2]);
        assert_eq!(spare(pool.claim(&fakes).await.unwrap()), Fake { number: 1, version: "v2".into() });
    }

    #[tokio::test]
    async fn a_spare_that_is_still_starting_restarts_after_it_starts() {
        let fakes = Fakes::default();
        fakes.set_version("v1");
        let pool = Pool::new(1);
        pool.tend(&fakes).await;
        fakes.set_version("v2");
        pool.tend(&fakes).await;
        assert_eq!(spare(pool.claim(&fakes).await.unwrap()), Fake { number: 1, version: "v2".into() });
        assert_eq!(Fakes::list(&fakes.restarted), vec![1]);
    }

    #[tokio::test]
    async fn a_spare_that_failed_goes_cold_with_its_number_and_is_tried_again() {
        let fakes = Fakes::default();
        fakes.set_version("v1");
        fakes.failing.store(true, Ordering::SeqCst);
        let pool = Pool::with_retry(2, Duration::ZERO);
        pool.tend(&fakes).await;
        assert_eq!(cold(pool.claim(&fakes).await.unwrap()), 1);

        fakes.failing.store(false, Ordering::SeqCst);
        settled(&pool, &fakes).await;
        settled(&pool, &fakes).await;
        assert_eq!(spare(pool.claim(&fakes).await.unwrap()).number, 2);
        let tries_of_2 = Fakes::list(&fakes.prepared).iter().filter(|number| **number == 2).count();
        assert_eq!(tries_of_2, 2);
    }

    #[tokio::test]
    async fn closing_stops_every_spare_and_starts_no_more() {
        let fakes = Fakes::default();
        fakes.set_version("v1");
        let pool = Pool::new(3);
        pool.tend(&fakes).await;
        settled(&pool, &fakes).await;
        pool.close_all(&fakes).await;
        assert_eq!(Fakes::list(&fakes.closed), vec![1, 2, 3]);

        pool.tend(&fakes).await;
        assert_eq!(cold(pool.claim(&fakes).await.unwrap()), 4);
        assert_eq!(Fakes::list(&fakes.prepared), vec![1, 2, 3]);
    }
}
