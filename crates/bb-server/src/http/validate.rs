//! zod v4 wording for request validation failures, so a Rust route answers an invalid request with
//! the message `@bb/hono-typed-routes` derives from the first zod issue.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// The zod name of a JSON value's type (`received ...` in an `invalid_type` issue).
pub fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub fn invalid_type(expected: &str, received: &Value) -> String {
    format!("Invalid input: expected {expected}, received {}", type_name(received))
}

pub fn unrecognized_key(key: &str) -> String {
    format!("Unrecognized key: \"{key}\"")
}

pub fn invalid_option(options: &[&str]) -> String {
    let quoted: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
    match quoted.as_slice() {
        [single] => format!("Invalid input: expected {single}"),
        _ => format!("Invalid option: expected one of {}", quoted.join("|")),
    }
}

pub fn too_small_array(min: usize) -> String {
    format!("Too small: expected array to have >={min} items")
}

pub fn too_big_array(max: usize) -> String {
    format!("Too big: expected array to have <={max} items")
}

pub fn too_small_string(min: usize) -> String {
    format!("Too small: expected string to have >={min} characters")
}

pub fn too_big_string(max: usize) -> String {
    format!("Too big: expected string to have <={max} characters")
}

/// The first key of `body` outside `allowed`, as a zod strict-object issue.
pub fn unknown_key(body: &serde_json::Map<String, Value>, allowed: &[&str]) -> Option<String> {
    body.keys().find(|key| !allowed.contains(&key.as_str())).map(|key| unrecognized_key(key))
}

fn serde_type(text: &str) -> Option<&'static str> {
    let text = text.trim();
    let head = text.split([' ', '`']).next().unwrap_or_default();
    Some(match head {
        "string" | "char" => "string",
        "integer" | "floating" => "number",
        "boolean" => "boolean",
        "null" | "unit" => "null",
        "sequence" | "tuple" => "array",
        "map" | "struct" => "object",
        "a" | "an" => return serde_type(text.split_once(' ')?.1),
        "borrowed" => "string",
        "u8" | "u16" | "u32" | "u64" | "i8" | "i16" | "i32" | "i64" | "f32" | "f64" | "usize"
        | "isize" | "number" | "u128" | "i128" => "number",
        _ => return None,
    })
}

fn backticked(list: &str) -> Vec<&str> {
    list.split('`').skip(1).step_by(2).collect()
}

static SERDE_LOCATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" at line \d+ column \d+$").expect("valid regex"));

/// Rewrites a serde error message (`missing field`, `unknown field`, `unknown variant`,
/// `invalid type`) in zod's wording; other messages are returned unchanged.
pub fn from_serde(message: &str) -> String {
    let message = SERDE_LOCATION.replace(message, "");
    let message = message.as_ref();
    if message.starts_with("missing field `") {
        return "Required".to_owned();
    }
    if let Some(rest) = message.strip_prefix("unknown field `") {
        let key = rest.split('`').next().unwrap_or_default();
        return unrecognized_key(key);
    }
    if let Some(rest) = message.strip_prefix("unknown variant `") {
        let options = match rest.split_once("expected ") {
            Some((_, expected)) => backticked(expected),
            None => Vec::new(),
        };
        if !options.is_empty() {
            return invalid_option(&options);
        }
    }
    if let Some(rest) = message.strip_prefix("invalid type: ")
        && let Some((received, expected)) = rest.split_once(", expected ")
        && let (Some(received), Some(expected)) = (serde_type(received), serde_type(expected))
    {
        return format!("Invalid input: expected {expected}, received {received}");
    }
    message.to_owned()
}

/// The zod message for a serde error raised while deserializing a request.
pub fn from_serde_error(error: &serde_json::Error) -> String {
    from_serde(&error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_serde_categories() {
        assert_eq!(from_serde("missing field `name` at line 1 column 2"), "Required");
        assert_eq!(from_serde("unknown field `zz`, expected `a` or `b`"), "Unrecognized key: \"zz\"");
        assert_eq!(
            from_serde("unknown variant `x`, expected `a` or `b`"),
            "Invalid option: expected one of \"a\"|\"b\""
        );
        assert_eq!(from_serde("unknown variant `x`, expected `a`"), "Invalid input: expected \"a\"");
        assert_eq!(
            from_serde("invalid type: integer `7`, expected a string at line 1 column 3"),
            "Invalid input: expected string, received number"
        );
        assert_eq!(
            from_serde("invalid type: sequence, expected struct Body"),
            "Invalid input: expected object, received array"
        );
    }
}
