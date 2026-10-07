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
        "map" | "struct" | "internally" | "adjacently" => "object",
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
    if message.starts_with("invalid length ") && message.contains(", expected struct ") {
        return "Invalid input: expected object, received array".to_owned();
    }
    message.to_owned()
}

/// The zod message for a serde error raised while deserializing a request.
pub fn from_serde_error(error: &serde_json::Error) -> String {
    from_serde(&error.to_string())
}

/// The shape of one field of a request object, checked the way the zod schema checks it.
#[derive(Clone, Copy, Debug)]
pub enum Kind {
    Str {
        min: usize,
        max: Option<usize>,
    },
    NullableStr {
        min: usize,
    },
    Bool,
    Int {
        min: Option<i64>,
        max: Option<i64>,
        positive: bool,
    },
    Enum(&'static [&'static str]),
    StrArray {
        min_items: usize,
        max_items: Option<usize>,
        item_min: usize,
        item_max: Option<usize>,
    },
    Object,
    Any,
}

#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub key: &'static str,
    pub required: bool,
    pub kind: Kind,
}

pub const fn req(key: &'static str, kind: Kind) -> Field {
    Field { key, required: true, kind }
}

pub const fn opt(key: &'static str, kind: Kind) -> Field {
    Field { key, required: false, kind }
}

pub const STR: Kind = Kind::Str { min: 0, max: None };
pub const NON_EMPTY: Kind = Kind::Str { min: 1, max: None };

fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn check_string(text: &str, min: usize, max: Option<usize>) -> Result<(), String> {
    if js_len(text) < min {
        return Err(too_small_string(min));
    }
    match max {
        Some(max) if js_len(text) > max => Err(too_big_string(max)),
        _ => Ok(()),
    }
}

fn check_value(value: Option<&Value>, kind: Kind) -> Result<(), String> {
    let missing = || "Required".to_owned();
    match kind {
        Kind::Any => Ok(()),
        Kind::Enum(options) => match value.and_then(Value::as_str) {
            Some(text) if options.contains(&text) => Ok(()),
            _ => Err(invalid_option(options)),
        },
        _ => {
            let Some(value) = value else { return Err(missing()) };
            match (kind, value) {
                (Kind::NullableStr { .. }, Value::Null) => Ok(()),
                (Kind::NullableStr { min }, Value::String(text)) => check_string(text, min, None),
                (Kind::NullableStr { .. }, other) => Err(invalid_type("string", other)),
                (Kind::Str { min, max }, Value::String(text)) => check_string(text, min, max),
                (Kind::Str { .. }, other) => Err(invalid_type("string", other)),
                (Kind::Bool, Value::Bool(_)) => Ok(()),
                (Kind::Bool, other) => Err(invalid_type("boolean", other)),
                (Kind::Int { min, max, positive }, Value::Number(number)) => {
                    let Some(n) = number.as_i64().filter(|_| !number.is_f64()) else {
                        return Err("Invalid input: expected int, received number".to_owned());
                    };
                    if positive && n <= 0 {
                        return Err("Too small: expected number to be >0".to_owned());
                    }
                    if let Some(min) = min.filter(|min| n < *min) {
                        return Err(format!("Too small: expected number to be >={min}"));
                    }
                    match max.filter(|max| n > *max) {
                        Some(max) => Err(format!("Too big: expected number to be <={max}")),
                        None => Ok(()),
                    }
                }
                (Kind::Int { .. }, other) => Err(invalid_type("number", other)),
                (Kind::Object, Value::Object(_)) => Ok(()),
                (Kind::Object, other) => Err(invalid_type("object", other)),
                (
                    Kind::StrArray { min_items, max_items, item_min, item_max },
                    Value::Array(items),
                ) => {
                    if items.len() < min_items {
                        return Err(too_small_array(min_items));
                    }
                    if let Some(max) = max_items.filter(|max| items.len() > *max) {
                        return Err(too_big_array(max));
                    }
                    for item in items {
                        match item {
                            Value::String(text) => check_string(text, item_min, item_max)?,
                            other => return Err(invalid_type("string", other)),
                        }
                    }
                    Ok(())
                }
                (Kind::StrArray { .. }, other) => Err(invalid_type("array", other)),
                _ => Ok(()),
            }
        }
    }
}

/// Checks `body` against an object schema and returns the message of zod's first issue: the
/// fields in schema order, then (for a strict object) the first unrecognized key.
pub fn check_object(body: &Value, fields: &[Field], strict: bool) -> Result<(), String> {
    let Some(object) = body.as_object() else { return Err(invalid_type("object", body)) };
    for field in fields {
        let value = object.get(field.key);
        if value.is_none() && !field.required {
            continue;
        }
        check_value(value, field.kind)?;
    }
    if strict {
        let allowed: Vec<&str> = fields.iter().map(|field| field.key).collect();
        if let Some(message) = unknown_key(object, &allowed) {
            return Err(message);
        }
    }
    Ok(())
}

/// Checks one field of `object` the way `check_object` checks it, for callers that interleave
/// fields needing a custom check.
pub fn check_field(object: &serde_json::Map<String, Value>, field: Field) -> Result<(), String> {
    let value = object.get(field.key);
    if value.is_none() && !field.required {
        return Ok(());
    }
    check_value(value, field.kind)
}

/// zod's message for a discriminated union whose discriminator matches none of `options`.
pub fn invalid_discriminator(options: &[&str]) -> String {
    let quoted: Vec<String> = options.iter().map(|option| format!("'{option}'")).collect();
    format!("Invalid discriminator value. Expected {}", quoted.join(" | "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_serde_categories() {
        assert_eq!(from_serde("missing field `name` at line 1 column 2"), "Required");
        assert_eq!(
            from_serde("unknown field `zz`, expected `a` or `b`"),
            "Unrecognized key: \"zz\""
        );
        assert_eq!(
            from_serde("unknown variant `x`, expected `a` or `b`"),
            "Invalid option: expected one of \"a\"|\"b\""
        );
        assert_eq!(
            from_serde("unknown variant `x`, expected `a`"),
            "Invalid input: expected \"a\""
        );
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
