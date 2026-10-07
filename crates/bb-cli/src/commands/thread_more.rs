use serde_json::{Map, Value, json};

use crate::call::{
    Call, CliResult, Handler, Output, clip, confirm, not_implemented, parse_json, thread_target,
    usage_error, valid_id,
};
use crate::http::encode;
use crate::render::{queue_wait, shown, text};

/// Handlers ported from `apps/cli/src/commands/thread-more.ts`.
pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("threadInteractionsList", not_implemented),
        ("threadInteractionsShow", thread_interactions_show),
        ("threadInteractionsResolve", thread_interactions_resolve),
        ("threadQueueList", thread_queue_list),
        ("threadQueueSend", thread_queue_send),
        ("threadQueueDelete", thread_queue_delete),
        ("threadSectionList", thread_section_list),
        ("threadSectionCreate", thread_section_create),
        ("threadSectionRename", thread_section_rename),
        ("threadSectionDelete", thread_section_delete),
    ]
}

fn field(value: &Value, key: &str) -> String {
    value.get(key).map(shown).unwrap_or_else(|| "undefined".into())
}

fn interaction_path(call: &Call) -> CliResult<String> {
    let interaction_id = valid_id(call.arg("interactionId")?, "<interactionId>")?;
    let thread_id = thread_target(call)?;
    Ok(format!("/threads/{}/interactions/{}", encode(&thread_id), encode(&interaction_id)))
}

fn thread_interactions_show(call: &mut Call) -> CliResult<Output> {
    let path = interaction_path(call)?;
    Ok(Output::json(call.http.get(&path, &[])?))
}

fn payload_kind(interaction: &Value) -> Option<&str> {
    interaction.get("payload").and_then(|payload| text(payload, "kind"))
}

fn user_answer(call: &Call, interaction: &Value) -> CliResult<Value> {
    if payload_kind(interaction) != Some("user_question") {
        let id = field(interaction, "id");
        return Err(usage_error(format!("Interaction {id} is not a question.")));
    }
    let questions = interaction["payload"]["questions"].as_array().cloned().unwrap_or_default();
    let id_of = |question: &Value| text(question, "id").unwrap_or("").to_string();
    let mut answers = Map::new();
    let mut record = |raw: &str, free_text: bool| -> CliResult<()> {
        let id = raw.split('=').next().unwrap_or("");
        let named = questions.iter().find(|question| id_of(question) == id);
        let only = (questions.len() == 1).then(|| &questions[0]);
        let Some(question) = named.or(only) else {
            let ids: Vec<String> = questions.iter().map(id_of).collect();
            let ids = ids.join(", ");
            return Err(usage_error(format!("'{raw}' must start with a question ID: {ids}.")));
        };
        let value = match named {
            Some(named) => raw.get(id_of(named).len() + 1..).unwrap_or("").to_string(),
            None => raw.to_string(),
        };
        let answer = answers.entry(id_of(question)).or_insert_with(|| json!({ "selected": [] }));
        if free_text {
            answer["freeText"] = json!(value);
        } else if let Some(selected) = answer["selected"].as_array_mut() {
            selected.push(json!(value));
        }
        Ok(())
    };
    for raw in call.list("answer")? {
        record(&raw, false)?;
    }
    for raw in call.list("text")? {
        record(&raw, true)?;
    }
    Ok(json!({ "kind": "user_answer", "answers": answers }))
}

fn approval_resolution(interaction: &Value, decision: &str) -> Value {
    if decision == "deny" {
        return json!({ "decision": decision });
    }
    if payload_kind(interaction) != Some("approval") {
        return json!({ "decision": decision, "grantedPermissions": null });
    }
    let subject = &interaction["payload"]["subject"];
    let subject_kind = text(subject, "kind").unwrap_or("");
    if subject_kind == "permission_grant" {
        let permissions = &subject["permissions"];
        let network = permissions.get("network").filter(|n| n["enabled"] == json!(true));
        let file_system = permissions.get("fileSystem").filter(|f| !f.is_null());
        let granted = json!({
            "network": network.map(|_| json!({ "enabled": true })),
            "fileSystem": file_system.map(|f| json!({ "read": f["read"], "write": f["write"] })),
        });
        return json!({ "decision": decision, "grantedPermissions": granted });
    }
    let grants_session = decision == "allow_for_session"
        && (subject_kind == "command" || subject_kind == "file_change");
    let granted = if grants_session { subject["sessionGrant"].clone() } else { Value::Null };
    json!({ "decision": decision, "grantedPermissions": granted })
}

fn resolution(call: &Call, interaction: &Value) -> CliResult<Value> {
    let grant = call.choice("grant", &["turn", "session"])?;
    let answering = call.on("answer")? || call.on("text")?;
    let ways = [call.on("approve")?, call.on("deny")?, grant.is_some(), answering];
    if ways.iter().filter(|way| **way).count() != 1 {
        let choices = "--approve, --deny, --grant, --answer/--text or --value";
        return Err(usage_error(format!("Provide exactly one of {choices}.")));
    }
    if answering {
        return user_answer(call, interaction);
    }
    let id = field(interaction, "id");
    if payload_kind(interaction) != Some("approval") {
        let hint = "Use --answer or --text for a question, --value for a form.";
        return Err(usage_error(format!("Interaction {id} is not an approval.")).hint(hint));
    }
    let offered = interaction["payload"]["availableDecisions"].as_array().cloned();
    let offered: Vec<String> = offered.unwrap_or_default().iter().map(shown).collect();
    let wanted: &[&str] = match (call.on("deny")?, grant) {
        (true, _) => &["deny"],
        (_, Some("session")) => &["allow_for_session"],
        (_, Some(_)) => &["allow_once"],
        _ => &["allow_once", "allow_for_session"],
    };
    let Some(decision) = wanted.iter().find(|w| offered.iter().any(|o| o == *w)) else {
        let available = offered.join(", ");
        return Err(usage_error(format!("Interaction {id} offers: {available}.")));
    };
    Ok(approval_resolution(interaction, decision))
}

fn thread_interactions_resolve(call: &mut Call) -> CliResult<Output> {
    let path = interaction_path(call)?;
    let updated = match call.flag("value")? {
        None => {
            let interaction = call.http.get(&path, &[])?;
            let resolved = resolution(call, &interaction)?;
            call.http.post(&format!("{path}/resolve"), &resolved)?
        }
        Some(raw) => {
            let value = parse_json(&raw, "--value")?;
            call.http.post(&format!("{path}/respond"), &json!({ "value": value }))?
        }
    };
    let state = if text(&updated, "status") == Some("resolving") {
        "submitted; delivering to the provider"
    } else {
        "resolved"
    };
    let text = format!("Interaction {} {state}", field(&updated, "id"));
    Ok(Output::text(updated, text))
}

fn thread_queue_list(call: &mut Call) -> CliResult<Output> {
    let thread_id = thread_target(call)?;
    let queued = call.http.get(&format!("/threads/{}/queued-messages", encode(&thread_id)), &[])?;
    let rows: Vec<Value> = queued
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|row| {
            let blocks = row.get("content").and_then(Value::as_array);
            let texts: Vec<&str> = blocks
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter(|block| text(block, "type") == Some("text"))
                .map(|block| text(block, "text").unwrap_or(""))
                .collect();
            let waiting = match row.get("failureReason").filter(|f| !f.is_null()) {
                None => queue_wait(row),
                Some(failed) => format!("Failed: {}", shown(failed)),
            };
            let joined = texts.join(" ");
            let message = clip(if joined.is_empty() { "(no text)" } else { &joined }, 40);
            let id = row.get("id").cloned().unwrap_or(Value::Null);
            let thread = row.get("threadId").cloned().unwrap_or(Value::Null);
            json!({ "id": id, "thread": thread, "message": message, "waiting": waiting })
        })
        .collect();
    Ok(Output::rows(&rows, &["id", "thread", "message", "waiting"], queued))
}

fn queued_message(call: &Call) -> CliResult<(String, String)> {
    let thread_id = valid_id(call.arg("threadId")?, "<threadId> argument")?;
    let message_id = valid_id(call.arg("messageId")?, "<messageId> argument")?;
    Ok((thread_id, message_id))
}

fn queued_data(thread_id: &str, message_id: &str, result: Value) -> Value {
    let mut data = Map::new();
    data.insert("threadId".into(), json!(thread_id));
    data.insert("queuedMessageId".into(), json!(message_id));
    if let Value::Object(fields) = result {
        data.extend(fields);
    }
    Value::Object(data)
}

fn queued_path(thread_id: &str, message_id: &str) -> String {
    format!("/threads/{}/queued-messages/{}", encode(thread_id), encode(message_id))
}

fn thread_queue_send(call: &mut Call) -> CliResult<Output> {
    let (thread_id, message_id) = queued_message(call)?;
    let mode = call.choice("mode", &["auto", "steer"])?.unwrap_or("auto");
    let path = format!("{}/send", queued_path(&thread_id, &message_id));
    let result = call.http.post(&path, &json!({ "mode": mode }))?;
    let text = format!("Queued message {message_id} {}", field(&result, "delivery"));
    Ok(Output::text(queued_data(&thread_id, &message_id, result), text))
}

fn thread_queue_delete(call: &mut Call) -> CliResult<Output> {
    let (thread_id, message_id) = queued_message(call)?;
    call.http.delete(&queued_path(&thread_id, &message_id), &[])?;
    let text = format!("Queued message {message_id} deleted");
    Ok(Output::text(queued_data(&thread_id, &message_id, json!({ "ok": true })), text))
}

fn thread_section_list(call: &mut Call) -> CliResult<Output> {
    let sections = call.http.get("/thread-sections", &[])?;
    let rows = sections.as_array().cloned().unwrap_or_default();
    Ok(Output::rows(&rows, &["id", "name"], sections))
}

fn thread_section_create(call: &mut Call) -> CliResult<Output> {
    let name = call.arg("name")?.to_string();
    let section = call.http.post("/thread-sections", &json!({ "name": name }))?;
    let text = format!("Section {} created", field(&section, "id"));
    Ok(Output::text(section, text))
}

fn thread_section_rename(call: &mut Call) -> CliResult<Output> {
    let change = json!({ "id": call.arg("id")?, "name": call.arg("name")? });
    let section = call.http.patch("/thread-sections", &change)?;
    let text = format!("Section {} renamed to {}", field(&section, "id"), field(&section, "name"));
    Ok(Output::text(section, text))
}

fn thread_section_delete(call: &mut Call) -> CliResult<Output> {
    let id = call.arg("id")?.to_string();
    confirm(call, &format!("Delete section {id}? Its threads stay, unsectioned."))?;
    let body = json!({ "id": id });
    let result = call.http.request("DELETE", "/thread-sections", &[], Some(&body))?;
    let moved = format!("{} thread(s) unsectioned", field(&result, "updatedThreadCount"));
    let text = format!("Section {} deleted; {moved}", field(&result, "id"));
    Ok(Output::text(result, text))
}
