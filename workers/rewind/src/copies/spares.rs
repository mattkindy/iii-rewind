//! Spare fork namespaces for the worker under test, each with its stubs registered and a copy
//! running the code on disk, so a new fork does not wait for a copy to start. The pool does the
//! counting and restarting, and `Spares` tells it how to make, restart and close a spare.

use std::{future::Future, sync::Arc, time::Duration};

use super::space::ForkSpace;
use crate::{
    app::App,
    catalog,
    error::Result,
    namespaces,
    pool::{Claim, Prepare},
};

const TEND_EVERY: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct Spares(pub Arc<App>);

impl Prepare for Spares {
    type Spare = ForkSpace;

    fn reserve(&self) -> Result<u64> {
        self.0.store.next_fork_number()
    }

    fn version(&self) -> Option<String> {
        self.0.target_code.latest().map(|code| code.version)
    }

    fn prepare(&self, number: u64) -> impl Future<Output = Result<ForkSpace>> + Send + 'static {
        let app = self.0.clone();
        async move {
            let rows = catalog::list(&app.iii).await?;
            app.catalog.replace(&rows);
            let worker = app.worker_of(&app.config.entry)?;
            let space = ForkSpace::open(&app, &namespaces::fork(number), &[worker]).await?;
            warmed(&app, space).await
        }
    }

    fn restart(&self, space: ForkSpace) -> impl Future<Output = Result<ForkSpace>> + Send + 'static {
        let app = self.0.clone();
        async move { warmed(&app, space).await }
    }

    fn close(&self, space: ForkSpace) -> impl Future<Output = ()> + Send + 'static {
        async move { space.close().await }
    }
}

/// The spare once its stubs are registered and its copy runs the code on disk, or closed if either fails.
async fn warmed(app: &Arc<App>, space: ForkSpace) -> Result<ForkSpace> {
    let started = async {
        space.ensure_stubs(app).await?;
        space.ensure_copies(app, &app.config.entry).await
    };
    match started.await {
        Ok(_) => Ok(space),
        Err(error) => {
            space.close().await;
            Err(error)
        }
    }
}

/// The number of a new fork that copies `workers`, the root's worker first. A fork whose root
/// runs in the worker under test takes a spare, so its namespace is open before its first run.
pub async fn claim(app: &Arc<App>, workers: &[String]) -> Result<u64> {
    let under_test = app.worker_of(&app.config.entry).ok();
    if under_test.is_none() || workers.first() != under_test.as_ref() {
        return app.store.next_fork_number();
    }

    let (number, mut space) = match app.pool.claim(&Spares(app.clone())).await? {
        Claim::Spare { number, spare } => (number, spare),
        Claim::Cold { number } => return Ok(number),
    };
    if space.root_worker() != workers.first().map(String::as_str) {
        space.close().await;
        return Ok(number);
    }

    if let Err(error) = space.add_workers(app, &workers[1..]).await {
        space.close().await;
        return Err(error);
    }

    app.spaces.adopt(space).await;
    Ok(number)
}

/// Keeps the pool full and its copies on the code on disk.
pub fn start_pool(app: &Arc<App>) {
    if app.pool.size() == 0 {
        return;
    }

    eprintln!("rewind: keeping {} copies of the worker under test ready for new forks", app.pool.size());
    let app = app.clone();
    app.rt.clone().spawn(async move {
        let spares = Spares(app.clone());
        loop {
            app.pool.tend(&spares).await;
            tokio::time::sleep(TEND_EVERY).await;
        }
    });
}

pub async fn close_pool(app: &Arc<App>) {
    app.pool.close_all(&Spares(app.clone())).await;
}
