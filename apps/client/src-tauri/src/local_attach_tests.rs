//! Attaching multiplexer sessions from `local_connect`: the argv a typed entry becomes, the
//! terminal identity tmux navigation needs, and real tmux, Herdr and Zellij on a local PTY.
use crate::multiplexer::Entry;
use serde_json::json;

fn entry(value: serde_json::Value) -> Result<Entry, serde_json::Error> {
    serde_json::from_value(value)
}
fn argv(value: serde_json::Value) -> Vec<String> {
    entry(value).unwrap().argv().unwrap()
}

#[test]
fn an_attach_entry_becomes_argv_with_every_name_literal() {
    for name in [
        "plain",
        "with space",
        "it's \"quoted\"",
        "$(touch NO) `x` * | & #{session_name}",
        "-leading-dash",
    ] {
        assert_eq!(
            argv(json!({"kind":"tmux","name":name,"tmuxServer":"work space"})),
            [
                "tmux",
                "-u",
                "-L",
                "work space",
                "attach-session",
                "-t",
                &format!("={name}")
            ]
        );
        assert_eq!(
            argv(json!({"kind":"tmux","name":name,"createIfMissing":true})),
            [
                "tmux",
                "-u",
                "-L",
                "default",
                "new-session",
                "-A",
                "-s",
                name
            ]
        );
    }
    // tmux parses a trailing semicolon again after the process launcher split argv.
    assert_eq!(argv(json!({"kind":"tmux","name":"a;"}))[6], "=a\\;",);
    for name in ["plain", "with space", "it's \"quoted\""] {
        assert_eq!(
            argv(json!({"kind":"zellij","name":name})),
            ["zellij", "attach", name]
        );
        assert_eq!(
            argv(json!({"kind":"zellij","name":name,"createIfMissing":true})),
            ["zellij", "attach", "--create", name]
        );
    }
    assert_eq!(
        argv(json!({"kind":"herdr","name":"work_1.a-b"})),
        ["herdr", "--session", "work_1.a-b"]
    );
}

#[test]
fn an_attach_entry_refuses_unknown_fields_and_invalid_targets() {
    // The renderer names a session; it never supplies a program, argument or shell text.
    for extra in ["command", "argv", "program", "cwd"] {
        assert!(
            entry(json!({"kind":"tmux","name":"a",extra:"x"})).is_err(),
            "{extra}"
        );
    }
    assert!(entry(json!({"kind":"screen","name":"a"})).is_err());
    for invalid in [
        json!({"kind":"zellij","name":"--bad"}),
        json!({"kind":"herdr","name":"with space"}),
        json!({"kind":"herdr","name":".."}),
        json!({"kind":"herdr","name":"a".repeat(65)}),
        json!({"kind":"tmux","name":""}),
        json!({"kind":"tmux","name":"   "}),
        json!({"kind":"tmux","name":"line\nbreak"}),
        json!({"kind":"tmux","name":"a".repeat(201)}),
        json!({"kind":"tmux","name":"a","tmuxServer":"a/b"}),
        json!({"kind":"zellij","name":"a","tmuxServer":"other"}),
    ] {
        let rejected = entry(invalid.clone()).map_or(true, |entry| entry.argv().is_err());
        assert!(rejected, "{invalid}");
    }
}

#[cfg(unix)]
mod runtime {
    use super::{
        super::{
            desktop,
            tests::{access_lease, events, until},
            LocalState,
        },
        *,
    };
    use crate::{
        ssh::AppState,
        tmux_jump::{request, Identity},
    };
    use std::{os::unix::fs::PermissionsExt, process::Command, time::Duration};

    /// Keeps real multiplexers away from the user's own state: private home, config,
    /// runtime and socket directories.
    struct Isolated {
        temp: tempfile::TempDir,
    }
    impl Isolated {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            for directory in ["tmux", "zellij-sockets"] {
                let path = temp.path().join(directory);
                std::fs::create_dir(&path).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            std::fs::create_dir(temp.path().join("zellij")).unwrap();
            std::fs::write(
                temp.path().join("zellij/config.kdl"),
                "show_release_notes false\nshow_startup_tips false\n",
            )
            .unwrap();
            std::fs::write(
                temp.path().join("config.toml"),
                "[update]\nversion_check = false\nmanifest_check = false\n",
            )
            .unwrap();
            Self { temp }
        }
        fn env(&self) -> Vec<(String, String)> {
            let at = |name: &str| self.temp.path().join(name).to_str().unwrap().to_owned();
            let home = self.temp.path().to_str().unwrap().to_owned();
            vec![
                ("HOME".into(), home.clone()),
                ("ZDOTDIR".into(), home.clone()),
                ("XDG_CONFIG_HOME".into(), home.clone()),
                ("XDG_CACHE_HOME".into(), home.clone()),
                ("XDG_DATA_HOME".into(), home),
                ("TMUX_TMPDIR".into(), at("tmux")),
                ("ZELLIJ_SOCKET_DIR".into(), at("zellij-sockets")),
                ("HERDR_CONFIG_PATH".into(), at("config.toml")),
                ("SHELL".into(), "/bin/sh".into()),
                // Not the login PATH: CI installs these tools beside the runner's own PATH.
                ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ]
        }
        fn state(&self) -> LocalState {
            let state = LocalState::default();
            state.set_test_env(self.env());
            state
        }
        /// Cleanup that must not fail the test.
        fn quiet(&self, program: &str, args: &[&str]) {
            let _ = self.command(program).args(args).output();
        }
        fn stop_tmux(&self, server: &str) {
            self.quiet("tmux", &["-L", server, "kill-server"]);
        }
        fn command(&self, program: &str) -> Command {
            let mut command = Command::new(program);
            for name in crate::host::INHERITED {
                command.env_remove(name);
            }
            command.env_remove("HERDR_SESSION").env_remove("HERDR_ENV");
            command.envs(self.env()).current_dir(self.temp.path());
            command
        }
    }
    fn text(command: &mut Command) -> String {
        let output = command.output().unwrap();
        assert!(output.status.success(), "{command:?}: {output:?}");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
    /// Retries `probe` until it finds something, or fails the test after 20 seconds.
    async fn eventually<T>(what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Some(found) = probe() {
                    return found;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{what}"))
    }
    fn unique(prefix: &str) -> String {
        format!("{prefix}{}", uuid::Uuid::new_v4().simple())
    }
    async fn attach(
        state: &LocalState,
        value: serde_json::Value,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
        crate::app_lock::AccessLease,
    ) {
        let lease = access_lease();
        let (channel, rx) = events();
        let connected = desktop::connect(
            state,
            lease.clone(),
            None,
            Some(entry(value).unwrap()),
            80,
            24,
            channel,
        )
        .await
        .unwrap();
        desktop::adopt(state, &connected.session_id, &lease).unwrap();
        (connected.session_id, rx, lease)
    }

    #[tokio::test]
    async fn the_pty_identity_is_the_child_and_its_terminal() {
        let state = LocalState::default();
        let (channel, mut rx) = events();
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf 'TTY_%s_END\\n' \"$(tty)\"; exec sleep 30"]);
        command.env("PATH", "/usr/bin:/bin");
        let connected = desktop::start(&state, command, 80, 24, channel)
            .await
            .unwrap();
        let printed = until(&mut rx, "_END").await;
        let tty = printed.split("TTY_").nth(1).unwrap().split("_END").next();
        let identity: Identity = desktop::display_identity(&state, &connected.session_id).unwrap();
        assert_eq!(Some(identity.tty.as_str()), tty);
        // The shell exec'd into `sleep`, so the PTY child is that process.
        let command = std::fs::read_to_string(format!("/proc/{}/comm", identity.pid))
            .or_else(|_| {
                Ok::<_, std::io::Error>(text(Command::new("ps").args([
                    "-o",
                    "comm=",
                    "-p",
                    &identity.pid.to_string(),
                ])))
            })
            .unwrap();
        assert!(command.trim().ends_with("sleep"), "{command}");
        desktop::disconnect(&state, &connected.session_id);
    }

    #[tokio::test]
    #[ignore = "requires tmux on PATH; runs an isolated tmux server and a local PTY"]
    async fn real_local_attach_tmux_streams_output_and_navigation_moves_the_displayed_client() {
        let home = Isolated::new();
        let state = home.state();
        let server = unique("lazysh-");
        let tmux = |args: &[&str]| text(home.command("tmux").args(["-L", &server]).args(args));
        // Spaces and quotes stay one literal name through argv.
        let first = "al pha's \"q\"";
        tmux(&["new-session", "-d", "-x", "80", "-y", "24", "-s", first]);
        tmux(&["new-session", "-d", "-x", "80", "-y", "24", "-s", "beta"]);
        let (id, mut rx, lease) = attach(
            &state,
            json!({"kind":"tmux","name":first,"tmuxServer":server}),
        )
        .await;
        // tmux switches to the alternate screen once the client is attached.
        until(&mut rx, "\u{1b}[?1049h").await;
        let app = tempfile::tempdir().unwrap();
        let app = AppState::new(app.path().into()).unwrap();
        let snapshot = |target| request(&lease, &app, &state, &id, target);
        let before = serde_json::to_value(snapshot(None).await.unwrap()).unwrap();
        let sessions = before["sessions"].as_array().unwrap();
        let find = |name: &str| sessions.iter().find(|row| row["name"] == name).unwrap();
        assert_eq!(before["current"]["sessionId"], find(first)["id"]);
        let (beta, window) = (
            find("beta")["id"].as_str().unwrap().to_owned(),
            find("beta")["windows"][0]["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
        let tty = desktop::display_identity(&state, &id).unwrap().tty;
        let displayed = || tmux(&["display-message", "-p", "-c", &tty, "#{session_name}"]);
        assert_eq!(displayed(), first);
        let after = snapshot(Some((
            before["generation"].as_str().unwrap().to_owned(),
            beta.clone(),
            window,
        )))
        .await
        .unwrap();
        assert_eq!(
            serde_json::to_value(after).unwrap()["current"]["sessionId"],
            beta
        );
        // The displayed client, not the control client, moved: checked on the same server.
        assert_eq!(displayed(), "beta");
        desktop::disconnect(&state, &id);
        home.stop_tmux(&server);
    }

    #[tokio::test]
    #[ignore = "requires tmux on PATH; runs an isolated tmux server and a local PTY"]
    async fn real_local_attach_tmux_creates_a_missing_session_only_when_asked() {
        let home = Isolated::new();
        let state = home.state();
        let server = unique("lazysh-");
        let name = "made it";
        let (id, mut rx, _lease) = attach(
            &state,
            json!({"kind":"tmux","name":name,"tmuxServer":server,"createIfMissing":true}),
        )
        .await;
        until(&mut rx, "\u{1b}[?1049h").await;
        let sessions = || {
            text(home.command("tmux").args([
                "-L",
                &server,
                "list-sessions",
                "-F",
                "#{session_name}",
            ]))
        };
        assert_eq!(sessions(), name);
        // Without `createIfMissing` a missing session ends the terminal instead of creating one.
        let (channel, mut closing) = events();
        let missing = desktop::connect(
            &state,
            access_lease(),
            None,
            Some(entry(json!({"kind":"tmux","name":"absent","tmuxServer":server})).unwrap()),
            80,
            24,
            channel,
        )
        .await
        .unwrap()
        .session_id;
        loop {
            let event = closing.recv().await.unwrap();
            if event["type"] == "closed" {
                break;
            }
        }
        assert_eq!(sessions(), name, "the missing session was created");
        desktop::disconnect(&state, &missing);
        desktop::disconnect(&state, &id);
        home.stop_tmux(&server);
    }

    #[tokio::test]
    #[ignore = "requires herdr on PATH; runs an isolated Herdr session on a local PTY"]
    async fn real_local_attach_herdr_streams_the_stock_client() {
        let home = Isolated::new();
        let state = home.state();
        let name = unique("lazysh-");
        let (id, mut rx, _lease) = attach(&state, json!({"kind":"herdr","name":name})).await;
        // The stock client switches to the alternate screen once it is attached.
        until(&mut rx, "\u{1b}[?1049h").await;
        let snapshot = eventually("the attached Herdr session never answered", || {
            let output = home
                .command("herdr")
                .args(["--session", &name, "api", "snapshot"])
                .output()
                .unwrap();
            output
                .status
                .success()
                .then(|| String::from_utf8(output.stdout).unwrap())
        })
        .await;
        assert!(snapshot.contains("session_snapshot"), "{snapshot}");
        desktop::disconnect(&state, &id);
        home.quiet("herdr", &["--session", &name, "server", "stop"]);
    }

    #[tokio::test]
    #[ignore = "requires zellij on PATH; runs an isolated temporary session on a local PTY"]
    async fn real_local_attach_zellij_creates_a_session_with_a_literal_name() {
        let home = Isolated::new();
        let state = home.state();
        let name = format!("{} it's \"q\"", unique("z"));
        let (id, mut rx, _lease) = attach(
            &state,
            json!({"kind":"zellij","name":name,"createIfMissing":true}),
        )
        .await;
        until(&mut rx, "\u{1b}[?1049h").await;
        eventually(
            "the attached Zellij session was not listed under its literal name",
            || {
                let names = text(home.command("zellij").args([
                    "list-sessions",
                    "--no-formatting",
                    "--short",
                ]));
                names.lines().any(|line| line == name).then_some(())
            },
        )
        .await;
        desktop::disconnect(&state, &id);
        home.quiet("zellij", &["delete-session", "--force", &name]);
    }
}
