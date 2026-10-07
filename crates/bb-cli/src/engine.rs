use std::collections::HashMap;

use crate::call::{CliError, Handler};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlagKind {
    Boolean,
    String,
    List,
    Optional,
}

#[derive(Debug, Clone)]
pub struct FlagSpec {
    pub names: Vec<String>,
    pub kind: FlagKind,
    pub placeholder: String,
    pub help: String,
}

#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub path: String,
    pub aliases: Vec<String>,
    pub args: String,
    pub summary: String,
    pub flags: Vec<FlagSpec>,
    pub examples: Vec<String>,
    pub json: String,
    pub run: Handler,
}

#[derive(Debug)]
pub struct Table {
    pub commands: Vec<CommandSpec>,
    pub groups: &'static [(&'static str, &'static str)],
    pub aliases: &'static [(&'static str, &'static str)],
}

impl Table {
    pub fn group(&self, name: &str) -> Option<&'static str> {
        lookup(self.groups, name)
    }

    pub fn alias(&self, name: &str) -> Option<&'static str> {
        lookup(self.aliases, name)
    }
}

fn lookup(entries: &'static [(&'static str, &'static str)], name: &str) -> Option<&'static str> {
    entries.iter().find(|(key, _)| *key == name).map(|(_, value)| *value)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Invocation {
    pub args: HashMap<String, String>,
    pub rest: Vec<String>,
    pub flags: HashMap<String, Vec<String>>,
}

#[derive(Debug)]
pub enum Resolution<'a> {
    Command { spec: &'a CommandSpec, argv: Vec<String> },
    Group { group: String, unknown: Option<String> },
    Other { name: Option<String>, argv: Vec<String> },
}

const MAX_PATH_WORDS: usize = 3;
const GLOBAL_FLAGS: &str = "
  --json  Print machine-readable JSON
  --help  Show this help";
pub const JSON_FAILURE: &str = "With --json a failure prints {\"ok\": false, \"error\": {code, message, \
                                hint?}} on stdout, the readable message on stderr, and exits non-zero.";

fn width(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn camel_case(path: &str) -> String {
    let mut out = String::new();
    let mut chars = path.chars().peekable();
    while let Some(c) = chars.next() {
        let word = chars.peek().is_some_and(|n| n.is_ascii_alphanumeric() || *n == '_');
        if (c == ' ' || c == '-') && word {
            out.extend(chars.next().map(|n| n.to_ascii_uppercase()));
        } else {
            out.push(c);
        }
    }
    out
}

fn split_gap(text: &str) -> Option<(&str, &str)> {
    if text.starts_with(char::is_whitespace) {
        return None;
    }
    text.char_indices().skip(1).find_map(|(at, _)| {
        let tail = &text[at..];
        let rest = tail.trim_start();
        let gap = tail.chars().take_while(|c| c.is_whitespace()).count();
        (gap >= 2 && !rest.is_empty()).then(|| (&text[..at], rest))
    })
}

fn parse_flag(line: &str) -> Result<FlagSpec, String> {
    let malformed = || format!("Malformed flag line '{}'", line.trim());
    let body = line.strip_prefix("  --").ok_or_else(malformed)?;
    let end = body.find(char::is_whitespace).ok_or_else(malformed)?;
    let (names, mut rest) = body.split_at(end);
    let mut value: Option<&str> = None;
    let mut repeat = false;
    let close = match rest.strip_prefix(' ') {
        Some(tail) if tail.starts_with('<') => tail.find('>'),
        Some(tail) if tail.starts_with('[') => tail.find(']'),
        _ => None,
    };
    if let Some(close) = close.filter(|close| *close > 1) {
        value = Some(&rest[1..close + 2]);
        rest = &rest[close + 2..];
        if value.is_some_and(|v| v.starts_with('<')) && rest.starts_with("...") {
            repeat = true;
            rest = &rest[3..];
        }
    }
    let help = rest.trim_start();
    if names.is_empty() || rest.len() - help.len() < 2 || help.is_empty() {
        return Err(malformed());
    }
    let kind = match value {
        None => FlagKind::Boolean,
        Some(_) if repeat => FlagKind::List,
        Some(v) if v.starts_with('[') => FlagKind::Optional,
        Some(_) => FlagKind::String,
    };
    Ok(FlagSpec {
        names: names.split('|').map(String::from).collect(),
        kind,
        placeholder: value.unwrap_or("").to_string(),
        help: help.to_string(),
    })
}

fn join_continuations(block: &str) -> String {
    let mut out = String::new();
    let mut lines = block.split('\n');
    out.push_str(lines.next().unwrap_or(""));
    for line in lines {
        let indent = line.len() - line.trim_start_matches(' ').len();
        if indent >= 4 {
            out.push(' ');
            out.push_str(&line[indent..]);
        } else {
            out.push('\n');
            out.push_str(line);
        }
    }
    out
}

fn parse_command(
    block: &str,
    handlers: &HashMap<&'static str, Handler>,
) -> Result<CommandSpec, String> {
    let joined = join_continuations(block);
    let lines: Vec<&str> = joined.split('\n').collect();
    let (usage, summary) = split_gap(lines.first().copied().unwrap_or("")).unwrap_or(("", ""));
    let mut words: Vec<&str> = usage.split(' ').collect();
    let args_at = words.iter().position(|w| w.starts_with('<') || w.starts_with('['));
    let args = args_at.map(|at| words.split_off(at).join(" ")).unwrap_or_default();
    let last = words.pop().unwrap_or("");
    let mut leaves = last.split('|').map(String::from);
    let leaf = leaves.next().unwrap_or_default();
    let aliases: Vec<String> = leaves.collect();
    words.push(&leaf);
    let path = words.join(" ");
    let run = *handlers
        .get(camel_case(&path).as_str())
        .ok_or_else(|| format!("'bb {path}' has no handler"))?;
    let marked = |mark: &str| -> Vec<String> {
        lines.iter().filter(|l| l.starts_with(mark)).map(|l| l[4..].to_string()).collect()
    };
    let flags = lines
        .iter()
        .filter(|line| line.starts_with("  --"))
        .map(|line| parse_flag(line))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CommandSpec {
        path,
        aliases,
        args,
        summary: summary.to_string(),
        flags,
        examples: marked("  $ "),
        json: marked("  > ").join(" "),
        run,
    })
}

pub fn parse_commands(
    text: &str,
    handlers: &HashMap<&'static str, Handler>,
) -> Result<Vec<CommandSpec>, String> {
    let mut blocks: Vec<String> = Vec::new();
    for line in text.split('\n') {
        match blocks.last_mut() {
            Some(block) if !line.starts_with(|c: char| !c.is_whitespace()) => {
                block.push('\n');
                block.push_str(line);
            }
            _ => blocks.push(line.to_string()),
        }
    }
    blocks
        .iter()
        .filter(|block| !block.trim().is_empty())
        .map(|block| parse_command(&format!("{}{GLOBAL_FLAGS}", block.trim_end()), handlers))
        .collect()
}

pub fn command_paths(spec: &CommandSpec) -> Vec<String> {
    let (prefix, leaf) = match spec.path.rsplit_once(' ') {
        Some((prefix, leaf)) => (format!("{prefix} "), leaf),
        None => (String::new(), spec.path.as_str()),
    };
    std::iter::once(leaf)
        .chain(spec.aliases.iter().map(String::as_str))
        .map(|leaf| format!("{prefix}{leaf}"))
        .collect()
}

pub fn resolve_command<'a>(table: &'a Table, input: &[String]) -> Resolution<'a> {
    let argv: Vec<String> = match input.split_first() {
        Some((first, others)) => match table.alias(first).filter(|alias| !alias.is_empty()) {
            Some(alias) => {
                alias.split(' ').map(String::from).chain(others.iter().cloned()).collect()
            }
            None => input.to_vec(),
        },
        None => Vec::new(),
    };
    let flag_at = argv.iter().position(|t| t.starts_with('-')).unwrap_or(argv.len());
    let words = &argv[..flag_at];
    let index: HashMap<String, &CommandSpec> = table
        .commands
        .iter()
        .flat_map(|spec| command_paths(spec).into_iter().map(move |path| (path, spec)))
        .collect();
    for size in (1..=words.len().min(MAX_PATH_WORDS)).rev() {
        let path = words[..size].join(" ");
        if let Some(spec) = index.get(&path) {
            return Resolution::Command { spec, argv: argv[size..].to_vec() };
        }
        if table.group(&path).is_some() {
            return Resolution::Group { group: path, unknown: words.get(size).cloned() };
        }
    }
    Resolution::Other { name: words.first().cloned(), argv }
}

fn edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for row in 1..=left.len() {
        let mut current = vec![row];
        for column in 1..=right.len() {
            let substitution = usize::from(left[row - 1] != right[column - 1]);
            let best = (previous[column] + 1)
                .min(current[column - 1] + 1)
                .min(previous[column - 1] + substitution);
            current.push(best);
        }
        previous = current;
    }
    previous[right.len()]
}

fn did_you_mean(word: &str, candidates: &[String], prefix: &str) -> String {
    let tolerance = 2.max(width(word) / 3);
    let mut near: Vec<(&String, usize)> = candidates
        .iter()
        .map(|candidate| (candidate, edit_distance(word, candidate)))
        .filter(|(_, far)| *far <= tolerance)
        .collect();
    near.sort_by_key(|(_, far)| *far);
    near.first().map(|(best, _)| format!(" Did you mean '{prefix}{best}'?")).unwrap_or_default()
}

pub fn usage_line(spec: &CommandSpec) -> String {
    ["bb", &spec.path, &spec.args, "[options]"]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

fn failure(spec: &CommandSpec, code: &str, message: String) -> CliError {
    CliError::new(message).code(code).hint(format!("Usage: {}", usage_line(spec)))
}

pub fn parse_invocation(spec: &CommandSpec, argv: &[String]) -> Result<Invocation, CliError> {
    let names: Vec<String> = spec.flags.iter().flat_map(|f| f.names.clone()).collect();
    let mut flags: HashMap<String, Vec<String>> = HashMap::new();
    let mut positionals: Vec<String> = Vec::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--" {
            positionals.extend(argv[index + 1..].iter().cloned());
            break;
        }
        if !token.starts_with("--") && token != "-h" {
            positionals.push(token.clone());
            index += 1;
            continue;
        }
        let equals = token.find('=');
        let name = if token == "-h" { "help" } else { token[2..].split('=').next().unwrap_or("") };
        let Some(flag) = spec.flags.iter().find(|known| known.names.iter().any(|n| n == name))
        else {
            let close = did_you_mean(name, &names, "--");
            return Err(CliError::new(format!("Unknown option --{name}.{close}"))
                .code("unknown_option")
                .hint(format!("Run `bb {} --help` for its options.", spec.path)));
        };
        let mut value = equals.map(|at| token[at + 1..].to_string());
        let next = argv.get(index + 1);
        let needs_value = matches!(flag.kind, FlagKind::String | FlagKind::List);
        let optional = flag.kind == FlagKind::Optional && next.is_some_and(|n| !n.starts_with('-'));
        if value.is_none()
            && (needs_value || optional)
            && let Some(next) = next
        {
            value = Some(next.clone());
            index += 1;
        }
        let missing = value.is_none() && needs_value;
        if missing || (value.is_some() && flag.kind == FlagKind::Boolean) {
            let problem = if missing {
                format!("needs a value {}", flag.placeholder)
            } else {
                "does not take a value".to_string()
            };
            return Err(failure(spec, "invalid_value", format!("Option --{name} {problem}.")));
        }
        let key = flag.names.first().cloned().unwrap_or_default();
        flags.entry(key).or_default().extend(value);
        index += 1;
    }
    let mut invocation = Invocation { flags, ..Invocation::default() };
    if invocation.flags.contains_key("help") {
        return Ok(invocation);
    }
    let expected: Vec<&str> = spec.args.split(' ').filter(|t| !t.is_empty()).collect();
    for (at, token) in expected.iter().enumerate() {
        let name: String = token.chars().filter(|c| !"<>[].".contains(*c)).collect();
        if token.contains("...") {
            invocation.rest = positionals.get(at..).map(<[String]>::to_vec).unwrap_or_default();
        } else if let Some(value) = positionals.get(at) {
            invocation.args.insert(name, value.clone());
        } else if token.starts_with('<') {
            return Err(failure(spec, "missing_required", format!("Missing {token}.")));
        }
    }
    if let Some(extra) = positionals.get(expected.len())
        && !spec.args.contains("...")
    {
        let message = format!("Unexpected argument '{extra}'.");
        return Err(failure(spec, "unexpected_argument", message));
    }
    Ok(invocation)
}

fn columns(rows: &[(String, String)]) -> Vec<String> {
    let widest = rows.iter().map(|(left, _)| width(left)).max().unwrap_or(0);
    rows.iter()
        .map(|(left, right)| {
            let pad = " ".repeat(widest - width(left));
            format!("  {left}{pad}  {right}")
        })
        .collect()
}

fn flag_row(flag: &FlagSpec) -> (String, String) {
    let name = flag.names.first().map(String::as_str).unwrap_or("");
    let repeat = if flag.kind == FlagKind::List { " (repeatable)" } else { "" };
    let also: String = flag.names.iter().skip(1).map(|a| format!(" (alias --{a})")).collect();
    let label = format!("--{name} {}", flag.placeholder).trim_end().to_string();
    (label, format!("{}{repeat}{also}", flag.help))
}

fn sections(parts: Vec<String>, separator: &str) -> String {
    parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(separator)
}

fn titled(title: &str, lines: Vec<String>) -> String {
    if lines.is_empty() {
        return String::new();
    }
    std::iter::once(title.to_string()).chain(lines).collect::<Vec<_>>().join("\n")
}

pub fn command_help(spec: &CommandSpec, brief: bool) -> String {
    let shown = if brief { spec.flags.len().saturating_sub(2) } else { spec.flags.len() };
    let rows: Vec<(String, String)> = spec.flags[..shown].iter().map(flag_row).collect();
    let examples = spec.examples.iter().map(|e| format!("  {e}")).collect();
    let optional = |cond: bool, text: String| if cond { text } else { String::new() };
    sections(
        vec![
            format!("Usage: {}", usage_line(spec)),
            spec.summary.clone(),
            optional(!spec.aliases.is_empty(), format!("Aliases: {}", spec.aliases.join(", "))),
            titled("Options:", columns(&rows)),
            optional(!brief, titled("Examples:", examples)),
            optional(!spec.json.is_empty(), format!("JSON (--json): {}", spec.json)),
            optional(!brief, JSON_FAILURE.to_string()),
        ],
        if brief { "\n" } else { "\n\n" },
    )
}

fn group_prefix(group: &str) -> String {
    if group.is_empty() { String::new() } else { format!("{group} ") }
}

fn commands_under<'a>(table: &'a Table, group: &str) -> Vec<&'a CommandSpec> {
    let prefix = group_prefix(group);
    table.commands.iter().filter(|spec| format!("{} ", spec.path).starts_with(&prefix)).collect()
}

pub fn group_help(table: &Table, group: &str) -> String {
    let prefix = group_prefix(group);
    let mut rows: Vec<(String, String)> = Vec::new();
    for spec in commands_under(table, group) {
        let word = spec.path[prefix.len()..].split(' ').next().unwrap_or("").to_string();
        let summary = table.group(&format!("{prefix}{word}")).unwrap_or(&spec.summary);
        if !rows.iter().any(|(known, _)| *known == word) {
            rows.push((word, summary.to_string()));
        }
    }
    let usage = format!("bb {prefix}<command>");
    sections(
        vec![
            format!("Usage: {usage} [options]"),
            table.group(group).unwrap_or("").to_string(),
            titled("Commands:", columns(&rows)),
            format!(
                "Run `{usage} --help` for details and `bb guide` for concepts. Enabled plugins add \
                 commands such as `bb tasks`; see `bb plugin list`."
            ),
            JSON_FAILURE.to_string(),
        ],
        "\n\n",
    )
}

pub fn unknown_command(table: &Table, found: &Resolution) -> CliError {
    let code = "unknown_command";
    if let Resolution::Group { group, unknown: Some(unknown) } = found {
        let leaves: Vec<String> = commands_under(table, group)
            .into_iter()
            .flat_map(command_paths)
            .map(|path| path[group.len() + 1..].to_string())
            .collect();
        let close = did_you_mean(unknown, &leaves, "");
        let message = format!("Unknown command 'bb {group} {unknown}'.{close}");
        let hint = format!("Run `bb {group} --help` for its commands.");
        return CliError::new(message).code(code).hint(hint);
    }
    let name = match found {
        Resolution::Other { name, .. } => name.clone().unwrap_or_default(),
        Resolution::Group { group, .. } => group.clone(),
        Resolution::Command { spec, .. } => spec.path.clone(),
    };
    let mut known: Vec<String> = Vec::new();
    let words = table.commands.iter().map(|spec| spec.path.split(' ').next().unwrap_or(""));
    for word in words.chain(table.aliases.iter().map(|(alias, _)| *alias)) {
        if !known.iter().any(|k| k == word) {
            known.push(word.to_string());
        }
    }
    let close = did_you_mean(&name, &known, "bb ");
    let hint = "Run `bb --help` for commands and `bb plugin list` for plugins.";
    CliError::new(format!("Unknown command 'bb {name}'.{close}")).code(code).hint(hint)
}

pub fn command_reference(table: &Table, group: &str) -> String {
    let mut entries: Vec<String> =
        commands_under(table, group).into_iter().map(|spec| command_help(spec, true)).collect();
    entries.push(format!("Every command takes --json. {JSON_FAILURE}"));
    entries.join("\n\n")
}
