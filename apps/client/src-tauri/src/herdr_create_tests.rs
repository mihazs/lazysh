use super::*;
use futures_util::FutureExt;
use std::collections::VecDeque;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::process::Command;

/// Runs each step exactly as the SSH exec channel would: the login shell gets
/// `-c <script>`.
#[cfg(unix)]
struct Local<F: Fn(&mut Command)> {
    login: Vec<String>,
    configure: F,
}
#[cfg(unix)]
fn sh<F: Fn(&mut Command)>(configure: F) -> Local<F> {
    Local {
        login: args(&["/bin/sh"]),
        configure,
    }
}
#[cfg(unix)]
impl<F: Fn(&mut Command)> Remote for Local<F> {
    async fn run(&mut self, argv: &[String], _timeout: Duration) -> Result<Output> {
        let mut command = Command::new(&self.login[0]);
        (self.configure)(&mut command);
        let output = command
            .args(&self.login[1..])
            .arg("-c")
            .arg(script(argv))
            .output()?;
        assert!(
            output.status.success(),
            "wrapper must always exit 0 under {:?}: {}",
            self.login,
            String::from_utf8_lossy(&output.stderr)
        );
        parse_status(&String::from_utf8(output.stdout).unwrap())
    }
}
#[cfg(unix)]
fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}
/// `/bin/sh` plus every installed bash, zsh and fish, invoked as sshd invokes a
/// login shell (`<shell> -c <command>`), without user startup files. Fish is
/// skipped explicitly when absent, unless `LAZYSH_REQUIRE_FISH` is set (CI).
#[cfg(unix)]
pub(crate) fn login_shells() -> Vec<Vec<String>> {
    let mut shells = vec![args(&["/bin/sh"])];
    for (name, flags) in [
        ("bash", &["--norc"][..]),
        ("zsh", &["-f"]),
        ("fish", &["--no-config"]),
    ] {
        match on_path(name) {
            Some(path) => {
                let mut login = vec![path.to_string_lossy().into_owned()];
                login.extend(args(flags));
                shells.push(login);
            }
            None if name == "fish" && std::env::var_os("LAZYSH_REQUIRE_FISH").is_some() => {
                panic!("LAZYSH_REQUIRE_FISH is set but fish is not on PATH")
            }
            None => eprintln!("skipping the {name} login shell: not installed"),
        }
    }
    shells
}
/// Scripted replies; records every argv it receives.
#[derive(Default)]
struct Scripted {
    replies: VecDeque<(i32, String)>,
    calls: Vec<Vec<String>>,
}
impl Remote for Scripted {
    async fn run(&mut self, argv: &[String], _timeout: Duration) -> Result<Output> {
        self.calls.push(argv.to_vec());
        let (status, text) = self.replies.pop_front().expect("unexpected remote step");
        Ok(Output { status, text })
    }
}
fn now<T>(future: impl std::future::Future<Output = T>) -> T {
    future
        .now_or_never()
        .expect("test remote completes synchronously")
}
fn request(value: serde_json::Value) -> CreateRequest {
    serde_json::from_value(value).unwrap()
}
const CREATED: &str = r#"{"id":"cli:workspace:create","result":{"type":"workspace_created","workspace":{"workspace_id":"w7"},"tab":{"tab_id":"w7:t1"},"root_pane":{"pane_id":"w7:p1"}}}"#;
fn worktree_request(agent: serde_json::Value) -> CreateRequest {
    request(serde_json::json!({
        "target":{"type":"worktree","repository":"/srv/repo","branch":"feat/x","base":"main","path":"/srv/repo-worktrees/feat-x"},
        "agent":agent,
    }))
}

#[test]
fn plan_shows_exact_quoted_argv_for_hostile_literals() {
    let plan = herdr_workspace_plan(
        "s'$(x)".into(),
        request(serde_json::json!({
            "target":{"type":"directory","label":"a;$(touch nope)'","directory":"/srv/it's here"},
            "agent":{"kind":"claude","name":"claude-1a2b","prompt":"say 'hi' $(id)"},
        })),
    )
    .unwrap();
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|s| (s.stage, s.command.as_str()))
        .collect();
    assert_eq!(
        commands,
        [
            ("agentCheck", "'command' '-v' '--' 'claude'"),
            ("workspace", "'herdr' '--session' 's'\\''$(x)' 'workspace' 'create' '--no-focus' '--label' 'a;$(touch nope)'\\''' '--cwd' '/srv/it'\\''s here'"),
            ("agent", "'herdr' '--session' 's'\\''$(x)' 'agent' 'start' 'claude-1a2b' '--kind' 'claude' '--pane' '<new-workspace-pane>' '--timeout' '60000' '--' 'say '\\''hi'\\'' $(id)'"),
        ]
    );
    assert_eq!(plan.steps[1].argv[7], "a;$(touch nope)'");
}

#[test]
fn rejects_hostile_or_invalid_branches_paths_and_agent_fields() {
    for name in [
        "",
        "-x",
        "--force",
        "HEAD",
        "@",
        "a..b",
        "a b",
        "a~1",
        "a^",
        "a:b",
        "a?",
        "a*",
        "a[",
        "a\\b",
        "a/",
        "/a",
        "a//b",
        ".a",
        "a/.b",
        "a.lock",
        "a/b.lock/c",
        "a@{1}",
        "a.",
        "a\nb",
        "a\tb",
        "a\u{7f}",
    ] {
        assert!(branch(name).is_err(), "accepted branch {name:?}");
    }
    for name in [
        "main",
        "feat/x",
        "fix/ssh-host_binding.2",
        "$(touch${IFS}x)",
        "a@b",
        "ü",
    ] {
        assert!(branch(name).is_ok(), "rejected branch {name:?}");
    }
    assert!(branch(&"a".repeat(201)).is_err());
    for path in [
        "", "relative", "./x", "/a/../b", "/a/./b", "/a\nb", "/a\\b", " ",
    ] {
        assert!(absolute_path(path).is_err(), "accepted path {path:?}");
    }
    for revision in ["-b", "--orphan", "a b", "", "x\n"] {
        assert!(base(revision).is_err(), "accepted base {revision:?}");
    }
    for agent in [
        serde_json::json!({"kind":"bash","name":"bash-1"}),
        serde_json::json!({"kind":"codex","name":"Codex"}),
        serde_json::json!({"kind":"codex","name":"codex 1"}),
        serde_json::json!({"kind":"codex","name":"x".repeat(33)}),
        serde_json::json!({"kind":"codex","name":"codex-1","prompt":"-p"}),
        serde_json::json!({"kind":"codex","name":"codex-1","prompt":"two\nlines"}),
        serde_json::json!({"kind":"codex","name":"codex-1","prompt":"back\\slash"}),
        serde_json::json!({"kind":"opencode","name":"opencode-1","prompt":"no argv prompt"}),
    ] {
        assert!(
            herdr_workspace_plan("default".into(), worktree_request(agent.clone())).is_err(),
            "accepted {agent}"
        );
    }
    assert!(serde_json::from_value::<CreateRequest>(serde_json::json!({
        "target":{"type":"directory","label":"x","directory":"/x","command":"rm -rf /"}
    }))
    .is_err());
}

#[cfg(unix)]
#[test]
fn wrapper_preserves_literal_argv_and_status_through_real_sh() {
    let hostile = "a'b $(touch nope) `id` \"q\" ; | &".to_owned();
    let dir = tempfile::tempdir().unwrap();
    let mut local = sh(|c: &mut Command| {
        c.current_dir(dir.path());
    });
    let out = now(local.run(
        &["printf".into(), "%s|".into(), hostile.clone()],
        Duration::ZERO,
    ))
    .unwrap();
    assert_eq!(
        (out.status, out.text.as_str()),
        (0, format!("{hostile}|").as_str())
    );
    let out = now(local.run(
        &["sh".into(), "-c".into(), "echo bad >&2; exit 3".into()],
        Duration::ZERO,
    ))
    .unwrap();
    assert_eq!((out.status, out.text.as_str()), (3, "bad\n"));
    assert!(!dir.path().join("nope").exists());
    assert!(parse_status("no marker").is_err());
}

/// Values a hostile host directory name, branch or prompt could carry. The
/// fish cases broke out of POSIX `'\''` quoting nested inside `sh -c '…'`.
#[cfg(unix)]
const HOSTILE: &[&str] = &[
    "a' ; touch INJECTED1 ; '",
    "a'; touch INJECTED3 #",
    "it's",
    "$(touch INJECTED4)",
    "`touch INJECTED5`",
    "\\'",
    "\\\\'\\",
    "back\\slash",
    "\"q\" $HOME ~ * ? [a] {b,c} (d) %self $status",
    "; | & < > ! #",
    "two\nlines",
    "",
];

#[cfg(unix)]
#[test]
fn login_shells_read_each_argv_word_literally() {
    for login in login_shells() {
        let home = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut local = Local {
            login: login.clone(),
            configure: |c: &mut Command| {
                c.current_dir(dir.path()).env("HOME", home.path());
            },
        };
        let mut argv = args(&["printf", "%s|"]);
        argv.extend(args(HOSTILE));
        let out = now(local.run(&argv, Duration::ZERO)).unwrap();
        let expected: String = HOSTILE.iter().map(|v| format!("{v}|")).collect();
        assert_eq!(
            (out.status, out.text.as_str()),
            (0, expected.as_str()),
            "{login:?}"
        );
        let created: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert!(created.is_empty(), "{login:?} created {created:?}");
    }
}

/// The worktree step succeeded and the workspace step failed: report, never roll back.
fn kept_worktree_after_workspace_failure(remote: &mut impl Remote, message: &str) {
    let outcome = now(execute(
        remote,
        &Host::Herdr("default"),
        &worktree_request(serde_json::Value::Null),
    ))
    .unwrap();
    assert_eq!(
        outcome.worktree.as_deref(),
        Some("/srv/repo-worktrees/feat-x")
    );
    assert_eq!(
        outcome.failure,
        Some(Failure {
            stage: "workspace",
            message: message.into()
        })
    );
}

#[test]
fn reports_partial_success_without_rolling_back() {
    // First-step failure: nothing exists, so it is an error.
    let mut remote = Scripted {
        replies: [(
            128,
            "fatal: a branch named 'feat/x' already exists\n".into(),
        )]
        .into(),
        ..Default::default()
    };
    let error = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &worktree_request(serde_json::Value::Null),
    ))
    .unwrap_err();
    assert_eq!(
        serde_json::to_value(&error).unwrap()["message"],
        "fatal: a branch named 'feat/x' already exists"
    );
    assert_eq!(remote.calls.len(), 1);

    // Worktree kept when the workspace step fails.
    let mut remote = Scripted {
        replies: [
            (0, String::new()),
            (
                1,
                r#"{"error":{"code":"server_not_running","message":"no server"}}"#.into(),
            ),
        ]
        .into(),
        ..Default::default()
    };
    kept_worktree_after_workspace_failure(&mut remote, "server_not_running: no server");
    assert_eq!(
        remote.calls[0],
        args(&[
            "git",
            "-C",
            "/srv/repo",
            "worktree",
            "add",
            "-b",
            "feat/x",
            "--",
            "/srv/repo-worktrees/feat-x",
            "main"
        ])
    );

    // A missing agent binary fails first, before any worktree or workspace exists.
    let mut remote = Scripted {
        replies: [(1, String::new())].into(),
        ..Default::default()
    };
    let error = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &worktree_request(serde_json::json!({"kind":"codex","name":"codex-a1"})),
    ))
    .unwrap_err();
    assert_eq!(
        serde_json::to_value(&error).unwrap()["message"],
        "codex was not found on the host PATH (command -v)"
    );
    assert_eq!(remote.calls, [args(&["command", "-v", "--", "codex"])]);

    // A failing worktree step after a passing agent check still created nothing.
    let mut remote = Scripted {
        replies: [
            (0, "/usr/bin/codex\n".into()),
            (128, "fatal: invalid reference: main\n".into()),
        ]
        .into(),
        ..Default::default()
    };
    assert!(now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &worktree_request(serde_json::json!({"kind":"codex","name":"codex-a1"})),
    ))
    .is_err());

    // The agent starts in the created root pane, and Herdr errors stay readable.
    let mut remote = Scripted {
        replies: [
            (0, "/usr/bin/codex\n".into()),
            (0, String::new()),
            (0, CREATED.into()),
            (
                1,
                format!(
                    "{{\"error\":{{\"code\":\"timeout\",\"message\":\"{}\"}}}}",
                    "x".repeat(5000)
                ),
            ),
        ]
        .into(),
        ..Default::default()
    };
    let outcome = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &worktree_request(serde_json::json!({"kind":"codex","name":"codex-a1","prompt":"go"})),
    ))
    .unwrap();
    assert_eq!(remote.calls[3][9], "w7:p1");
    assert_eq!(
        remote.calls[3][10..],
        args(&["--timeout", "60000", "--", "go"])
    );
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.stage, "agent");
    assert!(
        failure.message.starts_with("timeout: xxx")
            && failure.message.chars().count() == MESSAGE_LIMIT + 1
    );
    assert_eq!(outcome.pane_id.as_deref(), Some("w7:p1"));

    // A transport loss after the worktree exists is a reported partial result.
    struct Lost(Scripted);
    impl Remote for Lost {
        async fn run(&mut self, argv: &[String], timeout: Duration) -> Result<Output> {
            if self.0.replies.is_empty() {
                return Err(SshError::new("disconnected", "Session closed"));
            }
            self.0.run(argv, timeout).await
        }
    }
    let mut remote = Lost(Scripted {
        replies: [(0, String::new())].into(),
        ..Default::default()
    });
    kept_worktree_after_workspace_failure(&mut remote, "Session closed");

    // A workspace reply with inconsistent identity is not trusted.
    let mut remote = Scripted {
        replies: [(0, CREATED.replace("w7:p1", "w8:p1"))].into(),
        ..Default::default()
    };
    let directory =
        request(serde_json::json!({"target":{"type":"directory","label":"x","directory":"/x"}}));
    assert!(now(execute(&mut remote, &Host::Herdr("default"), &directory)).is_err());
}

#[cfg(unix)]
#[test]
fn agent_detection_marks_only_executables_found_by_command_v_as_installed() {
    let dir = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink("/bin/sh", dir.path().join("sh")).unwrap();
    for name in ["codex", "cursor-agent"] {
        let path = dir.path().join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
    }
    std::fs::write(dir.path().join("claude"), "not executable").unwrap();
    for login in login_shells() {
        let mut local = Local {
            login: login.clone(),
            configure: |c: &mut Command| {
                c.env_clear()
                    .env("PATH", dir.path())
                    .env("HOME", dir.path());
            },
        };
        let kinds = now(agent_kinds(&mut local)).unwrap();
        let found: Vec<_> = kinds
            .iter()
            .filter(|k| k.installed)
            .map(|k| (k.kind, k.executable, k.prompt))
            .collect();
        assert_eq!(
            found,
            [("codex", "codex", true), ("cursor", "cursor-agent", false)],
            "{login:?}"
        );
        // Every supported agent is listed, so the launcher can show the missing ones as unavailable.
        assert_eq!(kinds.len(), AGENTS.len(), "{login:?}");
        assert!(kinds.iter().any(|k| k.kind == "claude" && !k.installed));
    }
}

#[test]
fn bounded_keeps_host_text_but_strips_controls() {
    assert_eq!(bounded("  a\u{1b}[31mb\nc\r "), "a [31mb\nc");
}

fn entry(value: serde_json::Value) -> Entry {
    serde_json::from_value(value).unwrap()
}
/// A directory launch whose label, directory and prompt carry what tmux, Zellij
/// and the shell each treat specially.
fn hostile_launch() -> CreateRequest {
    request(serde_json::json!({
        "target":{"type":"directory","label":"a#{x};","directory":"/srv/it's #{y};"},
        "agent":{"kind":"claude","name":"claude-1a2b","prompt":"say 'hi'\n$(id);"},
    }))
}
fn plan_of(
    multiplexer: serde_json::Value,
    request: CreateRequest,
) -> Result<Vec<(&'static str, Vec<String>)>> {
    let plan = multiplexer_launch_plan(entry(multiplexer), request)?;
    Ok(plan.steps.into_iter().map(|s| (s.stage, s.argv)).collect())
}

#[test]
fn tmux_and_zellij_plans_run_the_agent_argv_with_every_hostile_literal_intact() {
    let tmux = plan_of(
        serde_json::json!({"kind":"tmux","name":"s 'q;","tmuxServer":"srv"}),
        hostile_launch(),
    )
    .unwrap();
    assert_eq!(
        tmux,
        [
            ("agentCheck", args(&["command", "-v", "--", "claude"])),
            ("folderCheck", args(&["test", "-d", "/srv/it's #{y};"])),
            (
                "window",
                args(&[
                    "tmux",
                    "-u",
                    "-L",
                    "srv",
                    "new-window",
                    "-P",
                    "-F",
                    "#{pane_id}",
                    "-t",
                    "=s 'q;:",
                    "-n",
                    "a##{x}\\;",
                    "-c",
                    "/srv/it's ##{y}\\;",
                    "--",
                    "claude",
                    "say 'hi'\n$(id)\\;",
                ])
            ),
        ]
    );
    let zellij = multiplexer_launch_plan(
        entry(serde_json::json!({"kind":"zellij","name":"s 'q;"})),
        hostile_launch(),
    )
    .unwrap();
    assert_eq!(
        zellij.steps[2].argv,
        args(&[
            "zellij",
            "--session=s 'q;",
            "run",
            "--cwd=/srv/it's #{y};",
            "--name=a#{x};",
            "--",
            "claude",
            "say 'hi'\n$(id);",
        ])
    );
    // The plan shows the argv exactly as it is sent.
    assert_eq!(
        zellij.steps[2].command,
        "'zellij' '--session=s '\\''q;' 'run' '--cwd=/srv/it'\\''s #{y};' '--name=a#{x};' '--' 'claude' 'say '\\''hi'\\''\n$(id);'"
    );
    // The default tmux server is named, never implied.
    let default = plan_of(
        serde_json::json!({"kind":"tmux","name":"w"}),
        hostile_launch(),
    )
    .unwrap();
    assert_eq!(default[2].1[..4], args(&["tmux", "-u", "-L", "default"]));
}

#[test]
fn a_worktree_launch_creates_the_worktree_before_the_window_or_pane() {
    for (multiplexer, stage) in [
        (serde_json::json!({"kind":"tmux","name":"w"}), "window"),
        (serde_json::json!({"kind":"zellij","name":"w"}), "pane"),
    ] {
        let steps = plan_of(
            multiplexer,
            worktree_request(serde_json::json!({"kind":"codex","name":"codex-a1"})),
        )
        .unwrap();
        let stages: Vec<_> = steps.iter().map(|s| s.0).collect();
        assert_eq!(stages, ["agentCheck", "worktree", stage]);
        // The agent starts in the new worktree, labelled with its branch.
        assert!(steps[2]
            .1
            .iter()
            .any(|a| a.contains("/srv/repo-worktrees/feat-x")));
        assert!(steps[2].1.iter().any(|a| a.contains("feat/x")));
    }
}

#[test]
fn a_launch_needs_an_agent_an_existing_session_and_a_valid_prompt() {
    let bare =
        || request(serde_json::json!({"target":{"type":"directory","label":"x","directory":"/x"}}));
    for kind in ["tmux", "zellij"] {
        let error = plan_of(serde_json::json!({"kind":kind,"name":"w"}), bare()).unwrap_err();
        assert_eq!(error.message(), "Choose an agent to start", "{kind}");
        let creating = plan_of(
            serde_json::json!({"kind":kind,"name":"w","createIfMissing":true}),
            hostile_launch(),
        )
        .unwrap_err();
        assert_eq!(
            creating.message(),
            "Start agents in an existing multiplexer session"
        );
        assert!(plan_of(
            serde_json::json!({"kind":kind,"name":"w"}),
            hostile_launch()
        )
        .is_ok());
    }
    assert!(plan_of(
        serde_json::json!({"kind":"zellij","name":"--x"}),
        hostile_launch()
    )
    .is_err());
    assert!(plan_of(
        serde_json::json!({"kind":"tmux","name":"w","tmuxServer":"a/b"}),
        hostile_launch()
    )
    .is_err());
    let prompted = |kind: &str, prompt: &str| {
        plan_of(
            serde_json::json!({"kind":"tmux","name":"w"}),
            request(serde_json::json!({
                "target":{"type":"directory","label":"x","directory":"/x"},
                "agent":{"kind":kind,"name":"agent-1","prompt":prompt},
            })),
        )
    };
    // Line breaks and tabs reach the agent verbatim; other controls, a backslash, an
    // option-like prompt and a CLI without an initial prompt are refused.
    assert!(prompted("codex", "one\n\ttwo").is_ok());
    for (kind, prompt) in [
        ("codex", "bell\u{7}"),
        ("codex", "back\\slash"),
        ("codex", "-p"),
        ("codex", &"x".repeat(2001)),
        ("opencode", "no argv prompt"),
    ] {
        assert!(
            prompted(kind, prompt).is_err(),
            "{kind} accepted {prompt:?}"
        );
    }
    // Herdr's `agent start` still takes one line.
    let multiline = request(serde_json::json!({
        "target":{"type":"directory","label":"x","directory":"/x"},
        "agent":{"kind":"codex","name":"agent-1","prompt":"two\nlines"},
    }));
    assert!(herdr_workspace_plan("default".into(), multiline).is_err());
}

/// A directory launch with `create` set or not, for the folder-step tests.
fn folder_launch(create: bool) -> CreateRequest {
    request(serde_json::json!({
        "target":{"type":"directory","label":"x","directory":"/srv/new 'dir","create":create},
        "agent":{"kind":"codex","name":"codex-a1"},
    }))
}

#[test]
fn a_new_folder_is_created_and_an_existing_one_is_checked_before_anything_starts() {
    let stages = |multiplexer: &serde_json::Value, create| {
        let plan = plan_of(multiplexer.clone(), folder_launch(create)).unwrap();
        plan.iter().map(|(stage, _)| *stage).collect::<Vec<_>>()
    };
    for (kind, last) in [("tmux", "window"), ("zellij", "pane")] {
        let multiplexer = serde_json::json!({"kind":kind,"name":"w"});
        // mkdir -p replaces the check: a folder that is about to be created needs none.
        assert_eq!(
            stages(&multiplexer, true),
            ["agentCheck", "folder", last],
            "{kind}"
        );
        assert_eq!(
            stages(&multiplexer, false),
            ["agentCheck", "folderCheck", last],
            "{kind}"
        );
        let plan = plan_of(multiplexer, folder_launch(true)).unwrap();
        assert_eq!(plan[1].1, args(&["mkdir", "-p", "--", "/srv/new 'dir"]));
    }
    // Herdr's plan keeps its shape unless a folder is created, and a worktree creates its own path.
    let herdr = |create| -> Vec<&'static str> {
        herdr_workspace_plan("default".into(), folder_launch(create))
            .unwrap()
            .steps
            .iter()
            .map(|s| s.stage)
            .collect()
    };
    assert_eq!(herdr(false), ["agentCheck", "workspace", "agent"]);
    assert_eq!(herdr(true), ["agentCheck", "folder", "workspace", "agent"]);
    let worktree = plan_of(
        serde_json::json!({"kind":"tmux","name":"w"}),
        worktree_request(serde_json::json!({"kind":"codex","name":"codex-a1"})),
    )
    .unwrap();
    assert_eq!(
        worktree.iter().map(|s| s.0).collect::<Vec<_>>(),
        ["agentCheck", "worktree", "window"]
    );
    // A relative or traversing path is refused whether it is created or not.
    for directory in ["relative", "/srv/../etc", "/srv/./x"] {
        let bad = request(serde_json::json!({
            "target":{"type":"directory","label":"x","directory":directory,"create":true},
            "agent":{"kind":"codex","name":"codex-a1"},
        }));
        assert!(
            plan_of(serde_json::json!({"kind":"tmux","name":"w"}), bad).is_err(),
            "{directory}"
        );
    }
}

#[test]
fn a_missing_existing_folder_stops_a_launch_and_a_created_folder_is_kept_when_the_pane_fails() {
    for host in [Host::Tmux("w", TmuxServer::default()), Host::Zellij("w")] {
        // `test -d` fails: nothing was created, and tmux would otherwise start in another directory.
        let mut remote = Scripted {
            replies: [(0, "/usr/bin/codex\n".into()), (1, String::new())].into(),
            ..Default::default()
        };
        let error = now(execute(&mut remote, &host, &folder_launch(false))).unwrap_err();
        assert_eq!(error.message(), "/srv/new 'dir is not a folder on the host");
        assert_eq!(remote.calls.len(), 2);
        // The folder was created and the window or pane failed: reported with what exists.
        let mut remote = Scripted {
            replies: [
                (0, "/usr/bin/codex\n".into()),
                (0, String::new()),
                (1, "no space left\n".into()),
            ]
            .into(),
            ..Default::default()
        };
        let outcome = now(execute(&mut remote, &host, &folder_launch(true))).unwrap();
        assert_eq!(outcome.folder.as_deref(), Some("/srv/new 'dir"));
        assert_eq!(outcome.pane_id, None);
        assert_eq!(
            outcome.failure.map(|f| (f.stage, f.message)),
            Some((
                if matches!(host, Host::Tmux(..)) {
                    "window"
                } else {
                    "pane"
                },
                "no space left".to_owned()
            ))
        );
    }
}

#[test]
fn a_launch_binds_to_the_named_tmux_server_and_session() {
    let named = entry(serde_json::json!({"kind":"tmux","name":"w","tmuxServer":"srv"}));
    assert!(matches!(
        Host::of(&named, None).unwrap(),
        Host::Tmux("w", ref server) if server.argv()[3] == "srv"
    ));
    let herdr = entry(serde_json::json!({"kind":"herdr","name":"w"}));
    assert!(matches!(Host::of(&herdr, None).unwrap(), Host::Herdr("w")));
    assert!(Host::of(
        &entry(serde_json::json!({"kind":"herdr","name":"../x"})),
        None
    )
    .is_err());
}

#[test]
fn a_missing_agent_refuses_a_tmux_or_zellij_launch_before_anything_is_created() {
    for host in [Host::Tmux("w", TmuxServer::default()), Host::Zellij("w")] {
        let mut remote = Scripted {
            replies: [(1, String::new())].into(),
            ..Default::default()
        };
        let error = now(execute(
            &mut remote,
            &host,
            &worktree_request(serde_json::json!({"kind":"codex","name":"codex-a1"})),
        ))
        .unwrap_err();
        assert_eq!(
            error.message(),
            "codex was not found on the host PATH (command -v)"
        );
        // No worktree, window or pane step ran.
        assert_eq!(remote.calls, [args(&["command", "-v", "--", "codex"])]);
    }
}

#[test]
fn a_launch_reports_the_new_pane_and_keeps_what_it_created_when_the_pane_fails() {
    // The agent check and the worktree pass; the window or pane step prints `reply`.
    let after_worktree = |reply: &str| Scripted {
        replies: [
            (0, "/usr/bin/codex\n".into()),
            (0, String::new()),
            (0, reply.into()),
        ]
        .into(),
        ..Default::default()
    };
    let agent = || serde_json::json!({"kind":"codex","name":"codex-a1","prompt":"go"});
    for (host, reply, pane) in [
        (
            Host::Tmux("w", TmuxServer::default()),
            "warning\n%12\n",
            "%12",
        ),
        (Host::Zellij("w"), "terminal_3\n", "terminal_3"),
    ] {
        let mut remote = after_worktree(reply);
        let outcome = now(execute(&mut remote, &host, &worktree_request(agent()))).unwrap();
        assert_eq!(outcome.failure, None);
        assert_eq!(
            (
                outcome.worktree.as_deref(),
                outcome.pane_id.as_deref(),
                outcome.agent.as_deref()
            ),
            (
                Some("/srv/repo-worktrees/feat-x"),
                Some(pane),
                Some("codex-a1")
            )
        );
        assert_eq!(
            remote.calls[2][remote.calls[2].len() - 2..],
            args(&["codex", "go"])
        );
    }
    // An unreadable reply is a failure of the pane stage after the worktree, never trusted.
    for reply in ["", "%", "%1x", "12", "terminal_1", "%99999999999999999999"] {
        let mut remote = after_worktree(reply);
        let outcome = now(execute(
            &mut remote,
            &Host::Tmux("w", TmuxServer::default()),
            &worktree_request(agent()),
        ))
        .unwrap();
        assert_eq!(
            outcome.failure.map(|f| f.stage),
            Some("window"),
            "{reply:?}"
        );
        assert_eq!(
            outcome.worktree.as_deref(),
            Some("/srv/repo-worktrees/feat-x")
        );
        assert_eq!(outcome.pane_id, None);
    }
    // With nothing created yet, a tmux or Zellij error is the call's error.
    let directory = || {
        request(serde_json::json!({
            "target":{"type":"directory","label":"x","directory":"/x"},
            "agent":{"kind":"codex","name":"codex-a1"},
        }))
    };
    for host in [Host::Tmux("w", TmuxServer::default()), Host::Zellij("w")] {
        let mut remote = Scripted {
            replies: [
                (0, "/usr/bin/codex\n".into()),
                (0, String::new()),
                (1, "can't find session: w\n".into()),
            ]
            .into(),
            ..Default::default()
        };
        let error = now(execute(&mut remote, &host, &directory())).unwrap_err();
        assert_eq!(error.message(), "can't find session: w");
    }
}

#[cfg(unix)]
#[test]
#[ignore = "requires git and herdr on PATH; runs an isolated headless server"]
fn real_herdr_worktree_workspace_and_agent() {
    use std::process::Stdio;
    // Herdr's socket path must fit sun_path, so keep the root short.
    let temp = tempfile::Builder::new()
        .prefix("lzh")
        .tempdir_in("/tmp")
        .unwrap();
    let root = temp.path().to_path_buf();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let marker = root.join("agent-started");
    let stub = bin.join("codex");
    // Prints Codex's composer so Herdr's managed start sees a ready agent.
    std::fs::write(
        &stub,
        "#!/bin/sh\n{ printf '%s\\n' \"$PWD\"; for a in \"$@\"; do printf 'arg:%s\\n' \"$a\"; done; } > \"$LAZYSH_STUB_OUT\"\nprintf '\\n\\342\\200\\272 Ask Codex to do anything\\n'\nwhile IFS= read -r line; do :; done\n",
    )
    .unwrap();
    std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let path = format!("{}:/usr/local/bin:/usr/bin:/bin", bin.display());
    let herdr = Command::new("sh")
        .args(["-c", "command -v herdr"])
        .output()
        .unwrap();
    let herdr_dir = std::path::Path::new(String::from_utf8(herdr.stdout).unwrap().trim())
        .parent()
        .unwrap()
        .to_path_buf();
    let path = format!("{path}:{}", herdr_dir.display());
    let configure = |command: &mut Command| {
        command
            .current_dir(&root)
            .env("HOME", &root)
            .env("ZDOTDIR", &root)
            .env("SHELL", "/bin/sh")
            .env("PATH", &path)
            .env("XDG_CONFIG_HOME", &root)
            .env("HERDR_CONFIG_PATH", root.join("config.toml"))
            .env("LAZYSH_STUB_OUT", &marker)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "lazysh")
            .env("GIT_AUTHOR_EMAIL", "lazysh@example.invalid")
            .env("GIT_COMMITTER_NAME", "lazysh")
            .env("GIT_COMMITTER_EMAIL", "lazysh@example.invalid")
            .env_remove("ENV")
            .env_remove("BASH_ENV")
            .env_remove("HERDR_SOCKET_PATH")
            .env_remove("HERDR_SESSION");
    };
    let mut server = Command::new("herdr");
    configure(&mut server);
    let server = server
        .arg("server")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _guard = Server(server);
    let mut remote = sh(configure);
    let shell = |remote: &mut Local<_>, text: &str| {
        let out = now(remote.run(&args(&["sh", "-c", text]), Duration::ZERO)).unwrap();
        assert_eq!(out.status, 0, "{text}: {}", out.text);
        out.text
    };
    let mut ready = false;
    for _ in 0..200 {
        if now(remote.run(&args(&["herdr", "api", "snapshot"]), Duration::ZERO))
            .unwrap()
            .status
            == 0
        {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(ready, "isolated Herdr server did not become ready");
    let snapshot = |remote: &mut Local<_>| -> serde_json::Value {
        serde_json::from_str(&shell(remote, "herdr --session default api snapshot")).unwrap()
    };
    let repo = root.join("repo");
    shell(
        &mut remote,
        &format!(
            "git init -q -b main {0} && mkdir {0}/sub && echo x > {0}/sub/f && git -C {0} add . && git -C {0} commit -qm init",
            quote(repo.to_str().unwrap())
        ),
    );
    let repo_text = repo.to_str().unwrap().to_owned();
    let info = now(repository(&mut remote, &format!("{repo_text}/sub"))).unwrap();
    assert_eq!(
        info,
        Repository {
            root: repo_text.clone(),
            main: repo_text.clone(),
            head: "main".into(),
            detached: false,
            worktrees: vec![repo_text.clone()],
        }
    );
    assert_eq!(
        now(repository(&mut remote, root.to_str().unwrap()))
            .unwrap_err()
            .kind(),
        "not_a_repository"
    );
    let kinds = now(agent_kinds(&mut remote)).unwrap();
    assert!(kinds.iter().any(|k| k.kind == "codex"), "{kinds:?}");

    // A hostile but valid branch name and prompt stay literal end to end.
    let branch_name = "feat/$(touch${IFS}pwned)'q";
    let worktree = format!("{repo_text}-worktrees/feat-$(touch${{IFS}}pwned)'q");
    let prompt = "review 'this' $(touch pwned2) `id`";
    let outcome = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &request(serde_json::json!({
            "target":{"type":"worktree","repository":repo_text,"branch":branch_name,"base":"main","path":worktree},
            "agent":{"kind":"codex","name":"codex-lazysh1","prompt":prompt},
        })),
    ))
    .unwrap();
    assert_eq!(outcome.failure, None, "{outcome:?}");
    assert_eq!(outcome.worktree.as_deref(), Some(worktree.as_str()));
    assert_eq!(outcome.agent.as_deref(), Some("codex-lazysh1"));
    let listed = shell(
        &mut remote,
        &format!("git -C {} worktree list --porcelain", quote(&repo_text)),
    );
    assert!(
        listed.contains(&format!("worktree {worktree}\n")),
        "{listed}"
    );
    assert!(
        listed.contains(&format!("branch refs/heads/{branch_name}\n")),
        "{listed}"
    );
    let tree = snapshot(&mut remote);
    let tree = &tree["result"]["snapshot"];
    let workspace = outcome.workspace_id.clone().unwrap();
    let pane = outcome.pane_id.clone().unwrap();
    assert!(tree["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w["workspace_id"] == workspace.as_str() && w["label"] == branch_name));
    assert!(tree["panes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["pane_id"] == pane.as_str() && p["cwd"] == worktree.as_str()));
    assert!(tree["agents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["pane_id"] == pane.as_str()
            && a["agent"] == "codex"
            && a["name"] == "codex-lazysh1"));
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        format!("{worktree}\narg:{prompt}\n")
    );
    for name in ["pwned", "pwned2"] {
        assert!(!root.join(name).exists() && !std::path::Path::new(&worktree).join(name).exists());
    }

    // A plain workspace without an agent, then a failing first step creates nothing.
    let plain = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &request(serde_json::json!({"target":{"type":"directory","label":"plain","directory":repo_text}})),
    ))
    .unwrap();
    assert!(plain.agent.is_none() && plain.failure.is_none() && plain.worktree.is_none());
    // A new folder is created, with its parents, before the workspace opens in it.
    let fresh = format!("{repo_text}-new/it's $(touch pwned3)/leaf");
    let folder = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &request(serde_json::json!({"target":{"type":"directory","label":"fresh","directory":fresh,"create":true}})),
    ))
    .unwrap();
    assert!(folder.failure.is_none() && folder.workspace_id.is_some());
    assert_eq!(folder.folder.as_deref(), Some(fresh.as_str()));
    assert!(std::path::Path::new(&fresh).is_dir());
    assert!(!root.join("pwned3").exists());
    let count = |remote: &mut Local<_>| {
        snapshot(remote)["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len()
    };
    let before = count(&mut remote);
    let duplicate = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &request(serde_json::json!({
            "target":{"type":"worktree","repository":repo_text,"branch":branch_name,"base":"main","path":format!("{repo_text}-worktrees/other")},
        })),
    ))
    .unwrap_err();
    assert!(serde_json::to_value(&duplicate).unwrap()["message"]
        .as_str()
        .unwrap()
        .contains("already exists"));
    assert_eq!(count(&mut remote), before);

    // An agent missing from PATH fails first: no worktree, branch or workspace.
    let kept = format!("{repo_text}-worktrees/kept");
    let missing = now(execute(
        &mut remote,
        &Host::Herdr("default"),
        &request(serde_json::json!({
            "target":{"type":"worktree","repository":repo_text,"branch":"kept","base":"HEAD","path":kept},
            "agent":{"kind":"maki","name":"maki-lazysh1"},
        })),
    ))
    .unwrap_err();
    assert!(serde_json::to_value(&missing).unwrap()["message"]
        .as_str()
        .unwrap()
        .starts_with("maki was not found"));
    assert!(!std::path::Path::new(&kept).exists());
    let branch_check = args(&[
        "git",
        "-C",
        &repo_text,
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/heads/kept",
    ]);
    assert_ne!(
        now(remote.run(&branch_check, Duration::ZERO))
            .unwrap()
            .status,
        0
    );
    assert_eq!(count(&mut remote), before);
    shell(&mut remote, "herdr --session default server stop");
}

/// A private root with a stub `codex` that records its directory and argv, shared by
/// the real tmux and Zellij launch tests. It is short because sockets must fit `sun_path`.
#[cfg(unix)]
struct AgentRoot(tempfile::TempDir);
#[cfg(unix)]
impl AgentRoot {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("lzh")
            .tempdir_in("/tmp")
            .unwrap();
        for name in ["bin", "records"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        let stub = dir.path().join("bin/codex");
        let records = quote(dir.path().join("records").to_str().unwrap());
        std::fs::write(
            &stub,
            format!("#!/bin/sh\nf=$(mktemp {records}/XXXXXX) || exit\nprintf '%s\\0' \"$(pwd -P)\" \"$@\" > \"$f\"\nexec sleep 3600\n"),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        Self(dir)
    }
    fn path(&self) -> &std::path::Path {
        self.0.path()
    }
    /// The one environment of the multiplexer server, the plan steps and the observers.
    fn configure(&self, command: &mut Command) {
        let tools: Vec<_> = ["tmux", "zellij"]
            .iter()
            .filter_map(|name| on_path(name)?.parent().map(|dir| dir.display().to_string()))
            .collect();
        let path = format!(
            "{}:{}:/usr/bin:/bin",
            self.path().join("bin").display(),
            tools.join(":")
        );
        let root = self.path();
        command
            .env_clear()
            .current_dir(root)
            .env("PATH", path)
            .env("HOME", root)
            .env("SHELL", "/bin/sh")
            .env("TERM", "xterm-256color")
            .env("TMUX_TMPDIR", root)
            .env("XDG_RUNTIME_DIR", root)
            .env("XDG_CACHE_HOME", root)
            .env("XDG_CONFIG_HOME", root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "lazysh")
            .env("GIT_AUTHOR_EMAIL", "lazysh@example.invalid")
            .env("GIT_COMMITTER_NAME", "lazysh")
            .env("GIT_COMMITTER_EMAIL", "lazysh@example.invalid");
    }
    /// Starts a background server with no output pipe the harness could wait on.
    fn start(&self, program: &str, arguments: &[&str]) {
        let mut command = Command::new(program);
        self.configure(&mut command);
        let status = command
            .args(arguments)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "{program} {arguments:?}");
    }
    /// What the stub recorded for the launch that ran in `directory`: its arguments.
    fn recorded(&self, directory: &str) -> Vec<String> {
        for _ in 0..400 {
            for entry in std::fs::read_dir(self.path().join("records")).unwrap() {
                let bytes = std::fs::read(entry.unwrap().path()).unwrap();
                let mut words: Vec<_> = bytes
                    .split(|byte| *byte == 0)
                    .map(|word| String::from_utf8(word.to_vec()).unwrap())
                    .collect();
                words.pop();
                if words.first().map(String::as_str) == Some(directory) {
                    return words.split_off(1);
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("the stub agent never recorded a launch in {directory}");
    }
}
/// Stops a private multiplexer server on drop, including after a failed assertion.
#[cfg(unix)]
struct Stop<'a>(&'a AgentRoot, &'static str, Vec<String>);
#[cfg(unix)]
impl Drop for Stop<'_> {
    fn drop(&mut self) {
        let mut command = Command::new(self.1);
        self.0.configure(&mut command);
        let _ = command.args(&self.2).output();
    }
}
#[cfg(unix)]
fn run_ok(remote: &mut impl Remote, argv: &[&str]) -> String {
    let out = now(remote.run(&args(argv), Duration::ZERO)).unwrap();
    assert_eq!(out.status, 0, "{argv:?}: {}", out.text);
    out.text
}

/// A directory launch and a worktree launch with hostile names start the stub in the
/// right directory with the prompt byte for byte; a missing agent or session creates nothing.
/// `panes` lists every `(pane id, directory)` of the session under test; `current`, when
/// the multiplexer follows a launch, the pane the session shows now.
#[cfg(unix)]
fn assert_agent_launches<R: Remote>(
    root: &AgentRoot,
    remote: &mut R,
    (host, gone): (&Host<'_>, &Host<'_>),
    panes: impl Fn(&mut R) -> Vec<(String, String)>,
    current: Option<&dyn Fn(&mut R) -> String>,
) {
    let repo = root.path().join("repo").to_str().unwrap().to_owned();
    run_ok(
        remote,
        &["sh", "-c", &format!("git init -q -b main {0} && echo x > {0}/f && git -C {0} add . && git -C {0} commit -qm init", quote(&repo))],
    );
    let directory = root.path().join("it's $(touch NO) #{x};");
    std::fs::create_dir(&directory).unwrap();
    let directory = directory.to_str().unwrap().to_owned();
    let prompt = "review 'this' $(touch pwned) `id`\nsecond line;";
    let started = panes(remote);
    let outcome = now(execute(
        remote,
        host,
        &request(serde_json::json!({
            "target":{"type":"directory","label":"lbl 'q #{x};","directory":directory},
            "agent":{"kind":"codex","name":"codex-lazysh1","prompt":prompt},
        })),
    ))
    .unwrap();
    assert_eq!(outcome.failure, None, "{outcome:?}");
    assert_eq!(root.recorded(&directory), [prompt]);
    let after = panes(remote);
    assert_eq!(after.len(), started.len() + 1, "{after:?}");
    let pane = outcome.pane_id.unwrap();
    assert!(
        after.contains(&(pane.clone(), directory.clone())),
        "{after:?}"
    );
    if let Some(current) = current {
        assert_eq!(current(remote), pane);
    }

    // A new folder, with the parents it needs, is created and the agent starts in it.
    let fresh = root.path().join("fresh $(touch NO2)/it's #{n};/leaf");
    let fresh = fresh.to_str().unwrap().to_owned();
    let created = |create| {
        request(serde_json::json!({
            "target":{"type":"directory","label":"new folder","directory":fresh,"create":create},
            "agent":{"kind":"codex","name":"codex-lazysh4","prompt":"hello"},
        }))
    };
    // Without `create` a missing folder stops the launch: tmux would start in another directory.
    let count = panes(remote).len();
    let missing = now(execute(remote, host, &created(false))).unwrap_err();
    assert_eq!(
        missing.message(),
        format!("{fresh} is not a folder on the host")
    );
    assert!(!std::path::Path::new(&fresh).exists());
    assert_eq!(panes(remote).len(), count);
    let outcome = now(execute(remote, host, &created(true))).unwrap();
    assert_eq!(outcome.failure, None, "{outcome:?}");
    assert_eq!(outcome.folder.as_deref(), Some(fresh.as_str()));
    assert!(std::path::Path::new(&fresh).is_dir());
    assert_eq!(root.recorded(&fresh), ["hello"]);
    assert!(panes(remote).contains(&(outcome.pane_id.unwrap(), fresh.clone())));

    let branch = "feat/$(touch${IFS}pwned)'q";
    let worktree = format!("{repo}-worktrees/feat-$(touch${{IFS}}pwned)'q");
    let outcome = now(execute(
        remote,
        host,
        &request(serde_json::json!({
            "target":{"type":"worktree","repository":repo,"branch":branch,"base":"main","path":worktree},
            "agent":{"kind":"codex","name":"codex-lazysh2"},
        })),
    ))
    .unwrap();
    assert_eq!(outcome.failure, None, "{outcome:?}");
    assert_eq!(outcome.worktree.as_deref(), Some(worktree.as_str()));
    let listed = run_ok(
        remote,
        &["git", "-C", &repo, "worktree", "list", "--porcelain"],
    );
    assert!(
        listed.contains(&format!("worktree {worktree}\n")),
        "{listed}"
    );
    assert!(
        listed.contains(&format!("branch refs/heads/{branch}\n")),
        "{listed}"
    );
    assert!(root.recorded(&worktree).is_empty());
    let after = panes(remote);
    let pane = outcome.pane_id.unwrap();
    assert!(
        after.contains(&(pane.clone(), worktree.clone())),
        "{after:?}"
    );
    if let Some(current) = current {
        assert_eq!(current(remote), pane);
    }

    // A missing agent or session refuses the launch before a worktree, branch or pane exists.
    let count = after.len();
    let kept = format!("{repo}-worktrees/kept");
    let missing = now(execute(
        remote,
        host,
        &request(serde_json::json!({
            "target":{"type":"worktree","repository":repo,"branch":"kept","base":"HEAD","path":kept},
            "agent":{"kind":"maki","name":"maki-lazysh1"},
        })),
    ))
    .unwrap_err();
    assert!(missing.message().starts_with("maki was not found"));
    assert!(!std::path::Path::new(&kept).exists());
    let gone = now(execute(
        remote,
        gone,
        &request(serde_json::json!({
            "target":{"type":"directory","label":"x","directory":directory},
            "agent":{"kind":"codex","name":"codex-lazysh3"},
        })),
    ))
    .unwrap_err();
    assert_eq!(gone.kind(), "remote_command_failed");
    assert_eq!(panes(remote).len(), count);
    for name in ["pwned", "NO", "NO2"] {
        assert!(
            !root.path().join(name).exists()
                && !std::path::Path::new(&directory).join(name).exists()
        );
    }
}

#[cfg(unix)]
#[test]
#[ignore = "requires git and tmux on PATH; runs an isolated temporary server"]
fn real_tmux_agent_window() {
    let root = AgentRoot::new();
    let label = format!("lz{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let session = "work 'q$(touch NO)";
    root.start(
        "tmux",
        &[
            "-f",
            "/dev/null",
            "-u",
            "-L",
            &label,
            "new-session",
            "-d",
            "-s",
            session,
            "-x",
            "80",
            "-y",
            "24",
            "sleep 3600",
        ],
    );
    let _stop = Stop(&root, "tmux", args(&["-L", &label, "kill-server"]));
    let server = TmuxServer::parse(Some(&label)).unwrap();
    let mut remote = sh(|command| root.configure(command));
    assert_agent_launches(
        &root,
        &mut remote,
        (
            &Host::Tmux(session, server.clone()),
            &Host::Tmux("gone", server),
        ),
        |remote| {
            let rows = run_ok(
                remote,
                &[
                    "tmux",
                    "-u",
                    "-L",
                    &label,
                    "list-panes",
                    "-a",
                    "-F",
                    "#{pane_id}\t#{pane_current_path}",
                ],
            );
            rows.lines()
                .filter_map(|row| row.split_once('\t'))
                .map(|(pane, path)| (pane.to_owned(), path.to_owned()))
                .collect()
        },
        // A tmux launch makes the new window the session's current one, so an attached client follows it.
        Some(&|remote| {
            run_ok(
                remote,
                &[
                    "tmux",
                    "-u",
                    "-L",
                    &label,
                    "display-message",
                    "-p",
                    "-t",
                    &format!("={session}:"),
                    "#{pane_id}",
                ],
            )
            .trim()
            .to_owned()
        }),
    );
}

#[cfg(unix)]
#[test]
#[ignore = "requires git and zellij on PATH; runs an isolated temporary session"]
fn real_zellij_agent_pane() {
    let root = AgentRoot::new();
    let session = format!("lz-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let config = root.path().join("config.kdl");
    std::fs::write(
        &config,
        "show_release_notes false\nshow_startup_tips false\n",
    )
    .unwrap();
    root.start(
        "zellij",
        &[
            "--config",
            config.to_str().unwrap(),
            "attach",
            "--create-background",
            &session,
        ],
    );
    let _stop = Stop(&root, "zellij", args(&["kill-session", &session]));
    let mut remote = sh(|command| root.configure(command));
    let panes = |remote: &mut Local<_>, session: &str| -> Vec<(String, String)> {
        let rows = run_ok(
            remote,
            &[
                "zellij",
                &format!("--session={session}"),
                "action",
                "list-panes",
                "--json",
            ],
        );
        // A session that has not laid out its first tab prints nothing.
        let Ok(rows) = serde_json::from_str::<serde_json::Value>(&rows) else {
            return vec![];
        };
        rows.as_array()
            .unwrap()
            .iter()
            .filter(|pane| pane["is_plugin"] == false)
            .map(|pane| {
                (
                    format!("terminal_{}", pane["id"]),
                    pane["pane_cwd"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect()
    };
    // A fresh background session lists no pane until its server has laid out its first tab.
    let mut ready = false;
    for _ in 0..400 {
        ready = !panes(&mut remote, &session).is_empty();
        if ready {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        ready,
        "the background Zellij session never created its first pane"
    );
    assert_agent_launches(
        &root,
        &mut remote,
        (&Host::Zellij(&session), &Host::Zellij("lz-gone")),
        |remote| panes(remote, &session),
        None,
    );
}
