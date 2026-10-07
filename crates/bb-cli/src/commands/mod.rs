use std::collections::HashMap;

use crate::call::Handler;

pub mod daemon;
pub mod system;
pub mod terminal;
pub mod thread;
pub mod thread_more;
pub mod workspace;

/// Every handler by its camelCase command path; the table refuses a command missing here.
pub fn handlers() -> HashMap<&'static str, Handler> {
    [
        system::handlers(),
        daemon::handlers(),
        thread::handlers(),
        thread_more::handlers(),
        workspace::handlers(),
        terminal::handlers(),
    ]
    .into_iter()
    .flatten()
    .collect()
}
