//! Owned OpenSSH acceptance of remote approvals for Claude hooks that run inside a real Zellij pane and a real Herdr
//! pane. Each multiplexer is a private server whose own report names the pane the current-source companion's blocking
//! hook runs in; the client lists the request with exactly that pane, only that pane answers it, and a hook ended at
//! the host leaves nothing to answer. No agent CLI runs, and no live multiplexer server is touched.
use super::agent_board_fixture::{
    altered, approvals, decide, hook_command, install_companion, pending, refused, App,
};
use super::*;
use serde_json::{json, Value};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::Manager;

/// A host command in the private multiplexer home. Pane programs inherit it from the server that starts them, so no
/// tmux, Zellij or Herdr variable of the machine running the test can name a pane for them.
fn host(home: &Path, program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .current_dir(home)
        .env("SHELL", "/bin/sh")
        .env("TERM", "xterm-256color")
        .env("HERDR_CONFIG_PATH", home.join("herdr.toml"));
    for name in [
        "HOME",
        "XDG_RUNTIME_DIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "ZDOTDIR",
    ] {
        command.env(name, home);
    }
    for name in [
        "ZELLIJ",
        "ZELLIJ_SESSION_NAME",
        "ZELLIJ_PANE_ID",
        "TMUX",
        "TMUX_PANE",
        "HERDR_ENV",
        "HERDR_PANE_ID",
        "HERDR_TAB_ID",
        "HERDR_WORKSPACE_ID",
        "HERDR_SOCKET_PATH",
        "HERDR_SESSION",
        "HERDR_BIN_PATH",
        "ENV",
        "BASH_ENV",
    ] {
        command.env_remove(name);
    }
    command
}

fn stdout(mut command: Command) -> String {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{command:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// A private multiplexer server that can start `sh <script>` in a new pane of its own.
trait Multiplexer {
    /// The identity the companion must bind for the pane: the one the multiplexer itself reports for it.
    fn launch(&self, name: &str, script: &Path) -> String;
}

struct Zellij {
    home: PathBuf,
    session: String,
}
impl Zellij {
    fn start(home: &Path) -> Self {
        let config = home.join("zellij.kdl");
        fs::write(
            &config,
            "show_release_notes false\nshow_startup_tips false\n",
        )
        .unwrap();
        let session = "lazysh-approvals".to_owned();
        let mut command = host(home, "zellij");
        command
            .arg("--config")
            .arg(&config)
            .args(["attach", "--create-background", &session]);
        stdout(command);
        Self {
            home: home.into(),
            session,
        }
    }
}
impl Multiplexer for Zellij {
    fn launch(&self, name: &str, script: &Path) -> String {
        let mut command = host(&self.home, "zellij");
        command
            .args([
                "--session",
                &self.session,
                "run",
                "--name",
                name,
                "--",
                "sh",
            ])
            .arg(script);
        let pane = stdout(command);
        let id = pane
            .trim()
            .strip_prefix("terminal_")
            .expect("Zellij reports the new pane as terminal_<id>");
        format!("zellij:{}:{id}", self.session)
    }
}
impl Drop for Zellij {
    fn drop(&mut self) {
        let _ = host(&self.home, "zellij")
            .args(["kill-session", "--", &self.session])
            .output();
    }
}

struct Herdr {
    home: PathBuf,
    session: String,
    server: std::process::Child,
}
impl Herdr {
    fn start(home: &Path) -> Self {
        // Pin the built-in detection rules; never fetch a newer catalog.
        fs::write(
            home.join("herdr.toml"),
            "[update]\nversion_check = false\nmanifest_check = false\n",
        )
        .unwrap();
        let server = host(home, "herdr")
            .arg("server")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut herdr = Self {
            home: home.into(),
            session: String::new(),
            server,
        };
        let ready = (0..250).any(|_| {
            let ready = host(home, "herdr")
                .args(["api", "snapshot"])
                .output()
                .unwrap()
                .status
                .success();
            if !ready {
                std::thread::sleep(Duration::from_millis(40));
            }
            ready
        });
        assert!(ready, "the isolated Herdr server did not become ready");
        let mut command = host(home, "herdr");
        command.args(["session", "list", "--json"]);
        let sessions: Value = serde_json::from_str(&stdout(command)).unwrap();
        let [session] = sessions["sessions"].as_array().unwrap().as_slice() else {
            panic!("one isolated Herdr session expected: {sessions}");
        };
        assert_eq!(session["running"], true);
        herdr.session = session["name"].as_str().unwrap().into();
        herdr
    }
}
impl Multiplexer for Herdr {
    fn launch(&self, name: &str, script: &Path) -> String {
        let mut command = host(&self.home, "herdr");
        command
            .args(["workspace", "create", "--label", name, "--cwd"])
            .arg(&self.home);
        let created: Value = serde_json::from_str(&stdout(command)).unwrap();
        let pane = created["result"]["root_pane"]["pane_id"].as_str().unwrap();
        // `exec` ends the pane with the hook, as it would end an agent's pane.
        let mut command = host(&self.home, "herdr");
        command
            .args(["pane", "run", pane])
            .arg(format!("exec sh {}", quote(script.to_str().unwrap())));
        stdout(command);
        format!("herdr:{}:{pane}", self.session)
    }
}
impl Drop for Herdr {
    fn drop(&mut self) {
        let _ = host(&self.home, "herdr").args(["server", "stop"]).output();
        let _ = self.server.kill();
        let _ = self.server.wait();
    }
}

/// A blocking Claude PermissionRequest hook started in a pane the multiplexer created.
struct PaneHook {
    pane: String,
    pid: PathBuf,
    output: PathBuf,
}
impl PaneHook {
    fn start(mux: &dyn Multiplexer, directory: &Path, companion: &Path, name: &str) -> Self {
        let payload = json!({"hook_event_name":"PermissionRequest","session_id":name,"cwd":"/work/real","tool_name":"Bash","tool_input":{"command":"git push --force-with-lease"}});
        let output = directory.join(format!("{name}.out"));
        let (command, pid) = hook_command(
            directory,
            companion,
            name,
            &payload,
            &format!("> {}", quote(output.to_str().unwrap())),
        );
        // The panes share the companion's state with the client's SSH commands.
        let script = directory.join(format!("{name}.sh"));
        fs::write(
            &script,
            format!(
                "LAZYSH_STATE_DIR={}; export LAZYSH_STATE_DIR\n{command}\n",
                quote(directory.join("state").to_str().unwrap())
            ),
        )
        .unwrap();
        Self {
            pane: mux.launch(name, &script),
            pid,
            output,
        }
    }

    /// What the hook printed to Claude once it was answered.
    async fn decision(&self) -> Value {
        timeout(Duration::from_secs(20), async {
            loop {
                let printed = fs::read_to_string(&self.output).unwrap_or_default();
                if !printed.is_empty() {
                    return serde_json::from_str::<Value>(&printed).unwrap()["hookSpecificOutput"]
                        ["decision"]
                        .clone();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("the waiting hook must print its decision")
    }
}

/// The caller boxes this large future: built inline in `openssh_check` it would take stack from every check.
pub(super) async fn verify(app: &App, id: &str, directory: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let session = app.state::<AppState>().session(id).await.unwrap();
    let companion = install_companion(&session).await;
    let home = directory.join("mux");
    fs::create_dir(&home).unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let (zellij, herdr) = (Zellij::start(&home), Herdr::start(&home));

    // Two hooks in each multiplexer are waiting at once. Each is listed with the pane its multiplexer reports.
    let mut waiting = Vec::new();
    for (kind, mux) in [("zellij", &zellij as &dyn Multiplexer), ("herdr", &herdr)] {
        for decision in ["allow", "deny"] {
            let name = format!("{kind}-{decision}");
            let hook = PaneHook::start(mux, directory, &companion, &name);
            let listed = pending(app, id, &name).await;
            assert_eq!(listed["agent"], "claude");
            assert_eq!(listed["toolName"], "Bash");
            assert_eq!(
                listed["toolInput"],
                json!({"command":"git push --force-with-lease"})
            );
            assert_eq!(
                listed["paneId"], hook.pane,
                "{name} is listed with its own pane"
            );
            assert!(hook.pane.starts_with(&format!("{kind}:")), "{}", hook.pane);
            waiting.push((decision, hook, listed));
        }
    }

    // No other pane, not even another live pane of the same multiplexer, a tmux pane or none can answer a request.
    for (_, hook, listed) in &waiting {
        let hash = listed["expectedHash"].as_str().unwrap();
        refused(app, id, listed, &altered(hash), Some(&hook.pane), "allow").await;
        for (_, other, _) in waiting
            .iter()
            .filter(|(_, other, _)| other.pane != hook.pane)
        {
            refused(app, id, listed, hash, Some(&other.pane), "allow").await;
        }
        refused(app, id, listed, hash, Some("%7"), "allow").await;
        refused(app, id, listed, hash, None, "allow").await;
    }
    assert_eq!(
        approvals(app, id).await.len(),
        4,
        "refused answers leave every request pending"
    );

    // The exact pane allows or denies its own hook, once.
    for (decision, hook, listed) in &waiting {
        let hash = listed["expectedHash"].as_str().unwrap();
        assert_eq!(
            decide(app, id, listed, hash, Some(&hook.pane), decision)
                .await
                .unwrap(),
            json!({"schemaVersion":1,"accepted":true})
        );
        assert_eq!(
            hook.decision().await["behavior"],
            *decision,
            "{}",
            hook.pane
        );
        refused(app, id, listed, hash, Some(&hook.pane), "allow").await;
    }
    assert!(approvals(app, id).await.is_empty());

    // Claude ends the hook when the prompt is answered at the host: the request leaves the client's list for good.
    for (kind, mux) in [("zellij", &zellij as &dyn Multiplexer), ("herdr", &herdr)] {
        let name = format!("{kind}-host");
        let hook = PaneHook::start(mux, directory, &companion, &name);
        let listed = pending(app, id, &name).await;
        assert_eq!(listed["paneId"], hook.pane);
        let pid = fs::read_to_string(&hook.pid).unwrap();
        assert!(Command::new("kill")
            .args(["-TERM", pid.trim()])
            .status()
            .unwrap()
            .success());
        timeout(Duration::from_secs(20), async {
            while !approvals(app, id).await.is_empty() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("a hook ended at the host leaves the client's list");
        refused(
            app,
            id,
            &listed,
            listed["expectedHash"].as_str().unwrap(),
            Some(&hook.pane),
            "allow",
        )
        .await;
        assert_eq!(
            fs::read_to_string(&hook.output).unwrap(),
            "",
            "{kind}: the ended hook printed no decision"
        );
    }
}
