use crate::types::{LineStats, NameStatusEntry, NumstatEntry, WorkspaceFileStatusKind};

pub(crate) const CONFLICT_CODES: [&str; 7] = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PorcelainEntry {
    pub path: String,
    pub code: String,
}

pub fn split_nul(output: &str) -> Vec<String> {
    output.split('\0').filter(|value| !value.is_empty()).map(str::to_owned).collect()
}

fn split_at_char(text: &str, count: usize) -> (&str, &str) {
    let at = text.char_indices().nth(count).map_or(text.len(), |(at, _)| at);
    text.split_at(at)
}

pub(crate) fn parse_porcelain_z(output: &str) -> Vec<PorcelainEntry> {
    let tokens: Vec<&str> = output.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        let (code, _) = split_at_char(token, 2);
        if token.chars().count() > 3 {
            let (_, path) = split_at_char(token, 3);
            entries.push(PorcelainEntry { path: path.to_owned(), code: code.to_owned() });
            if code.contains('R') || code.contains('C') {
                index += 1;
            }
        }
        index += 1;
    }
    entries
}

pub fn parse_name_status_z(output: &str) -> Vec<NameStatusEntry> {
    let tokens: Vec<&str> = output.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let status = tokens[index].chars().next().map(String::from).unwrap_or_default();
        let renamed = status == "R" || status == "C";
        let target = tokens.get(index + if renamed { 2 } else { 1 }).copied().unwrap_or("");
        if !status.is_empty() && !target.is_empty() {
            let previous_path =
                if renamed { tokens.get(index + 1).map(|path| (*path).to_owned()) } else { None };
            entries.push(NameStatusEntry {
                path: target.to_owned(),
                previous_path,
                status: status.clone(),
            });
        }
        index += match (status.is_empty(), renamed) {
            (true, _) => 1,
            (false, true) => 3,
            (false, false) => 2,
        };
    }
    entries
}

/// `Number.parseInt(text, 10)`: the leading integer, or `None` when there is none.
pub(crate) fn parse_count(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    let value: i64 = digits[..end].parse().ok()?;
    Some(if negative { -value } else { value })
}

pub fn parse_numstat_z(output: &str) -> Vec<NumstatEntry> {
    let bytes = output.as_bytes();
    let find = |needle: u8, from: usize| {
        bytes.get(from..)?.iter().position(|&byte| byte == needle).map(|at| at + from)
    };
    let mut entries = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let Some(first_tab) = find(b'\t', cursor) else { break };
        let Some(second_tab) = find(b'\t', first_tab + 1) else { break };
        let renamed = bytes.get(second_tab + 1) == Some(&0);
        let path_start = if renamed {
            match find(0, second_tab + 2) {
                Some(at) => at + 1,
                None => break,
            }
        } else {
            second_tab + 1
        };
        let Some(path_end) = find(0, path_start) else { break };
        entries.push(NumstatEntry {
            path: output[path_start..path_end].to_owned(),
            insertions: parse_count(&output[cursor..first_tab]),
            deletions: parse_count(&output[first_tab + 1..second_tab]),
        });
        cursor = path_end + 1;
    }
    entries
}

pub fn sum_line_stats(entries: &[NumstatEntry]) -> LineStats {
    LineStats {
        insertions: entries.iter().map(|entry| entry.insertions.unwrap_or(0)).sum(),
        deletions: entries.iter().map(|entry| entry.deletions.unwrap_or(0)).sum(),
    }
}

pub(crate) fn porcelain_kind(code: &str) -> WorkspaceFileStatusKind {
    use WorkspaceFileStatusKind as Kind;
    if code == "??" {
        return Kind::Untracked;
    }
    if CONFLICT_CODES.contains(&code) {
        return Kind::U;
    }
    let kinds = [('U', Kind::U), ('R', Kind::R), ('C', Kind::C), ('A', Kind::A), ('D', Kind::D)];
    kinds.into_iter().find(|(letter, _)| code.contains(*letter)).map_or(Kind::M, |(_, kind)| kind)
}

pub(crate) fn name_status_kind(status: &str) -> WorkspaceFileStatusKind {
    use WorkspaceFileStatusKind as Kind;
    match status {
        "A" => Kind::A,
        "D" => Kind::D,
        "R" => Kind::R,
        "C" => Kind::C,
        "U" => Kind::U,
        "M" | "T" => Kind::M,
        _ => Kind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numstat_with_renames_and_binaries() {
        let output = "2\t1\ttracked.txt\0-\t-\tbin.dat\x000\t0\t\0old.txt\0new.txt\0";
        let entries = parse_numstat_z(output);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].insertions, Some(2));
        assert_eq!(
            entries[1],
            NumstatEntry { path: "bin.dat".into(), insertions: None, deletions: None }
        );
        assert_eq!(entries[2].path, "new.txt");
        assert_eq!(sum_line_stats(&entries), LineStats { insertions: 2, deletions: 1 });
    }

    #[test]
    fn parses_name_status_and_porcelain() {
        let entries = parse_name_status_z("M\0a.txt\0R100\0old\0new\0A\0b\0");
        let paths: Vec<_> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "new", "b"]);
        assert_eq!(entries[1].previous_path.as_deref(), Some("old"));
        assert_eq!(entries[1].status, "R");
        let porcelain = parse_porcelain_z("R  new\0old\0?? x\0UU c\0");
        let codes: Vec<_> = porcelain.iter().map(|entry| entry.code.as_str()).collect();
        assert_eq!(codes, ["R ", "??", "UU"]);
        assert_eq!(porcelain_kind("UU"), WorkspaceFileStatusKind::U);
        assert_eq!(porcelain_kind(" M"), WorkspaceFileStatusKind::M);
        assert_eq!(name_status_kind("T"), WorkspaceFileStatusKind::M);
        assert_eq!(name_status_kind("X"), WorkspaceFileStatusKind::Unknown);
        assert_eq!(split_nul("a\0\0b\0"), ["a", "b"]);
        assert_eq!(parse_count("12abc"), Some(12));
        assert_eq!(parse_count("-"), None);
    }
}
