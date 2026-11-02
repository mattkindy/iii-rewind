//! Copies of workers, each a child process in a fork's namespace. `space` opens a fork's namespaces
//! and registers Rewind's handlers there, `spaces` keeps track of the open ones and closes idle
//! paused ones, `spares` keeps copies of the worker under test ready, and `process` runs one copy.

mod process;
mod space;
mod spaces;
mod spares;

pub use space::{ForkSpace, STUB_WORKER};
pub use spaces::{Spaces, park, start_idle_close};
pub use spares::{claim, close_pool, start_pool};
