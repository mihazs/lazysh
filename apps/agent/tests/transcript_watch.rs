//! The long-lived `transcript-watch` stream through the real executable.
#[path = "support/binary.rs"]
mod binary;
#[path = "support/jsonl.rs"]
mod jsonl;
#[path = "support/process.rs"]
mod process;

use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

const ID: &str = "11111111-1111-4111-8111-111111111111";

struct Watch {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Value>,
}
impl Watch {
    fn start(args: &[&str], envs: &[(&str, &Path)]) -> Self {
        let mut command = Command::new(binary::path());
        command.arg("transcript-watch").args(args);
        for (key, value) in envs {
            command.env(key, value);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = sender.send(serde_json::from_str(&line).unwrap());
            }
        });
        let stdin = child.stdin.take();
        Self {
            child,
            stdin,
            lines,
        }
    }
    fn next(&self) -> Value {
        self.lines
            .recv_timeout(Duration::from_secs(10))
            .expect("a frame")
    }
    fn next_of(&self, kind: &str) -> Value {
        loop {
            let frame = self.next();
            if frame["type"] == kind {
                return frame;
            }
        }
    }
}

fn record(id: &str, parent: Option<&str>, role: &str, text: &str) -> Value {
    json!({"type":role,"uuid":id,"parentUuid":parent,"sessionId":ID,"message":{"content":text}})
}
fn append(path: &Path, record: &Value) {
    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(file, "{record}").unwrap();
}

#[test]
fn an_append_reaches_the_stream_within_one_interval_and_closing_stdin_ends_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    jsonl::write(&path, &[record("m0", None, "user", "hello")]);
    let mut watch = Watch::start(
        &["--agent", "claude", "--path", path.to_str().unwrap()],
        &[],
    );
    let hello = watch.next();
    assert_eq!(
        (hello["type"].as_str(), hello["protocol"].as_u64()),
        (Some("hello"), Some(1))
    );
    assert_eq!(hello["intervalMs"], 250);
    let snapshot = watch.next();
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(
        snapshot["entries"][0]["message"]["blocks"][0]["text"],
        "hello"
    );
    let appended = Instant::now();
    append(&path, &record("m1", Some("m0"), "assistant", "answer"));
    let delta = watch.next_of("delta");
    let latency = appended.elapsed();
    eprintln!("append to delta latency: {latency:?}");
    assert_eq!(delta["upserts"][0]["id"], "m1");
    assert!(latency < Duration::from_secs(2));
    drop(watch.stdin.take());
    let status = watch.child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn a_provider_session_id_is_resolved_inside_the_agent_data_root_only() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("projects/one");
    std::fs::create_dir_all(&project).unwrap();
    jsonl::write(
        &project.join(format!("{ID}.jsonl")),
        &[record("m0", None, "user", "hello")],
    );
    let args = [
        "--agent",
        "claude",
        "--session-id",
        ID,
        "--interval-ms",
        "50",
    ];
    let watch = Watch::start(&args, &[("CLAUDE_CONFIG_DIR", home.path())]);
    watch.next_of("hello");
    assert_eq!(watch.next_of("snapshot")["branchId"], "m0");
    let other = tempfile::tempdir().unwrap();
    std::fs::create_dir(other.path().join("projects")).unwrap();
    let mut refused = Watch::start(&args, &[("CLAUDE_CONFIG_DIR", other.path())]);
    refused.next_of("hello");
    assert_eq!(refused.next_of("end")["reason"], "InvalidArgument");
    assert!(!refused.child.wait().unwrap().success());
}

#[test]
fn a_reference_streams_the_reported_conversation_and_a_foreign_one_streams_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    jsonl::write(&path, &[record("m0", None, "user", "hello")]);
    let state = directory.path().join("state");
    let companion = |args: &[&str], input: &Value, state: &Path| {
        process::run(
            Command::new(binary::path())
                .args(args)
                .env("LAZYSH_STATE_DIR", state)
                .env("TMUX_PANE", "%7"),
            input.to_string().as_bytes(),
        )
    };
    let payload = json!({"hook_event_name":"UserPromptSubmit","session_id":"owned","cwd":"/owned","transcript_path":path});
    assert!(companion(
        &["ingest", "--agent", "claude", "--reported-history"],
        &payload,
        &state
    )
    .status
    .success());
    let lookup = companion(
        &["reported-history", "--reference", "--session-id", "owned"],
        &Value::Null,
        &state,
    );
    let reply: Value = serde_json::from_slice(&lookup.stdout).unwrap();
    let token = reply["reference"].as_str().unwrap();
    let args = [
        "--agent",
        "claude",
        "--reference",
        token,
        "--interval-ms",
        "50",
    ];
    let watch = Watch::start(&args, &[("LAZYSH_STATE_DIR", &state)]);
    watch.next_of("hello");
    assert_eq!(
        watch.next_of("snapshot")["entries"][0]["message"]["blocks"][0]["text"],
        "hello"
    );
    let foreign = directory.path().join("foreign-state");
    let refused = Command::new(binary::path())
        .arg("transcript-watch")
        .args(args)
        .env("LAZYSH_STATE_DIR", &foreign)
        .output()
        .unwrap();
    assert!(!refused.status.success() && refused.stdout.is_empty());
    let other_agent = Command::new(binary::path())
        .args(["transcript-watch", "--agent", "codex", "--reference", token])
        .env("LAZYSH_STATE_DIR", &state)
        .output()
        .unwrap();
    assert!(!other_agent.status.success() && other_agent.stdout.is_empty());
}

#[test]
fn an_older_or_conflicting_invocation_is_a_usage_error_with_exit_code_two() {
    let run = |args: &[&str]| {
        Command::new(binary::path())
            .args(args)
            .output()
            .unwrap()
            .status
            .code()
    };
    assert_eq!(run(&["transcript-watch", "--agent", "claude"]), Some(2));
    assert_eq!(
        run(&[
            "transcript-watch",
            "--agent",
            "claude",
            "--path",
            "a",
            "--session-id",
            ID
        ]),
        Some(2)
    );
    assert_eq!(
        run(&[
            "transcript-watch",
            "--agent",
            "claude",
            "--path",
            "a",
            "--protocol",
            "2"
        ]),
        Some(2)
    );
    for other in [["--path", "a"], ["--session-id", ID]] {
        let mut args = vec!["transcript-watch", "--agent", "claude", "--reference", ID];
        args.extend(other);
        assert_eq!(run(&args), Some(2));
    }
}

#[test]
fn previews_of_attached_images_ride_the_stream_only_when_asked_for_and_only_for_a_named_file() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let png = include_bytes!("../../client/e2e/fixtures/recorded-images/regions.png");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let with_image = json!({"type":"user","uuid":"m0","parentUuid":null,"message":{"content":[
        {"type":"text","text":"look"},
        {"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(png)}}
    ]}});
    jsonl::write(&path, &[with_image]);
    let first_blocks = |extra: &[&str]| {
        let mut args = vec!["--agent", "claude", "--path", path.to_str().unwrap()];
        args.extend_from_slice(extra);
        let watch = Watch::start(&args, &[]);
        watch.next_of("hello");
        watch.next_of("snapshot")["entries"][0]["message"]["blocks"].clone()
    };
    let plain = first_blocks(&[]);
    assert!(plain[1].get("imagePreview").is_none());
    let admitted = first_blocks(&["--inline-images"]);
    assert_eq!(admitted[1]["imagePreview"]["mimeType"], "image/png");
    assert_eq!(admitted[1]["imagePreview"]["width"], 32);
    // A provider session id has no named file to read previews from: refused, nothing streamed.
    let status = Command::new(binary::path())
        .args([
            "transcript-watch",
            "--agent",
            "claude",
            "--session-id",
            ID,
            "--inline-images",
        ])
        .output()
        .unwrap();
    assert!(!status.status.success());
}
