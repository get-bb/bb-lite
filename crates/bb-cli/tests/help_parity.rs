use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use bb_cli::commands::node::node_command;
use bb_cli::table::table;

const CLI_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/cli");

fn printed(mut command: Command) -> (Option<i32>, String) {
    command.env("BB_SERVER_URL", "http://127.0.0.1:9").env_remove("BB_THREAD_ID");
    let output = command.output().unwrap();
    (output.status.code(), String::from_utf8_lossy(&output.stdout).into_owned())
}

fn native(args: &[String]) -> (Option<i32>, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bb"));
    command.args(args);
    printed(command)
}

/// The Node CLI is the reference for every command, flag and line of help. This fails when a
/// command is added or reworded there without the same change in `crates/bb-cli/src/table.rs`.
#[test]
fn every_help_page_matches_the_node_cli() {
    let root = Path::new(CLI_ROOT);
    if !root.join("../../node_modules/tsx/dist/loader.mjs").is_file() {
        eprintln!("skipped: node_modules is not installed in this checkout");
        return;
    }
    let mut pages: Vec<Vec<String>> =
        vec![vec!["--help".into()], vec!["guide".into(), "commands".into()]];
    let table = table().unwrap();
    for (group, _) in table.groups {
        pages.push(vec![(*group).to_owned(), "--help".into()]);
    }
    for spec in &table.commands {
        let mut page: Vec<String> = spec.path.split(' ').map(str::to_owned).collect();
        page.push("--help".into());
        pages.push(page);
    }
    let queue = Mutex::new(pages.into_iter());
    let differing = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                loop {
                    let Some(page) = queue.lock().unwrap().next() else { return };
                    if native(&page) != printed(node_command(root, &page)) {
                        differing.lock().unwrap().push(page.join(" "));
                    }
                }
            });
        }
    });
    let differing = differing.into_inner().unwrap();
    assert!(differing.is_empty(), "help differs from the Node CLI for: {differing:?}");
}
