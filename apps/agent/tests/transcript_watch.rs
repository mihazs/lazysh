//! The long-lived `transcript-watch` stream through the real executable.
#[path = "support/binary.rs"]
mod binary;
#[path = "support/jsonl.rs"]
mod jsonl;

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
}
