//! zod-equivalent checks of the thread message requests (`sendMessageRequestSchema`, the
//! queued-message schemas) and of the prompt `input` array they share with `POST /threads`.

use serde_json::{Map, Value};

use crate::http::validate::{
    Field, Kind, NON_EMPTY, STR, check_field, check_object, invalid_discriminator, invalid_type,
    opt, req, too_small_array,
};

const NON_NEGATIVE_INT: Kind = Kind::Int { min: Some(0), max: None, positive: false };
const NULLABLE_STR: Kind = Kind::NullableStr { min: 0 };
const VISIBILITY: Field = opt("visibility", Kind::Enum(&["agent-only"]));
const PROMPT_INPUT_TYPES: &[&str] = &["text", "image", "localImage", "localFile"];
const RESOURCE_KINDS: &[&str] = &["thread", "project", "section", "path", "command", "plugin"];
const PERMISSION_MODES: &[&str] = &["accept-edits", "auto", "full", "workspace-write"];
const SEND_MODES: &[&str] = &["queue-if-active", "steer-if-active", "auto", "start", "steer"];
const SEND_QUEUED_MODES: &[&str] = &["auto", "steer"];
const PLUGIN_ID_PATTERN: &str = "Invalid string: must match pattern /^[a-z0-9][a-z0-9-]*$/u";

pub const SERVICE_TIER: Kind = Kind::Enum(&["fast", "default"]);
pub const REASONING_LEVEL: Kind =
    Kind::Enum(&["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]);

const INPUT_SOURCE: Kind = Kind::Enum(&["explicit", "client-preference"]);
const EXECUTION_INPUT_SOURCES: &[Field] = &[
    opt("model", INPUT_SOURCE),
    opt("serviceTier", INPUT_SOURCE),
    opt("reasoningLevel", INPUT_SOURCE),
    opt("permissionMode", INPUT_SOURCE),
];

fn check_fields(object: &Map<String, Value>, fields: &[Field]) -> Result<(), String> {
    fields.iter().try_for_each(|field| check_field(object, *field))
}

fn as_object(value: Option<&Value>) -> Result<&Map<String, Value>, String> {
    match value {
        None => Err("Required".to_owned()),
        Some(Value::Object(object)) => Ok(object),
        Some(other) => Err(invalid_type("object", other)),
    }
}

fn discriminated<'a>(
    value: Option<&'a Value>,
    key: &str,
    options: &[&str],
) -> Result<(&'a Map<String, Value>, &'a str), String> {
    let object = as_object(value)?;
    match object.get(key).and_then(Value::as_str) {
        Some(tag) if options.contains(&tag) => Ok((object, tag)),
        _ => Err(invalid_discriminator(options)),
    }
}

fn is_url(text: &str) -> bool {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    url::Url::parse(trimmed).is_ok()
}

fn is_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    let lower_or_digit = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    chars.next().is_some_and(lower_or_digit) && chars.all(|c| lower_or_digit(c) || c == '-')
}

fn mention_resource(value: Option<&Value>) -> Result<(), String> {
    if let Some(Value::Object(object)) = value
        && object.get("kind").and_then(Value::as_str) == Some("folder")
        && object.get("folderId").is_some_and(Value::is_string)
    {
        return check_field(object, req("label", STR));
    }
    let (object, kind) = discriminated(value, "kind", RESOURCE_KINDS)?;
    let fields: &[Field] = match kind {
        "thread" => &[req("threadId", STR), opt("projectId", STR), req("label", STR)],
        "project" => &[req("projectId", STR), req("label", STR)],
        "section" => &[req("sectionId", STR), req("label", STR)],
        "path" => &[
            req("source", Kind::Enum(&["workspace", "thread-storage"])),
            req("entryKind", Kind::Enum(&["file", "directory"])),
            req("path", STR),
            req("label", STR),
        ],
        "command" => &[
            req("trigger", Kind::Enum(&["/", "$"])),
            req("name", STR),
            req("source", Kind::Enum(&["skill", "command"])),
            req("origin", Kind::Enum(&["builtin", "project", "user"])),
            req("label", STR),
            req("argumentHint", NULLABLE_STR),
        ],
        _ => &[
            req("pluginId", STR),
            opt("icon", NULLABLE_STR),
            req("itemId", STR),
            req("label", STR),
        ],
    };
    check_fields(object, fields)
}

fn mention(value: &Value) -> Result<(), String> {
    let object = as_object(Some(value))?;
    check_fields(object, &[req("start", NON_NEGATIVE_INT), req("end", NON_NEGATIVE_INT)])?;
    mention_resource(object.get("resource"))
}

fn prompt_input(value: &Value) -> Result<(), String> {
    let (object, kind) = discriminated(Some(value), "type", PROMPT_INPUT_TYPES)?;
    match kind {
        "text" => {
            check_field(object, req("text", STR))?;
            match object.get("mentions") {
                None => {}
                Some(Value::Array(mentions)) => mentions.iter().try_for_each(mention)?,
                Some(other) => return Err(invalid_type("array", other)),
            }
        }
        "image" => {
            check_field(object, req("url", STR))?;
            if object.get("url").and_then(Value::as_str).is_some_and(|url| !is_url(url)) {
                return Err("Invalid URL".to_owned());
            }
        }
        "localImage" => check_field(object, req("path", STR))?,
        _ => check_fields(
            object,
            &[
                req("path", STR),
                opt("name", STR),
                opt("sizeBytes", NON_NEGATIVE_INT),
                opt("mimeType", STR),
            ],
        )?,
    }
    check_field(object, VISIBILITY)
}

/// `z.array(promptInputSchema).min(1)`: the prompt `input` of a thread message request.
pub fn check_prompt_inputs(value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else { return Err("Required".to_owned()) };
    let Value::Array(items) = value else { return Err(invalid_type("array", value)) };
    if items.is_empty() {
        return Err(too_small_array(1));
    }
    items.iter().try_for_each(prompt_input)
}

fn check_message_fields(object: &Map<String, Value>) -> Result<(), String> {
    check_prompt_inputs(object.get("input"))?;
    check_fields(
        object,
        &[
            opt("model", STR),
            opt("serviceTier", SERVICE_TIER),
            opt("reasoningLevel", REASONING_LEVEL),
        ],
    )?;
    if let Some(mode) = object.get("permissionMode")
        && !mode.as_str().is_some_and(|mode| PERMISSION_MODES.contains(&mode))
    {
        return Err("Invalid input".to_owned());
    }
    match object.get("executionInputSources") {
        Some(sources) => check_object(sources, EXECUTION_INPUT_SOURCES, true),
        None => Ok(()),
    }
}

fn check_plugin_submission(value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else { return Ok(()) };
    let submission = as_object(Some(value))?;
    check_field(submission, req("pluginId", STR))?;
    if submission.get("pluginId").and_then(Value::as_str).is_some_and(|id| !is_plugin_id(id)) {
        return Err(PLUGIN_ID_PATTERN.to_owned());
    }
    match submission.contains_key("data") {
        true => Ok(()),
        false => Err("Invalid input".to_owned()),
    }
}

/// `sendMessageRequestSchema` (`POST /threads/:id/send`).
pub fn check_send_request(body: &Value) -> Result<(), String> {
    let object = as_object(Some(body))?;
    check_message_fields(object)?;
    check_fields(object, &[req("mode", Kind::Enum(SEND_MODES)), opt("senderThreadId", NON_EMPTY)])?;
    check_plugin_submission(object.get("pluginSubmission"))?;
    check_field(object, opt("sendAt", NON_NEGATIVE_INT))
}

/// `createQueuedMessageRequestSchema` (`POST /threads/:id/queued-messages`).
pub fn check_create_queued_request(body: &Value) -> Result<(), String> {
    let object = as_object(Some(body))?;
    check_message_fields(object)?;
    check_field(object, opt("senderThreadId", NON_EMPTY))
}

/// `updateQueuedMessageRequestSchema` (`PATCH /threads/:id/queued-messages/:queuedMessageId`).
pub fn check_update_queued_request(body: &Value) -> Result<(), String> {
    let object = as_object(Some(body))?;
    check_field(object, req("expectedUpdatedAt", NON_NEGATIVE_INT))?;
    check_prompt_inputs(object.get("input"))
}

/// `sendQueuedMessageRequestSchema` (`POST /threads/:id/queued-messages/:queuedMessageId/send`).
pub fn check_send_queued_request(body: &Value) -> Result<(), String> {
    check_object(body, &[req("mode", Kind::Enum(SEND_QUEUED_MODES))], false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn send(input: Value) -> Result<(), String> {
        check_send_request(&json!({ "input": input, "mode": "auto" }))
    }

    #[test]
    fn reports_nested_prompt_input_issues_as_zod_does() {
        let types =
            "Invalid discriminator value. Expected 'text' | 'image' | 'localImage' | 'localFile'";
        assert_eq!(send(json!([{ "type": "zz" }])), Err(types.to_owned()));
        assert_eq!(send(json!([7])), Err("Invalid input: expected object, received number".into()));
        assert_eq!(send(json!([{ "type": "text" }])), Err("Required".into()));
        assert_eq!(
            send(json!([{ "type": "text", "text": "a", "mentions": null }])),
            Err("Invalid input: expected array, received null".into())
        );
        assert_eq!(
            send(json!([{ "type": "text", "text": "a", "visibility": "x" }])),
            Err("Invalid input: expected \"agent-only\"".into())
        );
        assert_eq!(send(json!([{ "type": "image", "url": "nope" }])), Err("Invalid URL".into()));
        assert_eq!(send(json!([{ "type": "image", "url": " http://x " }])), Ok(()));
        let mention = json!({ "start": 0, "end": 1, "resource": { "kind": "folder", "folderId": "f", "label": "l" } });
        assert_eq!(send(json!([{ "type": "text", "text": "a", "mentions": [mention] }])), Ok(()));
        let mention = json!({ "start": 0, "end": 1, "resource": { "kind": "command", "label": "x", "trigger": "/", "name": "n", "source": "skill", "origin": "user" } });
        assert_eq!(
            send(json!([{ "type": "text", "text": "a", "mentions": [mention] }])),
            Err("Required".into())
        );
    }

    #[test]
    fn checks_plugin_submission_and_permission_mode() {
        let input = json!([{ "type": "text", "text": "a" }]);
        let body = |extra: Value| {
            let mut body = json!({ "input": input, "mode": "auto" });
            if let (Some(body), Some(extra)) = (body.as_object_mut(), extra.as_object()) {
                body.extend(extra.clone());
            }
            check_send_request(&body)
        };
        assert_eq!(body(json!({ "permissionMode": "workspace-write" })), Ok(()));
        assert_eq!(body(json!({ "permissionMode": "zz" })), Err("Invalid input".into()));
        assert_eq!(
            body(json!({ "pluginSubmission": { "pluginId": "A" } })),
            Err(PLUGIN_ID_PATTERN.into())
        );
        assert_eq!(
            body(json!({ "pluginSubmission": { "pluginId": "a" } })),
            Err("Invalid input".into())
        );
        assert_eq!(body(json!({ "pluginSubmission": { "pluginId": "a", "data": null } })), Ok(()));
    }
}
