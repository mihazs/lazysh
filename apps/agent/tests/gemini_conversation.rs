//! Synthetic Gemini CLI session files, shaped like `packages/core/src/services/chatRecordingTypes.ts`. No real session is used.
use lazysh_agent::transcript::{conversation, discover, TranscriptAgent, TranscriptPage};
use serde_json::{json, Value};
use std::{fs, path::Path};

#[path = "support/jsonl.rs"]
mod jsonl;

fn session(directory: &Path, records: &[Value]) -> std::path::PathBuf {
    let path = directory.join("tmp/project/chats/session-2026-11-13T01-00-abcd1234.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    jsonl::write(&path, records);
    path
}
fn read(path: &Path) -> TranscriptPage {
    conversation(path, TranscriptAgent::Gemini, 50).unwrap()
}
fn texts(page: &TranscriptPage) -> Vec<String> {
    page.messages
        .iter()
        .flat_map(|message| message["blocks"].as_array().unwrap())
        .filter(|block| block["type"] == "text")
        .map(|block| block["text"].as_str().unwrap().to_owned())
        .collect()
}
fn call(id: &str, name: &str, args: Value, status: &str) -> Value {
    json!({"id":id,"name":name,"args":args,"status":status,"timestamp":"2026-11-13T01:00:05.000Z",
        "result":[{"functionResponse":{"id":id,"name":name,"response":{"output":format!("{name} output")}}}]})
}
fn metadata() -> Value {
    json!({"sessionId":"abcd1234-0000","projectHash":"p","startTime":"2026-11-13T01:00:00.000Z","lastUpdated":"2026-11-13T01:00:00.000Z"})
}
fn user(id: &str, text: &str) -> Value {
    json!({"id":id,"timestamp":"2026-11-13T01:00:01.000Z","type":"user","content":[{"text":text}]})
}
fn model(id: &str, text: &str, extra: Value) -> Value {
    let mut message = json!({"id":id,"timestamp":"2026-11-13T01:00:02.000Z","type":"gemini","content":text,"model":"gemini-3-pro","tokens":{"input":1200,"output":30,"cached":0,"total":1230}});
    for (key, value) in extra.as_object().unwrap() {
        message[key] = value.clone();
    }
    message
}

#[test]
fn a_recorded_session_replays_replacements_patches_and_rewinds_like_the_cli() {
    let directory = tempfile::tempdir().unwrap();
    let path = session(
        directory.path(),
        &[
            metadata(),
            user("u1", "Explain the build"),
            model(
                "g1",
                "",
                json!({"thoughts":[{"subject":"Reading","description":"the config","timestamp":"t"}],
                "toolCalls":[call("t1","read_file",json!({"file_path":"a.ts"}),"executing")]}),
            ),
            // The same message again, finished: it keeps its place and replaces the earlier record.
            model(
                "g1",
                "",
                // The CLI appends the whole message each time, thoughts included.
                json!({"thoughts":[{"subject":"Reading","description":"the config","timestamp":"t"}],
                "toolCalls":[call("t1","read_file",json!({"file_path":"a.ts"}),"success")]}),
            ),
            json!({"$patch":{"id":"g1","toolCalls":[{"id":"t1","result":[{"functionResponse":{"id":"t1","name":"read_file","response":{"output":"patched output"}}}]}]}}),
            model("g2", "The build uses Vite.", json!({})),
            user("u2", "Now remove it"),
            model("g3", "This answer is rewound away.", json!({})),
            json!({"$rewindTo":"u2"}),
            json!({"$set":{"summary":"ignored metadata"}}),
        ],
    );
    let page = read(&path);
    assert_eq!(texts(&page), ["Explain the build", "The build uses Vite."]);
    let ids: Vec<_> = page
        .messages
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["u1", "g1", "g1:results", "g2"]);
    let thinking = &page.messages[1]["blocks"][0];
    assert_eq!(
        (thinking["type"].as_str(), thinking["text"].as_str()),
        (Some("thinking"), Some("Reading: the config"))
    );
    let tool = &page.messages[1]["blocks"][1];
    assert_eq!(
        (
            tool["type"].as_str(),
            tool["id"].as_str(),
            tool["name"].as_str()
        ),
        (Some("tool_use"), Some("t1"), Some("read_file"))
    );
    assert_eq!(
        serde_json::from_str::<Value>(tool["text"].as_str().unwrap()).unwrap(),
        json!({"file_path":"a.ts"})
    );
    let result = &page.messages[2]["blocks"][0];
    assert_eq!(
        (
            result["type"].as_str(),
            result["id"].as_str(),
            result["text"].as_str(),
            result["isError"].as_bool()
        ),
        (
            Some("tool_result"),
            Some("t1"),
            Some("patched output"),
            Some(false)
        )
    );
    assert_eq!(page.activity, Some("idle"));
    assert_eq!(
        page.session,
        Some(json!({"model":"gemini-3-pro","usage":{"usedTokens":1200}}))
    );
    assert_eq!(serde_json::to_value(page.agent).unwrap(), "gemini");
}

#[test]
fn a_failed_call_is_an_error_result_and_a_running_one_has_none_yet() {
    let directory = tempfile::tempdir().unwrap();
    let mut failed = call(
        "bad",
        "run_shell_command",
        json!({"command":"false"}),
        "error",
    );
    failed["result"] = json!([{"functionResponse":{"id":"bad","name":"run_shell_command","response":{"error":"exit 1"}}}]);
    let path = session(
        directory.path(),
        &[
            metadata(),
            user("u1", "run it"),
            model(
                "g1",
                "",
                json!({"toolCalls":[failed, call("run","run_shell_command",json!({"command":"sleep 9"}),"executing")]}),
            ),
        ],
    );
    let page = read(&path);
    let results = page.messages.last().unwrap();
    assert_eq!(results["id"], "g1:results");
    assert_eq!(results["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(
        (
            results["blocks"][0]["text"].as_str(),
            results["blocks"][0]["isError"].as_bool()
        ),
        (Some("exit 1"), Some(true))
    );
    assert_eq!(page.activity, Some("working"));
}

#[test]
fn a_cancelled_call_is_not_reported_as_a_success() {
    let directory = tempfile::tempdir().unwrap();
    let mut cancelled = call(
        "no",
        "run_shell_command",
        json!({"command":"rm -rf x"}),
        "cancelled",
    );
    cancelled["result"] = json!([{"functionResponse":{"id":"no","name":"run_shell_command","response":{"error":"[Operation Cancelled] User cancelled"}}}]);
    let path = session(
        directory.path(),
        &[
            metadata(),
            user("u1", "clean up"),
            model("g1", "", json!({"toolCalls":[cancelled]})),
        ],
    );
    let page = read(&path);
    let result = &page.messages.last().unwrap()["blocks"][0];
    assert_eq!(
        (result["text"].as_str(), result["isError"].as_bool()),
        (Some("[Operation Cancelled] User cancelled"), Some(true))
    );
    assert_eq!(page.activity, Some("stopped"));
}

#[test]
fn the_plan_a_sub_agent_and_a_background_shell_become_the_shared_cards() {
    let directory = tempfile::tempdir().unwrap();
    let todos = json!({"todos":[{"description":"Write the reader","status":"completed"},{"description":"Test it","status":"in_progress"},{"description":"Ship it","status":"pending"}]});
    let path = session(
        directory.path(),
        &[
            metadata(),
            user("u1", "do it"),
            model(
                "g1",
                "",
                json!({"toolCalls":[
                    call("plan","write_todos",todos,"success"),
                    call("sub","invoke_agent",json!({"agent_name":"codebase_investigator","prompt":"Map the repo"}),"executing"),
                    call("bg","run_shell_command",json!({"command":"npm run dev","description":"Dev server","is_background":true}),"success"),
                    call("fg","run_shell_command",json!({"command":"ls"}),"success"),
                ]}),
            ),
        ],
    );
    let page = read(&path);
    let plan = &page.messages[1]["blocks"][0]["card"];
    assert_eq!(plan["kind"], "plan");
    assert_eq!(
        plan["entries"],
        json!([{"text":"Write the reader","status":"completed"},{"text":"Test it","status":"in_progress"},{"text":"Ship it","status":"pending"}])
    );
    let work = page.work.unwrap();
    let summary: Vec<_> = work
        .iter()
        .map(|item| {
            (
                item["id"].as_str().unwrap(),
                item["kind"].as_str().unwrap(),
                item["title"].as_str().unwrap(),
                item["state"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("sub", "agent", "codebase_investigator", "running"),
            ("bg", "shell", "Dev server", "running")
        ]
    );
    assert_eq!(work[1]["command"], "npm run dev");
}

#[test]
fn a_todo_list_with_an_unknown_status_stays_an_ordinary_tool_block() {
    let directory = tempfile::tempdir().unwrap();
    let todos = json!({"todos":[{"description":"Step","status":"someday"}]});
    let path = session(
        directory.path(),
        &[
            metadata(),
            user("u1", "x"),
            model(
                "g1",
                "",
                json!({"toolCalls":[call("plan","write_todos",todos,"success")]}),
            ),
        ],
    );
    let page = read(&path);
    assert!(page.messages[1]["blocks"][0].get("card").is_none());
    assert_eq!(page.messages[1]["blocks"][0]["type"], "tool_use");
}

#[test]
fn a_prompt_with_an_expanded_file_shows_what_the_user_typed_and_an_unfinished_last_line_is_ignored()
{
    let directory = tempfile::tempdir().unwrap();
    let path = session(directory.path(), &[metadata()]);
    let typed = json!({"id":"u1","type":"user","timestamp":"t","content":[{"text":"look at @a.ts"},{"text":"--- a.ts ---\nSECRET FILE BODY"}],"displayContent":[{"text":"look at @a.ts"}]});
    let mut text = serde_json::to_string(&metadata()).unwrap()
        + "\n"
        + &serde_json::to_string(&typed).unwrap()
        + "\n";
    text.push_str("{\"id\":\"u2\",\"type\":\"user\",\"content\":\"half writ");
    fs::write(&path, text).unwrap();
    assert_eq!(texts(&read(&path)), ["look at @a.ts"]);
}

#[test]
fn a_legacy_single_object_session_reads_like_the_log() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory
        .path()
        .join("tmp/project/chats/session-legacy.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, serde_json::to_vec(&json!({"sessionId":"s","projectHash":"p","messages":[user("u1", "hello"), model("g1", "hi there", json!({}))]})).unwrap()).unwrap();
    assert_eq!(texts(&read(&path)), ["hello", "hi there"]);
}

#[test]
fn only_main_session_files_are_listed_and_a_sub_agent_file_is_not() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("tmp");
    let write = |relative: &str| {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{}\n").unwrap();
    };
    write("proj-a/chats/session-2026-11-13T01-00-abcd1234.jsonl");
    write("proj-b/chats/session-2026-11-12T01-00-ffff0000.jsonl");
    write("proj-a/chats/abcd1234-0000/sub-agent-id.jsonl");
    write("proj-a/chats/notes.jsonl");
    write("proj-a/logs/session-2026-11-13T01-00-abcd1234.jsonl");
    write("session-2026-11-13T01-00-abcd1234.jsonl");
    let found =
        serde_json::to_value(discover(TranscriptAgent::Gemini, Some(&root), 10).unwrap()).unwrap();
    let mut names: Vec<_> = found["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap().to_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "session-2026-11-12T01-00-ffff0000.jsonl",
            "session-2026-11-13T01-00-abcd1234.jsonl"
        ]
    );
}
