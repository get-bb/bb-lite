//! `client/turn/requested` and provider `userMessage` events into user messages: the port of
//! `user-message-parsing.ts`.

use std::collections::HashMap;

use serde_json::Value;

use crate::event::{self, EventScope, field, str_field};
use crate::format::{message_id, parse_agent_message_envelope};
use crate::rows::{
    ConversationAttachments, ConversationTurnRequest, TurnRequestKind, TurnRequestStatus,
    UserConversationFields, UserRoleTag,
};
use crate::types::{EventMeta, MessageBase, ThreadEventWithMeta, UserMessage};

/// `AcceptedClientRequest`: the `turn/input/accepted` event that accepted a client request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedClientRequest {
    pub meta: EventMeta,
    pub turn_id: String,
}

/// `buildAcceptedClientRequestById`: the first acceptance of each client request id.
pub fn build_accepted_client_request_by_id(
    events: &[ThreadEventWithMeta],
) -> HashMap<String, AcceptedClientRequest> {
    let mut accepted_by_id = HashMap::new();
    for ThreadEventWithMeta { event, meta } in events {
        if event::event_type(event) != "turn/input/accepted" {
            continue;
        }
        let (Some(turn_id), Some(client_request_id)) =
            (event::turn_id(event), event::client_request_id(event))
        else {
            continue;
        };
        accepted_by_id.entry(client_request_id.to_string()).or_insert_with(|| {
            AcceptedClientRequest { meta: meta.clone(), turn_id: turn_id.to_string() }
        });
    }
    accepted_by_id
}

/// The result of [`parse_prompt_input`]; `mentions` are `PromptTextMention` JSON with offsets
/// (UTF-16) into `text`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedPromptInput {
    pub text: String,
    pub mentions: Vec<Value>,
    pub attachments: ConversationAttachments,
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn offset_value(original: &Value, offset: f64) -> Value {
    if original.is_i64() || original.is_u64() || offset.fract() == 0.0 {
        Value::from(offset as i64)
    } else {
        Value::from(offset)
    }
}

/// `parsePromptInput`: the visible text, its mentions and the attachments of one input group;
/// `None` when it has neither text nor attachments.
pub fn parse_prompt_input(input: &[Value]) -> Option<ParsedPromptInput> {
    let mut text = String::new();
    let mut text_length = 0usize;
    let mut mentions = Vec::new();
    let mut attachments = ConversationAttachments::default();
    for part in input {
        if str_field(part, "visibility") == Some("agent-only") {
            continue;
        }
        match str_field(part, "type") {
            Some("text") => {
                let part_text = str_field(part, "text").unwrap_or_default();
                let part_length = utf16_len(part_text);
                for mention in event::array_field(part, "mentions").into_iter().flatten() {
                    let start = field(mention, "start").and_then(Value::as_f64);
                    let end = field(mention, "end").and_then(Value::as_f64);
                    let (Some(start), Some(end)) = (start, end) else { continue };
                    if start >= 0.0 && end > start && end <= part_length as f64 {
                        let mut next = mention.clone();
                        if let Some(object) = next.as_object_mut() {
                            let shift = text_length as f64;
                            let start_value = offset_value(&object["start"], shift + start);
                            let end_value = offset_value(&object["end"], shift + end);
                            object.insert("start".into(), start_value);
                            object.insert("end".into(), end_value);
                        }
                        mentions.push(next);
                    }
                }
                text.push_str(part_text);
                text_length += part_length;
            }
            Some("image") => {
                attachments.web_images += 1;
                if let Some(url) = event::non_empty_str_field(part, "url") {
                    attachments.image_urls.push(url.to_string());
                }
            }
            Some("localImage") => {
                attachments.local_images += 1;
                if let Some(path) = event::non_empty_str_field(part, "path") {
                    attachments.local_image_paths.push(path.to_string());
                }
            }
            Some("localFile") => {
                attachments.local_files += 1;
                if let Some(path) = event::non_empty_str_field(part, "path") {
                    attachments.local_file_paths.push(path.to_string());
                }
            }
            _ => {}
        }
    }
    let attached = attachments.web_images + attachments.local_images + attachments.local_files;
    if text.is_empty() && attached == 0 {
        return None;
    }
    Some(ParsedPromptInput { text, mentions, attachments })
}

/// `shouldPreservePendingMessages`.
pub fn should_preserve_pending_messages(thread_status: &str) -> bool {
    matches!(thread_status, "starting" | "active" | "pending")
}

fn expected_turn_id(event: &Value) -> Option<&str> {
    field(event, "target").and_then(|target| str_field(target, "expectedTurnId"))
}

/// `turnRequestKind`: a steer targets the turn it expected, unless another turn accepted it.
pub fn turn_request_kind(
    event: &Value,
    accepted_client_request: Option<&AcceptedClientRequest>,
) -> TurnRequestKind {
    match expected_turn_id(event) {
        None => TurnRequestKind::Message,
        Some(expected) => match accepted_client_request {
            Some(accepted) if accepted.turn_id != expected => TurnRequestKind::Message,
            _ => TurnRequestKind::Steer,
        },
    }
}

/// `clientRequestUserMessages`: one user message per non-empty input group of a
/// `client/turn/requested` event.
pub fn client_request_user_messages(
    event: &Value,
    meta: &EventMeta,
    status: TurnRequestStatus,
    accepted_client_request: Option<&AcceptedClientRequest>,
) -> Vec<UserMessage> {
    let target_kind = field(event, "target").and_then(|target| str_field(target, "kind"));
    let target_turn_id = if target_kind == Some("thread-start") {
        None
    } else {
        accepted_client_request
            .map(|accepted| accepted.turn_id.as_str())
            .or(expected_turn_id(event))
    };
    let kind = turn_request_kind(event, accepted_client_request);
    let row_meta = match accepted_client_request {
        Some(accepted) if kind == TurnRequestKind::Steer => &accepted.meta,
        _ => meta,
    };
    let thread_id = event::thread_id(event).unwrap_or_default();
    let input_groups = field(event, "inputGroups");
    let groups: Vec<&[Value]> = match input_groups.and_then(Value::as_array) {
        Some(groups) => {
            groups.iter().map(|group| group.as_array().map_or(&[][..], Vec::as_slice)).collect()
        }
        None => {
            vec![event::array_field(event, "input").map_or(&[][..], Vec::as_slice)]
        }
    };
    let scope = match target_turn_id {
        Some(turn_id) if !turn_id.is_empty() => EventScope::Turn { turn_id: turn_id.to_string() },
        _ => event::scope_or_thread(event),
    };
    let event_initiator = event::initiator(event).unwrap_or_default();
    let mut messages = Vec::new();
    for input in groups {
        let Some(parsed) = parse_prompt_input(input) else { continue };
        let envelope = parse_agent_message_envelope(&parsed.text);
        let initiator =
            if event_initiator == "user" && envelope.is_some() { "agent" } else { event_initiator };
        let suffix =
            if messages.is_empty() { String::new() } else { format!("-{}", messages.len()) };
        let sender_thread_id = event::sender_thread_id(event).map(str::to_string).or_else(|| {
            if initiator == "agent" { envelope.map(|e| e.sender_thread_id) } else { None }
        });
        messages.push(UserMessage {
            base: MessageBase {
                id: message_id(thread_id, "user-seed", &format!("{}{suffix}", meta.seq)),
                thread_id: thread_id.to_string(),
                source_seq_start: row_meta.seq,
                source_seq_end: row_meta.seq,
                created_at: row_meta.created_at,
                scope: scope.clone(),
                started_at: None,
                parent_tool_call_id: None,
            },
            text: parsed.text,
            attachments: Some(parsed.attachments),
            fields: UserConversationFields {
                role: UserRoleTag,
                initiator: initiator.to_string(),
                sender_thread_id,
                system_message_kind: event::system_message_kind(event)
                    .unwrap_or("unlabeled")
                    .to_string(),
                system_message_subject: event::system_message_subject(event).cloned(),
                turn_request: ConversationTurnRequest {
                    is_grouped: input_groups.is_some(),
                    kind,
                    status,
                },
                mentions: parsed.mentions,
            },
        });
    }
    messages
}

/// `parseProviderUserMessage`: a provider-reported `userMessage` item with text.
pub fn parse_provider_user_message(event: &Value, meta: &EventMeta) -> Option<UserMessage> {
    if event::event_type(event) != "item/completed" {
        return None;
    }
    let item = event::item(event)?;
    if event::item_type(item) != Some("userMessage") {
        return None;
    }
    let text: String = event::array_field(item, "content")
        .into_iter()
        .flatten()
        .filter(|part| str_field(part, "type") == Some("text"))
        .filter_map(|part| str_field(part, "text"))
        .collect();
    if text.is_empty() {
        return None;
    }
    let item_id = event::item_id(item).unwrap_or_default();
    let thread_id = event::thread_id(event).unwrap_or_default();
    Some(UserMessage {
        base: MessageBase {
            id: message_id(thread_id, "provider-input", item_id),
            thread_id: thread_id.to_string(),
            source_seq_start: meta.seq,
            source_seq_end: meta.seq,
            created_at: meta.created_at,
            scope: event::scope_or_thread(event),
            started_at: None,
            parent_tool_call_id: event::item_parent_tool_call_id(item)
                .filter(|id| !id.is_empty())
                .map(str::to_string),
        },
        text,
        attachments: None,
        fields: UserConversationFields {
            role: UserRoleTag,
            initiator: "system".into(),
            sender_thread_id: None,
            system_message_kind: "unlabeled".into(),
            system_message_subject: None,
            turn_request: ConversationTurnRequest {
                is_grouped: false,
                kind: TurnRequestKind::Steer,
                status: TurnRequestStatus::Accepted,
            },
            mentions: Vec::new(),
        },
    })
}
