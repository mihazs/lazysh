//! A session is named from the first prompt its agent reports, so two sessions of one folder can be told apart.
//! Only one bounded line is kept; the rest of a prompt is still discarded.
#[path = "support/json_output.rs"]
mod json_output;
#[path = "support/pane.rs"]
mod pane;
use serde_json::{json, Value};
use std::{fs, path::Path};

fn ingest(directory: &Path, kind: &str, payload: &Value) {
    let output = pane::run(directory, &["ingest", "--agent", kind], payload);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn row(directory: &Path, id: &str) -> Value {
    json_output::decode(pane::run(
        directory,
        &["snapshot", "--limit", "50"],
        &Value::Null,
    ))["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["sessionId"] == id)
        .unwrap()
        .clone()
}
/// The prompt hook of each agent, as that agent sends it.
fn prompt(kind: &str, session: &str, text: &str) -> Value {
    match kind {
        "gemini" => {
            json!({"hook_event_name":"BeforeAgent","session_id":session,"cwd":"/work/app","prompt":text})
        }
        "cursor" => {
            json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":session,"cwd":"/work/app","prompt":text})
        }
        _ => {
            json!({"hook_event_name":"UserPromptSubmit","session_id":session,"cwd":"/work/app","prompt":text})
        }
    }
}

#[test]
fn every_agent_that_reports_a_prompt_names_its_session_from_the_first_one() {
    for kind in [
        "claude", "codex", "droid", "kimi", "copilot", "gemini", "grok", "cursor",
    ] {
        let dir = tempfile::tempdir().unwrap();
        ingest(
            dir.path(),
            kind,
            &prompt(kind, "s1", "Fix the\n\tlogin  bug"),
        );
        assert_eq!(
            row(dir.path(), "s1")["title"],
            "Fix the login bug",
            "{kind}"
        );
        ingest(dir.path(), kind, &prompt(kind, "s1", "Now add dark mode"));
        let kept = row(dir.path(), "s1");
        assert_eq!(
            kept["title"], "Fix the login bug",
            "{kind}: first prompt wins"
        );
        assert_eq!(kept["eventCount"], 2);
    }
}

#[test]
fn two_sessions_in_one_folder_get_different_names() {
    let dir = tempfile::tempdir().unwrap();
    ingest(
        dir.path(),
        "claude",
        &prompt("claude", "a", "Migrate the billing tables"),
    );
    ingest(
        dir.path(),
        "claude",
        &prompt("claude", "b", "Write the release notes"),
    );
    let (a, b) = (row(dir.path(), "a"), row(dir.path(), "b"));
    assert_eq!(
        (a["project"].clone(), b["project"].clone()),
        (json!("/work/app"), json!("/work/app"))
    );
    assert_eq!(a["title"], "Migrate the billing tables");
    assert_eq!(b["title"], "Write the release notes");
}

#[test]
fn a_title_is_bounded_and_the_rest_of_the_prompt_is_not_kept() {
    let dir = tempfile::tempdir().unwrap();
    let long = format!("{} TAIL-MARKER", "refactor ".repeat(40));
    ingest(dir.path(), "claude", &prompt("claude", "s1", &long));
    let title = row(dir.path(), "s1")["title"].as_str().unwrap().to_owned();
    assert_eq!(title.chars().count(), 80);
    assert!(title.ends_with('…') && !title.contains("TAIL-MARKER"));
    for entry in fs::read_dir(dir.path()).unwrap() {
        let bytes = fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(11).any(|window| window == b"TAIL-MARKER"));
    }
}

#[test]
fn only_a_prompt_names_a_session_and_other_events_keep_the_name() {
    let dir = tempfile::tempdir().unwrap();
    ingest(
        dir.path(),
        "claude",
        &json!({"hook_event_name":"PreToolUse","session_id":"s1","cwd":"/work/app","tool_name":"Bash","prompt":"Not a prompt event"}),
    );
    assert!(
        row(dir.path(), "s1").get("title").is_none(),
        "no prompt, no title field"
    );
    // A bare slash command says nothing about the session either.
    ingest(dir.path(), "claude", &prompt("claude", "s1", "/clear"));
    assert!(row(dir.path(), "s1").get("title").is_none());
    ingest(
        dir.path(),
        "claude",
        &prompt("claude", "s1", "Plan the migration"),
    );
    ingest(
        dir.path(),
        "claude",
        &json!({"hook_event_name":"Stop","session_id":"s1","cwd":"/work/app"}),
    );
    let done = row(dir.path(), "s1");
    assert_eq!(
        (done["state"].clone(), done["title"].clone()),
        (json!("done"), json!("Plan the migration"))
    );
}

#[test]
fn a_title_an_agent_reports_itself_replaces_the_prompt_title_and_is_cleaned() {
    let dir = tempfile::tempdir().unwrap();
    let event = |state: &str, title: Value| json!({"schemaVersion":1,"sessionId":"g1","agent":"Test Agent","project":"/work/app","state":state,"summary":"A turn","title":title});
    ingest(
        dir.path(),
        "generic",
        &event("working", json!("First name")),
    );
    assert_eq!(row(dir.path(), "g1")["title"], "First name");
    ingest(
        dir.path(),
        "generic",
        &event("working", json!("  Renamed \u{7} by\nthe agent ")),
    );
    assert_eq!(row(dir.path(), "g1")["title"], "Renamed by the agent");
    // A title with nothing in it never rejects the report.
    ingest(dir.path(), "generic", &event("done", json!("\u{7}\u{1b}")));
    let kept = row(dir.path(), "g1");
    assert_eq!(
        (kept["state"].clone(), kept["title"].clone()),
        (json!("done"), json!("Renamed by the agent"))
    );

    // The same session, first named from its prompt, then by the agent itself; a later prompt changes neither.
    ingest(
        dir.path(),
        "claude",
        &prompt("claude", "c1", "From the prompt"),
    );
    let mut own = event("working", json!("Chosen by the agent"));
    (own["sessionId"], own["agent"]) = (json!("c1"), json!("Claude Code"));
    ingest(dir.path(), "generic", &own);
    assert_eq!(row(dir.path(), "c1")["title"], "Chosen by the agent");
    ingest(
        dir.path(),
        "claude",
        &prompt("claude", "c1", "Another prompt"),
    );
    assert_eq!(row(dir.path(), "c1")["title"], "Chosen by the agent");
}
