use std::sync::LazyLock;

use http::HeaderMap;
use regex::Regex;
use serde_json::Value;

use crate::contract::{Account, AccountQuota, AccountStatus, FAMILIES, LimitWindow, ModelFamily};

const CLAUDE_PREFIX: &str = "anthropic-ratelimit-unified-";
const CODEX_SLOTS: [&str; 2] = ["primary", "secondary"];
const BLOCK_WITHOUT_RESET_MS: i64 = 5 * 60 * 1_000;

static SCOPED_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^anthropic-ratelimit-unified-7d_(.+)-(?:utilization|reset|status)$")
        .expect("scoped header pattern")
});

pub const EMPTY_QUOTA: AccountQuota = AccountQuota {
    windows: Vec::new(),
    extra_usage: None,
    observed_at: None,
    held_until: None,
    error: None,
};

fn family_keys() -> Vec<String> {
    FAMILIES.iter().map(|family| format!("7d:{}", family.as_str())).collect()
}

fn window_rank(key: &str) -> i64 {
    let fixed = ["5h", "7d"];
    if let Some(index) = fixed.iter().position(|name| *name == key) {
        return index as i64;
    }
    if let Some(index) = family_keys().iter().position(|name| name == key) {
        return 2 + index as i64;
    }
    match CODEX_SLOTS.iter().position(|name| *name == key) {
        Some(index) => 2 + FAMILIES.len() as i64 + index as i64,
        None => -1,
    }
}

#[derive(Default)]
struct WindowUpdates(Vec<(String, Option<LimitWindow>)>);

impl WindowUpdates {
    fn set(&mut self, key: &str, window: Option<LimitWindow>) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = window,
            None => self.0.push((key.to_string(), window)),
        }
    }
    fn get(&self, key: &str) -> Option<&Option<LimitWindow>> {
        self.0.iter().find(|(name, _)| name == key).map(|(_, window)| window)
    }
}

pub fn dig<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value, |parent, key| parent.as_object()?.get(*key))
}

fn dig_opt<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    value.and_then(|value| dig(value, keys))
}

fn scalar<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| dig_opt(value, &[key]))
        .find(|entry| entry.is_number() || entry.is_string())
}

/// JavaScript `Number(text)`: whitespace-trimmed, empty is 0, hex/octal/binary prefixes allowed.
pub fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|value| value as f64);
        }
    }
    match trimmed.trim_start_matches(['+', '-']) {
        "Infinity" => {
            return Some(if trimmed.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
        }
        rest if rest.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') => {
            return None;
        }
        _ => {}
    }
    trimmed.parse::<f64>().ok()
}

fn numeric(value: Option<&Value>) -> Option<f64> {
    let parsed = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) if text.trim().is_empty() => return None,
        Value::String(text) => js_number(text)?,
        _ => return None,
    };
    parsed.is_finite().then_some(parsed)
}

fn numeric_str(value: Option<&str>) -> Option<f64> {
    let text = value?;
    if text.trim().is_empty() {
        return None;
    }
    js_number(text).filter(|parsed| parsed.is_finite())
}

fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

pub fn epoch_ms(value: f64) -> i64 {
    js_round(if value < 1_000_000_000_000.0 { value * 1_000.0 } else { value })
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

static ISO_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$")
        .expect("iso date pattern")
});
static HTTP_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[A-Za-z]{3},\s*)?(\d{1,2})[ -]([A-Za-z]{3})[ -](\d{2,4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(?:GMT|UTC|Z)?$")
        .expect("http date pattern")
});
const MONTHS: [&str; 12] =
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

fn utc_ms(parts: [i64; 6], millis: i64) -> Option<i64> {
    let [year, month, day, hour, minute, second] = parts;
    let valid = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour <= 24
        && minute < 60
        && second < 60;
    valid.then(|| {
        let seconds =
            days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
        seconds * 1_000 + millis
    })
}

/// `Date.parse` for the formats providers send: ISO 8601 (no offset means UTC) and RFC 7231 dates.
pub fn parse_date(text: &str) -> Option<i64> {
    let text = text.trim();
    let int =
        |found: Option<regex::Match>| found.map_or(Some(0), |m| m.as_str().parse::<i64>().ok());
    if let Some(caps) = ISO_DATE.captures(text) {
        let parts = [
            int(caps.get(1))?,
            int(caps.get(2))?,
            int(caps.get(3))?,
            int(caps.get(4))?,
            int(caps.get(5))?,
            int(caps.get(6))?,
        ];
        let millis = caps.get(7).map_or(0, |m| {
            let digits: String = m.as_str().chars().chain("000".chars()).take(3).collect();
            digits.parse::<i64>().unwrap_or(0)
        });
        let offset = match caps.get(8).map(|m| m.as_str()) {
            None | Some("Z") => 0,
            Some(zone) => {
                let sign = if zone.starts_with('-') { -1 } else { 1 };
                let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
                let hours = digits[..2].parse::<i64>().ok()?;
                let minutes = digits[2..].parse::<i64>().ok()?;
                sign * (hours * 60 + minutes) * 60_000
            }
        };
        return utc_ms(parts, millis).map(|ms| ms - offset);
    }
    let caps = HTTP_DATE.captures(text)?;
    let month = caps.get(2)?.as_str().to_ascii_lowercase();
    let month = MONTHS.iter().position(|name| *name == month)? as i64 + 1;
    let mut year = int(caps.get(3))?;
    if year < 100 {
        year += if year < 50 { 2000 } else { 1900 };
    }
    utc_ms(
        [year, month, int(caps.get(1))?, int(caps.get(4))?, int(caps.get(5))?, int(caps.get(6))?],
        0,
    )
}

fn reset_time(value: Option<&Value>) -> Option<i64> {
    if let Some(number) = numeric(value) {
        return Some(epoch_ms(number));
    }
    value.and_then(Value::as_str).and_then(parse_date)
}

fn reset_time_str(value: Option<&str>) -> Option<i64> {
    match numeric_str(value) {
        Some(number) => Some(epoch_ms(number)),
        None => value.and_then(parse_date),
    }
}

fn clamp(fraction: f64) -> f64 {
    fraction.clamp(0.0, 1.0)
}

/// Fetch `Headers.get`: every value of the name joined with ", ".
pub fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

fn window_of<'a>(quota: &'a AccountQuota, key: &str) -> Option<&'a LimitWindow> {
    quota.windows.iter().find(|window| window.key == key)
}

fn merge_windows(previous: &[LimitWindow], updates: &WindowUpdates) -> Vec<LimitWindow> {
    let mut merged: Vec<LimitWindow> =
        previous.iter().filter(|window| updates.get(&window.key).is_none()).cloned().collect();
    merged.extend(updates.0.iter().filter_map(|(_, window)| window.clone()));
    merged.sort_by_key(|window| window_rank(&window.key));
    merged
}

pub fn model_family(model: Option<&str>) -> ModelFamily {
    let name = model.unwrap_or("").to_lowercase();
    FAMILIES.into_iter().find(|family| name.contains(family.as_str())).unwrap_or(ModelFamily::Other)
}

pub fn claude_quota_from_headers(
    headers: &HeaderMap,
    previous: &AccountQuota,
    family: ModelFamily,
    now: i64,
) -> AccountQuota {
    let mut observed = false;
    let mut read = |key: &str, name: &str| -> Option<LimitWindow> {
        let prior = window_of(previous, key);
        let utilization = numeric_str(header(headers, &format!("{name}-utilization")).as_deref());
        let reset_at = reset_time_str(header(headers, &format!("{name}-reset")).as_deref());
        let status = header(headers, &format!("{name}-status"));
        if utilization.is_none() && reset_at.is_none() && status.is_none() {
            return prior.cloned();
        }
        observed = true;
        Some(LimitWindow {
            key: key.to_string(),
            minutes: None,
            utilization: utilization.or(prior.and_then(|window| window.utilization)),
            reset_at: reset_at.or(prior.and_then(|window| window.reset_at)),
            status: status.or(prior.and_then(|window| window.status.clone())),
        })
    };
    let mut updates = WindowUpdates::default();
    updates.set("5h", read("5h", &format!("{CLAUDE_PREFIX}5h")));
    updates.set("7d", read("7d", &format!("{CLAUDE_PREFIX}7d")));
    let mut names: Vec<&str> = headers.keys().map(|name| name.as_str()).collect();
    names.sort_unstable();
    let scope = names.iter().find_map(|name| SCOPED_HEADER.captures(name)?.get(1));
    if let Some(scope) = scope {
        let key = format!("7d:{}", family.as_str());
        let window = read(&key, &format!("{CLAUDE_PREFIX}7d_{}", scope.as_str()));
        updates.set(&key, window);
    }
    let overage = header(headers, &format!("{CLAUDE_PREFIX}overage-status")).unwrap_or_default();
    let known = ["allowed", "allowed_warning", "rejected"].contains(&overage.as_str());
    AccountQuota {
        windows: merge_windows(&previous.windows, &updates),
        extra_usage: if known { Some(overage != "rejected") } else { previous.extra_usage },
        observed_at: if observed || known { Some(now) } else { previous.observed_at },
        ..previous.clone()
    }
}

pub fn is_claude_quota_rejection(headers: &HeaderMap) -> bool {
    let shared = [format!("{CLAUDE_PREFIX}5h-status"), format!("{CLAUDE_PREFIX}7d-status")];
    headers.keys().any(|name| {
        let name = name.as_str();
        let scoped = SCOPED_HEADER.is_match(name) && name.ends_with("-status");
        let limited = shared.iter().any(|known| known == name) || scoped;
        limited && header(headers, name).is_some_and(|value| value.to_lowercase() == "rejected")
    })
}

fn claude_usage_window(key: &str, usage: Option<&Value>) -> Option<LimitWindow> {
    let names = ["used_percentage", "utilization", "usedPercentage", "percent"];
    let utilization = numeric(scalar(usage, &names)).map(|percent| percent / 100.0);
    let reset_at = reset_time(scalar(usage, &["resets_at", "reset_at", "resetAt"]));
    let stated = dig_opt(usage, &["status"]).and_then(Value::as_str).map(str::to_string);
    if utilization.is_none() && reset_at.is_none() && stated.is_none() {
        return None;
    }
    let full = if utilization.unwrap_or(0.0) >= 1.0 { "rejected" } else { "allowed" };
    let status = stated.or_else(|| utilization.map(|_| full.to_string()));
    Some(LimitWindow { key: key.to_string(), minutes: None, utilization, reset_at, status })
}

pub fn claude_quota_from_usage(
    payload: &Value,
    previous: &AccountQuota,
    now: i64,
) -> Option<AccountQuota> {
    let mut updates = WindowUpdates::default();
    let limits = dig(payload, &["limits"])
        .and_then(Value::as_array)
        .filter(|limits| limits.iter().all(Value::is_object));
    if limits.is_some() {
        for key in family_keys() {
            updates.set(&key, None);
        }
    }
    for limit in limits.into_iter().flatten() {
        let name = dig(limit, &["scope", "model", "display_name"]).and_then(Value::as_str);
        let weekly = limit.get("kind").and_then(Value::as_str) == Some("weekly_scoped")
            || limit.get("group").and_then(Value::as_str) == Some("weekly");
        let Some(name) = name.filter(|_| weekly) else { continue };
        let key = format!("7d:{}", model_family(Some(name)).as_str());
        let found = claude_usage_window(&key, Some(limit));
        let current = updates.get(&key).cloned().flatten();
        let stronger = current.as_ref().is_none_or(|window| {
            found.as_ref().and_then(|found| found.utilization).unwrap_or(-1.0)
                > window.utilization.unwrap_or(-1.0)
        });
        if found.is_some() && stronger {
            updates.set(&key, found);
        }
    }
    let mut fields =
        vec![("5h".to_string(), "five_hour".to_string()), ("7d".into(), "seven_day".into())];
    fields.extend(FAMILIES.iter().map(|family| {
        (format!("7d:{}", family.as_str()), format!("seven_day_{}", family.as_str()))
    }));
    for (key, field) in fields {
        if let Some(window) = claude_usage_window(&key, dig(payload, &[&field])) {
            updates.set(&key, Some(window));
        }
    }
    let extra = dig(payload, &["extra_usage"]);
    if updates.0.is_empty() && extra.is_none() {
        return None;
    }
    let used = |name: &str| numeric(scalar(extra, &[name]));
    let cap = used("monthly_limit");
    let under_cap = cap.is_none_or(|cap| used("used_credits").unwrap_or(0.0) < cap);
    let enabled = dig_opt(extra, &["is_enabled"]) == Some(&Value::Bool(true));
    let allowed = enabled && used("utilization").unwrap_or(0.0) < 100.0 && under_cap;
    let extra_usage = match extra {
        None => previous.extra_usage,
        Some(Value::Null) => None,
        Some(_) => Some(allowed),
    };
    Some(AccountQuota {
        windows: merge_windows(&previous.windows, &updates),
        extra_usage,
        observed_at: Some(now),
        ..previous.clone()
    })
}

enum Slot {
    Prior,
    Fresh(Option<LimitWindow>),
}

fn codex_header_window(
    headers: &HeaderMap,
    key: &str,
    prior: Option<&LimitWindow>,
    now: i64,
) -> Slot {
    let read =
        |name: &str| numeric_str(header(headers, &format!("x-codex-{key}-{name}")).as_deref());
    let used = read("used-percent");
    let at = read("reset-at").unwrap_or(0.0);
    let after = read("reset-after-seconds").unwrap_or(0.0);
    let relative = (after > 0.0).then(|| now + js_round(after * 1_000.0));
    let reset = if at > 0.0 { Some(epoch_ms(at)) } else { relative };
    let over = header(headers, &format!("x-codex-{key}-over-limit")).map(|v| v.to_lowercase());
    let over_limit = over.as_deref() == Some("true");
    if used.is_none() && reset.is_none() && !over_limit {
        return Slot::Prior;
    }
    let length = read("window-minutes").unwrap_or(0.0);
    let minutes = if length > 0.0 { Some(js_round(length)) } else { prior.and_then(|w| w.minutes) };
    let prior_reset = prior.and_then(|window| window.reset_at);
    let pending = prior_reset.filter(|reset| *reset > now);
    let reset_at = reset.or(pending);
    let utilization = match used {
        None => prior.and_then(|window| window.utilization),
        Some(used) => Some(clamp(used / 100.0)),
    };
    let falsy = utilization.is_none_or(|value| value == 0.0 || value.is_nan());
    if minutes.is_none() && reset_at.is_none() && falsy && !over_limit {
        return Slot::Fresh(None);
    }
    let rejected = over_limit || utilization.unwrap_or(0.0) >= 1.0;
    let status = rejected.then(|| "rejected".to_string());
    Slot::Fresh(Some(LimitWindow { key: key.to_string(), minutes, utilization, reset_at, status }))
}

pub fn codex_quota_from_headers(
    headers: &HeaderMap,
    previous: &AccountQuota,
    now: i64,
) -> AccountQuota {
    let mut unchanged = true;
    let mut windows = Vec::new();
    for key in CODEX_SLOTS {
        let prior = window_of(previous, key);
        match codex_header_window(headers, key, prior, now) {
            Slot::Prior => windows.extend(prior.cloned()),
            Slot::Fresh(window) => {
                unchanged &= window.is_none() && prior.is_none();
                windows.extend(window);
            }
        }
    }
    let credits: Vec<Option<String>> = ["has-credits", "unlimited"]
        .iter()
        .map(|name| header(headers, &format!("x-codex-credits-{name}")).map(|v| v.to_lowercase()))
        .collect();
    let seen = credits
        .iter()
        .all(|value| ["true", "1", "false", "0"].contains(&value.as_deref().unwrap_or("")));
    let funded = credits.iter().any(|value| matches!(value.as_deref(), Some("true" | "1")));
    if unchanged && !seen {
        return previous.clone();
    }
    AccountQuota {
        windows,
        extra_usage: if seen { Some(funded) } else { previous.extra_usage },
        observed_at: Some(now),
        held_until: None,
        ..previous.clone()
    }
}

pub fn is_codex_quota_rejection(headers: &HeaderMap) -> bool {
    if headers.contains_key("x-codex-rate-limit-reached-type") {
        return true;
    }
    CODEX_SLOTS.iter().any(|key| {
        let used = header(headers, &format!("x-codex-{key}-used-percent"));
        let used = numeric_str(used.as_deref()).unwrap_or(0.0);
        let over = header(headers, &format!("x-codex-{key}-over-limit")).map(|v| v.to_lowercase());
        used >= 100.0 || over.as_deref() == Some("true")
    })
}

pub fn codex_quota_from_usage(
    payload: &Value,
    previous: &AccountQuota,
    now: i64,
) -> Option<AccountQuota> {
    let limits = dig(payload, &["rate_limit"]);
    let credits = dig(payload, &["credits"]);
    if limits.is_none() && credits.is_none() {
        return None;
    }
    let windows = CODEX_SLOTS
        .iter()
        .filter_map(|key| {
            let usage = dig_opt(limits, &[&format!("{key}_window")]);
            let utilization = clamp(numeric(scalar(usage, &["used_percent"]))? / 100.0);
            let at = numeric(scalar(usage, &["reset_at"]));
            let after = numeric(scalar(usage, &["reset_after_seconds"]));
            let relative = after.map(|after| now + js_round(after * 1_000.0));
            let reset_at = at.map(epoch_ms).or(relative);
            let seconds = numeric(scalar(usage, &["limit_window_seconds"])).unwrap_or(0.0);
            let minutes = Some(js_round(seconds / 60.0)).filter(|minutes| *minutes != 0);
            let status = if utilization >= 1.0 { "rejected" } else { "allowed" };
            let status = Some(status.to_string());
            Some(LimitWindow {
                key: key.to_string(),
                minutes,
                utilization: Some(utilization),
                reset_at,
                status,
            })
        })
        .collect();
    let funded = ["has_credits", "unlimited"]
        .iter()
        .any(|name| dig_opt(credits, &[name]) == Some(&Value::Bool(true)));
    let extra_usage = match credits {
        None => previous.extra_usage,
        Some(Value::Null) => None,
        Some(_) => Some(funded),
    };
    Some(AccountQuota {
        windows: if limits.is_none() { previous.windows.clone() } else { windows },
        extra_usage,
        observed_at: Some(now),
        ..previous.clone()
    })
}

fn blocking_windows(
    quota: &AccountQuota,
    family: Option<ModelFamily>,
    threshold: f64,
    now: i64,
) -> Vec<&LimitWindow> {
    let family_key = family.map(|family| format!("7d:{}", family.as_str()));
    quota
        .windows
        .iter()
        .filter(|window| {
            let applies = !window.key.starts_with("7d:")
                || family_key.as_deref() == Some(window.key.as_str());
            let pending = window.reset_at.is_none_or(|reset| reset > now);
            let rejected = window.status.as_deref().is_some_and(|s| s.to_lowercase() == "rejected");
            applies && pending && (rejected || window.utilization.unwrap_or(0.0) >= threshold)
        })
        .collect()
}

pub fn is_exhausted(
    quota: &AccountQuota,
    family: Option<ModelFamily>,
    threshold: f64,
    now: i64,
) -> bool {
    !blocking_windows(quota, family, threshold, now).is_empty()
}

pub fn blocked(quota: &AccountQuota, now: i64) -> AccountQuota {
    let block = LimitWindow {
        key: "blocked".into(),
        minutes: None,
        utilization: None,
        reset_at: Some(now + BLOCK_WITHOUT_RESET_MS),
        status: Some("rejected".into()),
    };
    let mut updates = WindowUpdates::default();
    updates.set("blocked", Some(block));
    AccountQuota { windows: merge_windows(&quota.windows, &updates), ..quota.clone() }
}

pub fn blocking_reset_at(
    quota: &AccountQuota,
    family: Option<ModelFamily>,
    threshold: f64,
    now: i64,
) -> Option<i64> {
    let blocking = blocking_windows(quota, family, threshold, now);
    let resets: Vec<i64> = blocking.iter().filter_map(|window| window.reset_at).collect();
    if resets.is_empty() || resets.len() < blocking.len() {
        return None;
    }
    resets.into_iter().max()
}

pub fn account_status(
    account: &Account,
    quota: &AccountQuota,
    threshold: f64,
    now: i64,
) -> AccountStatus {
    if !account.enabled {
        return AccountStatus::Disabled;
    }
    if quota.error.is_some() {
        return AccountStatus::Error;
    }
    if quota.held_until.unwrap_or(0) > now {
        return AccountStatus::Held;
    }
    let spent = is_exhausted(quota, None, threshold, now);
    if spent && quota.extra_usage != Some(true) {
        AccountStatus::Exhausted
    } else {
        AccountStatus::Ready
    }
}

pub fn retry_after_ms(value: Option<&str>, now: i64) -> i64 {
    let Some(value) = value else { return 1_000 };
    if let Some(seconds) = js_number(value).filter(|seconds| seconds.is_finite()) {
        return ((seconds * 1_000.0).ceil() as i64).max(0);
    }
    parse_date(value).map_or(1_000, |date| (date - now).max(0))
}
