//! The machines connected to this server: the local runner and every remote
//! one, with the fan-out of their events to the server's handlers. The port
//! of `apps/server/src/runners/registry.ts`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bb_core::{RunnerEvent, RunnerEventSink, SharedRunner};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::mpsc;

use crate::error::{ApiResult, host_unavailable};
use crate::log::Logger;

/// Handles one runner event. Called in arrival order; whatever must stay
/// ordered (reserving a place in a thread's queue) has to happen before the
/// first `.await` of the returned future.
pub type RunnerEventHandler =
    Arc<dyn Fn(RunnerEvent, String) -> BoxFuture<'static, ApiResult<()>> + Send + Sync>;
pub type HostListener = Arc<dyn Fn(&str) + Send + Sync>;
pub type RunnerFactory = Box<dyn FnOnce(RunnerEventSink) -> SharedRunner + Send>;

struct Connection {
    id: u64,
    runner: SharedRunner,
    /// Completed handler batches, acknowledged to the runner in order.
    acks: mpsc::UnboundedSender<(u64, tokio::task::JoinHandle<()>)>,
}

#[derive(Default)]
struct State {
    connections: HashMap<String, Connection>,
    handlers: HashMap<&'static str, Vec<(u64, RunnerEventHandler)>>,
    connect_listeners: Vec<(u64, HostListener)>,
    disconnect_listeners: Vec<(u64, HostListener)>,
}

struct Inner {
    local_host_id: String,
    log: Logger,
    state: Mutex<State>,
    next_id: AtomicU64,
}

#[derive(Clone)]
pub struct RunnerRegistry {
    inner: Arc<Inner>,
}

/// Removes a handler or listener when dropped or when `remove` is called.
#[must_use]
pub struct Registration {
    remove: Option<Box<dyn FnOnce() + Send>>,
}

impl Registration {
    pub fn remove(mut self) {
        if let Some(remove) = self.remove.take() {
            remove();
        }
    }

    /// Keeps the handler registered for the life of the registry.
    pub fn forever(mut self) {
        self.remove = None;
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(remove) = self.remove.take() {
            remove();
        }
    }
}

impl RunnerRegistry {
    /// Must be called inside a tokio runtime when runners will connect.
    pub fn new(local_host_id: &str, log: Logger) -> Self {
        let state = Mutex::default();
        let inner = Inner {
            local_host_id: local_host_id.to_owned(),
            log,
            state,
            next_id: AtomicU64::new(1),
        };
        Self { inner: Arc::new(inner) }
    }

    pub fn local_host_id(&self) -> &str {
        &self.inner.local_host_id
    }

    pub fn get(&self, host_id: &str) -> ApiResult<SharedRunner> {
        let state = self.inner.state.lock();
        state
            .connections
            .get(host_id)
            .map(|connection| connection.runner.clone())
            .ok_or_else(host_unavailable)
    }

    pub fn is_connected(&self, host_id: &str) -> bool {
        self.inner.state.lock().connections.contains_key(host_id)
    }

    fn next_id(&self) -> u64 {
        self.inner.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Replaces whatever runner the machine had. `create` receives the sink
    /// the new runner must deliver its events to.
    pub fn connect(&self, host_id: &str, create: RunnerFactory) -> SharedRunner {
        self.disconnect(host_id, None);
        let id = self.next_id();
        let registry = self.clone();
        let host = host_id.to_owned();
        let sink: RunnerEventSink = Arc::new(move |event| registry.deliver(&host, id, event));
        let runner = create(sink);
        let (acks, pending) = mpsc::unbounded_channel();
        tokio::spawn(acknowledge(
            runner.clone(),
            pending,
            self.inner.log.clone(),
            host_id.to_owned(),
        ));
        let connection = Connection { id, runner: runner.clone(), acks };
        let listeners = {
            let mut state = self.inner.state.lock();
            state.connections.insert(host_id.to_owned(), connection);
            state.connect_listeners.clone()
        };
        for (_, listener) in listeners {
            listener(host_id);
        }
        runner
    }

    /// Drops the machine's connection; with `runner`, only if it is still that one.
    pub fn disconnect(&self, host_id: &str, runner: Option<&SharedRunner>) {
        let listeners = {
            let mut state = self.inner.state.lock();
            let Some(connection) = state.connections.get(host_id) else { return };
            if runner.is_some_and(|expected| !Arc::ptr_eq(expected, &connection.runner)) {
                return;
            }
            state.connections.remove(host_id);
            state.disconnect_listeners.clone()
        };
        for (_, listener) in listeners {
            listener(host_id);
        }
    }

    /// `kind` is a `RunnerEvent` kind such as `"thread.events"`.
    pub fn on_event(&self, kind: &'static str, handler: RunnerEventHandler) -> Registration {
        let id = self.next_id();
        self.inner.state.lock().handlers.entry(kind).or_default().push((id, handler));
        let inner = self.inner.clone();
        let remove = move || {
            if let Some(handlers) = inner.state.lock().handlers.get_mut(kind) {
                handlers.retain(|(registered, _)| *registered != id);
            }
        };
        Registration { remove: Some(Box::new(remove)) }
    }

    pub fn on_connected(&self, listener: HostListener) -> Registration {
        let id = self.next_id();
        self.inner.state.lock().connect_listeners.push((id, listener));
        let inner = self.inner.clone();
        let remove = move || {
            inner.state.lock().connect_listeners.retain(|(registered, _)| *registered != id)
        };
        Registration { remove: Some(Box::new(remove)) }
    }

    pub fn on_disconnected(&self, listener: HostListener) -> Registration {
        let id = self.next_id();
        self.inner.state.lock().disconnect_listeners.push((id, listener));
        let inner = self.inner.clone();
        let remove = move || {
            inner.state.lock().disconnect_listeners.retain(|(registered, _)| *registered != id)
        };
        Registration { remove: Some(Box::new(remove)) }
    }

    /// Runs every handler for the event and waits for all of them; a failing
    /// handler is logged and does not stop the others.
    pub fn emit(&self, host_id: &str, event: RunnerEvent) -> BoxFuture<'static, ()> {
        let kind = event.body.kind();
        let handlers: Vec<RunnerEventHandler> = {
            let state = self.inner.state.lock();
            let registered = state.handlers.get(kind).map(Vec::as_slice).unwrap_or_default();
            registered.iter().map(|(_, handler)| handler.clone()).collect()
        };
        let running: Vec<_> = handlers
            .into_iter()
            .map(|handler| handler(event.clone(), host_id.to_owned()))
            .collect();
        let (log, host_id) = (self.inner.log.clone(), host_id.to_owned());
        Box::pin(async move {
            for result in futures::future::join_all(running).await {
                if let Err(error) = result {
                    let fields = json!({"err": error.to_string(), "hostId": host_id, "kind": kind});
                    log.error("Runner event handler failed", fields);
                }
            }
        })
    }

    fn deliver(&self, host_id: &str, connection_id: u64, event: RunnerEvent) {
        let acks = {
            let state = self.inner.state.lock();
            match state.connections.get(host_id) {
                Some(connection) if connection.id == connection_id => connection.acks.clone(),
                _ => return,
            }
        };
        let reliable_seq = match event.lane {
            bb_core::Lane::Reliable => event.seq,
            bb_core::Lane::Live => None,
        };
        let handled = tokio::spawn(self.emit(host_id, event));
        if let Some(seq) = reliable_seq {
            let _ = acks.send((seq, handled));
        }
    }
}

async fn acknowledge(
    runner: SharedRunner,
    mut pending: mpsc::UnboundedReceiver<(u64, tokio::task::JoinHandle<()>)>,
    log: Logger,
    host_id: String,
) {
    while let Some((seq, handled)) = pending.recv().await {
        let _ = handled.await;
        if let Err(error) = runner.call("ackEvents", json!({ "seq": seq })).await {
            let fields = json!({"err": error.to_string(), "hostId": host_id});
            log.warn("Runner event acknowledgement failed", fields);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use bb_core::{RunnerApi, RunnerEventBody, RunnerResult};
    use serde_json::Value;
    use std::time::Duration;

    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl RunnerApi for Recorder {
        async fn call(&self, method: &str, params: Value) -> RunnerResult<Value> {
            self.calls.lock().push((method.to_owned(), params));
            Ok(Value::Null)
        }
    }

    fn thread_events(seq: u64) -> RunnerEvent {
        let body = RunnerEventBody::ThreadEvents { thread_id: "thr_1".into(), events: vec![] };
        RunnerEvent::reliable(seq, body)
    }

    #[tokio::test(start_paused = true)]
    async fn delivers_events_and_acknowledges_in_order() {
        let registry = RunnerRegistry::new("host_local", Logger::silent());
        let recorder = Arc::new(Recorder::default());
        let sink_slot: Arc<Mutex<Option<RunnerEventSink>>> = Arc::default();
        let (runner, slot) = (recorder.clone(), sink_slot.clone());
        registry.connect(
            "host_local",
            Box::new(move |sink| {
                *slot.lock() = Some(sink);
                runner
            }),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let handler: RunnerEventHandler = Arc::new(move |event, host_id| {
            let log = log.clone();
            Box::pin(async move {
                let seq = event.seq.unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(if seq == 1 { 50 } else { 1 })).await;
                log.lock().push((seq, host_id));
                Ok(())
            })
        });
        registry.on_event("thread.events", handler).forever();
        let sink = sink_slot.lock().clone().unwrap();
        sink(thread_events(1));
        sink(thread_events(2));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(seen.lock().iter().map(|(seq, _)| *seq).collect::<Vec<_>>(), [2, 1]);
        let acked: Vec<Value> =
            recorder.calls.lock().iter().map(|(_, params)| params["seq"].clone()).collect();
        assert_eq!(acked, [json!(1), json!(2)]);
    }

    #[tokio::test]
    async fn replacing_a_runner_notifies_and_drops_the_old_sink() {
        let registry = RunnerRegistry::new("host_local", Logger::silent());
        assert!(registry.get("host_x").is_err());
        let events = Arc::new(Mutex::new(Vec::new()));
        let (connected, disconnected) = (events.clone(), events.clone());
        registry
            .on_connected(Arc::new(move |host| connected.lock().push(format!("+{host}"))))
            .forever();
        registry
            .on_disconnected(Arc::new(move |host| disconnected.lock().push(format!("-{host}"))))
            .forever();
        let old_sink: Arc<Mutex<Option<RunnerEventSink>>> = Arc::default();
        let slot = old_sink.clone();
        let first = registry.connect(
            "host_x",
            Box::new(move |sink| {
                *slot.lock() = Some(sink);
                Arc::new(Recorder::default())
            }),
        );
        let second = registry.connect("host_x", Box::new(|_| Arc::new(Recorder::default())));
        assert_eq!(*events.lock(), ["+host_x", "-host_x", "+host_x"]);
        let handled = Arc::new(Mutex::new(0));
        let count = handled.clone();
        let handler: RunnerEventHandler = Arc::new(move |_, _| {
            *count.lock() += 1;
            Box::pin(async { Ok(()) })
        });
        registry.on_event("thread.events", handler).forever();
        (old_sink.lock().clone().unwrap())(thread_events(1));
        tokio::task::yield_now().await;
        assert_eq!(*handled.lock(), 0);
        registry.disconnect("host_x", Some(&first));
        assert!(registry.is_connected("host_x"));
        registry.disconnect("host_x", Some(&second));
        assert!(!registry.is_connected("host_x"));
    }
}
