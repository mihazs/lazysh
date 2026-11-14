use super::*;
use futures_util::FutureExt;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Command;

/// Runs each step exactly as the SSH exec channel would: the login shell gets
/// `-c <script>`.
struct Local<F: Fn(&mut Command)> {
    login: Vec<String>,
    configure: F,
}
fn sh<F: Fn(&mut Command)>(configure: F) -> Local<F> {
    Local {
        login: args(&["/bin/sh"]),
        configure,
    }
}
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
fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}
/// `/bin/sh` plus every installed bash, zsh and fish, invoked as sshd invokes a
/// login shell (`<shell> -c <command>`), without user startup files. Fish is
/// skipped explicitly when absent, unless `LAZYSH_REQUIRE_FISH` is set (CI).
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
        "default",
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
        "default",
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
        "default",
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
        "default",
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
        "default",
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
    assert!(now(execute(&mut remote, "default", &directory)).is_err());
}

#[test]
fn agent_detection_lists_only_executables_found_by_command_v() {
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
            .map(|k| (k.kind, k.executable, k.prompt))
            .collect();
        assert_eq!(
            found,
            [("codex", "codex", true), ("cursor", "cursor-agent", false)],
            "{login:?}"
        );
    }
}

#[test]
fn bounded_keeps_host_text_but_strips_controls() {
    assert_eq!(bounded("  a\u{1b}[31mb\nc\r "), "a [31mb\nc");
}

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
        "default",
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
        "default",
        &request(serde_json::json!({"target":{"type":"directory","label":"plain","directory":repo_text}})),
    ))
    .unwrap();
    assert!(plain.agent.is_none() && plain.failure.is_none() && plain.worktree.is_none());
    let count = |remote: &mut Local<_>| {
        snapshot(remote)["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len()
    };
    let before = count(&mut remote);
    let duplicate = now(execute(
        &mut remote,
        "default",
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
        "default",
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
