use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use bb_core::exec::{Ctx, normalize, path_exists};
use bb_core::{ProviderId, RunnerResult};
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

const SKILL_FILE_NAME: &str = "SKILL.md";
const MAX_SCAN_DEPTH: usize = 8;
const MAX_SCAN_ENTRIES: usize = 1_000;
const MAX_DESCRIPTION_LENGTH: usize = 300;
const FRONTMATTER_READ_BYTES: usize = 8 * 1024;
const BUILTIN_COMMANDS: [(&str, &str); 2] =
    [("clear", "Start fresh context in this thread"), ("compact", "Compact context")];

static FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z][A-Za-z0-9_-]*):\s*([^\n\r\u{2028}\u{2029}]*)$").expect("valid regex")
});
static BLOCK_SCALAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[|>][+-]?$").expect("valid regex"));
static CONTINUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s+\S").expect("valid regex"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSource {
    Skill,
    Command,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandOrigin {
    Builtin,
    Project,
    User,
}

impl CommandOrigin {
    fn rank(self) -> u8 {
        match self {
            Self::Builtin => 2,
            Self::Project => 1,
            Self::User => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommand {
    pub name: String,
    pub source: CommandSource,
    pub origin: CommandOrigin,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommandsArgs {
    pub provider_id: ProviderId,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommandListResponse {
    pub commands: Vec<ProviderCommand>,
}

#[derive(Clone, Debug)]
struct Root {
    directory: PathBuf,
    source: CommandSource,
    origin: CommandOrigin,
}

fn join(base: &Path, relative: &str) -> PathBuf {
    normalize(&base.join(relative))
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

async fn project_ancestors(cwd: &Path) -> Vec<PathBuf> {
    let mut directories = vec![cwd.to_path_buf()];
    let mut directory = cwd.to_path_buf();
    loop {
        if path_exists(directory.join(".git")).await {
            return directories;
        }
        let Some(parent) = directory.parent().map(Path::to_path_buf) else {
            return vec![cwd.to_path_buf()];
        };
        directories.insert(0, parent.clone());
        directory = parent;
    }
}

async fn scan_roots(ctx: &Ctx, args: &ListCommandsArgs) -> Vec<Root> {
    let home = env_dir("HOME").unwrap_or_default();
    let cwd = args.cwd.as_deref().map(|cwd| normalize(Path::new(cwd)));
    let ancestors = match &cwd {
        Some(cwd) => project_ancestors(cwd).await,
        None => Vec::new(),
    };
    let nearest = |relative: &str, source: CommandSource| -> Vec<Root> {
        cwd.iter()
            .map(|cwd| Root {
                directory: join(cwd, relative),
                source,
                origin: CommandOrigin::Project,
            })
            .collect()
    };
    let inherited = |relative: &str| -> Vec<Root> {
        ancestors
            .iter()
            .map(|directory| Root {
                directory: join(directory, relative),
                source: CommandSource::Skill,
                origin: CommandOrigin::Project,
            })
            .collect()
    };
    let user = |directory: PathBuf, source: CommandSource| Root {
        directory: normalize(&directory),
        source,
        origin: CommandOrigin::User,
    };
    let mut shared = nearest(".bb/skills", CommandSource::Skill);
    shared.push(user(ctx.data_dir.join("skills"), CommandSource::Skill));
    let mut roots = Vec::new();
    match args.provider_id {
        ProviderId::ClaudeCode => {
            let claude = env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
            roots.extend(inherited(".claude/skills"));
            roots.extend(nearest(".claude/commands", CommandSource::Command));
            roots.push(user(claude.join("skills"), CommandSource::Skill));
            roots.push(user(claude.join("commands"), CommandSource::Command));
        }
        ProviderId::Codex => {
            let codex = env_dir("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
            roots.extend(nearest(".codex/skills", CommandSource::Skill));
            roots.extend(inherited(".agents/skills"));
            roots.push(user(codex.join("skills"), CommandSource::Skill));
            roots.push(user(codex.join("skills").join(".system"), CommandSource::Skill));
            roots.push(user(home.join(".agents").join("skills"), CommandSource::Skill));
        }
        ProviderId::Echo => {}
    }
    roots.extend(shared);
    roots
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn unquote(value: &str) -> Option<&str> {
    let first = value.chars().next()?;
    let quoted = (first == '"' || first == '\'') && value.len() >= 2 && value.ends_with(first);
    quoted.then(|| &value[1..value.len() - 1])
}

pub fn parse_frontmatter(content: &str) -> HashMap<String, String> {
    let trimmed = content.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let lines: Vec<&str> =
        trimmed.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    let mut fields: HashMap<String, String> = HashMap::new();
    if lines.first() != Some(&"---") {
        return fields;
    }
    let end = lines.iter().skip(1).position(|line| *line == "---").map(|index| index + 1);
    let end = end.unwrap_or(lines.len().saturating_sub(1)).max(1);
    let mut key = String::new();
    for line in &lines[1..end] {
        if let Some(field) = FIELD.captures(line) {
            key = field[1].to_owned();
            let value = js_trim(&field[2]);
            let value =
                if BLOCK_SCALAR.is_match(value) { "" } else { unquote(value).unwrap_or(value) };
            fields.insert(key.clone(), value.to_owned());
        } else if !key.is_empty() && CONTINUATION.is_match(line) {
            let previous = fields.get(&key).map(String::as_str).unwrap_or_default();
            let joined = format!("{previous} {}", js_trim(line));
            fields.insert(key.clone(), js_trim(&joined).to_owned());
        }
    }
    fields
}

fn utf16_prefix(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (index, c) in text.char_indices() {
        units += c.len_utf16();
        if units > limit {
            return &text[..index];
        }
    }
    text
}

async fn describe(root: &Root, name: String, file_path: &Path) -> Option<ProviderCommand> {
    let mut file = tokio::fs::File::open(file_path).await.ok()?;
    let mut head = vec![0u8; FRONTMATTER_READ_BYTES];
    let read = file.read(&mut head).await.unwrap_or(0);
    let fields = parse_frontmatter(&String::from_utf8_lossy(&head[..read]));
    let description =
        fields.get("description").map(|text| utf16_prefix(text, MAX_DESCRIPTION_LENGTH));
    let non_empty = |text: Option<&str>| text.filter(|text| !text.is_empty()).map(str::to_owned);
    Some(ProviderCommand {
        name,
        source: root.source,
        origin: root.origin,
        description: non_empty(description),
        argument_hint: non_empty(fields.get("argument-hint").map(String::as_str)),
        plugin_id: None,
    })
}

/// An approximation of `String.prototype.localeCompare`: case-insensitive, lowercase first.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    left.to_lowercase().cmp(&right.to_lowercase()).then_with(|| right.cmp(left))
}

async fn scan(root: &Root, budget: &mut usize) -> Vec<Option<ProviderCommand>> {
    let mut found = Vec::new();
    let mut pending = vec![(String::new(), 0usize)];
    while let Some((relative, depth)) = pending.pop() {
        let directory = join(&root.directory, &relative);
        let mut entries = Vec::new();
        if let Ok(mut reader) = tokio::fs::read_dir(&directory).await {
            while entries.len() < *budget {
                let Ok(Some(entry)) = reader.next_entry().await else { break };
                let Ok(kind) = entry.file_type().await else { continue };
                entries.push((entry.file_name().to_string_lossy().into_owned(), kind));
            }
        }
        entries.sort_by(|left, right| locale_compare(&left.0, &right.0));
        *budget -= entries.len();
        let mut nested = Vec::new();
        for (name, kind) in entries {
            let entry_path =
                if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
            let linked = root.origin == CommandOrigin::User && kind.is_symlink();
            if root.source == CommandSource::Skill {
                if kind.is_dir() || linked {
                    let skill_file = directory.join(&name).join(SKILL_FILE_NAME);
                    found.push(describe(root, name, &skill_file).await);
                }
            } else if kind.is_dir() && depth < MAX_SCAN_DEPTH {
                nested.push((entry_path, depth + 1));
            } else if kind.is_file() && name.ends_with(".md") {
                let stem = &entry_path[..entry_path.len() - ".md".len()];
                let command = stem.replace('/', ":");
                found.push(describe(root, command, &directory.join(&name)).await);
            }
        }
        pending.extend(nested.into_iter().rev());
    }
    found
}

fn section(command: &ProviderCommand) -> u8 {
    match (command.origin, command.source) {
        (CommandOrigin::Builtin, _) => 0,
        (_, CommandSource::Skill) => 1,
        (CommandOrigin::Project, CommandSource::Command) => 2,
        (CommandOrigin::User, CommandSource::Command) => 3,
    }
}

pub async fn list_commands(ctx: &Ctx, args: ListCommandsArgs) -> RunnerResult<CommandListResponse> {
    let mut budget = MAX_SCAN_ENTRIES;
    let mut found: Vec<Option<ProviderCommand>> = Vec::new();
    if args.provider_id != ProviderId::Echo {
        found.extend(BUILTIN_COMMANDS.iter().map(|(name, description)| {
            Some(ProviderCommand {
                name: (*name).to_owned(),
                source: CommandSource::Command,
                origin: CommandOrigin::Builtin,
                description: Some((*description).to_owned()),
                argument_hint: None,
                plugin_id: None,
            })
        }));
    }
    for root in scan_roots(ctx, &args).await {
        found.extend(scan(&root, &mut budget).await);
    }
    let mut by_key: IndexMap<(CommandSource, String), ProviderCommand> = IndexMap::new();
    for command in found.into_iter().flatten() {
        let key = (command.source, command.name.clone());
        let replace =
            by_key.get(&key).is_none_or(|known| command.origin.rank() > known.origin.rank());
        if replace {
            by_key.insert(key, command);
        }
    }
    let mut commands: Vec<ProviderCommand> = by_key.into_values().collect();
    commands.sort_by(|left, right| {
        section(left).cmp(&section(right)).then_with(|| locale_compare(&left.name, &right.name))
    });
    Ok(CommandListResponse { commands })
}
