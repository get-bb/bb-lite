use std::collections::HashSet;

use icu_normalizer::DecomposingNormalizerBorrowed;
use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::{Db, DbResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadSearchSourceKind {
    Title,
    TitleFallback,
    UserMessage,
    AssistantMessage,
    SystemMessage,
}

impl ThreadSearchSourceKind {
    fn is_title(self) -> bool {
        matches!(self, Self::Title | Self::TitleFallback)
    }
}

/// UTF-16 code unit offsets into `text`, as the web app indexes strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HighlightRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSearchMatch {
    pub source_kind: ThreadSearchSourceKind,
    pub text: String,
    pub highlight_ranges: Vec<HighlightRange>,
    pub source_seq: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSearchHit {
    pub thread_id: String,
    pub matches: Vec<ThreadSearchMatch>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSearchGroup {
    pub total: i64,
    pub hits: Vec<ThreadSearchHit>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSearchResult {
    pub active: ThreadSearchGroup,
    pub archived: ThreadSearchGroup,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchRow {
    archived: i64,
    total: i64,
    source_kind: ThreadSearchSourceKind,
    source_seq: Option<i64>,
    text: String,
    thread_id: String,
}

pub const SEARCH_LIMIT_PER_GROUP_DEFAULT: i64 = 20;
pub const SEARCH_LIMIT_PER_GROUP_MAX: i64 = 50;
const HIGHLIGHT_RANGE_LIMIT: usize = 8;
const SNIPPET_MAX_CHARS: usize = 160;
const SNIPPET_LEAD_CHARS: usize = 40;
const IS_TITLE: &str = "s.source_kind IN ('title', 'title_fallback')";
const FTS: &str = "thread_search_segments_fts";

fn fold_text(value: &str) -> String {
    let categories = CodePointMapData::<GeneralCategory>::new();
    DecomposingNormalizerBorrowed::new_nfd()
        .normalize(value)
        .chars()
        .filter(|character| !GeneralCategoryGroup::Mark.contains(categories.get(*character)))
        .collect::<String>()
        .to_lowercase()
}

fn find_units(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| from + offset)
}

fn highlight_ranges(text: &str, tokens: &[&str]) -> Vec<HighlightRange> {
    let mut folded: Vec<u16> = Vec::new();
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    let mut index = 0;
    for character in text.chars() {
        let end = index + character.len_utf16();
        let units: Vec<u16> =
            fold_text(character.encode_utf8(&mut [0; 4])).encode_utf16().collect();
        for _ in 0..units.len() {
            starts.push(index);
            ends.push(end);
        }
        folded.extend(units);
        index = end;
    }
    let text_length = index;
    let mut seen = HashSet::new();
    let mut ranges = Vec::new();
    for token in tokens.iter().map(|token| fold_text(token)) {
        if token.is_empty() || !seen.insert(token.clone()) {
            continue;
        }
        let token: Vec<u16> = token.encode_utf16().collect();
        let mut at = find_units(&folded, &token, 0);
        while let Some(found) = at {
            let end = ends.get(found + token.len() - 1).copied().unwrap_or(text_length);
            ranges.push(HighlightRange { start: starts.get(found).copied().unwrap_or(0), end });
            at = find_units(&folded, &token, found + token.len());
        }
    }
    ranges.sort_by_key(|range| (range.start, range.end));
    let mut merged: Vec<HighlightRange> = Vec::new();
    for range in ranges {
        match merged.last_mut() {
            Some(previous) if range.start <= previous.end => {
                previous.end = previous.end.max(range.end);
            }
            _ => merged.push(range),
        }
    }
    merged.truncate(HIGHLIGHT_RANGE_LIMIT);
    merged
}

fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn code_points(units: &[u16]) -> Vec<(usize, bool)> {
    let mut at = 0;
    char::decode_utf16(units.iter().copied())
        .map(|decoded| {
            let (length, space) = match decoded {
                Ok(character) => (character.len_utf16(), is_js_space(character)),
                Err(_) => (1, false),
            };
            let point = (at, space);
            at += length;
            point
        })
        .collect()
}

fn first_space(units: &[u16]) -> Option<usize> {
    code_points(units).into_iter().find(|(_, space)| *space).map(|(at, _)| at)
}

fn last_space(units: &[u16]) -> Option<usize> {
    code_points(units).into_iter().rev().find(|(_, space)| *space).map(|(at, _)| at)
}

fn snippet(text: &str, tokens: &[&str]) -> (String, Vec<HighlightRange>) {
    let ranges = highlight_ranges(text, tokens);
    let units: Vec<u16> = text.encode_utf16().collect();
    let length = units.len();
    if length <= SNIPPET_MAX_CHARS {
        return (text.to_owned(), ranges);
    }
    let anchor_start = ranges.first().map_or(0, |range| range.start);
    let anchor_end = ranges.first().map_or(0, |range| range.end);
    let mut start = anchor_start
        .saturating_sub(SNIPPET_LEAD_CHARS)
        .min(length.saturating_sub(SNIPPET_MAX_CHARS));
    let mut end = length.min(start + SNIPPET_MAX_CHARS);
    let lead = (start > 0 && start < anchor_start)
        .then(|| first_space(&units[start..anchor_start]))
        .flatten();
    if let Some(boundary) = lead {
        start += boundary + 1;
    }
    if end < length {
        let tail_start = anchor_end.max(start);
        let tail = (tail_start < end).then(|| last_space(&units[tail_start..end])).flatten();
        if let Some(boundary) = tail {
            let near = end - (tail_start + boundary) <= SNIPPET_LEAD_CHARS;
            if boundary > 0 && near {
                end = tail_start + boundary;
            }
        }
    }
    if start > 0 && start < length && units[start] & 0xfc00 == 0xdc00 {
        start += 1;
    }
    if end > start && end < length && units[end - 1] & 0xfc00 == 0xd800 {
        end -= 1;
    }
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < length { "…" } else { "" };
    let shown = String::from_utf16_lossy(&units[start.min(end)..end]);
    let shift = usize::from(start > 0);
    let shifted = ranges
        .into_iter()
        .map(|range| HighlightRange {
            start: range.start.max(start) + shift - start,
            end: (range.end.min(end) + shift).saturating_sub(start),
        })
        .filter(|range| range.end > range.start)
        .collect();
    (format!("{prefix}{shown}{suffix}"), shifted)
}

fn list_match_rows(
    db: &Db,
    token_queries: &[String],
    limit_per_group: i64,
) -> DbResult<Vec<MatchRow>> {
    let token_matches: Vec<String> = (0..token_queries.len())
        .map(|index| {
            format!(
                "SELECT s.thread_id AS thread_id, {index} AS token,
       MIN({FTS}.rank) AS token_rank
     FROM {FTS} JOIN thread_search_segments AS s ON s.rowid = {FTS}.rowid
     WHERE {FTS} MATCH ? GROUP BY s.thread_id"
            )
        })
        .collect();
    let sql = format!(
        "WITH token_matches AS ({}),
     ranked_threads AS (
       SELECT m.thread_id, MIN(m.token_rank) AS best_rank,
         MAX(t.updated_at) AS updated_at,
         MAX(t.archived_at IS NOT NULL) AS archived
       FROM token_matches AS m JOIN threads AS t ON t.id = m.thread_id
       WHERE t.deleted_at IS NULL AND t.visibility = 'visible'
       GROUP BY m.thread_id HAVING COUNT(*) = {}),
     ordered_threads AS (
       SELECT thread_id, archived, ROW_NUMBER() OVER (PARTITION BY archived
           ORDER BY best_rank, updated_at DESC, thread_id DESC) AS thread_order,
         COUNT(*) OVER (PARTITION BY archived) AS total
       FROM ranked_threads),
     ranked_segments AS (
       SELECT o.archived, o.thread_order, o.total, {IS_TITLE} AS is_title,
         ROW_NUMBER() OVER (PARTITION BY s.thread_id, {IS_TITLE}
           ORDER BY {FTS}.rank, COALESCE(s.source_seq, -1), s.id)
           AS segment_order,
         s.source_kind, s.source_seq, s.text, s.thread_id
       FROM {FTS} JOIN thread_search_segments AS s ON s.rowid = {FTS}.rowid
         JOIN ordered_threads AS o ON o.thread_id = s.thread_id
       WHERE {FTS} MATCH ? AND o.thread_order <= ?)
     SELECT archived, total, source_kind, source_seq, text, thread_id
     FROM ranked_segments WHERE is_title = 1 OR segment_order <= 1
     ORDER BY archived, thread_order, is_title DESC, segment_order",
        token_matches.join(" UNION ALL "),
        token_queries.len()
    );
    let mut params: Vec<rusqlite::types::Value> =
        token_queries.iter().cloned().map(rusqlite::types::Value::Text).collect();
    params.push(rusqlite::types::Value::Text(token_queries.join(" OR ")));
    params.push(rusqlite::types::Value::Integer(limit_per_group));
    db.all(&sql, rusqlite::params_from_iter(params))
}

fn to_group(rows: Vec<MatchRow>, tokens: &[&str]) -> ThreadSearchGroup {
    let total = rows.first().map_or(0, |row| row.total);
    let mut hits: IndexMap<String, Vec<ThreadSearchMatch>> = IndexMap::new();
    for row in rows {
        let (text, highlight_ranges) = if row.source_kind.is_title() {
            let ranges = highlight_ranges(&row.text, tokens);
            (row.text, ranges)
        } else {
            snippet(&row.text, tokens)
        };
        hits.entry(row.thread_id).or_default().push(ThreadSearchMatch {
            source_kind: row.source_kind,
            text,
            highlight_ranges,
            source_seq: row.source_seq,
        });
    }
    let hits = hits
        .into_iter()
        .map(|(thread_id, matches)| ThreadSearchHit { thread_id, matches })
        .collect();
    ThreadSearchGroup { total, hits }
}

fn query_tokens(query: &str) -> Vec<&str> {
    let categories = CodePointMapData::<GeneralCategory>::new();
    let mut tokens = Vec::new();
    let mut start = None;
    for (at, character) in query.char_indices() {
        let category = categories.get(character);
        let word = GeneralCategoryGroup::Letter.contains(category)
            || GeneralCategoryGroup::Number.contains(category)
            || character == '_';
        match (word, start) {
            (true, None) => start = Some(at),
            (false, Some(from)) => {
                tokens.push(&query[from..at]);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(from) = start {
        tokens.push(&query[from..]);
    }
    tokens
}

pub fn search_threads(db: &Db, query: &str, limit_per_group: i64) -> DbResult<ThreadSearchResult> {
    let tokens = query_tokens(query);
    let mut token_queries: Vec<String> = Vec::new();
    for token in &tokens {
        let quoted = format!("\"{token}\"*");
        if !token_queries.contains(&quoted) {
            token_queries.push(quoted);
        }
    }
    let rows = if token_queries.is_empty() {
        Vec::new()
    } else {
        list_match_rows(db, &token_queries, limit_per_group)?
    };
    let (archived, active): (Vec<MatchRow>, Vec<MatchRow>) = rows
        .into_iter()
        .filter(|row| row.archived == 0 || row.archived == 1)
        .partition(|row| row.archived == 1);
    Ok(ThreadSearchResult {
        active: to_group(active, &tokens),
        archived: to_group(archived, &tokens),
    })
}
