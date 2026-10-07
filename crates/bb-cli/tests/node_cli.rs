use std::path::Path;
use std::process::{Command, Output};

use bb_cli::commands::node::node_command;

fn arguments(command: &Command) -> Vec<String> {
    command.get_args().map(|argument| argument.to_string_lossy().into_owned()).collect()
}

#[test]
fn chooses_the_bundle_when_built_and_the_source_otherwise() {
    let root = tempfile::tempdir().unwrap();
    let argv = ["server".to_owned(), "--json".to_owned()];
    let source = arguments(&node_command(root.path(), &argv));
    let loader = root.path().join("../../node_modules/tsx/dist/loader.mjs");
    let entry = root.path().join("src/index.ts");
    let expected = ["--conditions=source", "--import", loader.to_str().unwrap()];
    assert_eq!(source[..3], expected);
    assert_eq!(source[3..], [entry.to_str().unwrap(), "server", "--json"]);

    std::fs::create_dir(root.path().join("dist")).unwrap();
    std::fs::write(root.path().join("dist/bb.mjs"), "").unwrap();
    let bundle = root.path().join("dist/bb.mjs");
    let built = arguments(&node_command(root.path(), &argv));
    assert_eq!(built, [bundle.to_str().unwrap(), "server", "--json"]);
}

fn bb(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bb"))
        .args(args)
        .env("BB_CLI_ROOT", root)
        .env("BB_SERVER_URL", "http://127.0.0.1:9")
        .output()
        .unwrap()
}

#[test]
fn hands_server_runner_and_import_to_the_node_cli() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("dist")).unwrap();
    let script = "console.log(JSON.stringify(process.argv.slice(2))); process.exit(7);";
    std::fs::write(root.path().join("dist/bb.mjs"), script).unwrap();
    let cases: [&[&str]; 4] = [
        &["server"],
        &["runner", "run", "--data-dir", "/tmp/x"],
        &["runner", "join", "blob"],
        &["import-legacy", "--from", "/old", "--dry-run"],
    ];
    for args in cases {
        let output = bb(root.path(), args);
        let printed: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(printed, args, "{output:?}");
        assert_eq!(output.status.code(), Some(7));
    }
    let help = bb(root.path(), &["server", "--help"]);
    assert!(String::from_utf8_lossy(&help.stdout).starts_with("Usage: bb server"), "{help:?}");
}
