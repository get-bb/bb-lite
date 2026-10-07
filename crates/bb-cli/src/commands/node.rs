//! The commands the Node CLI still owns: starting the server, the machine runner and the
//! legacy import. They are handed to it with the same command line.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::call::{Call, CliError, CliResult, Handler, Output};

const CLI_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/cli");

pub fn handlers() -> Vec<(&'static str, Handler)> {
    vec![
        ("server", hand_over),
        ("runnerJoin", hand_over),
        ("runnerRun", hand_over),
        ("importLegacy", hand_over),
    ]
}

/// The Node CLI package: `BB_CLI_ROOT` (set by `apps/cli/bin/bb`), else the checkout this
/// binary was built in.
fn cli_root() -> PathBuf {
    let named = std::env::var("BB_CLI_ROOT").ok().filter(|root| !root.is_empty());
    PathBuf::from(named.unwrap_or_else(|| CLI_ROOT.to_owned()))
}

/// The same choice `apps/cli/bin/bb` makes: the bundle when it is built, else the source.
pub fn node_command(root: &Path, argv: &[String]) -> Command {
    let mut command = Command::new("node");
    let bundle = root.join("dist/bb.mjs");
    if bundle.is_file() {
        command.arg(bundle);
    } else {
        command
            .arg("--conditions=source")
            .arg("--import")
            .arg(root.join("../../node_modules/tsx/dist/loader.mjs"))
            .arg(root.join("src/index.ts"));
    }
    command.args(argv);
    command
}

#[cfg(unix)]
fn run(mut command: Command) -> std::io::Error {
    use std::os::unix::process::CommandExt;
    command.exec()
}

#[cfg(not(unix))]
fn run(mut command: Command) -> std::io::Error {
    match command.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => error,
    }
}

fn hand_over(call: &mut Call) -> CliResult<Output> {
    let error = run(node_command(&cli_root(), &call.argv));
    let message = format!("Could not start the Node CLI for 'bb {}': {error}", call.spec.path);
    Err(CliError::new(message))
}
