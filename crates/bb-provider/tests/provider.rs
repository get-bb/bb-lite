use bb_provider::{
    SearchMode, TokenUsage, ZERO_TOKEN_USAGE, add_token_usage, build_edit_diff, ellipsize,
    file_name, labels, presentation_title,
};
use serde_json::json;

#[test]
fn ellipsize_counts_utf16_units_and_keeps_surrogate_pairs_whole() {
    assert_eq!(ellipsize("short", 10), "short");
    assert_eq!(ellipsize("hello world", 5), "hell…");
    assert_eq!(ellipsize("ab😀cd", 6), "ab😀cd");
    assert_eq!(ellipsize("ab😀cd", 4), "ab…");
    assert_eq!(ellipsize("ab😀cd", 5), "ab😀…");
    assert_eq!(ellipsize("😀😀😀", 5), "😀😀…");
}

#[test]
fn titles_and_file_names() {
    assert_eq!(presentation_title("  first line \nsecond").as_deref(), Some("first line"));
    assert_eq!(presentation_title(" \n "), None);
    let long = "x".repeat(200);
    assert_eq!(presentation_title(&long).unwrap().encode_utf16().count(), 160);
    assert_eq!(file_name("/a/b/c.txt/"), "c.txt");
    assert_eq!(file_name("///"), "///");
}

#[test]
fn labels_match_the_typescript_presentations() {
    assert_eq!(
        labels::message().to_value(),
        json!({ "label": { "pending": "Responding", "completed": "Responded" }, "icon": { "glyph": "MessageSquare" } })
    );
    let command = labels::command("/bin/bash -lc 'ls -la'");
    assert_eq!(command.title.as_deref(), Some("ls -la"));
    assert_eq!(command.label.completed, "Ran command");
    assert_eq!(labels::command("  git status ").title.as_deref(), Some("git status"));
    assert_eq!(labels::command("zsh -c \"echo hi\"").title.as_deref(), Some("echo hi"));
    let same = labels::file_change(&["a/b.rs", "c/b.rs"]);
    assert_eq!(
        (same.label.pending.as_str(), same.title.as_deref()),
        ("Editing file", Some("b.rs"))
    );
    let many = labels::file_change(&["a.rs", "x/b.rs"]);
    assert_eq!(
        (many.label.completed.as_str(), many.title.as_deref()),
        ("Edited files", Some("a.rs, b.rs"))
    );
    let none: [&str; 0] = [];
    assert_eq!(labels::file_change(&none).title, None);
    assert_eq!(labels::file_read("/x/y/z.txt").title.as_deref(), Some("z.txt"));
    assert_eq!(labels::search(SearchMode::Path, "*.rs").label.pending, "Finding files");
    assert_eq!(labels::search(SearchMode::Content, "fn").icon.glyph, "Search");
    assert_eq!(labels::web_search(None).title, None);
    let tool = labels::tool("Grep", Some("pattern"));
    assert_eq!(
        (tool.label.pending.as_str(), tool.label.completed.as_str()),
        ("Running Grep", "Ran Grep")
    );
    assert_eq!(labels::agent("Review").label.completed, "Agent finished");
}

#[test]
fn build_edit_diff_matches_the_typescript_line_diff() {
    let edit = build_edit_diff("/src/a.txt", Some("a\nb\nc\n"), Some("a\nB\nc\n"));
    assert_eq!(edit.as_deref(), Some("--- a/src/a.txt\n+++ b/src/a.txt\n-b\n+B\n"));
    let created = build_edit_diff("p", None, Some("x\ny"));
    assert_eq!(created.as_deref(), Some("--- /dev/null\n+++ b/p\n+x\n+y\n"));
    let deleted = build_edit_diff("p", Some("x\n"), None);
    assert_eq!(deleted.as_deref(), Some("--- a/p\n+++ /dev/null\n-x\n"));
    assert_eq!(build_edit_diff("p", Some("a\r\nb"), Some("a\nb\n")), None);
    assert_eq!(build_edit_diff("p", None, None), None);
    let windows = build_edit_diff("\\dir\\f", Some("a"), Some("b"));
    assert_eq!(windows.as_deref(), Some("--- a/dir/f\n+++ b/dir/f\n-a\n+b\n"));
    let reordered = build_edit_diff("f", Some("a\nb\nc"), Some("c\nb\na"));
    assert_eq!(reordered.as_deref(), Some("--- a/f\n+++ b/f\n-a\n-b\n+b\n+a\n"));
}

#[test]
fn token_usage_adds_fieldwise() {
    let last = TokenUsage { total_tokens: 3, cache_read_input_tokens: Some(2), ..ZERO_TOKEN_USAGE };
    let sum = add_token_usage(&add_token_usage(&ZERO_TOKEN_USAGE, &last), &last);
    assert_eq!(sum.total_tokens, 6);
    assert_eq!(sum.cache_read_input_tokens, Some(4));
    assert_eq!(sum.cache_write_input_tokens, None);
}
