//! Port of `apps/server/src/ws/hub.ts`: routes "changed" notices to subscribed sockets.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Weak};
use std::time::Duration;

use indexmap::{IndexMap, IndexSet};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::task::AbortHandle;

use crate::domain::changes::{
    ChangedMessage, ClientMessage, EnvironmentChangeKind, HostChangeKind, PluginSignal,
    PongMessage, ProjectChangeKind, RealtimeSubscriptionTarget, SystemChangeKind, ThreadChangeKind,
    ThreadChangeMetadata, ThreadOpenSignal,
};

/// A connected client. `send` returns false when the socket is gone; the hub then drops it.
pub trait HubSocket: Send + Sync {
    fn send(&self, data: String) -> bool;
    fn close(&self, code: u16, reason: &str);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SocketId(pub u64);

pub type SubscriptionListener = Arc<dyn Fn(&RealtimeSubscriptionTarget, bool) + Send + Sync>;
pub type ChangeListener = Arc<dyn Fn(&ChangedMessage) + Send + Sync>;

pub const LIST_EVENTS_COALESCE: Duration = Duration::from_millis(1_000);
pub const INVALID_MESSAGE_CLOSE_CODE: u16 = 1008;
const LIST_RELEVANT_EVENT_TYPES: [&str; 2] = ["client/turn/requested", "turn/completed"];

type Recipients = Vec<(SocketId, Arc<dyn HubSocket>)>;

struct Client {
    socket: Arc<dyn HubSocket>,
    keys: IndexSet<String>,
}

struct Subscription {
    target: RealtimeSubscriptionTarget,
    sockets: IndexSet<SocketId>,
}

struct PendingListEvents {
    event_types: IndexSet<String>,
    merged: bool,
    generation: u64,
    timer: AbortHandle,
}

#[derive(Default)]
struct State {
    next_id: u64,
    clients: BTreeMap<SocketId, Client>,
    subscriptions: HashMap<String, Subscription>,
    pending_list_events: HashMap<String, PendingListEvents>,
    subscription_listeners: BTreeMap<u64, SubscriptionListener>,
    change_listeners: BTreeMap<u64, ChangeListener>,
}

impl State {
    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn recipients(&self, ids: impl IntoIterator<Item = SocketId>) -> Recipients {
        ids.into_iter().filter_map(|id| Some((id, self.clients.get(&id)?.socket.clone()))).collect()
    }

    fn subscriber_ids(&self, key: &str) -> impl Iterator<Item = SocketId> + '_ {
        self.subscriptions
            .get(key)
            .into_iter()
            .flat_map(|subscription| subscription.sockets.iter().copied())
    }

    fn list_only_subscribers(&self, thread_id: &str) -> Recipients {
        let detail_key = format!("thread-detail:{thread_id}");
        let ids = self.subscriber_ids("thread-list").filter(|id| {
            !self.clients.get(id).is_some_and(|client| client.keys.contains(&detail_key))
        });
        self.recipients(ids.collect::<Vec<_>>())
    }

    fn unsubscribe(&mut self, id: SocketId, key: &str) -> Option<RealtimeSubscriptionTarget> {
        if let Some(client) = self.clients.get_mut(&id) {
            client.keys.shift_remove(key);
        }
        let subscription = self.subscriptions.get_mut(key)?;
        subscription.sockets.shift_remove(&id);
        if !subscription.sockets.is_empty() {
            return None;
        }
        self.subscriptions.remove(key).map(|subscription| subscription.target)
    }
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
}

#[derive(Clone, Default)]
pub struct Hub {
    inner: Arc<Inner>,
}

/// Unregisters its listener when dropped.
#[must_use = "dropping the guard unregisters the listener"]
pub struct ListenerGuard {
    hub: Weak<Inner>,
    id: u64,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        let Some(inner) = self.hub.upgrade() else {
            return;
        };
        let mut state = inner.state.lock();
        let subscription = state.subscription_listeners.remove(&self.id);
        let change = state.change_listeners.remove(&self.id);
        drop(state);
        drop((subscription, change));
    }
}

fn is_list_relevant(changes: &[ThreadChangeKind], metadata: Option<&ThreadChangeMetadata>) -> bool {
    if changes.iter().any(|change| *change != ThreadChangeKind::EventsAppended) {
        return true;
    }
    let Some(metadata) = metadata else {
        return false;
    };
    metadata.background_activity_changed == Some(true)
        || metadata.has_pending_interaction.is_some()
        || metadata.project_id.is_some()
        || metadata
            .event_types
            .iter()
            .flatten()
            .any(|event_type| LIST_RELEVANT_EVENT_TYPES.contains(&event_type.as_str()))
}

fn subscription_keys(message: &ChangedMessage) -> Vec<String> {
    match message.id() {
        None => vec!["system".to_owned()],
        Some(id) => {
            let entity = message.entity();
            vec![format!("{entity}-list"), format!("{entity}-detail:{id}")]
        }
    }
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn thread(
        &self,
        id: &str,
        changes: Vec<ThreadChangeKind>,
        metadata: Option<ThreadChangeMetadata>,
    ) {
        let list_relevant = is_list_relevant(&changes, metadata.as_ref());
        let event_types =
            metadata.as_ref().and_then(|metadata| metadata.event_types.clone()).unwrap_or_default();
        let message = ChangedMessage::Thread { id: id.to_owned(), changes, metadata };
        self.notify_changed(&message);
        if list_relevant {
            self.route(&message);
            return;
        }
        let detail = {
            let state = self.inner.state.lock();
            state.recipients(
                state.subscriber_ids(&format!("thread-detail:{id}")).collect::<Vec<_>>(),
            )
        };
        self.send(detail, &message);
        let list_only = {
            let mut state = self.inner.state.lock();
            if let Some(pending) = state.pending_list_events.get_mut(id) {
                pending.event_types.extend(event_types);
                pending.merged = true;
                return;
            }
            let recipients = state.list_only_subscribers(id);
            let generation = state.next_id();
            if let Some(timer) = self.schedule_flush(id, generation) {
                let pending = PendingListEvents {
                    event_types: IndexSet::new(),
                    merged: false,
                    generation,
                    timer,
                };
                state.pending_list_events.insert(id.to_owned(), pending);
            }
            recipients
        };
        self.send(list_only, &message);
    }

    pub fn project(&self, id: &str, changes: Vec<ProjectChangeKind>) {
        self.publish(ChangedMessage::Project { id: id.to_owned(), changes });
    }

    pub fn environment(&self, id: &str, changes: Vec<EnvironmentChangeKind>) {
        self.publish(ChangedMessage::Environment { id: id.to_owned(), changes });
    }

    pub fn host(&self, id: &str, changes: Vec<HostChangeKind>) {
        self.publish(ChangedMessage::Host { id: id.to_owned(), changes });
    }

    pub fn system(&self, changes: Vec<SystemChangeKind>) {
        self.publish(ChangedMessage::System { changes });
    }

    /// Sends a plugin signal to every connected socket; returns how many received it.
    pub fn plugin_signal(&self, plugin_id: &str, channel: &str, payload: Value) -> usize {
        let signal =
            PluginSignal { plugin_id: plugin_id.to_owned(), channel: channel.to_owned(), payload };
        let everyone = self.everyone();
        self.send(everyone, &signal)
    }

    /// Sends a thread-open signal to every connected socket; returns how many received it.
    pub fn thread_open(&self, signal: ThreadOpenSignal) -> usize {
        let everyone = self.everyone();
        self.send(everyone, &signal)
    }

    /// Called with `true` when a target gains its first subscriber and `false` when it loses
    /// its last.
    pub fn on_subscription_change(
        &self,
        listener: impl Fn(&RealtimeSubscriptionTarget, bool) + Send + Sync + 'static,
    ) -> ListenerGuard {
        let mut state = self.inner.state.lock();
        let id = state.next_id();
        state.subscription_listeners.insert(id, Arc::new(listener));
        self.guard(id)
    }

    pub fn on_changed(
        &self,
        listener: impl Fn(&ChangedMessage) + Send + Sync + 'static,
    ) -> ListenerGuard {
        let mut state = self.inner.state.lock();
        let id = state.next_id();
        state.change_listeners.insert(id, Arc::new(listener));
        self.guard(id)
    }

    pub fn connect(&self, socket: Arc<dyn HubSocket>) -> SocketId {
        let mut state = self.inner.state.lock();
        let id = SocketId(state.next_id());
        let client = Client { socket, keys: IndexSet::new() };
        state.clients.insert(id, client);
        id
    }

    pub fn disconnect(&self, id: SocketId) {
        let removed = {
            let mut state = self.inner.state.lock();
            let keys: Vec<String> = state
                .clients
                .get(&id)
                .map(|client| client.keys.iter().cloned().collect())
                .unwrap_or_default();
            let removed: Vec<_> =
                keys.iter().filter_map(|key| state.unsubscribe(id, key)).collect();
            state.clients.remove(&id);
            removed
        };
        for target in removed {
            self.notify_subscription(&target, false);
        }
    }

    /// Handles one inbound frame. Frames from a socket that is not connected are ignored.
    pub fn receive(&self, id: SocketId, raw: &str) {
        let Some(socket) = self.inner.state.lock().clients.get(&id).map(|c| c.socket.clone())
        else {
            return;
        };
        match ClientMessage::parse(raw) {
            None => socket.close(INVALID_MESSAGE_CLOSE_CODE, "invalid-message"),
            Some(ClientMessage::Ping) => {
                self.send(vec![(id, socket)], &PongMessage {});
            }
            Some(ClientMessage::Subscribe { target }) => self.subscribe(id, target),
            Some(ClientMessage::Unsubscribe { target }) => {
                let removed = self.inner.state.lock().unsubscribe(id, &target.key());
                if let Some(target) = removed {
                    self.notify_subscription(&target, false);
                }
            }
        }
    }

    /// Cancels pending list-event flushes.
    pub fn close(&self) {
        let mut state = self.inner.state.lock();
        for (_, pending) in state.pending_list_events.drain() {
            pending.timer.abort();
        }
    }

    fn guard(&self, id: u64) -> ListenerGuard {
        ListenerGuard { hub: Arc::downgrade(&self.inner), id }
    }

    fn subscribe(&self, id: SocketId, target: RealtimeSubscriptionTarget) {
        let key = target.key();
        {
            let mut state = self.inner.state.lock();
            let Some(client) = state.clients.get_mut(&id) else {
                return;
            };
            client.keys.insert(key.clone());
            if let Some(existing) = state.subscriptions.get_mut(&key) {
                existing.sockets.insert(id);
                return;
            }
            let subscription =
                Subscription { target: target.clone(), sockets: IndexSet::from([id]) };
            state.subscriptions.insert(key, subscription);
        }
        self.notify_subscription(&target, true);
    }

    fn notify_subscription(&self, target: &RealtimeSubscriptionTarget, subscribed: bool) {
        let listeners: Vec<_> = {
            let state = self.inner.state.lock();
            state.subscription_listeners.values().cloned().collect()
        };
        for listener in listeners {
            listener(target, subscribed);
        }
    }

    fn notify_changed(&self, message: &ChangedMessage) {
        let listeners: Vec<_> = {
            let state = self.inner.state.lock();
            state.change_listeners.values().cloned().collect()
        };
        for listener in listeners {
            listener(message);
        }
    }

    fn everyone(&self) -> Recipients {
        let state = self.inner.state.lock();
        state.recipients(state.clients.keys().copied().collect::<Vec<_>>())
    }

    fn publish(&self, message: ChangedMessage) {
        self.notify_changed(&message);
        self.route(&message);
    }

    fn route(&self, message: &ChangedMessage) {
        let recipients = {
            let state = self.inner.state.lock();
            let mut sockets = IndexMap::new();
            for key in subscription_keys(message) {
                for id in state.subscriber_ids(&key) {
                    if let Some(client) = state.clients.get(&id) {
                        sockets.entry(id).or_insert_with(|| client.socket.clone());
                    }
                }
            }
            sockets.into_iter().collect()
        };
        self.send(recipients, message);
    }

    fn schedule_flush(&self, id: &str, generation: u64) -> Option<AbortHandle> {
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let hub = Arc::downgrade(&self.inner);
        let id = id.to_owned();
        let deadline = tokio::time::Instant::now() + LIST_EVENTS_COALESCE;
        let task = runtime.spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(inner) = hub.upgrade() {
                Hub { inner }.flush_list_events(&id, generation);
            }
        });
        Some(task.abort_handle())
    }

    fn flush_list_events(&self, id: &str, generation: u64) {
        let (recipients, event_types) = {
            let mut state = self.inner.state.lock();
            let current = state.pending_list_events.get(id).map(|pending| pending.generation);
            if current != Some(generation) {
                return;
            }
            let Some(pending) = state.pending_list_events.remove(id) else {
                return;
            };
            if !pending.merged {
                return;
            }
            let event_types: Vec<String> = pending.event_types.into_iter().collect();
            (state.list_only_subscribers(id), event_types)
        };
        let metadata = (!event_types.is_empty())
            .then(|| ThreadChangeMetadata { event_types: Some(event_types), ..Default::default() });
        let message = ChangedMessage::Thread {
            id: id.to_owned(),
            changes: vec![ThreadChangeKind::EventsAppended],
            metadata,
        };
        self.send(recipients, &message);
    }

    fn send(&self, recipients: Recipients, message: &impl Serialize) -> usize {
        let Ok(payload) = serde_json::to_string(message) else {
            return 0;
        };
        let mut delivered = 0;
        for (id, socket) in recipients {
            if socket.send(payload.clone()) {
                delivered += 1;
            } else {
                self.disconnect(id);
            }
        }
        delivered
    }
}
