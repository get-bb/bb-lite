use std::collections::HashMap;

const QUERY_MAX_LENGTH: usize = 256;
const RANK_UNIT: i64 = 1_000_000;
const DIRECTORY_SEGMENT_RANK: i64 = 1;
const STRUCTURED_PATH_RANK: i64 = 2;
const EXACT_DIRECTORY_PREFIX_RANK: i64 = 3;

const SCORE_MATCH: i64 = 16;
const SCORE_GAP_START: i64 = -3;
const SCORE_GAP_EXTENSION: i64 = -1;
const BONUS_BOUNDARY: i64 = SCORE_MATCH / 2;
const BONUS_NON_WORD: i64 = SCORE_MATCH / 2;
const BONUS_CAMEL_123: i64 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE: i64 = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER: i64 = 2;

pub struct PathMatch {
    pub index: usize,
    pub score: i64,
    pub positions: Vec<usize>,
}

#[derive(Clone)]
struct Ranked {
    index: usize,
    text: String,
    score: i64,
    start: usize,
    positions: Vec<usize>,
}

struct FzfHit {
    index: usize,
    score: i64,
    start: usize,
    positions: Vec<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Lower,
    Upper,
    Letter,
    Number,
    NonWord,
}

fn class_of(c: char) -> Class {
    if c.is_lowercase() {
        Class::Lower
    } else if c.is_uppercase() {
        Class::Upper
    } else if c.is_numeric() {
        Class::Number
    } else if c.is_alphabetic() {
        Class::Letter
    } else {
        Class::NonWord
    }
}

fn bonus_for(prev: Class, class: Class) -> i64 {
    if prev == Class::NonWord && class != Class::NonWord {
        BONUS_BOUNDARY
    } else if (prev == Class::Lower && class == Class::Upper)
        || (prev != Class::Number && class == Class::Number)
    {
        BONUS_CAMEL_123
    } else if class == Class::NonWord {
        BONUS_NON_WORD
    } else {
        0
    }
}

fn fold(c: char, sensitive: bool) -> char {
    if sensitive { c } else { c.to_lowercase().next().unwrap_or(c) }
}

fn fuzzy_match(text: &[char], pattern: &[char], sensitive: bool) -> Option<FzfHit> {
    if pattern.is_empty() {
        return Some(FzfHit { index: 0, score: 0, start: 0, positions: Vec::new() });
    }
    let mut pidx = 0;
    let (mut sidx, mut eidx) = (None, 0);
    for (index, c) in text.iter().enumerate() {
        if fold(*c, sensitive) == pattern[pidx] {
            sidx.get_or_insert(index);
            pidx += 1;
            if pidx == pattern.len() {
                eidx = index + 1;
                break;
            }
        }
    }
    let mut sidx = sidx.filter(|_| pidx == pattern.len())?;
    let mut pidx = pattern.len();
    for index in (sidx..eidx).rev() {
        if fold(text[index], sensitive) == pattern[pidx - 1] {
            pidx -= 1;
            if pidx == 0 {
                sidx = index;
                break;
            }
        }
    }
    let (mut pidx, mut score, mut in_gap, mut consecutive, mut first_bonus) = (0, 0, false, 0, 0);
    let mut positions = Vec::new();
    let mut prev = if sidx > 0 { class_of(text[sidx - 1]) } else { Class::NonWord };
    for (index, raw) in text.iter().enumerate().take(eidx).skip(sidx) {
        let class = class_of(*raw);
        if pidx < pattern.len() && fold(*raw, sensitive) == pattern[pidx] {
            positions.push(index);
            score += SCORE_MATCH;
            let mut bonus = bonus_for(prev, class);
            if consecutive == 0 {
                first_bonus = bonus;
            } else {
                if bonus == BONUS_BOUNDARY {
                    first_bonus = bonus;
                }
                bonus = bonus.max(first_bonus).max(BONUS_CONSECUTIVE);
            }
            score += if pidx == 0 { bonus * BONUS_FIRST_CHAR_MULTIPLIER } else { bonus };
            in_gap = false;
            consecutive += 1;
            pidx += 1;
        } else {
            score += if in_gap { SCORE_GAP_EXTENSION } else { SCORE_GAP_START };
            in_gap = true;
            consecutive = 0;
            first_bonus = 0;
        }
        prev = class;
    }
    Some(FzfHit { index: 0, score, start: sidx, positions })
}

fn find(texts: &[&str], query: &str) -> Vec<FzfHit> {
    let sensitive = query.chars().any(char::is_uppercase);
    let pattern: Vec<char> = query.chars().map(|c| fold(c, sensitive)).collect();
    let mut hits: Vec<(FzfHit, usize)> = texts
        .iter()
        .enumerate()
        .filter_map(|(index, text)| {
            let chars: Vec<char> = text.chars().collect();
            fuzzy_match(&chars, &pattern, sensitive)
                .map(|hit| (FzfHit { index, ..hit }, chars.len()))
        })
        .collect();
    hits.sort_by(|(a, alen), (b, blen)| {
        b.score
            .cmp(&a.score)
            .then(a.start.cmp(&b.start))
            .then(alen.cmp(blen))
            .then(a.index.cmp(&b.index))
    });
    hits.into_iter().map(|(hit, _)| hit).collect()
}

fn sorted(mut positions: Vec<usize>) -> Vec<usize> {
    positions.sort_unstable();
    positions.dedup();
    positions
}

fn smart_case(query: &str, value: &str) -> String {
    if query == query.to_lowercase() { value.to_lowercase() } else { value.to_owned() }
}

fn is_subsequence(query: &str, value: &str) -> bool {
    let query: Vec<char> = query.chars().collect();
    let mut at = 0;
    for c in value.chars() {
        if query.get(at) == Some(&c) {
            at += 1;
        }
        if at == query.len() {
            return true;
        }
    }
    query.is_empty()
}

fn path_relevance_bonus(path: &str, query: &str) -> i64 {
    let value = smart_case(query, path);
    let base = &value[value.rfind('/').map_or(0, |at| at + 1)..];
    let mut bonus = 0;
    if base.contains(query) {
        bonus += 10_000;
    }
    if is_subsequence(query, base) {
        bonus += 5_000;
    }
    if value.contains(query) {
        bonus += 1_000;
    }
    let occurrences = if query.is_empty() { 0 } else { value.matches(query).count() as i64 };
    bonus + occurrences * 500
}

fn compare(left: &Ranked, right: &Ranked) -> std::cmp::Ordering {
    right
        .score
        .cmp(&left.score)
        .then(left.start.cmp(&right.start))
        .then(left.text.chars().count().cmp(&right.text.chars().count()))
        .then(left.text.cmp(&right.text))
}

fn ranked(
    item: &(usize, String),
    rank: i64,
    positions: Vec<usize>,
    score: i64,
    start: usize,
) -> Ranked {
    Ranked {
        index: item.0,
        text: item.1.clone(),
        score: rank * RANK_UNIT + score,
        start,
        positions,
    }
}

struct Segment<'a> {
    text: &'a str,
    start: usize,
    index: usize,
    is_file_name: bool,
}

fn split_segments(path: &str) -> Vec<Segment<'_>> {
    let names: Vec<&str> = path.split('/').collect();
    let mut start = 0;
    names
        .iter()
        .enumerate()
        .map(|(index, text)| {
            let segment = Segment { text, start, index, is_file_name: index == names.len() - 1 };
            start += text.chars().count() + 1;
            segment
        })
        .collect()
}

fn segment_match<'a>(
    query: &str,
    segments: &[&'a Segment<'a>],
) -> Option<(&'a Segment<'a>, Vec<usize>, i64, usize)> {
    let texts: Vec<&str> = segments.iter().map(|segment| segment.text).collect();
    let hit = find(&texts, query).into_iter().next()?;
    let segment = segments[hit.index];
    let positions = sorted(hit.positions.iter().map(|p| segment.start + p).collect());
    Some((segment, positions, hit.score, segment.start + hit.start))
}

fn directory_segment_match(item: &(usize, String), query: &str) -> Option<Ranked> {
    let query_len = query.chars().count();
    if query_len < 2 {
        return None;
    }
    let mut best: Option<(Vec<usize>, i64, usize)> = None;
    for segment in split_segments(&item.1) {
        if segment.is_file_name || !smart_case(query, segment.text).starts_with(query) {
            continue;
        }
        let value = smart_case(query, segment.text);
        let length = segment.text.chars().count();
        let score =
            if value == query { 30_000 } else { 25_000 - length.saturating_sub(query_len) as i64 }
                + if segment.start == 0 { 5_000 } else { 0 };
        if best.as_ref().is_some_and(|best| best.1 >= score) {
            continue;
        }
        best = Some(((0..query_len).map(|at| segment.start + at).collect(), score, segment.start));
    }
    best.map(|(positions, score, start)| {
        ranked(item, DIRECTORY_SEGMENT_RANK, positions, score, start)
    })
}

fn exact_directory_prefix_match(item: &(usize, String), query: &str) -> Option<Ranked> {
    let prefix = &query[..query.rfind('/').map_or(0, |at| at + 1)];
    let leaf = &query[prefix.len()..];
    if prefix.is_empty() || !smart_case(prefix, &item.1).starts_with(prefix) {
        return None;
    }
    let prefix_len = prefix.chars().count();
    let mut positions: Vec<usize> = (0..prefix_len).collect();
    if leaf.is_empty() {
        return Some(ranked(item, EXACT_DIRECTORY_PREFIX_RANK, positions, 0, 0));
    }
    let tail: String = item.1.chars().skip(prefix_len).collect();
    let hit = find(&[&tail], leaf).into_iter().next()?;
    positions.extend(hit.positions.iter().map(|p| prefix_len + p));
    let score = hit.score + path_relevance_bonus(&tail, leaf);
    Some(ranked(item, EXACT_DIRECTORY_PREFIX_RANK, sorted(positions), score, 0))
}

fn structured_path_match(item: &(usize, String), query: &str) -> Option<Ranked> {
    let query_segments: Vec<&str> = query.split('/').filter(|s| !s.is_empty()).collect();
    if query_segments.is_empty() || query_segments.len() > 8 {
        return None;
    }
    let leaf_query = query_segments[query_segments.len() - 1];
    let path_segments = split_segments(&item.1);
    let (mut positions, mut score, mut first_start, mut next) = (Vec::new(), 0, None, 0);
    for (query_index, query_segment) in query_segments.iter().enumerate() {
        let skip_file = query.ends_with('/') && query_index == query_segments.len() - 1;
        let candidates: Vec<&Segment> = path_segments
            .iter()
            .filter(|segment| segment.index >= next && !(skip_file && segment.is_file_name))
            .collect();
        let (segment, found, found_score, start) = segment_match(query_segment, &candidates)?;
        positions.extend(found);
        first_start = Some(first_start.map_or(start, |first: usize| first.min(start)));
        score += found_score + if segment.index == next { 5_000 } else { 0 };
        next = segment.index + 1;
    }
    if let Some(leaf) = path_segments.last()
        && let Some((_, _, leaf_score, _)) = segment_match(leaf_query, &[leaf])
    {
        let excess = leaf.text.chars().count().saturating_sub(leaf_query.chars().count());
        score += 50_000 + leaf_score - excess as i64;
    }
    Some(ranked(item, STRUCTURED_PATH_RANK, sorted(positions), score, first_start.unwrap_or(0)))
}

fn plain_path_matches(items: &[(usize, String)], query: &str) -> Vec<Ranked> {
    let texts: Vec<&str> = items.iter().map(|item| item.1.as_str()).collect();
    let mut matches: Vec<Ranked> = find(&texts, query)
        .into_iter()
        .map(|hit| {
            let item = &items[hit.index];
            let score = hit.score + path_relevance_bonus(&item.1, query);
            ranked(item, 0, sorted(hit.positions), score, hit.start)
        })
        .collect();
    matches.sort_by(compare);
    matches
}

fn rank_path_matches(items: &[(usize, String)], query: &str) -> Vec<Ranked> {
    if query.split('/').all(str::is_empty) {
        return Vec::new();
    }
    let collect = |matcher: fn(&(usize, String), &str) -> Option<Ranked>| {
        items.iter().filter_map(|item| matcher(item, query)).collect::<Vec<_>>()
    };
    if !query.contains('/') {
        let mut matches = plain_path_matches(items, query);
        matches.extend(collect(directory_segment_match));
        return matches;
    }
    let exact = collect(exact_directory_prefix_match);
    if !exact.is_empty() && query.ends_with('/') {
        return exact;
    }
    let structured = collect(structured_path_match);
    let mut base = if exact.is_empty() { plain_path_matches(items, query) } else { exact };
    base.extend(structured);
    base
}

/// Port of `fuzzyMatchPaths` from `@bb/fuzzy-match`, ranking `paths` against `query`.
pub fn fuzzy_match_paths(paths: &[&str], query: &str, limit: usize) -> Vec<PathMatch> {
    if limit == 0 {
        return Vec::new();
    }
    if query.is_empty() {
        let unranked = |index| PathMatch { index, score: 0, positions: Vec::new() };
        return (0..paths.len().min(limit)).map(unranked).collect();
    }
    let query = query.replace('\\', "/");
    if query.encode_utf16().count() > QUERY_MAX_LENGTH {
        return Vec::new();
    }
    let items: Vec<(usize, String)> =
        paths.iter().enumerate().map(|(index, path)| (index, path.replace('\\', "/"))).collect();
    let mut best: Vec<Ranked> = Vec::new();
    let mut slots: HashMap<String, usize> = HashMap::new();
    for found in rank_path_matches(&items, &query) {
        match slots.get(&found.text) {
            Some(&slot) => {
                if compare(&found, &best[slot]).is_lt() {
                    best[slot] = found;
                }
            }
            None => {
                slots.insert(found.text.clone(), best.len());
                best.push(found);
            }
        }
    }
    best.sort_by(compare);
    best.into_iter()
        .take(limit)
        .map(|found| PathMatch {
            index: found.index,
            score: found.score,
            positions: found.positions,
        })
        .collect()
}
