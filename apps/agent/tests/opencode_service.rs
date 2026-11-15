//! `lazysh-agent opencode-service` against a stand-in for OpenCode 2.x's loopback service (`tests/support`), driving the
//! real executable over real sockets. What the stand-in recorded is what a real service would have received.
#![cfg(unix)]
#[path = "support/binary.rs"]
mod binary;
#[path = "support/opencode_service.rs"]
mod fixture;

use fixture::{Service, SESSION};
use serde_json::{json, Value};
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

struct Host {
    dir: tempfile::TempDir,
    service: Service,
}

impl Host {
    fn new() -> Self {
        let host = Self {
            dir: tempfile::tempdir().unwrap(),
            service: Service::start(),
        };
        host.registry(
            &format!("http://127.0.0.1:{}", host.service.port),
            "2.2.7",
            std::process::id(),
            fixture::PASSWORD,
        );
        host
    }
    fn xdg(&self) -> PathBuf {
        self.dir.path().join("xdg")
    }
    fn registry(&self, url: &str, version: &str, pid: u32, password: &str) {
        let directory = self.xdg().join("opencode");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("service.json");
        std::fs::write(&file, json!({"id": "service-1", "version": version, "url": url, "pid": pid, "password": password}).to_string()).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(binary::path());
        command
            .args(args)
            .env("XDG_STATE_HOME", self.xdg())
            .env("LAZYSH_STATE_DIR", self.dir.path().join("state"))
            .env_remove("TMUX_PANE");
        command
    }
    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }
    fn json(&self, args: &[&str]) -> Value {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(
            !text.contains(fixture::PASSWORD),
            "the service credentials were printed"
        );
        serde_json::from_str(&text).unwrap()
    }
    fn list(&self) -> Value {
        self.json(&["opencode-service", "list", "--session-id", SESSION])
    }
    fn request(&self, id: &str) -> Value {
        self.list()["requests"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
            .clone()
    }
    /// A reply to a listed request, as the app sends it: the identity and hash the listing printed.
    fn reply_args(request: &Value, extra: &[&str]) -> Vec<String> {
        let mut args = ["opencode-service", "reply", "--session-id", SESSION]
            .map(String::from)
            .to_vec();
        for (flag, key) in [
            ("--id", "id"),
            ("--expected-hash", "expectedHash"),
            ("--expires-at", "expiresAt"),
        ] {
            args.extend([flag.to_owned(), request[key].as_str().unwrap().to_owned()]);
        }
        args.extend(extra.iter().map(|arg| (*arg).to_owned()));
        args
    }
    fn reply(&self, request: &Value, extra: &[&str]) -> Value {
        let args = Self::reply_args(request, extra);
        self.json(&args.iter().map(String::as_str).collect::<Vec<_>>())
    }
    /// An OpenCode hook report that puts `session` in `pane`.
    fn report(&self, session: &str, pane: &str) {
        let mut child = self
            .command(&["ingest", "--agent", "opencode"])
            .env("TMUX_PANE", pane)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let payload = json!({"type": "session.status", "directory": "/work", "properties": {"sessionID": session, "status": {"type": "busy"}}});
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
    }
    fn sent(&self) -> usize {
        self.service.posts().len()
    }
}

fn outcome(value: &Value) -> (bool, &str) {
    (
        value["accepted"].as_bool().unwrap(),
        value["reason"].as_str().unwrap_or(""),
    )
}

fn fields() -> Value {
    json!([
        {"key": "color", "type": "string", "title": "Color", "required": true, "options": [{"value": "red", "label": "Red"}, {"value": "blue", "label": "Blue"}]},
        {"key": "tags", "type": "multiselect", "options": [{"value": "a", "label": "A"}]},
        {"key": "ok", "type": "boolean"},
        {"key": "count", "type": "integer"},
        {"key": "note", "type": "string"}
    ])
}

#[test]
fn lists_what_the_service_holds_for_the_session_and_never_its_credentials() {
    let host = Host::new();
    host.service
        .permission("per_a", "bash", &["echo hi"], &["echo *"]);
    host.service.form("frm_a", fields());
    host.service.run();
    let listing = host.list();
    assert_eq!(
        listing["service"],
        json!({"available": true, "shape": "v2", "version": "2.2.7"})
    );
    assert_eq!(listing["running"], true);
    let permission = host.request("per_a");
    assert_eq!(
        (
            permission["kind"].clone(),
            permission["action"].clone(),
            permission["resources"].clone(),
            permission["save"].clone()
        ),
        (
            json!("permission"),
            json!("bash"),
            json!(["echo hi"]),
            json!(["echo *"])
        )
    );
    assert!(
        permission["supported"] == true
            && permission["expectedHash"].as_str().unwrap().len() == 64
            && permission.get("metadata").is_none()
    );
    let form = host.request("frm_a");
    assert_eq!(
        (
            form["kind"].clone(),
            form["fields"][0]["key"].clone(),
            form["supported"].clone()
        ),
        (json!("form"), json!("color"), json!(true))
    );
    assert_eq!(host.sent(), 0);
}

#[test]
fn a_permission_answered_once_reaches_the_service_once_and_a_replay_sends_nothing() {
    let host = Host::new();
    host.service
        .permission("per_a", "bash", &["echo hi"], &["echo *"]);
    let request = host.request("per_a");
    assert_eq!(
        outcome(&host.reply(&request, &["--decision", "once"])),
        (true, "")
    );
    assert_eq!(
        host.service.posts(),
        vec![(
            format!("/api/session/{SESSION}/permission/per_a/reply"),
            json!({"decision": "once"})
        )]
    );
    assert_eq!(
        outcome(&host.reply(&request, &["--decision", "once"])),
        (false, "gone")
    );
    assert_eq!(host.sent(), 1);
}

#[test]
fn always_needs_the_listed_rules_and_a_rejection_carries_its_reason() {
    let host = Host::new();
    host.service
        .permission("per_a", "bash", &["echo hi"], &["echo *"]);
    host.service.permission("per_b", "edit", &["a.txt"], &[]);
    host.service
        .permission("per_c", "bash", &["rm x"], &["rm *"]);
    assert_eq!(
        outcome(&host.reply(&host.request("per_b"), &["--decision", "always"])),
        (false, "unsupported")
    );
    assert_eq!(host.sent(), 0);
    assert_eq!(
        outcome(&host.reply(&host.request("per_a"), &["--decision", "always"])),
        (true, "")
    );
    assert_eq!(
        outcome(&host.reply(
            &host.request("per_c"),
            &["--decision", "reject", "--message", "not in this repo"]
        )),
        (true, "")
    );
    let posts = host.service.posts();
    assert_eq!(
        (posts[0].1.clone(), posts[1].1.clone()),
        (
            json!({"decision": "always"}),
            json!({"decision": "reject", "message": "not in this repo"})
        )
    );
    for refused in [
        vec!["--decision", "reject", "--message", "two\nlines"],
        vec!["--decision", "once", "--message", "no"],
        vec!["--decision", "once", "--answer", "{}"],
        vec![],
    ] {
        let args = Host::reply_args(&host.request("per_b"), &refused);
        assert!(!host
            .run(&args.iter().map(String::as_str).collect::<Vec<_>>())
            .status
            .success());
    }
    assert_eq!(host.sent(), 2);
}

#[test]
fn a_request_that_changed_was_answered_elsewhere_or_expired_is_refused_and_nothing_is_sent() {
    let host = Host::new();
    for id in ["per_changed", "per_gone", "per_expired", "per_other"] {
        host.service
            .permission(id, "bash", &["echo hi"], &["echo *"]);
    }
    let [changed, gone, expired, other] =
        ["per_changed", "per_gone", "per_expired", "per_other"].map(|id| host.request(id));
    host.service.edit("per_changed", &["rm -rf /"]);
    host.service.answer_elsewhere("per_gone");
    assert_eq!(
        outcome(&host.reply(&changed, &["--decision", "once"])),
        (false, "changed")
    );
    assert_eq!(
        outcome(&host.reply(&gone, &["--decision", "once"])),
        (false, "gone")
    );
    let mut late = expired.clone();
    late["expiresAt"] = json!("2020-01-01T00:00:00Z");
    assert_eq!(
        outcome(&host.reply(&late, &["--decision", "once"])),
        (false, "expired")
    );
    // One request's hash never answers another, and a forged hash never answers its own.
    let mut swapped = other.clone();
    swapped["expectedHash"] = changed["expectedHash"].clone();
    assert_eq!(
        outcome(&host.reply(&swapped, &["--decision", "once"])),
        (false, "changed")
    );
    assert_eq!(host.sent(), 0);
}

#[test]
fn two_resolvers_of_the_same_request_send_one_answer() {
    let host = Host::new();
    host.service
        .permission("per_a", "bash", &["echo hi"], &["echo *"]);
    let args = Host::reply_args(&host.request("per_a"), &["--decision", "once"]);
    let children: Vec<_> = (0..2)
        .map(|_| {
            host.command(&args.iter().map(String::as_str).collect::<Vec<_>>())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    let mut results: Vec<(bool, String)> = children
        .into_iter()
        .map(|child| {
            let value: Value =
                serde_json::from_slice(&child.wait_with_output().unwrap().stdout).unwrap();
            let (accepted, reason) = outcome(&value);
            (accepted, reason.to_owned())
        })
        .collect();
    results.sort();
    assert_eq!(
        results,
        vec![(false, "gone".to_owned()), (true, String::new())]
    );
    assert_eq!(host.sent(), 1);
}

#[test]
fn a_pane_that_no_longer_shows_the_session_gets_no_answer() {
    let host = Host::new();
    host.service
        .permission("per_a", "bash", &["echo hi"], &["echo *"]);
    let request = host.request("per_a");
    let answer = || host.reply(&request, &["--pane-id", "%7", "--decision", "once"]);
    // No report, then another session's report, then two sessions in the pane: nothing proves it still shows this one.
    assert_eq!(outcome(&answer()), (false, "pane"));
    host.report("ses_other", "%7");
    assert_eq!(outcome(&answer()), (false, "pane"));
    host.report(SESSION, "%7");
    assert_eq!(outcome(&answer()), (false, "pane"));
    assert_eq!(host.sent(), 0);
    // The other session moves on to another pane, and this one alone is shown in %7.
    host.report("ses_other", "%9");
    assert_eq!(outcome(&answer()), (true, ""));
    assert_eq!(host.sent(), 1);
}

#[test]
fn a_question_form_is_answered_once_with_the_fields_it_asked_for() {
    let host = Host::new();
    host.service.form("frm_a", fields());
    let form = host.request("frm_a");
    let answer = r#"{"color":"red","tags":["a"],"ok":true,"count":3,"note":"hi"}"#;
    for invalid in [
        r#"{"tags":["a"]}"#,
        r#"{"color":3}"#,
        r#"{"color":"red","extra":"x"}"#,
        r#"{"color":"red","count":1.5}"#,
        r#"{"color":"red","tags":"a"}"#,
        "[]",
        "nope",
    ] {
        assert_eq!(
            outcome(&host.reply(&form, &["--answer", invalid])),
            (false, "invalid"),
            "{invalid}"
        );
    }
    assert_eq!(host.sent(), 0);
    assert_eq!(
        outcome(&host.reply(&form, &["--answer", answer])),
        (true, "")
    );
    assert_eq!(
        host.service.posts(),
        vec![(
            format!("/api/session/{SESSION}/form/frm_a/reply"),
            json!({"answer": serde_json::from_str::<Value>(answer).unwrap()})
        )]
    );
    assert_eq!(
        outcome(&host.reply(&form, &["--answer", answer])),
        (false, "gone")
    );
    assert_eq!(host.sent(), 1);
}

#[test]
fn a_form_with_a_field_the_dock_cannot_show_stays_in_the_terminal() {
    let host = Host::new();
    host.service.form("frm_a", json!([{"key": "a", "type": "string"}, {"key": "b", "type": "string", "when": [{"key": "a", "op": "eq", "value": "x"}]}]));
    host.service.form(
        "frm_b",
        json!([{"key": "link", "type": "external", "url": "https://example.com"}]),
    );
    for id in ["frm_a", "frm_b"] {
        let form = host.request(id);
        assert_eq!(form["supported"], false);
        assert_eq!(
            outcome(&host.reply(&form, &["--answer", "{}"])),
            (false, "unsupported")
        );
    }
    assert_eq!(host.sent(), 0);
}

#[test]
fn a_turn_is_stopped_once_and_only_while_it_runs() {
    let host = Host::new();
    let abort = |extra: &[&str]| {
        host.json(
            &[
                &["opencode-service", "abort", "--session-id", SESSION],
                extra,
            ]
            .concat(),
        )
    };
    assert_eq!(outcome(&abort(&[])), (false, "idle"));
    assert_eq!(host.sent(), 0);
    host.service.run();
    assert_eq!(outcome(&abort(&["--pane-id", "%7"])), (false, "pane"));
    assert_eq!(host.sent(), 0);
    assert_eq!(outcome(&abort(&[])), (true, ""));
    assert_eq!(
        host.service.posts()[0].0,
        format!("/api/session/{SESSION}/interrupt")
    );
    assert_eq!(outcome(&abort(&[])), (false, "idle"));
    assert_eq!(host.sent(), 1);
}

#[test]
fn an_unusable_service_is_reported_and_never_contacted_for_an_answer() {
    let host = Host::new();
    host.service
        .permission("per_a", "bash", &["echo hi"], &["echo *"]);
    let request = host.request("per_a");
    let live = format!("http://127.0.0.1:{}", host.service.port);
    let dead_pid = 4_000_000_000u32;
    for (url, version, pid, password, reason) in [
        (
            live.as_str(),
            "1.19.5",
            std::process::id(),
            fixture::PASSWORD,
            "unsupported",
        ),
        (
            live.as_str(),
            "2.2.7",
            dead_pid,
            fixture::PASSWORD,
            "stopped",
        ),
        (
            live.as_str(),
            "2.2.7",
            std::process::id(),
            "wrong",
            "unauthorized",
        ),
        (
            "http://192.0.2.1:4096",
            "2.2.7",
            std::process::id(),
            fixture::PASSWORD,
            "unsafe-address",
        ),
        (
            "https://127.0.0.1:4096",
            "2.2.7",
            std::process::id(),
            fixture::PASSWORD,
            "unsafe-address",
        ),
    ] {
        host.registry(url, version, pid, password);
        assert_eq!(
            host.list()["service"],
            json!({"available": false, "reason": reason}),
            "{url} {version}"
        );
        assert_eq!(
            outcome(&host.reply(&request, &["--decision", "once"])),
            (false, "unavailable")
        );
    }
    let file = host.xdg().join("opencode/service.json");
    host.registry(&live, "2.2.7", std::process::id(), fixture::PASSWORD);
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(host.list()["service"]["reason"], "unsafe-registry");
    std::fs::remove_file(&file).unwrap();
    assert_eq!(host.list()["service"]["reason"], "no-service");
    assert_eq!(host.sent(), 0);
}

#[test]
fn identities_that_could_reach_another_route_are_rejected_before_any_request() {
    let host = Host::new();
    for args in [
        vec!["opencode-service", "list", "--session-id", "ses_a/../b"],
        vec!["opencode-service", "list", "--session-id", "other"],
        vec![
            "opencode-service",
            "reply",
            "--session-id",
            SESSION,
            "--id",
            "per_a/reply",
            "--expected-hash",
            &"a".repeat(64),
            "--expires-at",
            "2999-01-01T00:00:00Z",
            "--decision",
            "once",
        ],
        vec![
            "opencode-service",
            "reply",
            "--session-id",
            SESSION,
            "--id",
            "per_a",
            "--expected-hash",
            "short",
            "--expires-at",
            "2999-01-01T00:00:00Z",
            "--decision",
            "once",
        ],
        vec![
            "opencode-service",
            "abort",
            "--session-id",
            SESSION,
            "--pane-id",
            "%7;x",
        ],
    ] {
        assert!(!host.run(&args).status.success(), "{args:?}");
    }
    assert_eq!(host.sent(), 0);
}
