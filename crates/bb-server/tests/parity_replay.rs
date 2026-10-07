mod parity_replay_support;

use parity_replay_support::results;

/// Differences accepted on purpose: `(scenario, step, json path, reason)`.
const ALLOWED: &[(&str, u64, &str, &str)] = &[];

fn check(scenario: &str) {
    let result = results().get(scenario).unwrap_or_else(|| panic!("no scenario {scenario}"));
    let open: Vec<_> = result
        .diffs
        .iter()
        .filter(|d| {
            !ALLOWED
                .iter()
                .any(|(s, n, p, _)| *s == d.scenario && *n == d.step && *p == d.json_path)
        })
        .collect();
    println!(
        "{scenario}: {} steps, {} differing, {} open differences",
        result.steps,
        result.differing_steps,
        open.len()
    );
    for d in &open {
        println!("{}", d.line());
    }
    assert!(open.is_empty(), "{scenario}: {} differences", open.len());
}

macro_rules! scenarios {
    ($($name:ident => $label:literal),* $(,)?) => {
        $(#[test]
        fn $name() {
            check($label);
        })*
    };
}

scenarios! {
    system_and_settings => "system-and-settings",
    projects => "projects",
    thread_basics => "thread-basics",
    managed_worktree => "managed-worktree",
    tools_and_items => "tools-and-items",
    interactions => "interactions",
    steering_and_queueing => "steering-and-queueing",
    parent_and_child => "parent-and-child",
    lifecycle => "lifecycle",
    search => "search",
    errors => "errors",
}
