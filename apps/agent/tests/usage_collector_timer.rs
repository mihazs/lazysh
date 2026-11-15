//! The real binary installing and removing the timer of each operating system against stand-in
//! `systemctl`, `launchctl` and `schtasks` programs that log their arguments. No real service manager runs.
#![cfg(unix)]
use quota_host::{json, run};
use serde_json::{json as value, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
};
#[path = "support/binary.rs"]
mod binary;
#[allow(dead_code)]
#[path = "support/quota_host.rs"]
mod quota_host;

/// A home directory, a tools directory holding the stand-in programs, and the files they write.
struct Timer {
    _root: tempfile::TempDir,
    state: PathBuf,
    home: PathBuf,
    tools: PathBuf,
    log: PathBuf,
    task: PathBuf,
    backend: &'static str,
}
impl Timer {
    fn new(backend: &'static str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let (home, tools) = (root.path().join("home"), root.path().join("tools"));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir(&tools).unwrap();
        let timer = Self {
            state: root.path().join("state"),
            log: root.path().join("log"),
            task: root.path().join("task"),
            home,
            tools,
            _root: root,
            backend,
        };
        for name in ["systemctl", "launchctl"] {
            timer.script(
                name,
                "printf '%s %s\\n' \"${0##*/}\" \"$*\" >> \"$FAKE_LOG\"\n\
                 if [ -n \"$FAKE_FAIL\" ]; then case \"$*\" in *\"$FAKE_FAIL\"*) exit 1;; esac; fi\n",
            );
        }
        // Task Scheduler keeps the document it was given and prints it back; it has no task before.
        timer.script(
            "schtasks",
            "printf 'schtasks %s\\n' \"$*\" >> \"$FAKE_LOG\"\n\
             case \"$1\" in\n\
               /Query) [ -f \"$FAKE_TASK\" ] && cat \"$FAKE_TASK\" || exit 1;;\n\
               /Create) cp \"$5\" \"$FAKE_TASK\";;\n\
               /Delete) rm -f \"$FAKE_TASK\";;\n\
             esac\n",
        );
        timer.script("loginctl", "echo \"${FAKE_LINGER:-no}\"\n");
        timer
    }
    fn script(&self, name: &str, body: &str) {
        let path = self.tools.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn command(&self, args: &[&str], fail: Option<&str>) -> Output {
        let mut command = Command::new(binary::path());
        command
            .args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("PATH", format!("{}:/usr/bin:/bin", self.tools.display()))
            .env("LAZYSH_STATE_DIR", &self.state)
            .env("LAZYSH_USAGE_TIMER_BACKEND_FOR_TESTS", self.backend)
            .env("FAKE_LOG", &self.log)
            .env("FAKE_TASK", &self.task);
        if let Some(fail) = fail {
            command.env("FAKE_FAIL", fail);
        }
        command.output().unwrap()
    }
    fn collector(&self, args: &[&str]) -> Output {
        let mut all = vec!["usage-collector"];
        all.extend(args);
        self.command(&all, None)
    }
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
    fn policy(&self) -> Value {
        json(&run(&self.state, &["usage-collection", "show"]))
    }
    fn units(&self) -> PathBuf {
        self.home.join(".config/systemd/user")
    }
    fn plist(&self) -> PathBuf {
        self.home
            .join("Library/LaunchAgents/app.lazysh.usage-collector.plist")
    }
}
fn exe() -> String {
    binary::path()
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned()
}
fn exit(output: &Output) -> i32 {
    output.status.code().unwrap()
}

#[test]
fn status_of_a_fresh_host_reports_everything_off_and_creates_nothing() {
    let timer = Timer::new("systemd");
    let status = json(&timer.collector(&["status"]));
    assert_eq!(status["collector"]["enabled"], false);
    assert_eq!(status["collector"]["timer"]["state"], "absent");
    assert_eq!(status["collector"]["timer"]["linger"], false);
    assert_eq!(status["lastRun"], Value::Null);
    assert_eq!(status["samples"]["count"], 0);
    assert_eq!(status["samples"]["state"], "ok");
    assert!(!timer.state.exists());
    assert!(!timer.home.join(".config").exists());
}

#[test]
fn enable_installs_the_systemd_timer_records_the_policy_and_disable_removes_only_ours() {
    let timer = Timer::new("systemd");
    let enabled = json(&timer.collector(&["enable", "--interval-minutes", "15"]));
    assert_eq!(enabled["collector"]["enabled"], true);
    assert_eq!(enabled["collector"]["intervalMinutes"], 15);
    assert_eq!(enabled["collector"]["timer"]["state"], "installed");
    let policy = timer.policy();
    assert_eq!(policy["collectorEnabled"], true);
    assert_eq!(policy["collectorIntervalMinutes"], 15);
    assert_eq!(policy["accountQuotaEnabled"], true);
    let service = fs::read_to_string(timer.units().join("lazysh-usage-collector.service")).unwrap();
    let unit = fs::read_to_string(timer.units().join("lazysh-usage-collector.timer")).unwrap();
    assert!(service.contains(&format!("ExecStart=\"{}\" usage-collector run\n", exe())));
    assert!(unit.contains("OnCalendar=*:0/5\n") && unit.contains("Persistent=true\n"));
    assert!(service.starts_with("# lazysh-agent-managed: usage-collector\n"));
    assert_eq!(
        timer.calls(),
        [
            "systemctl --user show-environment",
            "systemctl --user daemon-reload",
            "systemctl --user enable --now lazysh-usage-collector.timer",
            // The status that `enable` prints reads the timer back.
            "systemctl --user show-environment",
            "systemctl --user is-enabled lazysh-usage-collector.timer",
        ]
    );
    verify_units(&timer);

    // Enabling again is idempotent and keeps the interval it was not told to change.
    let again = json(&timer.collector(&["enable"]));
    assert_eq!(again["collector"]["intervalMinutes"], 15);

    // A file that is not ours, even under the name of one of ours, is never removed.
    let other = timer.units().join("other.service");
    fs::write(&other, "[Unit]\nDescription=mine\n").unwrap();
    let disabled = json(&timer.collector(&["disable"]));
    assert_eq!(disabled["collector"]["enabled"], false);
    assert_eq!(disabled["collector"]["timer"]["state"], "absent");
    assert_eq!(timer.policy()["collectorEnabled"], false);
    assert!(other.exists());
    assert!(!timer.units().join("lazysh-usage-collector.timer").exists());
    assert!(!timer
        .units()
        .join("lazysh-usage-collector.service")
        .exists());
    assert!(timer
        .calls()
        .contains(&"systemctl --user disable --now lazysh-usage-collector.timer".to_owned()));
}

/// `systemd-analyze verify` reads the rendered units for real when the machine has it.
fn verify_units(timer: &Timer) {
    let Some(analyze) = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join("systemd-analyze"))
        .find(|path| path.is_file())
    else {
        eprintln!("systemd-analyze is not installed here: the unit syntax was not verified");
        return;
    };
    let output = Command::new(analyze)
        .args(["--user", "verify"])
        .arg(timer.units().join("lazysh-usage-collector.service"))
        .arg(timer.units().join("lazysh-usage-collector.timer"))
        .env("HOME", &timer.home)
        .output()
        .unwrap();
    assert!(
        output.status.success() && output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn an_account_without_a_user_manager_exits_41_and_changes_nothing() {
    let timer = Timer::new("systemd");
    let output = timer.command(&["usage-collector", "enable"], Some("show-environment"));
    assert_eq!(exit(&output), 41);
    assert!(String::from_utf8_lossy(&output.stderr).contains("TimerUnsupported"));
    assert!(!timer.state.exists());
    assert!(!timer.home.join(".config").exists());
    assert_eq!(
        json(&timer.command(&["usage-collector", "status"], Some("show-environment")))["collector"]
            ["timer"]["state"],
        "unsupported"
    );
}

#[test]
fn a_refused_timer_exits_42_puts_back_the_files_and_leaves_the_collector_off() {
    let timer = Timer::new("systemd");
    let output = timer.command(&["usage-collector", "enable"], Some("enable --now"));
    assert_eq!(exit(&output), 42);
    assert!(String::from_utf8_lossy(&output.stderr).contains("TimerFailed"));
    assert!(!timer.units().join("lazysh-usage-collector.timer").exists());
    assert!(!timer
        .units()
        .join("lazysh-usage-collector.service")
        .exists());
    assert_eq!(timer.policy()["collectorEnabled"], false);
}

#[test]
fn a_file_that_is_not_ours_is_never_replaced_or_removed() {
    let timer = Timer::new("systemd");
    fs::create_dir_all(timer.units()).unwrap();
    let foreign = timer.units().join("lazysh-usage-collector.timer");
    fs::write(&foreign, "[Timer]\nOnCalendar=daily\n").unwrap();
    assert_eq!(exit(&timer.collector(&["enable"])), 42);
    assert_eq!(
        fs::read_to_string(&foreign).unwrap(),
        "[Timer]\nOnCalendar=daily\n"
    );
    assert!(!timer
        .units()
        .join("lazysh-usage-collector.service")
        .exists());
    assert_eq!(timer.policy()["collectorEnabled"], false);
    assert_eq!(exit(&timer.collector(&["disable"])), 42);
    assert!(foreign.exists());
}

#[test]
fn a_drifted_timer_is_reported_as_drift() {
    let timer = Timer::new("systemd");
    json(&timer.collector(&["enable"]));
    let unit = timer.units().join("lazysh-usage-collector.timer");
    fs::write(
        &unit,
        fs::read_to_string(&unit)
            .unwrap()
            .replace("*:0/5", "hourly"),
    )
    .unwrap();
    assert_eq!(
        json(&timer.collector(&["status"]))["collector"]["timer"]["state"],
        "drift"
    );
    let not_loaded = timer.command(&["usage-collector", "status"], Some("is-enabled"));
    assert_eq!(json(&not_loaded)["collector"]["timer"]["state"], "drift");
}

#[test]
fn the_launchd_agent_is_rendered_loaded_and_unloaded() {
    let timer = Timer::new("launchd");
    let enabled = json(&timer.collector(&["enable"]));
    assert_eq!(enabled["collector"]["timer"]["state"], "installed");
    let agent = plist::Value::from_file(timer.plist()).unwrap();
    let agent = agent.as_dictionary().unwrap();
    assert_eq!(
        agent.get("Label").and_then(plist::Value::as_string),
        Some("app.lazysh.usage-collector")
    );
    assert_eq!(
        agent
            .get("StartInterval")
            .and_then(plist::Value::as_signed_integer),
        Some(300)
    );
    let arguments: Vec<&str> = agent
        .get("ProgramArguments")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|argument| argument.as_string().unwrap())
        .collect();
    assert_eq!(arguments, [exe().as_str(), "usage-collector", "run"]);
    assert!(fs::read_to_string(timer.plist())
        .unwrap()
        .contains("lazysh-agent-managed: usage-collector"));
    assert!(timer
        .calls()
        .iter()
        .any(|call| call.starts_with("launchctl bootstrap gui/")));
    json(&timer.collector(&["disable"]));
    assert!(!timer.plist().exists());
    assert!(timer
        .calls()
        .iter()
        .any(|call| call.starts_with("launchctl bootout gui/")));
    // Without a login session of the user's GUI domain there is nowhere to load an agent.
    let output = timer.command(&["usage-collector", "enable"], Some("print gui/"));
    assert_eq!(exit(&output), 41);
    assert!(!timer.plist().exists());
}

#[test]
fn the_scheduled_task_is_a_utf16_document_registered_and_deleted_by_name() {
    let timer = Timer::new("schtasks");
    let enabled = json(&timer.collector(&["enable"]));
    assert_eq!(enabled["collector"]["timer"]["state"], "installed");
    let bytes = fs::read(&timer.task).unwrap();
    assert_eq!(
        bytes[..2],
        [0xFF, 0xFE],
        "UTF-16 little-endian byte order mark"
    );
    let units: Vec<u16> = bytes[2..]
        .chunks(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let document = String::from_utf16(&units).unwrap();
    assert!(document.contains("lazysh-agent-managed: usage-collector"));
    assert!(document.contains(&format!("<Command>{}</Command>", exe())));
    assert!(document.contains("<Arguments>usage-collector run</Arguments>"));
    assert!(document.contains("<Interval>PT5M</Interval>"));
    assert!(document.contains("<StartWhenAvailable>true</StartWhenAvailable>"));
    let mut reader = quick_xml::Reader::from_str(&document);
    // The document must be well-formed XML: every event reads until the end.
    while reader.read_event().unwrap() != quick_xml::events::Event::Eof {}
    assert!(timer.calls().iter().any(|call| call
        .starts_with("schtasks /Create /TN lazysh-usage-collector /XML ")
        && call.ends_with(" /F")));
    json(&timer.collector(&["disable"]));
    assert!(!timer.task.exists());
    assert!(timer
        .calls()
        .contains(&"schtasks /Delete /TN lazysh-usage-collector /F".to_owned()));

    // A task of the same name that is not ours is neither replaced nor deleted.
    fs::write(&timer.task, "<Task>somebody else's</Task>").unwrap();
    assert_eq!(exit(&timer.collector(&["enable"])), 42);
    assert_eq!(exit(&timer.collector(&["disable"])), 42);
    assert_eq!(
        fs::read_to_string(&timer.task).unwrap(),
        "<Task>somebody else's</Task>"
    );
}

#[test]
fn run_reads_the_quota_for_real_once_per_interval_and_records_it() {
    let host = quota_host::host();
    // Not enabled: the tick starts nothing and writes nothing.
    let off = json(&host.command(&["usage-collector", "run"]).output().unwrap());
    assert_eq!(off, value!({"schemaVersion":1,"outcome":"off"}));
    assert!(!host.started.exists() && !host.state.exists());

    lazysh_agent::usage_collection::update(&host.state, None, |policy| {
        policy.collector_enabled = true;
    })
    .unwrap();
    let first = json(&host.command(&["usage-collector", "run"]).output().unwrap());
    assert_eq!(first, value!({"schemaVersion":1,"outcome":"recorded"}));
    assert!(host.started.exists());
    let second = json(&host.command(&["usage-collector", "run"]).output().unwrap());
    assert_eq!(second["outcome"], "notDue");

    let status = json(
        &host
            .command(&["usage-collector", "status", "--limit", "5"])
            .output()
            .unwrap(),
    );
    assert_eq!(status["samples"]["count"], 1);
    assert_eq!(status["lastRun"]["outcome"], "recorded");
    assert_eq!(status["recent"][0]["source"], "external_cli");
    assert_eq!(status["recent"][0]["entries"][0]["id"], "owned");
    assert_eq!(
        status["recent"][0]["recordedAt"],
        status["samples"]["newest"]
    );
    assert!(
        status["observedAt"].as_str().unwrap() >= status["samples"]["newest"].as_str().unwrap()
    );
}
