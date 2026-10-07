use serde::{Deserialize, Serialize};

/// `TimelineActivityIntent` from `@bb/server-contract`: what a shell command does, as shown in the
/// timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TimelineActivityIntent {
    #[serde(rename = "read")]
    Read { command: String, name: String, path: Option<String> },
    #[serde(rename = "list_files")]
    ListFiles { command: String, path: Option<String> },
    #[serde(rename = "search")]
    Search { command: String, query: Option<String>, path: Option<String> },
    #[serde(rename = "unknown")]
    Unknown { command: String },
}

const SHELL_WRAPPER_NAMES: [&str; 3] = ["sh", "bash", "zsh"];

const SHELL_SEGMENT_BREAK_TOKENS: [&str; 5] = ["&&", "||", "|", ";", "\n"];

const SEARCH_FLAGS_WITH_VALUE: &[&str] = &[
    "-g",
    "--glob",
    "-t",
    "--type",
    "-T",
    "--type-not",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-m",
    "--max-count",
];

const FIND_FLAGS_WITH_VALUE: &[&str] = &[
    "-name",
    "-iname",
    "-path",
    "-ipath",
    "-type",
    "-maxdepth",
    "-mindepth",
    "-size",
    "-mtime",
    "-mmin",
    "-user",
    "-group",
    "-perm",
    "-regex",
    "-iregex",
];

const HEAD_TAIL_FLAGS_WITH_VALUE: &[&str] = &["-n", "-c"];

const NO_FLAGS_WITH_VALUE: &[&str] = &[];

fn is_double_quote_escapable(ch: char) -> bool {
    matches!(ch, '$' | '`' | '"' | '\\' | '\n')
}

fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

fn is_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

fn unwrap_quoted_shell_arg(value: &str) -> String {
    let quote = match value.chars().next() {
        Some(q @ ('\'' | '"')) => q,
        _ => return value.to_string(),
    };
    if value.len() < 2 || !value.ends_with(quote) {
        return value.to_string();
    }
    let inner = &value[1..value.len() - 1];
    if quote == '\'' {
        return inner.to_string();
    }
    let mut result = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\'
            && let Some(next) = chars.next_if(|&next| is_double_quote_escapable(next))
        {
            result.push(next);
            continue;
        }
        result.push(ch);
    }
    result
}

fn is_known_shell_wrapper(value: &str) -> bool {
    let shell_name = value.rsplit('/').next().unwrap_or(value);
    SHELL_WRAPPER_NAMES.contains(&shell_name)
}

/// Unwraps `sh|bash|zsh -c|-lc '<command>'` to the inner command; otherwise returns the trimmed
/// input. `None` for blank input.
pub fn extract_shell_command_from_string(value: &str) -> Option<String> {
    let trimmed = js_trim(value);
    if trimmed.is_empty() {
        return None;
    }
    let Some(program_end) = trimmed.find(is_js_whitespace) else {
        return Some(trimmed.to_string());
    };
    let shell_program = &trimmed[..program_end];
    let after_program = trimmed[program_end..].trim_start_matches(is_js_whitespace);
    let after_flag = after_program
        .strip_prefix("-lc")
        .filter(|rest| rest.starts_with(is_js_whitespace))
        .or_else(|| {
            after_program.strip_prefix("-c").filter(|rest| rest.starts_with(is_js_whitespace))
        });
    let Some(after_flag) = after_flag else {
        return Some(trimmed.to_string());
    };
    let command_arg = after_flag.trim_start_matches(is_js_whitespace);
    if command_arg.is_empty() || !is_known_shell_wrapper(shell_program) {
        return Some(trimmed.to_string());
    }
    Some(unwrap_quoted_shell_arg(js_trim(command_arg)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShellToken {
    value: String,
    quoted: bool,
}

impl ShellToken {
    fn operator(value: &str) -> Self {
        ShellToken { value: value.to_string(), quoted: false }
    }
}

#[derive(Default)]
struct TokenBuilder {
    tokens: Vec<ShellToken>,
    current: String,
    has_quoted: bool,
    has_unquoted: bool,
}

impl TokenBuilder {
    fn flush(&mut self) {
        let fully_quoted = self.has_quoted && !self.has_unquoted;
        if self.current.is_empty() && !fully_quoted {
            self.has_quoted = false;
            self.has_unquoted = false;
            return;
        }
        self.tokens
            .push(ShellToken { value: std::mem::take(&mut self.current), quoted: fully_quoted });
        self.has_quoted = false;
        self.has_unquoted = false;
    }

    fn push_quoted(&mut self, ch: char) {
        self.current.push(ch);
        self.has_quoted = true;
    }

    fn push_unquoted(&mut self, ch: char) {
        self.current.push(ch);
        self.has_unquoted = true;
    }

    fn push_operator(&mut self, value: &str) {
        self.tokens.push(ShellToken::operator(value));
    }
}

fn tokenize_shell_words(command: &str) -> Vec<ShellToken> {
    let chars: Vec<char> = command.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let mut b = TokenBuilder::default();
    let mut quote: Option<char> = None;
    let mut escaping = false;
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if escaping {
            if quote.is_some() {
                b.push_quoted(character);
            } else {
                b.push_unquoted(character);
            }
            escaping = false;
            index += 1;
            continue;
        }
        if character == '\\' {
            if quote == Some('\'') {
                b.push_quoted(character);
                index += 1;
                continue;
            }
            if quote == Some('"') && !at(index + 1).is_some_and(is_double_quote_escapable) {
                b.push_quoted(character);
                index += 1;
                continue;
            }
            escaping = true;
            index += 1;
            continue;
        }
        if let Some(q) = quote {
            if character == q {
                quote = None;
                if b.current.is_empty() {
                    b.has_quoted = true;
                }
            } else {
                b.push_quoted(character);
            }
            index += 1;
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            index += 1;
            continue;
        }
        if character == '\n' {
            b.flush();
            b.push_operator("\n");
            index += 1;
            continue;
        }
        if is_js_whitespace(character) {
            b.flush();
            index += 1;
            continue;
        }
        if character == '|' || character == '&' || character == ';' {
            if character == '&' && at(index + 1) == Some('>') {
                b.flush();
                if at(index + 2) == Some('>') {
                    b.push_operator("&>>");
                    index += 3;
                } else {
                    b.push_operator("&>");
                    index += 2;
                }
                continue;
            }
            b.flush();
            let next = at(index + 1);
            if (character == '|' && next == Some('|')) || (character == '&' && next == Some('&')) {
                b.push_operator(if character == '|' { "||" } else { "&&" });
                index += 2;
                continue;
            }
            b.push_operator(&character.to_string());
            index += 1;
            continue;
        }
        if character == '<' || character == '>' {
            let mut prefix = String::new();
            let current_is_unquoted = b.has_unquoted && !b.has_quoted;
            if current_is_unquoted && (b.current == "&" || is_ascii_digits(&b.current)) {
                prefix = std::mem::take(&mut b.current);
                b.has_unquoted = false;
            } else if !b.current.is_empty() || b.has_quoted {
                b.flush();
            }
            let next1 = at(index + 1);
            let next2 = at(index + 2);
            let (op, consumed) = if character == '>' {
                match next1 {
                    Some('>') => (">>", 2),
                    Some('|') => (">|", 2),
                    Some('(') => (">(", 2),
                    Some('&') => (">&", 2),
                    _ => (">", 1),
                }
            } else {
                match (next1, next2) {
                    (Some('<'), Some('<')) => ("<<<", 3),
                    (Some('<'), Some('-')) => ("<<-", 3),
                    (Some('<'), _) => ("<<", 2),
                    (Some('('), _) => ("<(", 2),
                    (Some('>'), _) => ("<>", 2),
                    _ => ("<", 1),
                }
            };
            prefix.push_str(op);
            b.push_operator(&prefix);
            index += consumed;
            continue;
        }
        b.push_unquoted(character);
        index += 1;
    }
    if escaping {
        b.push_unquoted('\\');
    }
    b.flush();
    b.tokens
}

fn base_executable_name(token: &str) -> &str {
    match token.rfind('/') {
        Some(slash) => &token[slash + 1..],
        None => token,
    }
}

fn is_sed_in_place_flag(token: &str) -> bool {
    if token == "--in-place" || token.starts_with("--in-place=") {
        return true;
    }
    token.starts_with("-i") && !token.starts_with("-i-")
}

fn is_env_assignment(value: &str) -> bool {
    let Some(eq) = value.find('=') else {
        return false;
    };
    let name = &value[..eq];
    let mut bytes = name.bytes();
    match bytes.next() {
        Some(first) if first.is_ascii_alphabetic() || first == b'_' => {}
        _ => return false,
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn split_shell_command_segments(command: &str) -> Vec<Vec<ShellToken>> {
    let mut segments = Vec::new();
    let mut current = Vec::new();
    for token in tokenize_shell_words(command) {
        if !token.quoted && SHELL_SEGMENT_BREAK_TOKENS.contains(&token.value.as_str()) {
            if !current.is_empty() {
                segments.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(token);
    }
    if !current.is_empty() {
        segments.push(current);
    }
    segments
}

struct Redirect {
    is_write: bool,
    consumed_extra: usize,
}

fn redirect(is_write: bool, consumed_extra: usize) -> Option<Redirect> {
    Some(Redirect { is_write, consumed_extra })
}

fn split_redirect_prefix(value: &str) -> (&str, &str) {
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 {
        return value.split_at(digits);
    }
    if value.starts_with('&') {
        return value.split_at(1);
    }
    ("", value)
}

fn scan_redirect_at(tokens: &[ShellToken], index: usize) -> Option<Redirect> {
    let token = tokens.get(index)?;
    if token.quoted {
        return None;
    }
    let value = token.value.as_str();
    let next_value = tokens.get(index + 1).map(|t| t.value.as_str());
    let (prefix, op) = split_redirect_prefix(value);
    if op == "<<" || op == "<<-" {
        return redirect(true, 1);
    }
    if op == "<<<" {
        return redirect(false, 1);
    }
    if value == "<(" || value == ">(" {
        let mut extra = 0;
        for t in &tokens[index + 1..] {
            extra += 1;
            if t.value.ends_with(')') {
                break;
            }
        }
        return redirect(false, extra);
    }
    if op == "<>" {
        return redirect(true, 1);
    }
    if op == "<" {
        return redirect(false, 1);
    }
    if op == ">|" {
        return redirect(next_value != Some("/dev/null"), 1);
    }
    if op == ">&" || op == ">>&" {
        return redirect(false, usize::from(next_value.is_some()));
    }
    if op == ">" || op == ">>" {
        let Some(next_value) = next_value else {
            return redirect(false, 0);
        };
        if prefix.starts_with(|c: char| ('2'..='9').contains(&c)) {
            return redirect(false, 1);
        }
        return redirect(next_value != "/dev/null", 1);
    }
    None
}

fn get_command_token_index(tokens: &[ShellToken]) -> usize {
    tokens.iter().take_while(|t| !t.quoted && is_env_assignment(&t.value)).count()
}

fn segment_has_write_shape(arg_tokens: &[ShellToken]) -> bool {
    let mut i = 0;
    while i < arg_tokens.len() {
        if let Some(redir) = scan_redirect_at(arg_tokens, i) {
            if redir.is_write {
                return true;
            }
            i += 1 + redir.consumed_extra;
            continue;
        }
        i += 1;
    }
    false
}

fn collect_positionals(arg_tokens: &[ShellToken], flags_with_value: &[&str]) -> Vec<String> {
    let mut positionals = Vec::new();
    let mut i = 0;
    while i < arg_tokens.len() {
        let token = &arg_tokens[i];
        if let Some(redir) = scan_redirect_at(arg_tokens, i) {
            i += 1 + redir.consumed_extra;
            continue;
        }
        if !token.quoted && token.value.starts_with('-') && token.value != "-" {
            i += if flags_with_value.contains(&token.value.as_str()) { 2 } else { 1 };
            continue;
        }
        positionals.push(token.value.clone());
        i += 1;
    }
    positionals
}

enum SegmentClassification {
    Write,
    Intent(TimelineActivityIntent),
    None,
}

fn classify_shell_segment(tokens: &[ShellToken], full_command: &str) -> SegmentClassification {
    let command_index = get_command_token_index(tokens);
    let Some(command_token) = tokens.get(command_index) else {
        return SegmentClassification::None;
    };
    let arg_tokens = &tokens[command_index + 1..];
    let command_name = base_executable_name(&command_token.value);
    if command_name == "tee" {
        return SegmentClassification::Write;
    }
    if command_name == "sed"
        && arg_tokens.iter().any(|t| !t.quoted && is_sed_in_place_flag(&t.value))
    {
        return SegmentClassification::Write;
    }
    if segment_has_write_shape(arg_tokens) {
        return SegmentClassification::Write;
    }
    let read_intent = |path: Option<&String>| match path {
        Some(path) if !path.is_empty() => {
            SegmentClassification::Intent(TimelineActivityIntent::Read {
                command: full_command.to_string(),
                name: command_name.to_string(),
                path: Some(path.clone()),
            })
        }
        _ => SegmentClassification::None,
    };
    match command_name {
        "rg" | "grep" => {
            let positionals = collect_positionals(arg_tokens, SEARCH_FLAGS_WITH_VALUE);
            SegmentClassification::Intent(TimelineActivityIntent::Search {
                command: full_command.to_string(),
                query: positionals.first().cloned(),
                path: if positionals.len() > 1 { positionals.last().cloned() } else { None },
            })
        }
        "find" => {
            let positionals = collect_positionals(arg_tokens, FIND_FLAGS_WITH_VALUE);
            match positionals.into_iter().next() {
                Some(path) if !path.is_empty() => {
                    SegmentClassification::Intent(TimelineActivityIntent::ListFiles {
                        command: full_command.to_string(),
                        path: Some(path),
                    })
                }
                _ => SegmentClassification::None,
            }
        }
        "ls" => {
            let positionals = collect_positionals(arg_tokens, NO_FLAGS_WITH_VALUE);
            SegmentClassification::Intent(TimelineActivityIntent::ListFiles {
                command: full_command.to_string(),
                path: Some(positionals.into_iter().next().unwrap_or_else(|| ".".to_string())),
            })
        }
        "cat" | "nl" => read_intent(collect_positionals(arg_tokens, NO_FLAGS_WITH_VALUE).first()),
        "head" | "tail" => {
            read_intent(collect_positionals(arg_tokens, HEAD_TAIL_FLAGS_WITH_VALUE).first())
        }
        "sed" if arg_tokens.iter().any(|t| !t.quoted && t.value == "-n") => {
            read_intent(collect_positionals(arg_tokens, NO_FLAGS_WITH_VALUE).get(1))
        }
        _ => SegmentClassification::None,
    }
}

/// Classifies a shell command: empty when any segment writes (redirect, `tee`, `sed -i`),
/// otherwise the first read, list or search intent among its pipeline and `&&`/`;` segments.
pub fn parse_shell_command_intents(command: Option<&str>) -> Vec<TimelineActivityIntent> {
    let Some(command) = command.filter(|c| !c.is_empty()) else {
        return Vec::new();
    };
    let classifications: Vec<SegmentClassification> = split_shell_command_segments(command)
        .iter()
        .map(|segment| classify_shell_segment(segment, command))
        .collect();
    if classifications.iter().any(|c| matches!(c, SegmentClassification::Write)) {
        return Vec::new();
    }
    classifications
        .into_iter()
        .find_map(|c| match c {
            SegmentClassification::Intent(intent) => Some(intent),
            _ => None,
        })
        .into_iter()
        .collect()
}
