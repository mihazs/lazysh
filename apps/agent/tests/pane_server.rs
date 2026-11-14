//! A hook reports the tmux or rmux server its pane belongs to, so `%7` of one server is not taken for `%7` of another.
#[path = "support/process.rs"]
mod process;
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Command, Output},
};

const SERVER_VARIABLES: [&str; 6] = [
    "TMUX",
    "TMUX_PANE",
    "RMUX",
    "RMUX_PANE",
    "ZELLIJ_SESSION_NAME",
    "ZELLIJ_PANE_ID",
];

fn agent(directory: &Path, environment: &[(&str, &str)]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_lazysh-agent"));
    for name in SERVER_VARIABLES {
        command.env_remove(name);
    }
    command
        .env("LAZYSH_STATE_DIR", directory)
        .envs(environment.iter().copied());
    command
}
fn hook(session: &str) -> Value {
    json!({"hook_event_name":"UserPromptSubmit","session_id":session,"cwd":"/work/app","prompt":"PRIVATE-PROMPT"})
}
fn ingest(directory: &Path, environment: &[(&str, &str)], payload: &Value) -> Output {
    let output = process::run(
        agent(directory, environment).args(["ingest", "--agent", "claude"]),
        &serde_json::to_vec(payload).unwrap(),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}
fn session(directory: &Path, id: &str) -> Value {
    let output = process::run(
        agent(directory, &[]).args(["snapshot", "--limit", "50"]),
        b"",
    );
    assert!(output.status.success());
    let snapshot: Value = serde_json::from_slice(&output.stdout).unwrap();
    snapshot["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["sessionId"] == id)
        .unwrap()
        .clone()
}

#[test]
fn the_same_pane_id_in_two_servers_stays_two_distinct_reports() {
    let dir = tempfile::tempdir().unwrap();
    let (default, work) = ("/tmp/tmux-1000/default,812,0", "/tmp/tmux-1000/work,812,0");
    ingest(
        dir.path(),
        &[("TMUX_PANE", "%7"), ("TMUX", default)],
        &hook("one"),
    );
    ingest(
        dir.path(),
        &[("TMUX_PANE", "%7"), ("TMUX", work)],
        &hook("two"),
    );
    let (one, two) = (session(dir.path(), "one"), session(dir.path(), "two"));
    assert_eq!(
        (&one["paneId"], &two["paneId"]),
        (&json!("%7"), &json!("%7"))
    );
    assert_eq!(one["paneServer"], "tmux:default");
    assert_eq!(two["paneServer"], "tmux:work");
}

#[test]
fn an_rmux_pane_is_named_as_rmux_and_a_custom_socket_names_no_server() {
    let dir = tempfile::tempdir().unwrap();
    let rmux = "/tmp/rmux-1000/native,123,0";
    ingest(
        dir.path(),
        &[
            ("TMUX_PANE", "%2"),
            ("TMUX", rmux),
            ("RMUX_PANE", "%2"),
            ("RMUX", rmux),
        ],
        &hook("rmux"),
    );
    assert_eq!(session(dir.path(), "rmux")["paneServer"], "rmux:native");
    ingest(
        dir.path(),
        &[("TMUX_PANE", "%3"), ("TMUX", "/home/me/custom.sock,812,0")],
        &hook("custom"),
    );
    let custom = session(dir.path(), "custom");
    assert_eq!(custom["paneId"], "%3");
    assert!(custom.get("paneServer").is_none(), "{custom}");
}

#[test]
fn a_later_report_from_a_pane_with_no_server_clears_the_old_one() {
    let dir = tempfile::tempdir().unwrap();
    let tmux = [("TMUX_PANE", "%7"), ("TMUX", "/tmp/tmux-1000/work,812,0")];
    ingest(dir.path(), &tmux, &hook("moved"));
    assert_eq!(session(dir.path(), "moved")["paneServer"], "tmux:work");
    ingest(dir.path(), &[("TMUX_PANE", "%7")], &hook("moved"));
    assert!(session(dir.path(), "moved").get("paneServer").is_none());
}

#[test]
fn a_generic_payload_keeps_its_own_pane_and_may_not_name_an_invalid_server() {
    let dir = tempfile::tempdir().unwrap();
    let tmux = [("TMUX_PANE", "%7"), ("TMUX", "/tmp/tmux-1000/work,812,0")];
    let event = |server: Value| json!({"schemaVersion":1,"sessionId":"generic","agent":"Test Agent","project":"/work/app","state":"working","summary":"A turn","paneId":"%1","paneServer":server});
    let run = |payload: &Value| {
        process::run(
            agent(dir.path(), &tmux).args(["ingest", "--agent", "generic"]),
            &serde_json::to_vec(payload).unwrap(),
        )
    };
    // The payload's pane is not the environment's pane, so the environment's server does not describe it.
    assert!(run(&event(Value::Null)).status.success());
    assert!(session(dir.path(), "generic").get("paneServer").is_none());
    assert!(run(&event(json!("rmux:own"))).status.success());
    assert_eq!(session(dir.path(), "generic")["paneServer"], "rmux:own");
    for invalid in ["zellij:work", "tmux:../x", "tmux:"] {
        assert!(!run(&event(json!(invalid))).status.success(), "{invalid}");
    }
}

/// The label in `TMUX` is read from a real tmux server's own environment, not from a format written down here.
#[cfg(unix)]
#[test]
#[ignore = "requires tmux on PATH"]
fn a_hook_inside_a_real_named_tmux_server_reports_that_server_and_pane() {
    let dir = tempfile::tempdir().unwrap();
    let label = format!("lazysh-pane-{}", std::process::id());
    // An owned socket directory: the user's own tmux servers are never listed, started or stopped.
    let tmux = |args: &[&str]| {
        let mut command = Command::new("tmux");
        for name in SERVER_VARIABLES {
            command.env_remove(name);
        }
        command
            .env("TMUX_TMPDIR", dir.path())
            .args(["-L", &label])
            .args(args)
            .output()
            .unwrap()
    };
    struct Kill<'a>(&'a dyn Fn(&[&str]) -> Output);
    impl Drop for Kill<'_> {
        fn drop(&mut self) {
            (self.0)(&["kill-server"]);
        }
    }
    let _kill = Kill(&tmux);
    let payload = dir.path().join("payload.json");
    std::fs::write(&payload, serde_json::to_vec(&hook("real")).unwrap()).unwrap();
    let done = dir.path().join("done");
    let script = format!(
        "LAZYSH_STATE_DIR='{}' '{}' ingest --agent claude < '{}'; touch '{}'; sleep 60",
        dir.path().display(),
        env!("CARGO_BIN_EXE_lazysh-agent"),
        payload.display(),
        done.display()
    );
    let started = tmux(&[
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "80",
        "-y",
        "24",
        &script,
    ]);
    assert!(started.status.success(), "{started:?}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !done.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "the hook never ran in the pane"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let panes = tmux(&["list-panes", "-a", "-F", "#{pane_id}"]);
    let pane = String::from_utf8(panes.stdout).unwrap().trim().to_owned();
    let row = session(dir.path(), "real");
    assert_eq!(row["paneId"], pane.as_str());
    assert_eq!(row["paneServer"], format!("tmux:{label}"));
}
