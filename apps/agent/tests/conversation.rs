use lazysh_agent::transcript::{conversation, discover, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::Command};

fn write(path: &Path, records: &[Value]) {
    let mut file = fs::File::create(path).unwrap();
    for record in records {
        serde_json::to_writer(&mut file, record).unwrap();
        writeln!(file).unwrap();
    }
}
fn message(id: &str, parent: Option<&str>, role: &str, text: &str) -> Value {
    json!({"type":role,"uuid":id,"parentUuid":parent,"message":{"content":text}})
}
fn ids(page: &lazysh_agent::transcript::TranscriptPage) -> Vec<&str> {
    page.messages
        .iter()
        .map(|message| message["id"].as_str().unwrap())
        .collect()
}

#[test]
fn refreshed_branch_replaces_recorded_tool_error_without_inventing_live_state() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut records = vec![
        message("root", None, "user", "inspect"),
        json!({"type":"assistant","uuid":"call","parentUuid":"root","message":{"content":[{"type":"tool_use","id":"tool1","name":"Read","input":{}}]}}),
        json!({"type":"user","uuid":"failed","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"denied","is_error":true}]}}),
    ];
    write(&path, &records);
    let failed = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert_eq!(
        failed.messages.last().unwrap()["blocks"][0]["isError"],
        true
    );
    records.push(json!({"type":"user","uuid":"replacement","parentUuid":"call","message":{"content":[{"type":"tool_result","tool_use_id":"tool1","content":"read","is_error":false}]}}));
    write(&path, &records);
    let refreshed = conversation(&path, TranscriptAgent::Claude, 50).unwrap();
    assert_eq!(refreshed.branch_id.as_deref(), Some("replacement"));
    assert!(!ids(&refreshed).contains(&"failed"));
    assert_eq!(
        refreshed.messages.last().unwrap()["blocks"][0]["isError"],
        false
    );
    assert_eq!(
        refreshed.messages.last().unwrap()["blocks"][0]["id"],
        "tool1"
    );
}

#[test]
fn latest_main_leaf_selects_one_branch_ignoring_progress_sidechains_and_old_forks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut side = message("side", Some("root"), "assistant", "other agent");
    side["isSidechain"] = json!(true);
    write(
        &path,
        &[
            message("root", None, "user", "question"),
            message("old", Some("root"), "assistant", "abandoned answer"),
            message("new", Some("root"), "assistant", "current answer"),
            json!({"type":"progress","uuid":"old-progress","parentUuid":"old"}),
            side,
        ],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(page.view, "active_branch");
    assert_eq!(ids(&page), vec!["root", "new"]);
    assert_eq!(page.branch_id.as_deref(), Some("new"));
    assert!(!page.has_more && !page.truncated);
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args([
            "transcript",
            "--agent",
            "claude",
            "--view",
            "conversation",
            "--path",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(output.status.success());
    let cli: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(cli["branchId"], "new");
    assert_eq!(cli["view"], "active_branch");
}

#[test]
fn compaction_replaces_earlier_chain_and_recent_limit_is_explicit() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut summary = message(
        "summary",
        Some("boundary"),
        "user",
        "summary of prior context",
    );
    summary["isCompactSummary"] = json!(true);
    write(
        &path,
        &[
            message("old", None, "user", "original context"),
            json!({"type":"system","uuid":"boundary","parentUuid":null,"logicalParentUuid":"old","subtype":"compact_boundary"}),
            summary,
            message("reply", Some("summary"), "assistant", "current answer"),
        ],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(ids(&page), vec!["summary", "reply"]);
    let latest = conversation(&path, TranscriptAgent::Claude, 1).unwrap();
    assert_eq!(ids(&latest), vec!["reply"]);
    assert!(latest.truncated);
}

#[test]
fn parallel_tool_calls_and_results_are_recovered_without_answering_a_different_response() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("parallel.jsonl");
    let call = |id: &str, parent: &str, call_id: &str| json!({"type":"assistant","uuid":id,"parentUuid":parent,"message":{"id":"response1","content":[{"type":"tool_use","id":call_id,"name":"Read","input":{}}]}});
    let result = |id: &str, parent: &str, call_id: &str| json!({"type":"user","uuid":id,"parentUuid":parent,"message":{"content":[{"type":"tool_result","tool_use_id":call_id,"content":"result"}]}});
    write(
        &path,
        &[
            message("root", None, "user", "read both files"),
            call("a1", "root", "tool1"),
            call("a2", "a1", "tool2"),
            result("r2", "a2", "tool2"),
            result("r1", "a1", "tool1"),
            result("wrong", "root", "unrelated-call"),
            message("done", Some("r1"), "assistant", "summary"),
        ],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(ids(&page), vec!["root", "a1", "a2", "r2", "r1", "done"]);
}

#[test]
fn cycles_oversize_files_and_unsupported_conversation_agents_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    write(
        &path,
        &[
            message("a", Some("b"), "user", "a"),
            message("b", Some("a"), "assistant", "b"),
        ],
    );
    assert!(conversation(&path, TranscriptAgent::Claude, 100).is_err());
    assert!(conversation(&path, TranscriptAgent::Codex, 100).is_err());
    fs::File::create(&path)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    assert!(conversation(&path, TranscriptAgent::Claude, 100).is_err());
}

#[test]
fn duplicate_uuids_use_the_latest_record_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("duplicate.jsonl");
    let mut old = message("assistant", Some("root"), "assistant", "stale");
    old["message"]["id"] = json!("response1");
    let mut new = old.clone();
    new["message"]["content"] = json!("current");
    write(
        &path,
        &[message("root", None, "user", "question"), old, new],
    );
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(ids(&page), vec!["root", "assistant"]);
    assert_eq!(page.messages[1]["blocks"][0]["text"], "current");
}

#[test]
fn discovery_only_lists_bounded_metadata_from_expected_depths() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("projects");
    fs::create_dir_all(root.join("project/subagents")).unwrap();
    fs::write(
        root.join("project/session.jsonl"),
        b"not JSON; discovery must not parse this",
    )
    .unwrap();
    fs::write(root.join("project/subagents/hidden.jsonl"), b"private").unwrap();
    fs::write(root.join("project/settings.json"), b"private").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .env("LAZYSH_STATE_DIR", directory.path().join("companion-state"))
        .args(["discover", "--agent", "claude", "--root"])
        .arg(&root)
        .output()
        .unwrap();
    assert!(output.status.success());
    let page: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(page["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(page["sessions"][0]["name"], "session.jsonl");
    assert_eq!(page["sessions"][0]["bytes"], 39);
    assert!(page["sessions"][0]["modifiedAt"].is_string());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("not JSON"));
    let empty = serde_json::to_value(
        discover(
            TranscriptAgent::Claude,
            Some(&directory.path().join("absent")),
            50,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(empty["sessions"].as_array().unwrap().is_empty());
    let codex = directory.path().join("sessions");
    fs::create_dir_all(codex.join("2026/10/24")).unwrap();
    fs::write(codex.join("2026/10/24/rollout.jsonl"), b"{}").unwrap();
    let codex =
        serde_json::to_value(discover(TranscriptAgent::Codex, Some(&codex), 50).unwrap()).unwrap();
    assert_eq!(codex["sessions"].as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn discovery_ignores_symbolic_links_and_caps_results() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("projects");
    fs::create_dir_all(root.join("project")).unwrap();
    let outside = directory.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.jsonl"), b"secret").unwrap();
    symlink(&outside, root.join("linked-project")).unwrap();
    symlink(
        outside.join("secret.jsonl"),
        root.join("project/linked.jsonl"),
    )
    .unwrap();
    for i in 0..5 {
        fs::write(root.join(format!("project/{i}.jsonl")), b"{}").unwrap();
    }
    let page =
        serde_json::to_value(discover(TranscriptAgent::Claude, Some(&root), 2).unwrap()).unwrap();
    assert_eq!(page["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(page["truncated"], true);
    assert!(!page.to_string().contains("secret"));
    assert!(discover(
        TranscriptAgent::Claude,
        Some(&root.join("linked-project")),
        50
    )
    .is_err());
}
