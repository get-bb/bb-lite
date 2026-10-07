use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::ProviderId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
    Reliable,
    Live,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum RunnerEventBody {
    #[serde(rename = "thread.events", rename_all = "camelCase")]
    ThreadEvents { thread_id: String, events: Vec<Value> },
    #[serde(rename = "interaction.requested", rename_all = "camelCase")]
    InteractionRequested {
        thread_id: String,
        turn_id: Option<String>,
        request_id: String,
        provider_id: ProviderId,
        provider_thread_id: String,
        payload: Value,
    },
    #[serde(rename = "interaction.cancelled", rename_all = "camelCase")]
    InteractionCancelled { thread_id: String, request_id: String, reason: String },
    #[serde(rename = "toolCall.requested", rename_all = "camelCase")]
    ToolCallRequested {
        thread_id: String,
        turn_id: Option<String>,
        request_id: String,
        call_id: String,
        tool: String,
        #[serde(default)]
        arguments: Value,
    },
    #[serde(rename = "toolCall.cancelled", rename_all = "camelCase")]
    ToolCallCancelled { thread_id: String, request_id: String },
    #[serde(rename = "script.output", rename_all = "camelCase")]
    ScriptOutput { operation_id: String, text: String },
    #[serde(rename = "terminal.output", rename_all = "camelCase")]
    TerminalOutput { terminal_id: String, data_base64: String },
    #[serde(rename = "terminal.exited", rename_all = "camelCase")]
    TerminalExited { terminal_id: String, exit_code: Option<i32> },
    #[serde(rename = "workspace.changed", rename_all = "camelCase")]
    WorkspaceChanged { path: String, change: String },
}

impl RunnerEventBody {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ThreadEvents { .. } => "thread.events",
            Self::InteractionRequested { .. } => "interaction.requested",
            Self::InteractionCancelled { .. } => "interaction.cancelled",
            Self::ToolCallRequested { .. } => "toolCall.requested",
            Self::ToolCallCancelled { .. } => "toolCall.cancelled",
            Self::ScriptOutput { .. } => "script.output",
            Self::TerminalOutput { .. } => "terminal.output",
            Self::TerminalExited { .. } => "terminal.exited",
            Self::WorkspaceChanged { .. } => "workspace.changed",
        }
    }

    pub fn is_reliable(&self) -> bool {
        !matches!(
            self,
            Self::TerminalOutput { .. }
                | Self::TerminalExited { .. }
                | Self::WorkspaceChanged { .. }
        )
    }
}

/// One event from a runner. `seq` is the runner-wide sequence of a reliable
/// event; on a live `terminal.output` it is that terminal's chunk sequence.
/// A reliable event without `seq` has not been through the outbox yet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerEvent {
    pub lane: Lane,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(flatten)]
    pub body: RunnerEventBody,
}

impl RunnerEvent {
    pub fn unsequenced(body: RunnerEventBody) -> Self {
        let lane = if body.is_reliable() { Lane::Reliable } else { Lane::Live };
        Self { lane, seq: None, body }
    }

    pub fn reliable(seq: u64, body: RunnerEventBody) -> Self {
        Self { lane: Lane::Reliable, seq: Some(seq), body }
    }

    pub fn terminal_output(terminal_id: String, seq: u64, data_base64: String) -> Self {
        let body = RunnerEventBody::TerminalOutput { terminal_id, data_base64 };
        Self { lane: Lane::Live, seq: Some(seq), body }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reliable_event_round_trips() {
        let wire = json!({
            "lane": "reliable", "seq": 7, "kind": "interaction.requested",
            "threadId": "thr_1", "turnId": null, "requestId": "r1",
            "providerId": "claude-code", "providerThreadId": "p1", "payload": {"a": 1}
        });
        let event: RunnerEvent = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(event.seq, Some(7));
        assert_eq!(serde_json::to_value(&event).unwrap(), wire);
    }

    #[test]
    fn terminal_output_keeps_its_own_seq() {
        let event = RunnerEvent::terminal_output("term_1".into(), 3, "aGk=".into());
        let wire = json!({"lane": "live", "seq": 3, "kind": "terminal.output", "terminalId": "term_1", "dataBase64": "aGk="});
        assert_eq!(serde_json::to_value(&event).unwrap(), wire);
    }
}
