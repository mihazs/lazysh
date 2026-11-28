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
        // rmux is attached over SSH only.
        json!({"kind":"rmux","name":"a"}),
    ] {
        let rejected = entry(invalid.clone()).map_or(true, |entry| entry.argv().is_err());
        assert!(rejected, "{invalid}");
    }
}

/// What a native Windows attach starts, decided on any host: the platform and search paths are
/// arguments, so a Linux run exercises the Windows rules against real files.
#[test]
fn a_windows_attach_runs_the_found_program_and_never_tmux() {
    use super::desktop::attach_program;
    use std::ffi::OsStr;

    let directory = tempfile::tempdir().unwrap();
    for file in ["zellij.exe", "herdr.com", "tmux.exe"] {
        std::fs::write(directory.path().join(file), b"").unwrap();
    }
    let path = directory.path().as_os_str();
    let pathext = Some(OsStr::new(".COM;.EXE;.BAT"));
    let start = |program: &str| attach_program(program, true, path, pathext);
    assert_eq!(
        start("zellij").unwrap(),
        directory.path().join("zellij.exe").into_os_string()
    );
    assert_eq!(
        start("herdr").unwrap(),
        directory.path().join("herdr.com").into_os_string()
    );
    // A tmux build on the PATH (MSYS2, Cygwin) is not a supported native target.
    assert!(start("tmux").unwrap_err().contains("WSL"));
    let empty = tempfile::tempdir().unwrap();
    let missing = attach_program("zellij", true, empty.path().as_os_str(), pathext);
    assert!(missing.unwrap_err().starts_with("zellij was not found"));
    // Elsewhere the PTY searches the login PATH itself.
    assert_eq!(
        attach_program("tmux", false, empty.path().as_os_str(), None).unwrap(),
        OsStr::new("tmux")
    );
}

/// Discovery, one-shot actions and attach resolve one program the same way: the same file, in the
/// same PATH and PATHEXT order, and a batch shim or a bare name is none of them.
#[test]
fn discovery_actions_and_attach_find_the_same_native_program() {
    use super::desktop::attach_program;
    use crate::native_program::{on_path, start};
    use std::ffi::OsStr;

    let (first, second) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    for (directory, file) in [
        (&first, "herdr.com"),
        (&second, "herdr.exe"),
        (&first, "zellij.cmd"),
        (&second, "zellij.bat"),
        (&second, "zellij"),
    ] {
        std::fs::write(directory.path().join(file), b"").unwrap();
    }
    let path = std::env::join_paths([first.path(), second.path()]).unwrap();
    for pathext in [
        None,
        Some(".EXE;.COM"),
        Some(".COM;.EXE"),
        Some(".BAT;.CMD"),
    ] {
        let pathext = pathext.map(OsStr::new);
        for program in ["herdr", "zellij", "missing"] {
            let found = attach_program(program, true, &path, pathext);
            assert_eq!(on_path(true, &path, pathext, program), found.is_ok());
            // An action starts the file attach starts; a program not found keeps its name.
            assert_eq!(
                start(true, &path, pathext, program),
                found.unwrap_or_else(|_| program.into()),
                "{program} {pathext:?}"
            );
        }
    }
    assert!(on_path(true, &path, Some(OsStr::new(".EXE;.COM")), "herdr"));
    assert_eq!(
        start(true, &path, Some(OsStr::new(".EXE;.COM")), "herdr"),
        // The first PATH directory wins over a better extension further on.
        first.path().join("herdr.com").into_os_string()
    );
    assert!(!on_path(true, &path, None, "zellij"));
    // Elsewhere the name itself is looked up and started.
    assert!(!on_path(false, &path, None, "herdr"));
    assert_eq!(start(false, &path, None, "herdr"), OsStr::new("herdr"));
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
        tmux_jump::{request, Identity, Target},
    };
    use std::{os::unix::fs::PermissionsExt, process::Command, time::Duration};

    /// Keeps real multiplexers away from the user's own state: private home, config,
    /// runtime and socket directories.
    struct Isolated {
        temp: tempfile::TempDir,
        /// Searched before the inherited PATH, for a specific build of a tool.
        tools: Option<std::path::PathBuf>,
    }
    impl Isolated {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            for directory in ["tmux", "zellij-sockets", "runtime"] {
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
            Self { temp, tools: None }
        }
        /// Makes `binary` the `herdr` every command of this home and every local terminal runs.
        fn with_herdr(mut self, binary: &std::path::Path) -> Self {
            let tools = self.temp.path().join("tools");
            std::fs::create_dir(&tools).unwrap();
            std::os::unix::fs::symlink(binary, tools.join("herdr")).unwrap();
            self.tools = Some(tools);
            self
        }
        fn env(&self) -> Vec<(String, String)> {
            let at = |name: &str| self.temp.path().join(name).to_str().unwrap().to_owned();
            let home = self.temp.path().to_str().unwrap().to_owned();
            vec![
                ("HOME".into(), home.clone()),
                ("ZDOTDIR".into(), home.clone()),
                ("XDG_CONFIG_HOME".into(), home.clone()),
                ("XDG_CACHE_HOME".into(), home.clone()),
                ("XDG_DATA_HOME".into(), home.clone()),
                ("XDG_STATE_HOME".into(), home),
                ("XDG_RUNTIME_DIR".into(), at("runtime")),
                ("TMUX_TMPDIR".into(), at("tmux")),
                ("ZELLIJ_SOCKET_DIR".into(), at("zellij-sockets")),
                ("HERDR_CONFIG_PATH".into(), at("config.toml")),
                ("SHELL".into(), "/bin/sh".into()),
                // Not the login PATH: CI installs these tools beside the runner's own PATH.
                (
                    "PATH".into(),
                    std::env::join_paths(self.tools.iter().cloned().chain(std::env::split_paths(
                        &std::env::var_os("PATH").unwrap_or_default(),
                    )))
                    .unwrap()
                    .into_string()
                    .unwrap(),
                ),
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
    /// One guard action on a local terminal, as the `herdr_chat` command takes it.
    async fn guard(
        app: &AppState,
        state: &LocalState,
        id: &str,
        lease: &crate::app_lock::AccessLease,
        action: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        crate::herdr_guard::chat(
            lease,
            app,
            state,
            id,
            serde_json::from_value(action).unwrap(),
        )
        .await
        .map(|reply| serde_json::to_value(reply).unwrap())
        .map_err(|error| error.kind().to_owned())
    }
    /// Closes the terminal and waits for its guard to report unavailable.
    async fn guard_ends_with_the_terminal(
        app: &AppState,
        state: &LocalState,
        id: &str,
        lease: &crate::app_lock::AccessLease,
    ) {
        desktop::disconnect(state, id);
        tokio::time::timeout(Duration::from_secs(10), async {
            while guard(app, state, id, lease, json!({"kind":"status"}))
                .await
                .is_ok_and(|status| status["available"] == true)
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the closed terminal kept its guard");
    }
    fn app_state() -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().unwrap();
        let app = AppState::new(directory.path().into()).unwrap();
        (directory, app)
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
            None,
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
        // The TTY can arrive before the shell execs into `sleep`.
        eventually("PTY child must exec sleep", || {
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
            command.trim().ends_with("sleep").then_some(())
        })
        .await;
        desktop::disconnect(&state, &connected.session_id);
    }

    #[tokio::test]
    async fn a_multiplexer_session_attaches_on_the_default_shell_only() {
        let (channel, _rx) = events();
        let error = desktop::connect(
            &LocalState::default(),
            access_lease(),
            None,
            Some(entry(json!({"kind":"tmux","name":"work"})).unwrap()),
            Some("pwsh"),
            80,
            24,
            channel,
        )
        .await
        .err()
        .expect("a target other than the default refuses an attach");
        assert!(error.contains("own shell"), "{error}");
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
        let after = snapshot(Some(Target::new(
            before["generation"].as_str().unwrap().to_owned(),
            beta.clone(),
            window,
            None,
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
            None,
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
        let (id, mut rx, lease) = attach(&state, json!({"kind":"herdr","name":name})).await;
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
        // Stock Herdr has no guard: the attach is ordinary and offers no guarded input.
        let (_directory, app) = app_state();
        let status = guard(&app, &state, &id, &lease, json!({"kind":"status"})).await;
        assert_eq!(status.unwrap()["available"], false);
        desktop::disconnect(&state, &id);
        home.quiet("herdr", &["--session", &name, "server", "stop"]);
    }

    /// A `herdr` that admits the guard, opens its display with the private first frame and
    /// then shows `PUBLIC_SCREEN`; the claim names `owner_boot` as the connection's boot.
    /// It logs each invocation's arguments, with `--guarded-attach` for an attach.
    fn guarded_herdr_script(owner_boot: &str) -> String {
        let (boot, ticket, ownership) = ("ab".repeat(32), "cd".repeat(32), "ef".repeat(32));
        format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> "$HOME/invocations"
case "$*" in
  *"api guarded"*)
    body=$(cat)
    case "$body" in
      *cancel_preparation*)
        printf '{{"id":"guard","error":{{"code":"guard_invalid","message":"guard_invalid"}}}}' >&2; exit 1;;
      *lazysh.guard.claim*)
        printf '{{"id":"guard","result":{{"type":"guard_claimed","owner":{{"boot":"{owner_boot}","ownership":"{ownership}","last_preparation":0}}}}}}';;
    esac;;
  *--guarded-attach*)
    body='{{"boot":"{boot}","ticket":"{ticket}"}}'
    printf '\036LAZYSH-GUARD-1:%08x:%s\037PUBLIC_SCREEN\n' "${{#body}}" "$body"
    exec sleep 30;;
  *) printf 'ORDINARY_SCREEN\n'; exec sleep 30;;
esac
"#
        )
    }
    /// Connects a local Herdr terminal to a `herdr` that runs `script`.
    async fn attach_scripted(
        script: &str,
    ) -> (
        Isolated,
        LocalState,
        Result<String, String>,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
        crate::app_lock::AccessLease,
    ) {
        let home = Isolated::new();
        let path = home.temp.path().join("herdr-script");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let home = home.with_herdr(&path);
        let state = home.state();
        let lease = access_lease();
        let (channel, rx) = events();
        let connected = desktop::connect(
            &state,
            lease.clone(),
            None,
            Some(entry(json!({"kind":"herdr","name":"scripted"})).unwrap()),
            None,
            80,
            24,
            channel,
        )
        .await
        .map(|connected| connected.session_id);
        (home, state, connected, rx, lease)
    }
    fn invocations(home: &Isolated) -> Vec<String> {
        std::fs::read_to_string(home.temp.path().join("invocations"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[tokio::test]
    async fn a_guarded_local_herdr_keeps_its_first_frame_off_the_terminal_and_binds_the_guard() {
        let (home, state, connected, mut rx, lease) =
            attach_scripted(&guarded_herdr_script(&"ab".repeat(32))).await;
        let id = connected.unwrap();
        desktop::adopt(&state, &id, &lease).unwrap();
        let shown = until(&mut rx, "PUBLIC_SCREEN").await;
        for private in ["LAZYSH-GUARD-1", &"ab".repeat(32), &"cd".repeat(32)] {
            assert!(!shown.contains(private), "the terminal showed {private}");
        }
        let (_directory, app) = app_state();
        let status = guard(&app, &state, &id, &lease, json!({"kind":"status"})).await;
        assert_eq!(status.unwrap()["available"], true);
        // The guard probe, the attach and the claim; never an ordinary attach.
        let ran = invocations(&home);
        assert_eq!(
            ran.iter()
                .filter(|line| line.contains("api guarded"))
                .count(),
            2,
            "{ran:?}"
        );
        assert_eq!(
            ran.iter()
                .filter(|line| !line.contains("api guarded"))
                .collect::<Vec<_>>(),
            ["--session scripted --guarded-attach"]
        );
        guard_ends_with_the_terminal(&app, &state, &id, &lease).await;
    }

    #[tokio::test]
    async fn a_guard_claim_the_host_does_not_confirm_closes_the_terminal_without_an_ordinary_attach(
    ) {
        // The claim answers for a different boot than the ticket named.
        let (home, _state, connected, mut rx, _lease) =
            attach_scripted(&guarded_herdr_script(&"12".repeat(32))).await;
        assert!(connected.is_err(), "the unconfirmed guard attached anyway");
        loop {
            let event = rx.recv().await.unwrap();
            if event["type"] == "closed" {
                break;
            }
        }
        let ran = invocations(&home);
        assert!(
            ran.iter().all(|line| line != "--session scripted"),
            "fell back to an ordinary attach: {ran:?}"
        );
    }

    #[tokio::test]
    async fn a_local_herdr_without_the_guard_stays_an_ordinary_attach() {
        // Stock Herdr rejects the unknown `api guarded` subcommand.
        let script = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/invocations\"\ncase \"$*\" in\n  *\"api guarded\"*) cat >/dev/null; echo 'unknown subcommand' >&2; exit 2;;\nesac\nprintf 'ORDINARY_SCREEN\\n'; exec sleep 30\n";
        let (home, state, connected, mut rx, lease) = attach_scripted(script).await;
        let id = connected.unwrap();
        desktop::adopt(&state, &id, &lease).unwrap();
        until(&mut rx, "ORDINARY_SCREEN").await;
        let (_directory, app) = app_state();
        let status = guard(&app, &state, &id, &lease, json!({"kind":"status"})).await;
        assert_eq!(status.unwrap()["available"], false);
        assert!(invocations(&home)
            .iter()
            .any(|line| line == "--session scripted"));
        desktop::disconnect(&state, &id);
    }

    fn source(selector: &str) -> serde_json::Value {
        json!({"agent":"hermes","path":"/owned/{literal}<transcript>","view":"records","inlineImages":false,"transcriptSessionId":selector})
    }
    async fn captured(path: &std::path::Path, expected: &[u8]) {
        eventually("the guarded input never reached the pane", || {
            let bytes = std::fs::read(path).unwrap_or_default();
            assert!(
                bytes.len() <= expected.len(),
                "extra or repeated input reached the pane"
            );
            (bytes == expected).then_some(())
        })
        .await;
    }

    #[tokio::test]
    #[ignore = "requires LAZYSH_TEST_HERDR built from the guarded source; runs an isolated Herdr server and a local PTY"]
    async fn guarded_herdr_input_on_a_local_pty_reaches_only_the_confirmed_pane() {
        let binary =
            std::path::PathBuf::from(std::env::var("LAZYSH_TEST_HERDR").expect("guarded Herdr"));
        let home = Isolated::new().with_herdr(&binary);
        std::fs::write(
            home.temp.path().join("config.toml"),
            "onboarding = false\n[terminal]\ndefault_shell = '/bin/sh'\nshell_mode = 'non_login'\n[update]\nversion_check = false\nmanifest_check = false\n",
        )
        .unwrap();
        let state = home.state();
        // A Unix socket path holds at most 107 bytes, and these live in the home directory.
        let name = unique("g")[..9].to_owned();
        let herdr = |args: &[&str]| {
            let mut command = home.command("herdr");
            command.args(["--session", &name]).args(args);
            command
        };
        // An owned server with one workspace that the terminal then attaches to.
        // Stops the owned server and its panes when the test ends, including by a failed assertion.
        struct Server(std::process::Child, Command);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.1.output();
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let _server = Server(
            herdr(&["server"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
            herdr(&["server", "stop"]),
        );
        eventually("the owned Herdr server never answered", || {
            herdr(&["api", "snapshot"])
                .output()
                .unwrap()
                .status
                .success()
                .then_some(())
        })
        .await;
        let directory = home.temp.path().to_str().unwrap();
        text(&mut herdr(&[
            "workspace",
            "create",
            "--label",
            "GUARD_LOCAL",
            "--cwd",
            directory,
        ]));
        let (id, mut rx, lease) = attach(&state, json!({"kind":"herdr","name":name})).await;
        let shown = until(&mut rx, "GUARD_LOCAL").await;
        // The private first frame never reaches the terminal.
        assert!(!shown.contains("LAZYSH-GUARD-1"), "{shown}");
        let (_directory, app) = app_state();
        let guard = |action| guard(&app, &state, &id, &lease, action);
        assert_eq!(
            guard(json!({"kind":"status"})).await.unwrap()["available"],
            true
        );
        let context = source("A{literal}<selector>");
        let inspected = guard(json!({"kind":"prepare","source":context}))
            .await
            .unwrap();
        let pane = inspected["destination"]["pane"].as_str().unwrap();
        // The pane runs a process that records the bytes it receives.
        let bytes = home.temp.path().join("input-bytes");
        let pid = home.temp.path().join("input-pid");
        let quote = |path: &std::path::Path| crate::ssh::quote(path.to_str().unwrap());
        let script = format!(
            "stty raw -echo; echo $$ > {}; exec cat > {}",
            quote(&pid),
            quote(&bytes)
        );
        let command = format!("sh -c {}", crate::ssh::quote(&script));
        text(&mut herdr(&["pane", "run", pane, &command]));
        eventually("the pane process never started", || {
            pid.exists().then_some(())
        })
        .await;
        let prepared = guard(json!({"kind":"prepare","source":context}))
            .await
            .unwrap();
        let bound =
            guard(json!({"kind":"confirm","candidate":prepared["candidate"],"source":context}))
                .await
                .unwrap();
        assert_eq!(
            bound["destination"]["pane"],
            inspected["destination"]["pane"]
        );
        let text_in = "literal{safe}<text>\nsecond\t";
        guard(
            json!({"kind":"input","receipt":bound["receipt"],"source":context,"operation":1,
            "input":{"kind":"send","text":text_in}}),
        )
        .await
        .unwrap();
        let mut expected = format!("{text_in}\r").into_bytes();
        captured(&bytes, &expected).await;
        let input = |receipt: &serde_json::Value, operation: u32, input: serde_json::Value| {
            guard(
                json!({"kind":"input","receipt":receipt,"source":context,"operation":operation,"input":input}),
            )
        };
        // A dialog answer has no guard input and never reaches the pane.
        assert!(input(&bound["receipt"], 2, json!({"kind":"cycle_mode"}))
            .await
            .is_err());
        input(&bound["receipt"], 2, json!({"kind":"request_stop"}))
            .await
            .unwrap();
        expected.push(0x1b);
        captured(&bytes, &expected).await;
        // A spent operation number is refused, and that refusal retires the receipt.
        assert!(input(&bound["receipt"], 2, json!({"kind":"request_stop"}))
            .await
            .is_err());
        assert!(input(&bound["receipt"], 3, json!({"kind":"request_stop"}))
            .await
            .is_err());
        captured(&bytes, &expected).await;
        // A released receipt delivers nothing either.
        let prepared = guard(json!({"kind":"prepare","source":context}))
            .await
            .unwrap();
        let fresh =
            guard(json!({"kind":"confirm","candidate":prepared["candidate"],"source":context}))
                .await
                .unwrap();
        guard(json!({"kind":"release","receipt":fresh["receipt"]}))
            .await
            .unwrap();
        assert!(input(&fresh["receipt"], 1, json!({"kind":"request_stop"}))
            .await
            .is_err());
        captured(&bytes, &expected).await;
        guard_ends_with_the_terminal(&app, &state, &id, &lease).await;
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
