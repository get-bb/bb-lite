//! Port of `packages/domain/src/change-kinds.ts` and the realtime message shapes the WebSocket
//! hub sends and receives.

use serde::de::Error as _;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

macro_rules! change_kinds {
    ($name:ident { $($variant:ident = $value:literal,)+ }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $value)] $variant,)+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value,)+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($value => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

change_kinds!(ThreadChangeKind {
    ThreadCreated = "thread-created",
    ThreadDeleted = "thread-deleted",
    EventsAppended = "events-appended",
    HistoryRewritten = "history-rewritten",
    InteractionsChanged = "interactions-changed",
    StatusChanged = "status-changed",
    TitleChanged = "title-changed",
    QueueChanged = "queue-changed",
    ArchivedChanged = "archived-changed",
    PinStateChanged = "pin-state-changed",
    ParentChanged = "parent-changed",
    EnvironmentChanged = "environment-changed",
    ReadStateChanged = "read-state-changed",
    TabsChanged = "tabs-changed",
    TerminalsChanged = "terminals-changed",
});

change_kinds!(ProjectChangeKind {
    ProjectCreated = "project-created",
    ProjectUpdated = "project-updated",
    ProjectDeleted = "project-deleted",
    ProjectSourcesChanged = "project-sources-changed",
    ThreadsChanged = "threads-changed",
});

change_kinds!(EnvironmentChangeKind {
    EnvironmentCreated = "environment-created",
    EnvironmentDeleted = "environment-deleted",
    MetadataChanged = "metadata-changed",
    StatusChanged = "status-changed",
    WorkStatusChanged = "work-status-changed",
    GitRefsChanged = "git-refs-changed",
});

change_kinds!(HostChangeKind {
    HostConnected = "host-connected",
    HostDisconnected = "host-disconnected",
    ProviderModelCatalogChanged = "provider-model-catalog-changed",
});

change_kinds!(SystemChangeKind {
    ConfigChanged = "config-changed",
    PluginsChanged = "plugins-changed",
    UiPreferencesChanged = "ui-preferences-changed",
});

/// `statusChange` of a thread notice. `runtime` and `activity` carry the thread's
/// `ThreadRuntimeState` and `ThreadActivityState` JSON.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadStatusChange {
    pub status: String,
    pub runtime: Value,
    pub activity: Value,
    pub latest_attention_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadChangeMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_activity_changed: Option<bool>,
    /// Thread event type names (`ThreadEventType`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_types: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_pending_interaction: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_change: Option<Box<ThreadStatusChange>>,
}

/// `{type: "changed", entity, id?, changes, metadata?}`.
#[derive(Clone, Debug, PartialEq)]
pub enum ChangedMessage {
    Thread { id: String, changes: Vec<ThreadChangeKind>, metadata: Option<ThreadChangeMetadata> },
    Project { id: String, changes: Vec<ProjectChangeKind> },
    Environment { id: String, changes: Vec<EnvironmentChangeKind> },
    Host { id: String, changes: Vec<HostChangeKind> },
    System { changes: Vec<SystemChangeKind> },
}

impl ChangedMessage {
    pub fn entity(&self) -> &'static str {
        match self {
            Self::Thread { .. } => "thread",
            Self::Project { .. } => "project",
            Self::Environment { .. } => "environment",
            Self::Host { .. } => "host",
            Self::System { .. } => "system",
        }
    }

    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Thread { id, .. }
            | Self::Project { id, .. }
            | Self::Environment { id, .. }
            | Self::Host { id, .. } => Some(id),
            Self::System { .. } => None,
        }
    }
}

impl Serialize for ChangedMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("type", "changed")?;
        map.serialize_entry("entity", self.entity())?;
        if let Some(id) = self.id() {
            map.serialize_entry("id", id)?;
        }
        match self {
            Self::Thread { changes, metadata, .. } => {
                map.serialize_entry("changes", changes)?;
                if let Some(metadata) = metadata {
                    map.serialize_entry("metadata", metadata)?;
                }
            }
            Self::Project { changes, .. } => map.serialize_entry("changes", changes)?,
            Self::Environment { changes, .. } => map.serialize_entry("changes", changes)?,
            Self::Host { changes, .. } => map.serialize_entry("changes", changes)?,
            Self::System { changes } => map.serialize_entry("changes", changes)?,
        }
        map.end()
    }
}

/// `realtimeSubscriptionTargetSchema`: strict objects discriminated by `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RealtimeSubscriptionTarget {
    #[serde(rename_all = "camelCase")]
    ThreadDetail {
        thread_id: String,
    },
    ThreadList,
    ProjectList,
    #[serde(rename_all = "camelCase")]
    EnvironmentDetail {
        environment_id: String,
    },
    EnvironmentList,
    HostList,
    System,
}

impl RealtimeSubscriptionTarget {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ThreadDetail { .. } => "thread-detail",
            Self::ThreadList => "thread-list",
            Self::ProjectList => "project-list",
            Self::EnvironmentDetail { .. } => "environment-detail",
            Self::EnvironmentList => "environment-list",
            Self::HostList => "host-list",
            Self::System => "system",
        }
    }

    /// `realtimeSubscriptionTargetKey`: `kind`, or `kind:id` for a scoped target.
    pub fn key(&self) -> String {
        match self {
            Self::ThreadDetail { thread_id: id }
            | Self::EnvironmentDetail { environment_id: id } => {
                format!("{}:{id}", self.kind())
            }
            _ => self.kind().to_owned(),
        }
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let scoped = |field: &str| -> Option<String> {
            if object.len() != 2 {
                return None;
            }
            let id = object.get(field)?.as_str()?;
            (!id.is_empty()).then(|| id.to_owned())
        };
        let unscoped = |target: Self| (object.len() == 1).then_some(target);
        match object.get("kind")?.as_str()? {
            "thread-detail" => scoped("threadId").map(|thread_id| Self::ThreadDetail { thread_id }),
            "thread-list" => unscoped(Self::ThreadList),
            "project-list" => unscoped(Self::ProjectList),
            "environment-detail" => scoped("environmentId")
                .map(|environment_id| Self::EnvironmentDetail { environment_id }),
            "environment-list" => unscoped(Self::EnvironmentList),
            "host-list" => unscoped(Self::HostList),
            "system" => unscoped(Self::System),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for RealtimeSubscriptionTarget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(&value).ok_or_else(|| D::Error::custom("invalid subscription target"))
    }
}

/// `clientMessageSchema`: what a browser sends over the realtime socket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMessage {
    Subscribe { target: RealtimeSubscriptionTarget },
    Unsubscribe { target: RealtimeSubscriptionTarget },
    Ping,
}

impl ClientMessage {
    pub fn from_value(value: &Value) -> Option<Self> {
        let object: &Map<String, Value> = value.as_object()?;
        let target = || RealtimeSubscriptionTarget::from_value(object.get("target")?);
        match object.get("type")?.as_str()? {
            "subscribe" => target().map(|target| Self::Subscribe { target }),
            "unsubscribe" => target().map(|target| Self::Unsubscribe { target }),
            "ping" => Some(Self::Ping),
            _ => None,
        }
    }

    /// `parseFrame(clientMessageSchema, raw)`: `None` for anything the schema rejects.
    pub fn parse(raw: &str) -> Option<Self> {
        Self::from_value(&serde_json::from_str::<Value>(raw).ok()?)
    }
}

impl<'de> Deserialize<'de> for ClientMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(&value).ok_or_else(|| D::Error::custom("invalid client message"))
    }
}

/// `{type: "pong"}`, the answer to a ping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "pong")]
pub struct PongMessage {}

/// `pluginSignalSchema`: `{type: "plugin-signal", pluginId, channel, payload}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename = "plugin-signal", rename_all = "camelCase")]
pub struct PluginSignal {
    pub plugin_id: String,
    pub channel: String,
    pub payload: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PanelFileSource {
    Workspace,
    ThreadStorage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadOpenSplit {
    Right,
    Down,
    Left,
    Top,
    Replace,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadOpenFile {
    pub source: PanelFileSource,
    pub path: String,
    pub line_number: Option<u64>,
}

/// `threadOpenSignalSchema` without its `type`; serializes with `type: "thread-open"` first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "thread-open", rename_all = "camelCase")]
pub struct ThreadOpenSignal {
    pub project_id: String,
    pub thread_id: String,
    pub split: ThreadOpenSplit,
    pub file: Option<ThreadOpenFile>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn changed_messages_serialize_like_typescript() {
        let thread = ChangedMessage::Thread {
            id: "thr_1".into(),
            changes: vec![ThreadChangeKind::EventsAppended, ThreadChangeKind::PinStateChanged],
            metadata: Some(ThreadChangeMetadata {
                event_types: Some(vec!["turn/completed".into()]),
                project_id: Some("p1".into()),
                ..Default::default()
            }),
        };
        assert_eq!(
            serde_json::to_string(&thread).unwrap(),
            r#"{"type":"changed","entity":"thread","id":"thr_1","changes":["events-appended","pin-state-changed"],"metadata":{"eventTypes":["turn/completed"],"projectId":"p1"}}"#
        );
        let system =
            ChangedMessage::System { changes: vec![SystemChangeKind::UiPreferencesChanged] };
        assert_eq!(
            serde_json::to_string(&system).unwrap(),
            r#"{"type":"changed","entity":"system","changes":["ui-preferences-changed"]}"#
        );
        let host = ChangedMessage::Host {
            id: "h".into(),
            changes: vec![HostChangeKind::ProviderModelCatalogChanged],
        };
        assert_eq!(
            serde_json::to_value(&host).unwrap(),
            json!({"type": "changed", "entity": "host", "id": "h",
                "changes": ["provider-model-catalog-changed"]})
        );
        for kind in EnvironmentChangeKind::ALL {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
        }
    }

    #[test]
    fn signals_serialize_with_their_type_first() {
        let signal = PluginSignal {
            plugin_id: "tasks".into(),
            channel: "c".into(),
            payload: json!({"a": 1}),
        };
        assert_eq!(
            serde_json::to_string(&signal).unwrap(),
            r#"{"type":"plugin-signal","pluginId":"tasks","channel":"c","payload":{"a":1}}"#
        );
        let open = ThreadOpenSignal {
            project_id: "p".into(),
            thread_id: "t".into(),
            split: ThreadOpenSplit::Right,
            file: Some(ThreadOpenFile {
                source: PanelFileSource::ThreadStorage,
                path: "a.md".into(),
                line_number: None,
            }),
        };
        assert_eq!(
            serde_json::to_string(&open).unwrap(),
            r#"{"type":"thread-open","projectId":"p","threadId":"t","split":"right","file":{"source":"thread-storage","path":"a.md","lineNumber":null}}"#
        );
        assert_eq!(serde_json::to_string(&PongMessage {}).unwrap(), r#"{"type":"pong"}"#);
    }

    #[test]
    fn client_messages_parse_like_the_zod_schema() {
        let detail = RealtimeSubscriptionTarget::ThreadDetail { thread_id: "thr_1".into() };
        assert_eq!(
            ClientMessage::parse(
                r#"{"type":"subscribe","target":{"kind":"thread-detail","threadId":"thr_1"}}"#
            ),
            Some(ClientMessage::Subscribe { target: detail.clone() })
        );
        assert_eq!(detail.key(), "thread-detail:thr_1");
        assert_eq!(RealtimeSubscriptionTarget::HostList.key(), "host-list");
        assert_eq!(ClientMessage::parse(r#"{"type":"ping","extra":1}"#), Some(ClientMessage::Ping));
        assert_eq!(
            ClientMessage::parse(
                r#"{"type":"unsubscribe","target":{"kind":"environment-detail","environmentId":"e"}}"#
            ),
            Some(ClientMessage::Unsubscribe {
                target: RealtimeSubscriptionTarget::EnvironmentDetail {
                    environment_id: "e".into()
                }
            })
        );
        let rejected = [
            "not json",
            "[]",
            r#"{"type":"pong"}"#,
            r#"{"type":"subscribe"}"#,
            r#"{"type":"subscribe","target":{"kind":"thread-detail","threadId":""}}"#,
            r#"{"type":"subscribe","target":{"kind":"thread-detail"}}"#,
            r#"{"type":"subscribe","target":{"kind":"thread-detail","threadId":7}}"#,
            r#"{"type":"subscribe","target":{"kind":"thread-list","extra":1}}"#,
            r#"{"type":"subscribe","target":{"kind":"thread-detail","threadId":"a","x":1}}"#,
            r#"{"type":"subscribe","target":{"kind":"nope"}}"#,
            r#"{"type":"subscribe","target":"thread-list"}"#,
        ];
        for raw in rejected {
            assert_eq!(ClientMessage::parse(raw), None, "{raw}");
        }
        let target: RealtimeSubscriptionTarget =
            serde_json::from_value(json!({"kind": "system"})).unwrap();
        assert_eq!(serde_json::to_value(&target).unwrap(), json!({"kind": "system"}));
        assert_eq!(
            serde_json::to_value(&detail).unwrap(),
            json!({"kind": "thread-detail", "threadId": "thr_1"})
        );
    }
}
