use std::collections::{HashMap, HashSet};

use bb_cli::call::{Handler, not_implemented};
use bb_cli::engine::{
    FlagKind, Resolution, command_help, command_paths, command_reference, group_help,
    parse_commands, parse_invocation, resolve_command, unknown_command,
};
use bb_cli::table::table;
use bb_cli::{commands, failure_json};

fn argv(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| w.to_string()).collect()
}

fn resolved(words: &[&str]) -> (String, Vec<String>) {
    match resolve_command(table().unwrap(), &argv(words)) {
        Resolution::Command { spec, argv } => (spec.path.clone(), argv),
        other => panic!("{words:?} resolved to {other:?}"),
    }
}

#[test]
fn declares_each_command_once_with_a_summary_a_handler_and_its_groups() {
    let table = table().unwrap();
    let paths: Vec<String> = table.commands.iter().flat_map(command_paths).collect();
    assert_eq!(paths.iter().collect::<HashSet<_>>().len(), paths.len());
    let mut prefixes: Vec<String> = table.groups.iter().map(|(g, _)| g.to_string()).collect();
    prefixes.extend(paths.iter().cloned());
    for spec in &table.commands {
        assert!(spec.summary.len() > 10, "{}", spec.path);
        let flags: Vec<&String> = spec.flags.iter().flat_map(|f| &f.names).collect();
        assert_eq!(flags.iter().collect::<HashSet<_>>().len(), flags.len(), "{}", spec.path);
        let words: Vec<&str> = spec.path.split(' ').collect();
        for at in 1..words.len() {
            assert!(prefixes.contains(&words[..at].join(" ")), "{}", spec.path);
        }
    }
    assert_eq!(table.commands.len(), commands::handlers().len());
    let first_words: Vec<&str> = paths.iter().map(|p| p.split(' ').next().unwrap()).collect();
    for (alias, _) in table.aliases {
        assert!(!first_words.contains(alias), "{alias}");
        let found = resolve_command(table, &argv(&[alias]));
        assert!(!matches!(found, Resolution::Other { .. }), "{alias}");
    }
}

const DEMO: &str = "
demo run|go <id> [rest...]  Run a demo command
  --name|label <text>  A value
  --tag <tag>...  Several values
  --reuse [path]  An optional value
  --dry  A switch
  $ bb demo run thr_1 --dry
  > {ok}
";

#[test]
fn parses_the_table_text_into_arguments_aliases_and_typed_flags() {
    let handlers: HashMap<&'static str, Handler> =
        HashMap::from([("demoRun", not_implemented as Handler)]);
    let specs = parse_commands(DEMO, &handlers).unwrap();
    let spec = &specs[0];
    assert_eq!(
        (spec.path.as_str(), spec.aliases.clone(), spec.json.as_str()),
        ("demo run", argv(&["go"]), "{ok}")
    );
    let kinds: Vec<FlagKind> = spec.flags.iter().map(|f| f.kind).collect();
    use FlagKind::*;
    assert_eq!(kinds, [String, List, Optional, Boolean, Boolean, Boolean]);
    let input = argv(&[
        "thr_1",
        "--label=x",
        "--tag",
        "a",
        "--tag",
        "b",
        "--reuse",
        "--dry",
        "--",
        "--raw",
        "-",
    ]);
    let parsed = parse_invocation(spec, &input).unwrap();
    assert_eq!(parsed.args, HashMap::from([("id".into(), "thr_1".into())]));
    assert_eq!(parsed.rest, argv(&["--raw", "-"]));
    let expected: HashMap<std::string::String, Vec<std::string::String>> = HashMap::from([
        ("name".into(), argv(&["x"])),
        ("tag".into(), argv(&["a", "b"])),
        ("reuse".into(), vec![]),
        ("dry".into(), vec![]),
    ]);
    assert_eq!(parsed.flags, expected);
    assert_eq!(parse_invocation(spec, &[]).unwrap_err().message, "Missing <id>.");
    let missing = parse_invocation(spec, &argv(&["x", "--name"])).unwrap_err();
    assert!(missing.message.contains("needs a value"));
    assert!(parse_commands(DEMO, &HashMap::new()).unwrap_err().contains("has no handler"));
    let malformed = DEMO.replace("--dry  A", "--dry A");
    assert!(parse_commands(&malformed, &handlers).unwrap_err().contains("--dry A"));
}

#[test]
fn resolves_aliases_nested_groups_and_unknown_words() {
    assert_eq!(resolved(&["models", "codex"]), ("provider models".into(), argv(&["codex"])));
    assert_eq!(resolved(&["section", "list"]), ("thread section list".into(), vec![]));
    assert_eq!(resolved(&["environment", "get", "env_1"]), ("env show".into(), argv(&["env_1"])));
    let status = resolved(&["thread", "status", "thr_1", "--json"]);
    assert_eq!(status, ("thread show".into(), argv(&["thr_1", "--json"])));
    assert_eq!(resolved(&["server", "status"]), ("server status".into(), vec![]));
    let table = table().unwrap();
    match resolve_command(table, &argv(&["thread", "queue", "peek"])) {
        Resolution::Group { group, unknown } => {
            assert_eq!((group.as_str(), unknown.as_deref()), ("thread queue", Some("peek")))
        }
        other => panic!("{other:?}"),
    }
    match resolve_command(table, &argv(&["tasks", "show", "ABC-1"])) {
        Resolution::Other { name, .. } => assert_eq!(name.as_deref(), Some("tasks")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn prints_help_and_the_reference_exactly_as_the_typescript_cli() {
    let table = table().unwrap();
    let spec = |path: &str| table.commands.iter().find(|s| s.path == path).unwrap();
    let line = |text: String| format!("{text}\n");
    assert_eq!(line(group_help(table, "")), include_str!("fixtures/root-help.txt"));
    assert_eq!(line(group_help(table, "thread")), include_str!("fixtures/thread-help.txt"));
    let wait = line(command_help(spec("thread wait"), false));
    assert_eq!(wait, include_str!("fixtures/thread-wait-help.txt"));
    let all = line(command_reference(table, ""));
    assert_eq!(all, include_str!("fixtures/guide-commands.txt"));
    let machine = line(command_reference(table, "machine"));
    assert_eq!(machine, include_str!("fixtures/guide-commands-machine.txt"));
    assert!(!machine.contains("bb thread spawn"));
}

#[test]
fn reports_unknown_commands_and_bad_options_like_the_typescript_cli() {
    let table = table().unwrap();
    let found = resolve_command(table, &argv(&["thread", "tel", "--json"]));
    let failure = unknown_command(table, &found);
    let expected = serde_json::json!({ "ok": false, "error": {
        "code": "unknown_command",
        "message": "Unknown command 'bb thread tel'. Did you mean 'tell'?",
        "hint": "Run `bb thread --help` for its commands.",
    }});
    assert_eq!(failure_json(&failure), expected);
    let other = unknown_command(table, &resolve_command(table, &argv(&["thred"])));
    assert_eq!(other.message, "Unknown command 'bb thred'. Did you mean 'bb thread'?");
    let (_, rest) = resolved(&["thread", "wait", "x", "--timeout"]);
    let wait = table.commands.iter().find(|s| s.path == "thread wait").unwrap();
    let error = parse_invocation(wait, &rest).unwrap_err();
    assert_eq!(error.message, "Option --timeout needs a value <duration>.");
    assert_eq!(error.hint.as_deref(), Some("Usage: bb thread wait <id> [options]"));
    let unknown = parse_invocation(wait, &argv(&["x", "--statu"])).unwrap_err();
    assert_eq!(unknown.message, "Unknown option --statu. Did you mean '--status'?");
    assert_eq!(unknown.code, "unknown_option");
}
