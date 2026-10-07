//! The plugin CLI helper of `packages/plugin/src/cli.ts`: declare commands,
//! options and positionals once and get parsing, help text and usage errors.

use std::future::Future;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::json;

use super::api::{CliCommandSummary, CliContext, CliResult, PluginCli};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CliValue {
    Bool(bool),
    Int(i64),
    Str(String),
    List(Vec<CliValue>),
}

impl From<&str> for CliValue {
    fn from(value: &str) -> Self {
        Self::Str(value.to_owned())
    }
}

impl From<String> for CliValue {
    fn from(value: String) -> Self {
        Self::Str(value)
    }
}

impl From<i64> for CliValue {
    fn from(value: i64) -> Self {
        Self::Int(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliOptionKind {
    Boolean,
    String,
    Integer,
    Enum,
}

#[derive(Clone, Debug)]
pub struct CliOption {
    pub kind: CliOptionKind,
    pub description: String,
    pub values: Option<Vec<String>>,
    pub aliases: Vec<String>,
    pub placeholder: Option<String>,
    pub required: bool,
    pub repeatable: bool,
    pub default: Option<CliValue>,
}

impl CliOption {
    fn new(kind: CliOptionKind, description: impl Into<String>) -> Self {
        Self {
            kind,
            description: description.into(),
            values: None,
            aliases: Vec::new(),
            placeholder: None,
            required: false,
            repeatable: false,
            default: None,
        }
    }

    pub fn boolean(description: impl Into<String>) -> Self {
        Self::new(CliOptionKind::Boolean, description)
    }

    pub fn string(description: impl Into<String>) -> Self {
        Self::new(CliOptionKind::String, description)
    }

    pub fn integer(description: impl Into<String>) -> Self {
        Self::new(CliOptionKind::Integer, description)
    }

    pub fn enumeration<V: Into<String>>(
        values: impl IntoIterator<Item = V>,
        description: impl Into<String>,
    ) -> Self {
        let mut option = Self::new(CliOptionKind::Enum, description);
        option.values = Some(values.into_iter().map(Into::into).collect());
        option
    }

    pub fn alias(mut self, alias: impl Into<String>) -> Self {
        self.aliases.push(alias.into());
        self
    }

    pub fn placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub fn repeatable(mut self) -> Self {
        self.repeatable = true;
        self
    }

    pub fn default_value(mut self, value: impl Into<CliValue>) -> Self {
        self.default = Some(value.into());
        self
    }
}

#[derive(Clone, Debug)]
pub struct CliPositional {
    pub name: String,
    pub description: String,
    pub required: bool,
    pub variadic: bool,
}

impl CliPositional {
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            required: false,
            variadic: false,
        }
    }

    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub fn variadic(mut self) -> Self {
        self.variadic = true;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PositionalValue {
    One(String),
    Many(Vec<String>),
}

/// The parsed arguments. An option or optional positional that was not given
/// and has no default is absent from its map.
#[derive(Clone, Debug, Default)]
pub struct CliInput {
    pub options: IndexMap<String, CliValue>,
    pub positionals: IndexMap<String, PositionalValue>,
    pub help: String,
}

impl CliInput {
    pub fn flag(&self, name: &str) -> bool {
        matches!(self.options.get(name), Some(CliValue::Bool(true)))
    }

    pub fn string(&self, name: &str) -> Option<&str> {
        match self.options.get(name) {
            Some(CliValue::Str(value)) => Some(value),
            _ => None,
        }
    }

    pub fn integer(&self, name: &str) -> Option<i64> {
        match self.options.get(name) {
            Some(CliValue::Int(value)) => Some(*value),
            _ => None,
        }
    }

    pub fn strings(&self, name: &str) -> Vec<String> {
        match self.options.get(name) {
            Some(CliValue::List(values)) => values
                .iter()
                .filter_map(|value| match value {
                    CliValue::Str(text) => Some(text.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn integers(&self, name: &str) -> Vec<i64> {
        match self.options.get(name) {
            Some(CliValue::List(values)) => values
                .iter()
                .filter_map(|value| match value {
                    CliValue::Int(number) => Some(*number),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn positional(&self, name: &str) -> Option<&str> {
        match self.positionals.get(name) {
            Some(PositionalValue::One(value)) => Some(value),
            _ => None,
        }
    }

    pub fn variadic(&self, name: &str) -> &[String] {
        match self.positionals.get(name) {
            Some(PositionalValue::Many(values)) => values,
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PluginCliError {
    pub message: String,
    pub code: String,
    pub hint: Option<String>,
    pub exit_code: i32,
    usage: bool,
}

impl PluginCliError {
    /// Code `command_failed`, exit code 1, no hint.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "command_failed".into(),
            hint: None,
            exit_code: 1,
            usage: false,
        }
    }

    pub fn code(mut self, code: impl Into<String>) -> Self {
        self.code = code.into();
        self
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn exit_code(mut self, exit_code: i32) -> Self {
        self.exit_code = exit_code;
        self
    }

    fn usage(message: impl Into<String>) -> Self {
        Self { usage: true, ..Self::new(message).code("usage") }
    }
}

pub type CliOutcome = Result<CliResult, PluginCliError>;
type CliRun = Arc<dyn Fn(CliInput, CliContext) -> BoxFuture<'static, CliOutcome> + Send + Sync>;

/// A successful result printing `stdout`.
pub fn cli_output(stdout: impl Into<String>) -> CliOutcome {
    Ok(CliResult { exit_code: 0, stdout: stdout.into(), stderr: String::new() })
}

#[derive(Clone)]
pub struct CliCommand {
    pub summary: String,
    pub description: Option<String>,
    pub aliases: Vec<String>,
    pub options: Vec<(String, CliOption)>,
    /// For the root command, an empty list means it takes no words at all.
    pub positionals: Vec<CliPositional>,
    run: CliRun,
}

impl CliCommand {
    pub fn new<F, Fut>(summary: impl Into<String>, run: F) -> Self
    where
        F: Fn(CliInput, CliContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = CliOutcome> + Send + 'static,
    {
        Self {
            summary: summary.into(),
            description: None,
            aliases: Vec::new(),
            options: Vec::new(),
            positionals: Vec::new(),
            run: Arc::new(move |input, context| Box::pin(run(input, context))),
        }
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn alias(mut self, alias: impl Into<String>) -> Self {
        self.aliases.push(alias.into());
        self
    }

    pub fn option(mut self, name: impl Into<String>, option: CliOption) -> Self {
        self.options.push((name.into(), option));
        self
    }

    pub fn positional(mut self, positional: CliPositional) -> Self {
        self.positionals.push(positional);
        self
    }
}

#[derive(Clone)]
pub struct CliSpec {
    pub name: String,
    pub summary: String,
    pub root: Option<CliCommand>,
    /// Keyed by the space-separated path, in help order.
    pub commands: Vec<(String, CliCommand)>,
}

impl CliSpec {
    pub fn new(name: impl Into<String>, summary: impl Into<String>) -> Self {
        Self { name: name.into(), summary: summary.into(), root: None, commands: Vec::new() }
    }

    pub fn root(mut self, command: CliCommand) -> Self {
        self.root = Some(command);
        self
    }

    pub fn command(mut self, path: impl Into<String>, command: CliCommand) -> Self {
        self.commands.push((path.into(), command));
        self
    }
}

fn signature(name: &str, option: &CliOption) -> String {
    if option.kind == CliOptionKind::Boolean {
        return format!("--{name}");
    }
    let fallback = option.values.as_ref().map_or_else(|| "value".to_owned(), |v| v.join("|"));
    format!("--{name} <{}>", option.placeholder.clone().unwrap_or(fallback))
}

fn usage(scope: &str, command: &CliCommand) -> String {
    let mut parts = vec![scope.to_owned()];
    for entry in &command.positionals {
        let token = format!("<{}{}>", entry.name, if entry.variadic { "..." } else { "" });
        parts.push(if entry.required { token } else { format!("[{token}]") });
    }
    for (name, option) in &command.options {
        let text = signature(name, option);
        parts.push(if option.required { text } else { format!("[{text}]") });
    }
    format!("Usage:\n  {}", parts.join(" "))
}

fn section(title: &str, rows: &[(String, String)]) -> Vec<String> {
    if rows.is_empty() {
        return Vec::new();
    }
    let width = rows.iter().map(|(left, _)| left.chars().count()).max().unwrap_or(0);
    let mut lines = vec![String::new(), title.to_owned()];
    for (left, text) in rows {
        let pad = " ".repeat(width - left.chars().count());
        lines.push(format!("  {left}{pad}  {text}"));
    }
    lines
}

fn command_help(scope: &str, command: &CliCommand) -> String {
    let args: Vec<_> = command
        .positionals
        .iter()
        .map(|entry| (format!("<{}>", entry.name), entry.description.clone()))
        .collect();
    let flags: Vec<_> = command
        .options
        .iter()
        .map(|(name, option)| (signature(name, option), option.description.clone()))
        .collect();
    let mut lines = vec![format!("{scope} — {}", command.summary), String::new()];
    lines.push(usage(scope, command));
    if let Some(description) = &command.description {
        lines.extend([String::new(), description.clone()]);
    }
    lines.extend(section("Arguments:", &args));
    lines.extend(section("Options:", &flags));
    lines.push(String::new());
    lines.join("\n")
}

fn list_help(spec: &CliSpec, words: &[String]) -> String {
    let prefix: String = words.iter().map(|word| format!("{word} ")).collect();
    let scope = std::iter::once("bb")
        .chain(std::iter::once(spec.name.as_str()))
        .chain(words.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let commands: Vec<_> = spec
        .commands
        .iter()
        .filter(|(path, _)| path.starts_with(&prefix))
        .map(|(path, command)| (format!("bb {} {path}", spec.name), command.summary.clone()))
        .collect();
    let title = if words.is_empty() { spec.summary.as_str() } else { "commands" };
    let mut lines = vec![
        format!("{scope} — {title}"),
        String::new(),
        format!("Usage:\n  {scope} <command> [options]"),
    ];
    lines.extend(section("Commands:", &commands));
    lines.extend([
        String::new(),
        format!("Run `{scope} <command> --help` for arguments and options."),
        String::new(),
    ]);
    lines.join("\n")
}

fn resolve_command<'a>(
    spec: &'a CliSpec,
    words: &[String],
) -> Option<(&'a str, &'a CliCommand, usize)> {
    let mut best: Option<(&str, &CliCommand, usize)> = None;
    for (path, command) in &spec.commands {
        for spelling in std::iter::once(path).chain(&command.aliases) {
            let parts: Vec<&str> = spelling.split(' ').collect();
            let matches = parts
                .iter()
                .enumerate()
                .all(|(index, part)| words.get(index).map(String::as_str) == Some(part));
            if matches && parts.len() > best.map_or(0, |(_, _, length)| length) {
                best = Some((path, command, parts.len()));
            }
        }
    }
    best
}

fn is_integer(raw: &str) -> bool {
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

fn option_value(name: &str, option: &CliOption, raw: &str) -> Result<CliValue, PluginCliError> {
    let valid = match option.kind {
        CliOptionKind::Enum => {
            option.values.as_deref().unwrap_or_default().iter().any(|v| v == raw)
        }
        CliOptionKind::Integer => is_integer(raw),
        _ => true,
    };
    if !valid {
        let expected = if option.kind == CliOptionKind::Enum {
            option.values.as_deref().unwrap_or_default().join(", ")
        } else {
            "an integer".to_owned()
        };
        return Err(PluginCliError::usage(format!(
            "invalid value '{raw}' for --{name}: expected {expected}"
        )));
    }
    if option.kind == CliOptionKind::Integer {
        let number = raw.parse::<i64>().or_else(|_| raw.parse::<f64>().map(|n| n as i64));
        return Ok(CliValue::Int(number.unwrap_or_default()));
    }
    Ok(CliValue::Str(raw.to_owned()))
}

fn parse_arguments(command: &CliCommand, argv: &[String]) -> Result<CliInput, PluginCliError> {
    let declared = &command.options;
    let mut given: IndexMap<&str, Vec<String>> = IndexMap::new();
    let mut words: Vec<String> = Vec::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--" {
            words.extend(argv[index + 1..].iter().cloned());
            break;
        }
        let Some(body) = token.strip_prefix("--") else {
            words.push(token.clone());
            index += 1;
            continue;
        };
        let (spelled, inline) = match body.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (body, None),
        };
        let Some((name, option)) = declared
            .iter()
            .find(|(key, option)| key == spelled || option.aliases.iter().any(|a| a == spelled))
        else {
            return Err(PluginCliError::usage(format!("unknown option '--{spelled}'")));
        };
        let value = match inline {
            Some(value) => Some(value),
            None if option.kind == CliOptionKind::Boolean => Some("true".to_owned()),
            None => {
                index += 1;
                argv.get(index).cloned()
            }
        };
        let Some(value) = value else {
            return Err(PluginCliError::usage(format!("--{name} requires a value")));
        };
        given.entry(name.as_str()).or_default().push(value);
        index += 1;
    }

    let mut options = IndexMap::new();
    let mut missing = Vec::new();
    for (name, option) in declared {
        let raw = given.get(name.as_str()).map(Vec::as_slice).unwrap_or_default();
        if option.kind == CliOptionKind::Boolean {
            let on = raw.last().is_some_and(|last| last != "false");
            options.insert(name.clone(), CliValue::Bool(on));
            continue;
        }
        if raw.len() > 1 && !option.repeatable {
            return Err(PluginCliError::usage(format!("--{name} was given more than once")));
        }
        if raw.is_empty() && option.required {
            missing.push(format!("--{name}"));
        }
        let parsed = raw
            .iter()
            .map(|value| option_value(name, option, value))
            .collect::<Result<Vec<_>, _>>()?;
        if option.repeatable {
            options.insert(name.clone(), CliValue::List(parsed));
        } else if let Some(value) = parsed.into_iter().next().or_else(|| option.default.clone()) {
            options.insert(name.clone(), value);
        }
    }

    let mut positionals = IndexMap::new();
    for entry in &command.positionals {
        let count = if entry.variadic { words.len() } else { words.len().min(1) };
        let taken: Vec<String> = words.drain(..count).collect();
        if entry.required && taken.is_empty() {
            missing.push(format!("<{}>", entry.name));
        }
        if entry.variadic {
            positionals.insert(entry.name.clone(), PositionalValue::Many(taken));
        } else if let Some(first) = taken.into_iter().next() {
            positionals.insert(entry.name.clone(), PositionalValue::One(first));
        }
    }
    if let Some(word) = words.first() {
        return Err(PluginCliError::usage(format!("unexpected argument '{word}'")));
    }
    if !missing.is_empty() {
        return Err(PluginCliError::usage(format!("missing {}", missing.join(", "))));
    }
    Ok(CliInput { options, positionals, help: String::new() })
}

fn failure(error: PluginCliError, json: bool, hint: &str) -> CliResult {
    let detail = if error.usage { Some(hint) } else { error.hint.as_deref() };
    let mut parts = vec![error.message.as_str()];
    parts.extend(detail);
    let stderr = format!("{}\n", parts.join("\n\n"));
    if !json {
        return CliResult { exit_code: error.exit_code, stdout: String::new(), stderr };
    }
    let mut body = json!({ "code": error.code, "message": error.message });
    if let Some(hint) = &error.hint {
        body["hint"] = json!(hint);
    }
    let text =
        serde_json::to_string_pretty(&json!({ "ok": false, "error": body })).unwrap_or_default();
    CliResult { exit_code: error.exit_code, stdout: format!("{text}\n"), stderr }
}

struct DefinedCli {
    spec: CliSpec,
}

impl DefinedCli {
    async fn dispatch(
        &self,
        argv: &[String],
        context: CliContext,
        hint: &mut String,
    ) -> CliOutcome {
        let spec = &self.spec;
        let flags = argv.iter().position(|t| t == "--").map_or(argv, |end| &argv[..end]);
        let wants_help = flags.iter().any(|t| t == "--help" || t == "-h");
        let first_flag = argv.iter().position(|t| t.starts_with('-')).unwrap_or(argv.len());
        let words = &argv[..first_flag];
        let resolved = resolve_command(spec, words);
        let prefix: String = words.iter().map(|word| format!("{word} ")).collect();
        let is_group = spec.commands.iter().any(|(path, _)| path.starts_with(&prefix));
        if resolved.is_none() && wants_help && is_group {
            return cli_output(list_help(spec, words));
        }
        let stray =
            !words.is_empty() && spec.root.as_ref().is_none_or(|root| root.positionals.is_empty());
        let command = resolved.map(|(_, command, _)| command).or(spec.root.as_ref());
        let command = match command {
            Some(command) if !(resolved.is_none() && stray) => command,
            _ => {
                let typed = words.join(" ");
                return Err(PluginCliError::usage(if typed.is_empty() {
                    "missing command".to_owned()
                } else {
                    format!("unknown command '{typed}'")
                }));
            }
        };
        let scope = match resolved {
            Some((path, _, _)) => format!("bb {} {path}", spec.name),
            None => format!("bb {}", spec.name),
        };
        let help = command_help(&scope, command);
        if wants_help {
            return cli_output(help);
        }
        *hint = usage(&scope, command);
        let rest = &argv[resolved.map_or(0, |(_, _, length)| length)..];
        let input = CliInput { help, ..parse_arguments(command, rest)? };
        (command.run)(input, context).await
    }
}

#[async_trait]
impl PluginCli for DefinedCli {
    fn name(&self) -> String {
        self.spec.name.clone()
    }

    fn summary(&self) -> String {
        self.spec.summary.clone()
    }

    fn commands(&self) -> Vec<CliCommandSummary> {
        self.spec
            .commands
            .iter()
            .map(|(name, command)| CliCommandSummary {
                name: name.clone(),
                summary: command.summary.clone(),
            })
            .collect()
    }

    async fn run(&self, argv: Vec<String>, context: CliContext) -> CliResult {
        let mut hint = format!("Run `bb {} --help` for the command list.", self.spec.name);
        match self.dispatch(&argv, context, &mut hint).await {
            Ok(result) => result,
            Err(error) => {
                let flags =
                    argv.iter().position(|t| t == "--").map_or(&argv[..], |end| &argv[..end]);
                failure(error, flags.iter().any(|t| t == "--json"), &hint)
            }
        }
    }
}

pub fn define_cli(spec: CliSpec) -> Arc<dyn PluginCli> {
    Arc::new(DefinedCli { spec })
}
