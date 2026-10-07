//! The port of `apps/server/src/threads/timeline-pages.ts`. Timeline rows are the projected
//! `TimelineRow` JSON values.

use std::collections::{BTreeSet, HashMap, HashSet};

use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::db::event_read::MAX_INLINE_OUTPUT_CHARS;
use crate::domain::thread::ThreadStatus;
use crate::error::{ApiError, invalid_request};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePaginationCursor {
    pub anchor_seq: i64,
    pub anchor_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimelinePage {
    Latest { segment_limit: usize },
    Older { segment_limit: usize, before_cursor: TimelinePaginationCursor },
}

impl TimelinePage {
    pub fn segment_limit(&self) -> usize {
        match self {
            Self::Latest { segment_limit } | Self::Older { segment_limit, .. } => *segment_limit,
        }
    }

    pub fn is_latest(&self) -> bool {
        matches!(self, Self::Latest { .. })
    }
}

/// `version` is always 3.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSnapshot {
    pub version: u32,
    pub thread_id: String,
    pub max_seq: i64,
    pub status: ThreadStatus,
    pub surface: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineContentCursor {
    pub before_leaf: i64,
    pub before_sequence: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineContentPage {
    pub anchor_seq: i64,
    pub start: i64,
    pub end: i64,
    pub total: i64,
}

#[derive(Clone, Copy, Debug)]
pub struct PaginateTimelineArgs<'a> {
    pub rows: &'a [Value],
    pub page: &'a TimelinePage,
    pub content_cursor: Option<TimelineContentCursor>,
    pub max_leaves: i64,
    pub max_bytes: i64,
    pub owned_sequence_start: i64,
    pub owned_sequence_end: i64,
    pub known_has_older_segments: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContentWindow {
    pub rows: Vec<Value>,
    pub older_rows_source_seq_end: Option<i64>,
    pub start: i64,
    pub end: i64,
    pub total: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TimelineWindow {
    pub rows: Vec<Value>,
    pub returned_segment_count: usize,
    pub has_older_rows: bool,
    pub older_cursor: Option<TimelinePaginationCursor>,
    pub older_rows_source_seq_end: Option<i64>,
    pub older_row_updates: Option<Vec<Value>>,
    pub content_cursor: Option<TimelineContentCursor>,
    pub content_page: Option<TimelineContentPage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecodedCursor {
    snapshot: TimelineSnapshot,
    anchor_seq: i64,
    anchor_id: String,
    #[serde(default)]
    content: Option<DecodedContent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecodedContent {
    before_sequence: i64,
    before_leaf: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncodedCursor<'a> {
    snapshot: &'a TimelineSnapshot,
    anchor_seq: i64,
    anchor_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<&'a TimelineContentCursor>,
}

const CURSOR_PREFIX: &str = "timeline-v3:";
const TRUNCATION_TAIL: &str = " more characters truncated]";
const PREVIEW_THRESHOLD_CHARS: usize = 4_000;
const PREVIEW_HEAD_CHARS: usize = 2_000;
const PREVIEW_TAIL_CHARS: usize = 1_000;

fn decode_cursor(anchor_id: &str) -> Option<DecodedCursor> {
    let encoded = anchor_id.strip_prefix(CURSOR_PREFIX)?;
    let trimmed = encoded.trim_end_matches('=');
    let bytes = URL_SAFE_NO_PAD.decode(trimmed).or_else(|_| URL_SAFE.decode(encoded)).ok()?;
    let decoded: DecodedCursor = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let snapshot = &decoded.snapshot;
    let valid = snapshot.version == 3
        && snapshot.max_seq >= 0
        && decoded.anchor_seq >= 0
        && !decoded.anchor_id.is_empty()
        && decoded.content.as_ref().is_none_or(|c| c.before_sequence > 0 && c.before_leaf > 0);
    valid.then_some(decoded)
}

pub fn snapshot_from_cursor(
    cursor: &TimelinePaginationCursor,
    thread_id: &str,
    surface: &str,
) -> Result<(TimelineSnapshot, Option<TimelineContentCursor>), ApiError> {
    if let Some(decoded) = decode_cursor(&cursor.anchor_id) {
        let snapshot = decoded.snapshot;
        let anchor_seq = decoded.anchor_seq;
        let content = decoded.content.map(|content| TimelineContentCursor {
            before_leaf: content.before_leaf,
            before_sequence: content.before_sequence,
        });
        let content_end = content.map_or(anchor_seq + 1, |content| content.before_sequence);
        let matches = anchor_seq == cursor.anchor_seq
            && anchor_seq <= snapshot.max_seq
            && snapshot.thread_id == thread_id
            && snapshot.surface == surface
            && content_end <= snapshot.max_seq + 1
            && content_end > anchor_seq;
        if matches {
            return Ok((snapshot, content));
        }
    }
    Err(invalid_request(
        "Timeline pagination cursor is no longer available; reload the latest page",
    ))
}

pub fn bind_cursor(
    cursor: Option<&TimelinePaginationCursor>,
    snapshot: &TimelineSnapshot,
    content: Option<&TimelineContentCursor>,
) -> Option<TimelinePaginationCursor> {
    let cursor = cursor?;
    let payload = EncodedCursor {
        snapshot,
        anchor_seq: cursor.anchor_seq,
        anchor_id: &cursor.anchor_id,
        content,
    };
    let json = serde_json::to_string(&payload).unwrap_or_default();
    let encoded = URL_SAFE_NO_PAD.encode(json.as_bytes());
    Some(TimelinePaginationCursor {
        anchor_seq: cursor.anchor_seq,
        anchor_id: format!("{CURSOR_PREFIX}{encoded}"),
    })
}

fn kind(row: &Value) -> &str {
    row.get("kind").and_then(Value::as_str).unwrap_or("")
}

fn work_kind(row: &Value) -> &str {
    row.get("workKind").and_then(Value::as_str).unwrap_or("")
}

fn is_delegation(row: &Value) -> bool {
    kind(row) == "work" && work_kind(row) == "delegation"
}

fn int(row: &Value, key: &str) -> i64 {
    let value = row.get(key);
    value
        .and_then(Value::as_i64)
        .or_else(|| value.and_then(Value::as_f64).map(|number| number as i64))
        .unwrap_or(0)
}

fn row_id(row: &Value) -> &str {
    row.get("id").and_then(Value::as_str).unwrap_or("")
}

pub fn nested_timeline_rows(row: &Value) -> Option<&Vec<Value>> {
    let key = match kind(row) {
        "turn" => "children",
        "work" if is_delegation(row) => "childRows",
        _ => return None,
    };
    row.get(key).and_then(Value::as_array).filter(|rows| !rows.is_empty())
}

fn with_nested_rows(row: &Value, rows: Vec<Value>) -> Value {
    let key = match kind(row) {
        "turn" => "children",
        "work" if is_delegation(row) => "childRows",
        _ => return row.clone(),
    };
    let mut next = row.clone();
    if let Some(object) = next.as_object_mut() {
        object.insert(key.to_owned(), Value::Array(rows));
    }
    next
}

fn json_bytes<T: Serialize + ?Sized>(value: &T) -> i64 {
    serde_json::to_string(value).map_or(0, |json| json.len() as i64)
}

fn measure(items: &[Value], ancestors: i64, costs: &mut Vec<i64>) {
    for row in items {
        match nested_timeline_rows(row) {
            None => costs.push(json_bytes(row) + ancestors),
            Some(nested) => {
                let own = json_bytes(&with_nested_rows(row, Vec::new()));
                measure(nested, ancestors + own, costs);
            }
        }
    }
}

struct Picker {
    index: i64,
    start: i64,
    end: i64,
    older_rows_source_seq_end: Option<i64>,
}

impl Picker {
    fn record_older(&mut self, row: &Value) {
        let end = int(row, "sourceSeqEnd");
        self.older_rows_source_seq_end = Some(self.older_rows_source_seq_end.unwrap_or(0).max(end));
    }

    fn pick(&mut self, items: &[Value]) -> Vec<Value> {
        let mut out = Vec::new();
        for row in items {
            match nested_timeline_rows(row) {
                None => {
                    let position = self.index;
                    self.index += 1;
                    if position < self.start {
                        self.record_older(row);
                    }
                    if position >= self.start && position < self.end {
                        out.push(row.clone());
                    }
                }
                Some(nested) => {
                    let picked = self.pick(nested);
                    if picked.is_empty() && self.index <= self.start {
                        self.record_older(row);
                    }
                    if !picked.is_empty() {
                        out.push(with_nested_rows(row, picked));
                    }
                }
            }
        }
        out
    }
}

pub fn paginate_contents(
    rows: &[Value],
    before: Option<i64>,
    max_leaves: i64,
    max_bytes: i64,
) -> ContentWindow {
    let mut costs = Vec::new();
    measure(rows, 0, &mut costs);
    let total = costs.len() as i64;
    let end = before.unwrap_or(total).min(total);
    let mut start = end;
    let mut bytes = 0;
    while start > 0 && end - start < max_leaves.max(1) {
        let cost = usize::try_from(start - 1).ok().and_then(|i| costs.get(i)).copied().unwrap_or(0);
        if start < end && bytes + cost > max_bytes {
            break;
        }
        bytes += cost;
        start -= 1;
    }
    let mut picker = Picker { index: 0, start, end, older_rows_source_seq_end: None };
    let picked = picker.pick(rows);
    ContentWindow {
        rows: picked,
        older_rows_source_seq_end: picker.older_rows_source_seq_end,
        start,
        end,
        total,
    }
}

struct Segment<'a> {
    rows: Vec<&'a Value>,
    sequence_start: i64,
}

fn logical_segments<'a>(args: &PaginateTimelineArgs<'a>) -> Vec<Segment<'a>> {
    let (start, end) = (args.owned_sequence_start, args.owned_sequence_end);
    let owned: Vec<&Value> = args
        .rows
        .iter()
        .filter(|row| int(row, "sourceSeqStart") >= start && int(row, "sourceSeqStart") < end)
        .collect();
    let mut bounds = BTreeSet::from([start]);
    for row in &owned {
        let seq = int(row, "sourceSeqStart");
        let role = row.get("role").and_then(Value::as_str);
        if kind(row) == "conversation" && role == Some("user") && seq > start {
            bounds.insert(seq);
        }
    }
    let bounds: Vec<i64> = bounds.into_iter().collect();
    let mut segments: Vec<Segment> =
        bounds.iter().map(|&sequence_start| Segment { rows: Vec::new(), sequence_start }).collect();
    for row in owned {
        let seq = int(row, "sourceSeqStart");
        let later = bounds.iter().position(|&bound| bound > seq);
        let slot = match later {
            None | Some(0) => segments.len() - 1,
            Some(later) => later - 1,
        };
        segments[slot].rows.push(row);
    }
    let mut populated: Vec<Segment> =
        segments.into_iter().filter(|segment| !segment.rows.is_empty()).collect();
    if let Some(first) = populated.first_mut() {
        first.sequence_start = start;
    }
    populated
}

fn row_changes_from(row: &Value, sequence: i64) -> Value {
    match nested_timeline_rows(row) {
        None => row.clone(),
        Some(nested) => with_nested_rows(row, rows_changed_from(nested, sequence)),
    }
}

fn rows_changed_from(rows: &[Value], sequence: i64) -> Vec<Value> {
    match rows.iter().position(|row| int(row, "sourceSeqEnd") >= sequence) {
        None => Vec::new(),
        Some(first) => rows[first..].iter().map(|row| row_changes_from(row, sequence)).collect(),
    }
}

pub fn paginate_timeline(args: &PaginateTimelineArgs<'_>) -> TimelineWindow {
    let segments = logical_segments(args);
    let limit = args.page.segment_limit();
    let skip = if limit == 0 { 0 } else { segments.len().saturating_sub(limit) };
    let selected = &segments[skip..];
    let mut returned: HashMap<String, Value> = HashMap::new();
    let mut remaining_bytes = args.max_bytes;
    let mut remaining_leaves = args.max_leaves;
    let mut returned_segment_count = 0;
    let mut window_start = selected.first().map_or(args.owned_sequence_start, |s| s.sequence_start);
    let mut has_older_rows =
        args.known_has_older_segments.unwrap_or(segments.len() > selected.len());
    let mut content_seq_end = None;
    let mut content_cursor = None;
    let mut content_page = None;
    for index in (0..selected.len()).rev() {
        let segment = &selected[index];
        let segment_rows: Vec<Value> = segment.rows.iter().map(|row| (*row).clone()).collect();
        let before = args.content_cursor.map(|cursor| cursor.before_leaf);
        let contents = paginate_contents(&segment_rows, before, remaining_leaves, remaining_bytes);
        for row in &contents.rows {
            returned.insert(row_id(row).to_owned(), row.clone());
        }
        returned_segment_count += 1;
        remaining_leaves -= contents.end - contents.start;
        remaining_bytes -= json_bytes(&contents.rows);
        let ContentWindow { start, end, total, .. } = contents;
        if start == 0 && remaining_leaves > 0 && remaining_bytes > 0 {
            continue;
        }
        window_start = segment.sequence_start;
        has_older_rows = start > 0 || index > 0 || has_older_rows;
        content_seq_end = contents.older_rows_source_seq_end;
        let before_sequence =
            selected.get(index + 1).map_or(args.owned_sequence_end, |next| next.sequence_start);
        content_cursor =
            (start > 0).then_some(TimelineContentCursor { before_leaf: start, before_sequence });
        content_page = Some(TimelineContentPage { anchor_seq: window_start, start, end, total });
        break;
    }
    let missing: Vec<&Value> = args
        .rows
        .iter()
        .filter(|row| {
            int(row, "sourceSeqStart") < args.owned_sequence_end
                && !returned.contains_key(row_id(row))
        })
        .collect();
    let changed: Vec<&Value> = missing
        .iter()
        .copied()
        .filter(|row| args.page.is_latest() && int(row, "sourceSeqEnd") >= window_start)
        .collect();
    let updates: Vec<Value> =
        changed.iter().map(|row| row_changes_from(row, window_start)).collect();
    let report = !changed.is_empty() && json_bytes(&updates) <= remaining_bytes;
    let older_rows_source_seq_end = missing
        .iter()
        .filter(|row| !(report && changed.iter().any(|changed| std::ptr::eq(*changed, **row))))
        .fold(content_seq_end, |seq_end: Option<i64>, row| {
            Some(seq_end.unwrap_or(0).max(int(row, "sourceSeqEnd")))
        });
    let mut seen = HashSet::new();
    let rows = args
        .rows
        .iter()
        .map(row_id)
        .filter(|id| seen.insert(*id))
        .filter_map(|id| returned.get(id).cloned())
        .collect();
    TimelineWindow {
        rows,
        returned_segment_count,
        has_older_rows,
        older_cursor: has_older_rows.then(|| TimelinePaginationCursor {
            anchor_seq: window_start,
            anchor_id: format!("timeline-window:{window_start}"),
        }),
        older_rows_source_seq_end,
        older_row_updates: report.then_some(updates),
        content_cursor,
        content_page,
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn group_thousands(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

fn truncate_text(value: &str, max: usize) -> String {
    let length = utf16_len(value);
    if length <= max || value.ends_with(TRUNCATION_TAIL) {
        return value.to_owned();
    }
    let units: Vec<u16> = value.encode_utf16().take(max).collect();
    let head = String::from_utf16_lossy(&units);
    let dropped = group_thousands(length - max);
    format!("{head}\n…[{dropped}{TRUNCATION_TAIL}")
}

fn is_high(unit: u16) -> bool {
    unit & 0xfc00 == 0xd800
}

fn is_low(unit: u16) -> bool {
    unit & 0xfc00 == 0xdc00
}

fn splits_surrogate_pair(units: &[u16], index: usize) -> bool {
    let before = index.checked_sub(1).and_then(|i| units.get(i)).copied();
    before.is_some_and(is_high) && units.get(index).copied().is_some_and(is_low)
}

fn preview_text(output: &str) -> String {
    let units: Vec<u16> = output.encode_utf16().collect();
    let head_end = PREVIEW_HEAD_CHARS.min(units.len());
    let head_end =
        if splits_surrogate_pair(&units, PREVIEW_HEAD_CHARS) { head_end - 1 } else { head_end };
    let tail_start = units.len().saturating_sub(PREVIEW_TAIL_CHARS);
    let tail_start =
        if splits_surrogate_pair(&units, tail_start) { tail_start + 1 } else { tail_start };
    let head = &units[..head_end];
    let tail = &units[tail_start..];
    let omitted = units.len() as i64 - head.len() as i64 - tail.len() as i64;
    let count = if omitted < 0 {
        format!("-{}", group_thousands(omitted.unsigned_abs() as usize))
    } else {
        group_thousands(omitted as usize)
    };
    let (head, tail) = (String::from_utf16_lossy(head), String::from_utf16_lossy(tail));
    format!("{head}\n…[{count} characters omitted from preview]\n{tail}")
}

fn map_rows(rows: &[Value], map: &dyn Fn(Value) -> Value) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let key = match kind(row) {
                "turn" if row.get("children").is_some_and(|c| !c.is_null()) => Some("children"),
                "work" if is_delegation(row) => Some("childRows"),
                _ => None,
            };
            let Some(key) = key else { return map(row.clone()) };
            let nested = row.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
            let mut next = row.clone();
            if let Some(object) = next.as_object_mut() {
                object.insert(key.to_owned(), Value::Array(map_rows(&nested, map)));
            }
            map(next)
        })
        .collect()
}

fn cut_field(object: &mut Map<String, Value>, key: &str, max: usize) {
    if let Some(Value::String(text)) = object.get(key) {
        let cut = truncate_text(text, max);
        object.insert(key.to_owned(), Value::String(cut));
    }
}

fn truncate_row(mut row: Value) -> Value {
    let max = MAX_INLINE_OUTPUT_CHARS as usize;
    if kind(&row) != "work" {
        return row;
    }
    let work = work_kind(&row).to_owned();
    let Some(object) = row.as_object_mut() else { return row };
    match work.as_str() {
        "command" | "tool" | "delegation" => cut_field(object, "output", max),
        "file-change" => {
            if let Some(Value::Object(change)) = object.get_mut("change") {
                cut_field(change, "diff", max);
            }
            cut_field(object, "stdout", max);
            cut_field(object, "stderr", max);
        }
        _ => {}
    }
    row
}

fn preview_row(mut row: Value) -> Value {
    let output = row.get("output").and_then(Value::as_str).unwrap_or("").to_owned();
    let previewable = kind(&row) == "work"
        && matches!(work_kind(&row), "command" | "tool")
        && utf16_len(&output) > PREVIEW_THRESHOLD_CHARS;
    if !previewable {
        return row;
    }
    let Some(object) = row.as_object_mut() else { return row };
    let preview = match object.get("outputPreview") {
        Some(existing) if !existing.is_null() => existing.clone(),
        _ => json!({
            "experimental_fullOutputAvailability": "available",
            "totalChars": utf16_len(&output),
        }),
    };
    object.insert("output".to_owned(), Value::String(preview_text(&output)));
    object.insert("outputPreview".to_owned(), preview);
    row
}

/// Truncates long outputs in a `ThreadTimelineResponse` (its `rows` and
/// `timelinePage.olderRowUpdates`), and with `preview` shortens long command and tool outputs.
pub fn limit_response_outputs(mut response: Value, preview: bool) -> Value {
    let limit = |rows: &[Value]| -> Vec<Value> {
        let truncated = map_rows(rows, &truncate_row);
        if preview { truncated.into_iter().map(preview_row).collect() } else { truncated }
    };
    if let Some(rows) = response.get("rows").and_then(Value::as_array) {
        let limited = limit(rows);
        response["rows"] = Value::Array(limited);
    }
    let updates = response.pointer("/timelinePage/olderRowUpdates").and_then(Value::as_array);
    if let Some(updates) = updates {
        let limited = limit(updates);
        response["timelinePage"]["olderRowUpdates"] = Value::Array(limited);
    }
    response
}
