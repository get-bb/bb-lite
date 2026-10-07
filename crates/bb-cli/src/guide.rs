use serde_json::json;

use crate::call::{Call, CliResult, Output, usage_error};
use crate::engine::command_reference;

const GENERATED_TOPIC: &str = "commands";
const DEFAULT_TOPIC: &str = "concepts";

pub const WRITTEN: &[(&str, &str)] = &[
    ("concepts", include_str!("../../../apps/cli/guide/concepts.md")),
    ("environments", include_str!("../../../apps/cli/guide/environments.md")),
    ("json", include_str!("../../../apps/cli/guide/json.md")),
    ("machines", include_str!("../../../apps/cli/guide/machines.md")),
    ("migrating", include_str!("../../../apps/cli/guide/migrating.md")),
    ("plugins", include_str!("../../../apps/cli/guide/plugins.md")),
    ("threads", include_str!("../../../apps/cli/guide/threads.md")),
];

pub fn guide(call: &mut Call) -> CliResult<Output> {
    let mut topics: Vec<&str> = WRITTEN.iter().map(|(topic, _)| *topic).collect();
    topics.push(GENERATED_TOPIC);
    let topic = call.args("topic").unwrap_or(DEFAULT_TOPIC).to_string();
    if !topics.contains(&topic.as_str()) {
        let known = topics.join(", ");
        let message = format!("Unknown guide topic '{topic}'.");
        return Err(usage_error(message).hint(format!("Topics: {known}")));
    }
    let text = match WRITTEN.iter().find(|(name, _)| *name == topic) {
        Some((_, text)) => text.to_string(),
        None => command_reference(call.table, call.args("group").unwrap_or("")),
    };
    let shown = text.trim_end().to_string();
    Ok(Output::text(json!({ "topic": topic, "topics": topics, "text": text }), shown))
}
