//! The small pieces every thread operation shares: the per-thread queue, the
//! notifications collected during a commit, and the two "cannot write" errors.
//! The port of `apps/server/src/threads/core.ts`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::db::threads::ThreadRow;
use crate::domain::changes::{ProjectChangeKind, ThreadChangeKind, ThreadChangeMetadata};
use crate::error::ApiError;
use crate::ws::hub::Hub;

pub struct Provisioning {
    pub id: String,
    pub abort: CancellationToken,
}

#[derive(Default)]
pub struct ThreadRuntime {
    pub provisioning: Option<Provisioning>,
    pub pending_start: Option<String>,
    pub cancelled_start: Option<String>,
}

type Action = Box<dyn FnOnce() + Send>;

/// Notifications and follow-ups gathered inside a transaction and released
/// once it has committed.
pub struct Outbox {
    hub: Hub,
    actions: Mutex<Vec<Action>>,
}

impl Outbox {
    pub fn new(hub: Hub) -> Self {
        Self { hub, actions: Mutex::default() }
    }

    pub fn thread(
        &self,
        id: &str,
        changes: Vec<ThreadChangeKind>,
        metadata: Option<ThreadChangeMetadata>,
    ) {
        let (hub, id) = (self.hub.clone(), id.to_owned());
        self.after(move || hub.thread(&id, changes, metadata));
    }

    pub fn project(&self, id: &str, changes: Vec<ProjectChangeKind>) {
        let (hub, id) = (self.hub.clone(), id.to_owned());
        self.after(move || hub.project(&id, changes));
    }

    pub fn after(&self, action: impl FnOnce() + Send + 'static) {
        self.actions.lock().push(Box::new(action));
    }

    pub fn flush(self) {
        for action in self.actions.into_inner() {
            action();
        }
    }
}

struct Tail {
    generation: u64,
    done: oneshot::Receiver<()>,
}

#[derive(Default)]
struct SerialState {
    tails: HashMap<String, Tail>,
    generation: u64,
    idle_waiters: Vec<oneshot::Sender<()>>,
}

/// Runs work for one thread at a time, in the order `run` was called.
#[derive(Clone, Default)]
pub struct ThreadSerial {
    state: Arc<Mutex<SerialState>>,
}

impl ThreadSerial {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserves the next place in the thread's queue NOW and returns a future
    /// that waits for the work ahead of it, runs `work` and frees the place.
    /// Dropping the future frees the place too.
    pub fn run<T, F>(&self, thread_id: &str, work: F) -> impl Future<Output = T> + Send + 'static
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (finished, done) = oneshot::channel();
        let (previous, generation) = {
            let mut state = self.state.lock();
            state.generation += 1;
            let generation = state.generation;
            let previous = state.tails.insert(thread_id.to_owned(), Tail { generation, done });
            (previous, generation)
        };
        let slot = Slot {
            state: self.state.clone(),
            thread_id: thread_id.to_owned(),
            generation,
            finished,
        };
        async move {
            if let Some(previous) = previous {
                let _ = previous.done.await;
            }
            let result = work.await;
            drop(slot);
            result
        }
    }

    /// Resolves when no thread has queued work.
    pub async fn idle(&self) {
        loop {
            let waiting = {
                let mut state = self.state.lock();
                if state.tails.is_empty() {
                    return;
                }
                let (notify, waiting) = oneshot::channel();
                state.idle_waiters.push(notify);
                waiting
            };
            let _ = waiting.await;
        }
    }
}

struct Slot {
    state: Arc<Mutex<SerialState>>,
    thread_id: String,
    generation: u64,
    finished: oneshot::Sender<()>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut state = self.state.lock();
        if state.tails.get(&self.thread_id).is_some_and(|tail| tail.generation == self.generation) {
            state.tails.remove(&self.thread_id);
        }
        if state.tails.is_empty() {
            for waiter in state.idle_waiters.drain(..) {
                let _ = waiter.send(());
            }
        }
        let (replacement, _) = oneshot::channel();
        let _ = std::mem::replace(&mut self.finished, replacement).send(());
    }
}

/// `reason` is a `ThreadNotWritableReason` such as `"archived"`.
pub fn not_writable(thread: &ThreadRow, reason: &str, message: &str) -> ApiError {
    let details = json!({
        "reason": reason,
        "archivedAt": thread.archived_at,
        "threadStatus": thread.status,
    });
    ApiError::new(409, "thread_not_writable", message).details(details)
}

/// `details` is a `ThreadEnvironmentUnavailableErrorDetails`.
pub fn environment_unavailable(details: serde_json::Value) -> ApiError {
    let message = "Thread environment is not available";
    ApiError::new(409, "thread_environment_unavailable", message).details(details)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn runs_one_thread_in_call_order_and_threads_independently() {
        let serial = ThreadSerial::new();
        let order = Arc::new(Mutex::new(Vec::new()));
        let job = |thread: &'static str, name: &'static str, wait: u64| {
            let order = order.clone();
            serial.run(thread, async move {
                order.lock().push(format!("{name}:start"));
                tokio::time::sleep(Duration::from_millis(wait)).await;
                order.lock().push(format!("{name}:end"));
                name
            })
        };
        let (a, b, c) = (job("t1", "a", 30), job("t1", "b", 1), job("t2", "c", 10));
        let (second, first, other) = tokio::join!(b, a, c);
        assert_eq!((first, second, other), ("a", "b", "c"));
        assert_eq!(*order.lock(), ["a:start", "c:start", "c:end", "a:end", "b:start", "b:end"]);
        serial.idle().await;
    }

    #[tokio::test]
    async fn a_dropped_job_frees_its_place() {
        let serial = ThreadSerial::new();
        let never = serial.run("t", std::future::pending::<()>());
        let next = serial.run("t", async { 7 });
        drop(never);
        assert_eq!(next.await, 7);
        serial.idle().await;
    }
}
