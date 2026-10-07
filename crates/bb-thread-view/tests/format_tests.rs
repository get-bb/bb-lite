use bb_thread_view::format::*;
use bb_thread_view::rows::{
    ActivityIntent, FileReadTag, FileReadWork, ParentChangeAction, SearchMode, SearchTag,
    SearchWork,
};

fn change<'a>(
    kind: Option<&'a str>,
    move_path: Option<&'a str>,
    diff: Option<&'a str>,
) -> FileChangeRef<'a> {
    FileChangeRef { path: "a", kind, move_path, diff }
}

#[test]
fn capitalize_and_plural_match_typescript() {
    let got: Vec<String> =
        ["", "hello", "ßtraße", "😀x", "éa"].iter().map(|s| capitalize(s)).collect();
    assert_eq!(got, ["", "Hello", "SStraße", "😀x", "Éa"]);
    assert_eq!(plural(1, "file", None), "1 file");
    assert_eq!(plural(2, "file", None), "2 files");
    assert_eq!(plural(0, "match", Some("matches")), "0 matches");
}

#[test]
fn durations_match_typescript() {
    let inputs = [
        0.0,
        0.4,
        0.5,
        999.5,
        1000.0,
        1499.0,
        1500.0,
        59499.0,
        59500.0,
        60000.0,
        3600000.0,
        3661000.0,
        7322500.0,
        -5.0,
        f64::NAN,
    ];
    let got: Vec<String> = inputs.iter().map(|d| duration_to_compact_string(*d)).collect();
    let expected = [
        "0ms", "0ms", "1ms", "1000ms", "1s", "1s", "2s", "59s", "1m", "1m", "1h", "1h 1m 1s",
        "2h 2m 3s", "0s", "0s",
    ];
    assert_eq!(got, expected);
    assert_eq!(duration_to_compact_string_opt(None), None);
}

#[test]
fn diff_counts_and_stats_text() {
    let got: Vec<String> = [0, 999, 1000, 1234567, -1234].map(format_diff_count).to_vec();
    assert_eq!(got, ["0", "999", "1,000", "1,234,567", "-1,234"]);
    assert_eq!(format_diff_stats_text(1200, 0, false), "+1,200 -0");
    assert_eq!(format_diff_stats_text(1200, 0, true), "+1,200");
    assert_eq!(format_diff_stats_text(0, 0, true), "");
}

#[test]
fn paths() {
    let names: Vec<String> = ["a/b/c.ts", "a\\b\\c.ts", "dir/", "plain"]
        .iter()
        .map(|p| file_name_from_path(p))
        .collect();
    assert_eq!(names, ["c.ts", "c.ts", "dir/", "plain"]);
    let dirs: Vec<&str> =
        ["a/b/c.ts", "c.ts", "/c"].iter().map(|p| directory_from_path(p)).collect();
    assert_eq!(dirs, ["a/b", "", ""]);
    assert_eq!(message_id("thr", "user", "k"), "thr:user:k");
    assert_eq!(ownership_change_verb(ParentChangeAction::Release), "released from");
}

#[test]
fn file_change_actions_and_paths() {
    let actions: Vec<&str> = [
        change(None, Some("b"), None),
        change(None, Some("b"), Some("--- a\n+++ b\n+x")),
        change(Some("Add"), None, None),
        change(Some("file_removed"), None, None),
        change(Some("update"), None, None),
    ]
    .iter()
    .map(|c| get_file_change_action(c).as_str())
    .collect();
    assert_eq!(actions, ["renamed", "edited", "created", "deleted", "edited"]);
    let moved = FileChangeRef { path: "x/a.ts", kind: None, move_path: Some("y/b.ts"), diff: None };
    assert_eq!(format_file_change_path(&moved, PathDisplayMode::Compact), "a.ts -> b.ts");
    let edited = FileChangeRef { diff: Some("+z"), ..moved };
    assert_eq!(format_file_change_path(&edited, PathDisplayMode::Full), "y/b.ts");
    assert_eq!(FileChangeAction::Renamed.present(), "Renaming");
}

#[test]
fn patch_metadata_and_diff_stats() {
    let meta: Vec<bool> =
        ["diff --git a b", "@@ -1 +1 @@", "\\ No newline at end of file  ", "+x", "index\u{feff}"]
            .iter()
            .map(|l| is_patch_metadata_line(l))
            .collect();
    assert_eq!(meta, [true, true, true, false, false]);
    let stats: Vec<(u64, u64)> = [
        change(Some("add"), None, Some("one\ntwo\n\n")),
        change(Some("delete"), None, Some("one\n  \nthree")),
        change(Some("add"), None, Some("--- /dev/null\n+++ b/a\n@@ -0,0 +1,2 @@\n+one\n+two")),
        change(None, None, Some("context\nonly")),
        change(Some("update"), None, Some("@@\n+a\n-b\n-c")),
        change(None, None, None),
    ]
    .iter()
    .map(|c| {
        let s = get_file_change_diff_stats(c);
        (s.added, s.removed)
    })
    .collect();
    assert_eq!(stats, [(2, 0), (0, 2), (2, 0), (0, 0), (1, 2), (0, 0)]);
}

#[test]
fn agent_message_envelope() {
    let parsed = parse_agent_message_envelope("[bb message from thread:thr_1;x=y]  body").unwrap();
    assert_eq!((parsed.body_start, parsed.sender_thread_id.as_str()), (36, "thr_1"));
    let parsed = parse_agent_message_envelope("[bb message from thread:thr_2]\nhi").unwrap();
    assert_eq!((parsed.body_start, parsed.sender_thread_id.as_str()), (31, "thr_2"));
    assert_eq!(parse_agent_message_envelope("[bb message from thread:]x"), None);
    assert_eq!(parse_agent_message_envelope("no"), None);
}

fn read(path: Option<&str>, name: &str) -> ActivityIntent {
    ActivityIntent::Read { command: "c".into(), name: name.into(), path: path.map(Into::into) }
}

fn parts(
    intent: &ActivityIntent,
    mode: PathDisplayMode,
    pending: bool,
) -> (Option<&'static str>, String) {
    let parts = format_timeline_activity_intent_detail_parts(intent, mode, pending);
    (parts.prefix, parts.content)
}

#[test]
fn activity_intent_detail_parts() {
    use PathDisplayMode::{Compact, Full};
    let search = |query: Option<&str>, path: Option<&str>| ActivityIntent::Search {
        command: "c".into(),
        query: query.map(Into::into),
        path: path.map(Into::into),
    };
    let skill = read(Some("/h/.bb/plugins/cache/mkt/foo/1.0/skills/x/SKILL.md"), "fileRead");
    assert_eq!(parts(&skill, Compact, true), (Some("Reading"), "x/SKILL.md".into()));
    let plugin = read(Some("/h/.bb/plugins/cache/mkt/foo/skills/SKILL.md"), "n");
    assert_eq!(parts(&plugin, Compact, false), (Some("Read"), "foo/SKILL.md".into()));
    let deploy = read(Some("/a/skills/deploy/SKILL.md"), "n");
    assert_eq!(parts(&deploy, Compact, false), (Some("Read"), "deploy/SKILL.md".into()));
    assert_eq!(parts(&read(Some("/a/b.ts"), "n"), Full, false), (Some("Read"), "/a/b.ts".into()));
    assert_eq!(parts(&read(None, "n"), Compact, false), (Some("Read"), "n".into()));
    let list = ActivityIntent::ListFiles { command: "c".into(), path: Some(String::new()) };
    assert_eq!(parts(&list, Compact, true), (Some("Listing"), "files".into()));
    assert_eq!(
        parts(&search(Some("foo"), Some("src")), Compact, false),
        (Some("Searched"), "for foo in src".into())
    );
    assert_eq!(
        parts(&search(None, Some("src")), Compact, true),
        (Some("Searching"), "in src".into())
    );
    assert_eq!(parts(&search(Some(""), None), Compact, true), (Some("Searching"), "files".into()));
    let unknown = ActivityIntent::Unknown { command: "ls -la".into() };
    assert_eq!(parts(&unknown, Compact, true), (None, "ls -la".into()));

    let keys: Vec<Option<String>> = [
        read(None, "n"),
        ActivityIntent::ListFiles { command: "c".into(), path: None },
        search(Some("q"), None),
        unknown,
    ]
    .iter()
    .map(get_timeline_activity_intent_detail_dedupe_key)
    .collect();
    assert_eq!(keys, [Some("read:n".into()), Some("list:".into()), Some("search:q|".into()), None]);
}

#[test]
fn item_activity_intents() {
    let file_read = FileReadWork {
        work_kind: FileReadTag,
        call_id: "c".into(),
        path: "p".into(),
        cmd: None,
        completed_at: None,
        presentation: None,
    };
    let json = serde_json::to_value(file_read_activity_intent(&file_read)).unwrap();
    assert_eq!(json, serde_json::json!({"type":"read","command":"p","name":"fileRead","path":"p"}));
    let search = |mode, query: &str, cmd: Option<&str>| SearchWork {
        work_kind: SearchTag,
        call_id: "c".into(),
        mode,
        query: query.into(),
        path: None,
        cmd: cmd.map(Into::into),
        completed_at: None,
        presentation: None,
    };
    let list =
        serde_json::to_value(search_activity_intent(&search(SearchMode::List, "", None))).unwrap();
    assert_eq!(list, serde_json::json!({"type":"list_files","command":"","path":null}));
    let path =
        serde_json::to_value(search_activity_intent(&search(SearchMode::Path, "q", Some("rg"))))
            .unwrap();
    assert_eq!(path, serde_json::json!({"type":"list_files","command":"rg","path":"q"}));
    assert!(has_timeline_exploration_intent(ExplorationRow::FileRead(&file_read)));
}
