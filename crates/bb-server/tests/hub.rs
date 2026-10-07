use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bb_server::domain::changes::{
    ChangedMessage, EnvironmentChangeKind, HostChangeKind, ProjectChangeKind,
    RealtimeSubscriptionTarget, SystemChangeKind, ThreadChangeKind, ThreadChangeMetadata,
    ThreadOpenSignal, ThreadOpenSplit,
};
use bb_server::ws::hub::{Hub, HubSocket, SocketId};
use parking_lot::Mutex;
use serde_json::{Value, json};

#[derive(Default)]
struct TestSocket {
    sent: Mutex<Vec<Value>>,
    closed: Mutex<Vec<(u16, String)>>,
    broken: AtomicBool,
}

impl HubSocket for TestSocket {
    fn send(&self, data: String) -> bool {
        if self.broken.load(Ordering::SeqCst) {
            return false;
        }
        self.sent.lock().push(serde_json::from_str(&data).unwrap());
        true
    }

    fn close(&self, code: u16, reason: &str) {
        self.closed.lock().push((code, reason.to_owned()));
    }
}

struct Client {
    id: SocketId,
    socket: Arc<TestSocket>,
}

impl Client {
    fn sent(&self) -> Vec<Value> {
        self.socket.sent.lock().clone()
    }

    fn count(&self) -> usize {
        self.socket.sent.lock().len()
    }
}

fn hub_client(hub: &Hub, targets: &[Value]) -> Client {
    let socket = Arc::new(TestSocket::default());
    let id = hub.connect(socket.clone());
    for target in targets {
        hub.receive(id, &json!({"type": "subscribe", "target": target}).to_string());
    }
    Client { id, socket }
}

fn append(hub: &Hub, event_type: &str) {
    let metadata = ThreadChangeMetadata {
        event_types: Some(vec![event_type.to_owned()]),
        ..Default::default()
    };
    hub.thread("thr_1", vec![ThreadChangeKind::EventsAppended], Some(metadata));
}

async fn elapse(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
}

fn event_types(client: &Client) -> Vec<Value> {
    client
        .sent()
        .iter()
        .map(|message| {
            message["metadata"]["eventTypes"]
                .as_array()
                .map(|types| {
                    let names: Vec<_> = types.iter().filter_map(Value::as_str).collect();
                    Value::from(names.join(","))
                })
                .unwrap_or(Value::Null)
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn coalesces_events_appended_for_list_only_subscribers() {
    let hub = Hub::new();
    let thread_one = json!({"kind": "thread-detail", "threadId": "thr_1"});
    let list_only = hub_client(&hub, &[json!({"kind": "thread-list"})]);
    let viewer = hub_client(&hub, &[json!({"kind": "thread-list"}), thread_one]);
    append(&hub, "item/started");
    append(&hub, "item/agentMessage/delta");
    append(&hub, "item/completed");
    assert_eq!(viewer.count(), 3);
    assert_eq!(event_types(&list_only), vec![json!("item/started")]);
    elapse(1_000).await;
    assert_eq!(event_types(&list_only)[1], json!("item/agentMessage/delta,item/completed"));
    assert_eq!(
        list_only.sent()[1],
        json!({"type": "changed", "entity": "thread", "id": "thr_1",
            "changes": ["events-appended"],
            "metadata": {"eventTypes": ["item/agentMessage/delta", "item/completed"]}})
    );
    append(&hub, "turn/completed");
    let metadata = ThreadChangeMetadata { project_id: Some("p1".into()), ..Default::default() };
    hub.thread("thr_1", vec![ThreadChangeKind::StatusChanged], Some(metadata));
    elapse(5_000).await;
    assert_eq!((list_only.count(), viewer.count()), (4, 5));
    hub.receive(viewer.id, "not json");
    assert_eq!(*viewer.socket.closed.lock(), vec![(1008, "invalid-message".to_owned())]);
}

#[tokio::test(start_paused = true)]
async fn a_quiet_window_flushes_nothing_and_reopens() {
    let hub = Hub::new();
    let list_only = hub_client(&hub, &[json!({"kind": "thread-list"})]);
    append(&hub, "item/started");
    elapse(1_000).await;
    assert_eq!(list_only.count(), 1);
    append(&hub, "item/completed");
    assert_eq!(list_only.count(), 2);
    hub.thread("thr_1", vec![ThreadChangeKind::EventsAppended], None);
    elapse(1_000).await;
    assert_eq!(
        list_only.sent()[2],
        json!({"type": "changed", "entity": "thread", "id": "thr_1",
            "changes": ["events-appended"]})
    );
}

#[tokio::test(start_paused = true)]
async fn a_detail_subscriber_receives_every_event_notice() {
    let hub = Hub::new();
    let detail = hub_client(&hub, &[json!({"kind": "thread-detail", "threadId": "thr_1"})]);
    let other = hub_client(&hub, &[json!({"kind": "thread-detail", "threadId": "thr_2"})]);
    for _ in 0..10 {
        append(&hub, "item/agentMessage/delta");
    }
    elapse(1_000).await;
    assert_eq!(detail.count(), 10);
    assert_eq!(other.count(), 0);
    assert_eq!(
        detail.sent()[0],
        json!({"type": "changed", "entity": "thread", "id": "thr_1",
            "changes": ["events-appended"],
            "metadata": {"eventTypes": ["item/agentMessage/delta"]}})
    );
}

#[tokio::test(start_paused = true)]
async fn close_cancels_pending_flushes() {
    let hub = Hub::new();
    let list_only = hub_client(&hub, &[json!({"kind": "thread-list"})]);
    append(&hub, "item/started");
    append(&hub, "item/completed");
    hub.close();
    elapse(2_000).await;
    assert_eq!(list_only.count(), 1);
    append(&hub, "item/started");
    assert_eq!(list_only.count(), 2);
}

#[tokio::test]
async fn an_invalid_frame_closes_the_socket() {
    let hub = Hub::new();
    let client = hub_client(&hub, &[]);
    for raw in [
        "not json",
        r#"{"type":"subscribe","target":{"kind":"thread-list","extra":true}}"#,
        r#"{"type":"subscribe","target":{"kind":"thread-detail","threadId":""}}"#,
        r#"{"type":"hello"}"#,
    ] {
        hub.receive(client.id, raw);
    }
    assert_eq!(client.socket.closed.lock().len(), 4);
    assert!(
        client
            .socket
            .closed
            .lock()
            .iter()
            .all(|(code, reason)| *code == 1008 && reason == "invalid-message")
    );
    assert_eq!(client.count(), 0);
}

#[tokio::test]
async fn answers_ping_with_pong() {
    let hub = Hub::new();
    let client = hub_client(&hub, &[]);
    hub.receive(client.id, r#"{"type":"ping"}"#);
    assert_eq!(client.sent(), vec![json!({"type": "pong"})]);
    assert!(client.socket.closed.lock().is_empty());
}

type Seen = Arc<Mutex<Vec<(String, bool)>>>;

fn record_subscriptions(hub: &Hub) -> (Seen, impl Drop) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let guard = hub.on_subscription_change(move |target: &RealtimeSubscriptionTarget, on| {
        sink.lock().push((target.key(), on));
    });
    (seen, guard)
}

#[tokio::test]
async fn disconnect_unsubscribes() {
    let hub = Hub::new();
    let (seen, _guard) = record_subscriptions(&hub);
    let list = json!({"kind": "project-list"});
    let first = hub_client(&hub, std::slice::from_ref(&list));
    let second = hub_client(&hub, &[list, json!({"kind": "host-list"})]);
    assert_eq!(
        *seen.lock(),
        vec![("project-list".to_owned(), true), ("host-list".to_owned(), true)]
    );
    hub.disconnect(first.id);
    assert_eq!(seen.lock().len(), 2);
    hub.project("p1", vec![ProjectChangeKind::ProjectUpdated]);
    assert_eq!((first.count(), second.count()), (0, 1));
    hub.disconnect(second.id);
    let mut tail = seen.lock()[2..].to_vec();
    tail.sort();
    assert_eq!(tail, vec![("host-list".to_owned(), false), ("project-list".to_owned(), false)]);
    hub.project("p1", vec![ProjectChangeKind::ProjectUpdated]);
    assert_eq!(second.count(), 1);
    assert_eq!(hub.plugin_signal("tasks", "c", json!(1)), 0);
}

#[tokio::test]
async fn unsubscribe_message_stops_delivery() {
    let hub = Hub::new();
    let (seen, _guard) = record_subscriptions(&hub);
    let target = json!({"kind": "environment-detail", "environmentId": "env_1"});
    let client = hub_client(&hub, std::slice::from_ref(&target));
    hub.environment("env_1", vec![EnvironmentChangeKind::GitRefsChanged]);
    hub.environment("env_2", vec![EnvironmentChangeKind::GitRefsChanged]);
    hub.receive(client.id, &json!({"type": "unsubscribe", "target": target}).to_string());
    hub.environment("env_1", vec![EnvironmentChangeKind::GitRefsChanged]);
    assert_eq!(
        client.sent(),
        vec![json!({"type": "changed", "entity": "environment", "id": "env_1",
            "changes": ["git-refs-changed"]})]
    );
    assert_eq!(
        *seen.lock(),
        vec![
            ("environment-detail:env_1".to_owned(), true),
            ("environment-detail:env_1".to_owned(), false)
        ]
    );
}

#[tokio::test]
async fn a_failed_send_drops_the_socket() {
    let hub = Hub::new();
    let (seen, _guard) = record_subscriptions(&hub);
    let broken = hub_client(&hub, &[json!({"kind": "system"})]);
    let healthy = hub_client(&hub, &[]);
    broken.socket.broken.store(true, Ordering::SeqCst);
    assert_eq!(hub.plugin_signal("tasks", "updated", json!({"id": 1})), 1);
    assert_eq!(*seen.lock(), vec![("system".to_owned(), true), ("system".to_owned(), false)]);
    assert_eq!(
        healthy.sent(),
        vec![json!({"type": "plugin-signal", "pluginId": "tasks", "channel": "updated",
            "payload": {"id": 1}})]
    );
    broken.socket.broken.store(false, Ordering::SeqCst);
    hub.system(vec![SystemChangeKind::ConfigChanged]);
    assert_eq!(hub.plugin_signal("tasks", "updated", Value::Null), 1);
    assert_eq!(broken.count(), 0);
    hub.receive(broken.id, r#"{"type":"ping"}"#);
    assert_eq!(broken.count(), 0);
}

#[tokio::test]
async fn routes_changes_to_list_and_detail_subscribers_once() {
    let hub = Hub::new();
    let changed = Arc::new(Mutex::new(Vec::new()));
    let sink = changed.clone();
    let guard = hub.on_changed(move |message: &ChangedMessage| {
        sink.lock().push(serde_json::to_value(message).unwrap());
    });
    let both = hub_client(
        &hub,
        &[json!({"kind": "thread-list"}), json!({"kind": "thread-detail", "threadId": "t"})],
    );
    let hosts = hub_client(&hub, &[json!({"kind": "host-list"})]);
    let system = hub_client(&hub, &[json!({"kind": "system"})]);
    hub.thread("t", vec![ThreadChangeKind::TitleChanged], None);
    hub.host("h", vec![HostChangeKind::HostConnected]);
    hub.system(vec![SystemChangeKind::PluginsChanged]);
    assert_eq!(both.count(), 1);
    assert_eq!(
        hosts.sent(),
        vec![json!({"type": "changed", "entity": "host", "id": "h",
            "changes": ["host-connected"]})]
    );
    assert_eq!(
        system.sent(),
        vec![json!({"type": "changed", "entity": "system", "changes": ["plugins-changed"]})]
    );
    assert_eq!(changed.lock().len(), 3);
    drop(guard);
    hub.system(vec![SystemChangeKind::PluginsChanged]);
    assert_eq!(changed.lock().len(), 3);
}

#[tokio::test]
async fn thread_open_reaches_every_socket() {
    let hub = Hub::new();
    let first = hub_client(&hub, &[]);
    let second = hub_client(&hub, &[json!({"kind": "system"})]);
    let delivered = hub.thread_open(ThreadOpenSignal {
        project_id: "p".into(),
        thread_id: "t".into(),
        split: ThreadOpenSplit::Down,
        file: None,
    });
    assert_eq!(delivered, 2);
    let expected = json!({"type": "thread-open", "projectId": "p", "threadId": "t",
        "split": "down", "file": null});
    assert_eq!((first.sent(), second.sent()), (vec![expected.clone()], vec![expected]));
}
