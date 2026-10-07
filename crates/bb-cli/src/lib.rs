pub mod call;
pub mod commands;
pub mod engine;
pub mod guide;
pub mod http;
pub mod paths;
pub mod plugin_proxy;
pub mod render;
pub mod table;

use serde_json::{Map, Value, json};

use crate::call::{Call, CliEnv, CliError, CliResult, read_env};
use crate::engine::{
    Resolution, Table, command_help, group_help, parse_invocation, resolve_command, unknown_command,
};
use crate::plugin_proxy::{find_plugin_command, run_plugin_command};

pub fn wants_json(argv: &[String]) -> bool {
    let end = argv.iter().position(|t| t == "--").unwrap_or(argv.len());
    let scanned = &argv[..end];
    scanned.iter().enumerate().any(|(at, token)| {
        token == "--json"
            || token == "--format=json"
            || (token == "--format" && scanned.get(at + 1).is_some_and(|n| n == "json"))
    })
}

/// The failure envelope printed on stdout with `--json`.
pub fn failure_json(failure: &CliError) -> Value {
    let mut error = Map::new();
    error.insert("code".into(), json!(failure.code));
    error.insert("message".into(), json!(failure.message));
    if let Some(hint) = &failure.hint {
        error.insert("hint".into(), json!(hint));
    }
    json!({ "ok": false, "error": error })
}

fn report(failure: &CliError, envelope: bool) -> i32 {
    eprintln!("Error: {}", failure.message);
    if let Some(hint) = &failure.hint {
        eprintln!("{hint}");
    }
    if envelope {
        println!("{}", serde_json::to_string_pretty(&failure_json(failure)).unwrap_or_default());
    }
    failure.exit_code
}

fn dispatch(table: &Table, argv: &[String], env: &CliEnv) -> CliResult<i32> {
    let asks_help = argv.first().is_some_and(|a| a == "help");
    let found = resolve_command(table, if asks_help { &argv[1..] } else { argv });
    match found {
        Resolution::Command { spec, argv } => {
            let invocation = if asks_help { None } else { Some(parse_invocation(spec, &argv)?) };
            let Some(invocation) = invocation.filter(|i| !i.flags.contains_key("help")) else {
                println!("{}", command_help(spec, false));
                return Ok(0);
            };
            let mut call = Call::new(table, spec, invocation, env.clone());
            let result = (spec.run)(&mut call).and_then(|output| call.emit(output));
            match result {
                Ok(()) => Ok(0),
                Err(failure) => Ok(report(&failure, wants_json(&argv) && !call.wrote_json)),
            }
        }
        Resolution::Group { ref group, unknown: None } => {
            println!("{}", group_help(table, group));
            Ok(0)
        }
        Resolution::Group { .. } => Err(unknown_command(table, &found)),
        Resolution::Other { ref name, ref argv } => {
            let Some(name) = name else {
                println!("{}", group_help(table, ""));
                let first = argv.first().map(String::as_str);
                return Ok(if matches!(first, None | Some("--help" | "-h")) { 0 } else { 1 });
            };
            match find_plugin_command(env, name)? {
                Some(plugin_id) => run_plugin_command(env, &plugin_id, argv[1..].to_vec()),
                None => Err(unknown_command(table, &found)),
            }
        }
    }
}

/// `bb` with these arguments (without the program name); returns the exit code.
pub fn run(argv: &[String], var: impl Fn(&str) -> Option<String>) -> i32 {
    let table = match table::table() {
        Ok(table) => table,
        Err(problem) => {
            eprintln!("{problem}");
            return 1;
        }
    };
    let result = read_env(var).and_then(|env| dispatch(table, argv, &env));
    result.unwrap_or_else(|failure| report(&failure, wants_json(argv)))
}
