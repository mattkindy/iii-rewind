//! Replaying a recorded run against copies of workers. `session` keeps one rerun's state and places
//! each call the copy makes, `decision` decides what each call gets back, and `stubs` has the
//! handlers that answer the copy and `run_in`, which starts a rerun and collects what it did.

mod decision;
mod session;
mod stubs;
#[cfg(test)]
pub mod testing;

pub use decision::{Choice, Policy, Unanswered, answers_to_keep};
pub use session::{CallAt, CalledBy, Filled, Session, SessionSlot};
pub use stubs::{Ran, copied_call, live_step, run_in, stub_call};
#[cfg(test)]
pub use decision::Decision;
