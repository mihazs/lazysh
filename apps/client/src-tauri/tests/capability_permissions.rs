//! A command listed in the app manifest is refused by Tauri's ACL unless the main capability allows it.
use std::collections::HashSet;

#[test]
fn every_manifest_command_is_allowed_by_the_main_capability() {
    let build = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/build.rs")).unwrap();
    let capability: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/capabilities/main.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let allowed: HashSet<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|permission| permission.as_str())
        .collect();
    let commands = build
        .split("commands(&[")
        .nth(1)
        .unwrap()
        .split("])")
        .next()
        .unwrap();
    let missing: Vec<_> = commands
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\","))
        .filter(|command| {
            !allowed.contains(format!("allow-{}", command.replace('_', "-")).as_str())
        })
        .collect();
    assert!(
        missing.is_empty(),
        "commands without an allow permission: {missing:?}"
    );
}
