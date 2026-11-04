//! Plan and question cards and recorded turn state over the fixtures in
//! `fixtures/interaction-cards` (provenance in its README).
use lazysh_agent::transcript::{
    conversation, opencode_conversation, read_page, TranscriptAgent, TranscriptPage,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::Path};

const CLAUDE: &str = include_str!("fixtures/interaction-cards/claude.jsonl");
const CODEX: &str = include_str!("fixtures/interaction-cards/codex.jsonl");
const OPENCODE: &str = include_str!("fixtures/interaction-cards/opencode-v1.json");

fn lines(source: &str) -> Vec<Value> {
    source
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn write(path: &Path, records: &[Value]) {
    let text: String = records.iter().map(|record| format!("{record}\n")).collect();
    fs::write(path, text).unwrap();
}
fn cards(page: &TranscriptPage) -> Vec<Value> {
    page.messages
        .iter()
        .flat_map(|message| message["blocks"].as_array().unwrap())
        .filter_map(|block| block.get("card").cloned())
        .collect()
}
fn activity(page: &TranscriptPage) -> Value {
    serde_json::to_value(page).unwrap()["activity"].clone()
}
fn layout(multiple: bool) -> Value {
    json!({"kind":"question","questions":[{
        "question":"Which fixture layout should the reader use?","header":"Layout","multiple":multiple,
        "options":[{"label":"Flat","description":"One records file per agent."},{"label":"Nested","description":"One directory per agent."}],
    }]})
}
fn plan(third: (&str, &str)) -> Value {
    json!({"kind":"plan","entries":[
        {"text":"Record the fixture shapes","status":"completed"},
        {"text":"Choose a layout","status":"in_progress"},
        {"text":third.0,"status":third.1},
    ]})
}
const PROPOSED: &str = "## Fixture plan\n\n1. Add nested fixtures.\n2. Cover each reader.";

#[test]
fn claude_recorded_todos_questions_and_plan_approval_become_cards_in_both_views() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("claude.jsonl");
    fs::write(&path, CLAUDE).unwrap();
    let expected = vec![
        plan(("Write the reader tests", "pending")),
        layout(false),
        json!({"kind":"proposed_plan","text":PROPOSED}),
    ];
    let branch = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(cards(&branch), expected);
    assert_eq!(activity(&branch), "idle");
    let records = read_page(&path, TranscriptAgent::Claude, 0, 100).unwrap();
    assert_eq!(cards(&records), expected);
    // Records pages are partial, so they never claim a turn state.
    assert_eq!(activity(&records), Value::Null);
    // The tool card and its recorded answer remain beside the question card.
    let answer = records.messages[4]["blocks"][0].clone();
    assert_eq!(answer["type"], "tool_result");
    assert_eq!(answer["id"], "toolu_c_ask");
    // Claude-shaped Qoder records do not inherit Claude tool semantics.
    let qoder = read_page(&path, TranscriptAgent::QoderIde, 0, 100).unwrap();
    assert!(cards(&qoder).is_empty());
}

#[test]
fn claude_turn_state_follows_the_recorded_leaf_and_unknown_stays_unknown() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("claude.jsonl");
    let records = lines(CLAUDE);
    for (count, expected) in [
        (1, json!("working")),
        (2, json!("working")),
        (3, json!("working")),
        (4, json!("waiting")),
        (6, json!("waiting")),
        (8, Value::Null),
        (10, Value::Null),
        (11, json!("idle")),
    ] {
        write(&path, &records[..count]);
        let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
        assert_eq!(activity(&page), expected, "after {count} records");
    }
    let mut next = records.clone();
    next.push(json!({"parentUuid":"c-t3","isSidechain":false,"type":"user","uuid":"c-u5","timestamp":"2026-11-04T10:01:00.000Z","message":{"role":"user","content":"Next prompt"}}));
    write(&path, &next);
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(activity(&page), "working");
    next.push(json!({"parentUuid":"c-u5","isSidechain":false,"type":"user","uuid":"c-u6","timestamp":"2026-11-04T10:01:01.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}));
    write(&path, &next);
    let page = conversation(&path, TranscriptAgent::Claude, 100).unwrap();
    assert_eq!(activity(&page), Value::Null);
}

#[test]
fn malformed_or_unrecognized_tool_inputs_keep_only_the_plain_tool_card() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("claude.jsonl");
    let mut records = lines(CLAUDE);
    let todos = &mut records[1]["message"]["content"][0]["input"]["todos"];
    todos[2]["status"] = json!("blocked");
    records[3]["message"]["content"][0]["input"]["questions"][0]["options"] = json!([]);
    records[5]["message"]["content"][0]["name"] = json!("exit_plan_mode");
    write(&path, &records);
    let page = read_page(&path, TranscriptAgent::Claude, 0, 100).unwrap();
    assert!(cards(&page).is_empty());
    let tools: Vec<_> = page
        .messages
        .iter()
        .flat_map(|message| message["blocks"].as_array().unwrap())
        .filter(|block| block["type"] == "tool_use")
        .map(|block| block["name"].as_str().unwrap())
        .collect();
    assert_eq!(tools, ["TodoWrite", "AskUserQuestion", "exit_plan_mode"]);
}

#[test]
fn codex_recorded_plan_questions_and_turn_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    fs::write(&path, CODEX).unwrap();
    let branch = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(activity(&branch), "idle");
    let proposed = branch.messages.last().unwrap()["blocks"][0].clone();
    assert_eq!(
        proposed,
        json!({"type":"text","text":PROPOSED,"card":{"kind":"proposed_plan"}})
    );
    let records = read_page(&path, TranscriptAgent::Codex, 0, 100).unwrap();
    let mut explained = plan(("Write the reader tests", "pending"));
    explained["explanation"] = json!("Fixture work in order.");
    assert_eq!(
        cards(&records),
        [
            explained,
            json!({"kind":"question","questions":[{
                "question":"Which fixture layout should the reader use?","header":"Layout","multiple":false,
                "options":[{"label":"Flat (Recommended)","description":"One records file per agent."},{"label":"Nested","description":"One directory per agent."}],
            }]}),
        ]
    );
    let lifecycle = lines(CODEX);
    for (count, expected) in [(2, "working"), (6, "waiting"), (7, "working")] {
        write(&path, &lifecycle[..count]);
        let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
        assert_eq!(activity(&page), expected, "after {count} records");
    }
    let mut aborted = lifecycle[..6].to_vec();
    aborted.push(
        json!({"timestamp":"2026-11-04T10:00:05.000Z","type":"event_msg","ordinal":6,
        "payload":{"type":"turn_aborted","turn_id":"turn-fixture-1","reason":"interrupted"}}),
    );
    write(&path, &aborted);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(activity(&page), "stopped");
    write(&path, &lifecycle[..1]);
    let page = conversation(&path, TranscriptAgent::Codex, 100).unwrap();
    assert_eq!(activity(&page), Value::Null);
}

fn opencode_database(path: &Path, edit: impl FnOnce(&mut Value)) {
    let mut fixture: Value = serde_json::from_str(OPENCODE).unwrap();
    edit(&mut fixture);
    let db = Connection::open(path).unwrap();
    db.execute_batch(
        "CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,revert TEXT,time_updated INTEGER);
         CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER);
         CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,data TEXT);",
    )
    .unwrap();
    let session = fixture["sessionId"].as_str().unwrap();
    db.execute("INSERT INTO session VALUES(?1,'fixture',NULL,1)", [session])
        .unwrap();
    for message in fixture["messages"].as_array().unwrap() {
        db.execute(
            "INSERT INTO message VALUES(?1,?2,?3,?4)",
            params![
                message["id"].as_str().unwrap(),
                session,
                message["data"].to_string(),
                message["time_created"].as_i64().unwrap()
            ],
        )
        .unwrap();
    }
    for part in fixture["parts"].as_array().unwrap() {
        db.execute(
            "INSERT INTO part VALUES(?1,?2,?3,?4)",
            params![
                part["id"].as_str().unwrap(),
                part["message_id"].as_str().unwrap(),
                session,
                part["data"].to_string()
            ],
        )
        .unwrap();
    }
}
type Edit = fn(&mut Value);
fn without_final_answer(fixture: &mut Value) {
    fixture["messages"].as_array_mut().unwrap().truncate(2);
    fixture["parts"].as_array_mut().unwrap().truncate(4);
}

#[test]
fn opencode_v1_todos_questions_and_turn_state_from_recorded_messages() {
    let directory = tempfile::tempdir().unwrap();
    let cases: [(&str, Edit, Value); 5] = [
        ("idle", |_| {}, json!("idle")),
        ("between-steps", without_final_answer, json!("working")),
        (
            "asking",
            |fixture| {
                without_final_answer(fixture);
                let message = &mut fixture["messages"][1]["data"];
                message["time"].as_object_mut().unwrap().remove("completed");
                message.as_object_mut().unwrap().remove("finish");
                fixture["parts"][3]["data"]["state"]["status"] = json!("running");
            },
            json!("waiting"),
        ),
        (
            "aborted",
            |fixture| {
                without_final_answer(fixture);
                fixture["messages"][1]["data"]["error"] =
                    json!({"name":"MessageAbortedError","data":{"message":"Aborted"}});
            },
            json!("stopped"),
        ),
        (
            "prompted",
            |fixture| {
                fixture["messages"].as_array_mut().unwrap().truncate(1);
                fixture["parts"].as_array_mut().unwrap().truncate(1);
            },
            json!("working"),
        ),
    ];
    for (name, edit, expected) in cases {
        let path = directory.path().join(format!("{name}.db"));
        opencode_database(&path, edit);
        let page = opencode_conversation(&path, "ses_fixture", 100).unwrap();
        assert_eq!(activity(&page), expected, "{name}");
        if name == "idle" {
            assert_eq!(
                cards(&page),
                [plan(("Drop the legacy layout", "cancelled")), layout(true)]
            );
        }
    }
}

/// The client fixture is the companion's own output for these recorded
/// fixtures, so browser and component tests cannot drift from the adapters.
/// Regenerate with `UPDATE_INTERACTION_PAGES=1 cargo test --test interaction_cards`.
#[test]
fn client_fixture_pages_are_the_companion_output() {
    let directory = tempfile::tempdir().unwrap();
    let claude = directory.path().join("claude.jsonl");
    let page = |page: TranscriptPage| serde_json::to_value(page).unwrap();
    write(&claude, &lines(CLAUDE)[..4]);
    let claude_waiting = page(conversation(&claude, TranscriptAgent::Claude, 100).unwrap());
    fs::write(&claude, CLAUDE).unwrap();
    let claude_idle = page(conversation(&claude, TranscriptAgent::Claude, 100).unwrap());
    let codex = directory.path().join("rollout.jsonl");
    fs::write(&codex, CODEX).unwrap();
    let codex_idle = page(conversation(&codex, TranscriptAgent::Codex, 100).unwrap());
    let codex_records = page(read_page(&codex, TranscriptAgent::Codex, 0, 100).unwrap());
    let opencode = directory.path().join("opencode.db");
    opencode_database(&opencode, |_| {});
    let opencode_idle = page(opencode_conversation(&opencode, "ses_fixture", 100).unwrap());
    // The waiting branch is a prefix of the idle one; store only what differs.
    let waiting = json!({
        "messages":claude_waiting["messages"].as_array().unwrap().len(),
        "activity":claude_waiting["activity"],"nextOffset":claude_waiting["nextOffset"],
        "branchId":claude_waiting["branchId"],
    });
    let mut derived = claude_idle.clone();
    for field in ["activity", "nextOffset", "branchId"] {
        derived[field] = waiting[field].clone();
    }
    derived["messages"] = json!(claude_idle["messages"].as_array().unwrap()[..4]);
    assert_eq!(derived, claude_waiting);
    let actual = json!({
        "provenance":"Generated by apps/agent/tests/interaction_cards.rs from apps/agent/tests/fixtures/interaction-cards. claudeWaiting lists only how that page differs from claudeIdle.",
        "claudeWaiting":waiting,"claudeIdle":claude_idle,
        "codexIdle":codex_idle,"codexRecords":codex_records,"opencodeIdle":opencode_idle,
    });
    let target =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../client/e2e/fixtures/interactionPages.json");
    if std::env::var_os("UPDATE_INTERACTION_PAGES").is_some() {
        fs::write(
            &target,
            serde_json::to_string_pretty(&actual).unwrap() + "\n",
        )
        .unwrap();
    }
    let committed: Value = serde_json::from_str(&fs::read_to_string(&target).unwrap()).unwrap();
    assert_eq!(committed, actual);
}
