//! Real local sessions: `test:local` selects these through the `local::` path segment.
mod local {
    use crate::{
        app_lock::{AccessLease, AccessState, Guarded, GuardedError},
        host::{Cmd, Host},
        local::{adopted_test_session, local_disconnect, LocalState},
        ssh::{AppState, SshError},
    };
    use std::{fs, future::Future, path::Path, process::Command, time::Duration};
    use tauri::{test::MockRuntime, App, Manager};

    type Answer<T> = std::result::Result<Guarded<T>, GuardedError<SshError>>;
    // Boxed before awaiting: the command futures are too large for a test thread's stack in debug.
    fn ok<T>(answer: impl Future<Output = Answer<T>>) -> impl Future<Output = T> {
        let answer = Box::pin(answer);
        async move {
            match answer.await {
                Ok(value) => value.into_inner().unwrap(),
                Err(error) => panic!("{:?}", error.into_inner().unwrap()),
            }
        }
    }
    fn kind<T>(answer: impl Future<Output = Answer<T>>) -> impl Future<Output = &'static str> {
        let answer = Box::pin(answer);
        async move {
            match answer.await {
                Ok(_) => panic!("expected an error"),
                Err(error) => error.into_inner().unwrap().kind(),
            }
        }
    }
    fn lease() -> AccessLease {
        AccessState::disabled().lease(None).unwrap()
    }
    async fn app(directory: &Path) -> (App<MockRuntime>, String) {
        let app = tauri::test::mock_app();
        app.manage(AppState::new(directory.join("state")).unwrap());
        app.manage(LocalState::default());
        let id = adopted_test_session(&app.state::<LocalState>(), lease()).await;
        (app, id)
    }
    /// A live local session resolved through the host context.
    async fn resolved() -> (tempfile::TempDir, App<MockRuntime>, String, Host) {
        let temp = tempfile::tempdir().unwrap();
        let (app, id) = app(temp.path()).await;
        let host = Host::resolve(&app.state(), &app.state(), &id, &lease())
            .await
            .unwrap();
        (temp, app, id, host)
    }
    fn path(path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }
    fn git(repository: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }
    /// Unix sleeps directly; Windows waits on a console-free ping.
    fn slow() -> Cmd {
        if cfg!(windows) {
            Cmd::new(&[], &["ping", "-n", "60", "127.0.0.1"])
        } else {
            Cmd::new(&[], &["sleep", "60"])
        }
    }

    #[tokio::test]
    async fn local_files_list_and_read_with_remote_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let (app, id) = app(temp.path()).await;
        let root = temp.path().join("files");
        fs::create_dir_all(root.join("folder")).unwrap();
        fs::write(root.join("text & 100%.txt"), "hello 世界").unwrap();
        fs::write(root.join("binary"), [0xff, 0xfe]).unwrap();
        fs::write(root.join("large"), vec![b'a'; 1024 * 1024 + 1]).unwrap();
        let list = |directory: String| {
            crate::ssh::list_directory(lease(), app.state(), app.state(), id.clone(), directory)
        };
        let read = |file: &Path| {
            crate::ssh::read_file(lease(), app.state(), app.state(), id.clone(), path(file))
        };
        let entries = ok(list(path(&root))).await;
        let names = entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.is_dir, entry.size))
            .collect::<Vec<_>>();
        assert_eq!(names[0], ("folder", true, names[0].2));
        assert!(names.contains(&("text & 100%.txt", false, 12)));
        assert_eq!(ok(read(&root.join("text & 100%.txt"))).await, "hello 世界");
        assert_eq!(kind(read(&root.join("binary"))).await, "binary_file");
        assert_eq!(kind(read(&root.join("large"))).await, "file_too_large");
        assert_eq!(kind(read(&root.join("folder"))).await, "not_regular_file");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(root.join("binary"), root.join("link"));
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(root.join("binary"), root.join("link"));
        match linked {
            Ok(()) => assert_eq!(kind(read(&root.join("link"))).await, "not_regular_file"),
            // Windows needs Developer Mode or elevation to create the link at all.
            Err(error) if cfg!(windows) => eprintln!("symlink case skipped: {error}"),
            Err(error) => panic!("{error}"),
        }
        let crowded = root.join("crowded");
        fs::create_dir(&crowded).unwrap();
        for index in 0..10_001 {
            fs::write(crowded.join(index.to_string()), b"").unwrap();
        }
        assert_eq!(kind(list(path(&crowded))).await, "directory_too_large");
        // Relative paths start in the home directory, as SFTP paths do.
        assert!(Box::pin(list(".".into())).await.is_ok());
    }

    #[tokio::test]
    async fn local_repository_shows_changes_history_and_diffs_through_git_argv() {
        let temp = tempfile::tempdir().unwrap();
        let (app, id) = app(temp.path()).await;
        let repository = temp.path().join("repo & 100%");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-q"]);
        git(&repository, &["config", "user.name", "Local Test"]);
        git(
            &repository,
            &["config", "user.email", "local@example.invalid"],
        );
        git(&repository, &["config", "core.autocrlf", "false"]);
        fs::write(repository.join("tracked.txt"), "before\n").unwrap();
        fs::write(repository.join("staged.txt"), "old\n").unwrap();
        let message = "say \"hi\" & 100% %PATH% $HOME";
        git(&repository, &["add", "--", "."]);
        git(&repository, &["commit", "-qm", message]);
        fs::write(repository.join("tracked.txt"), "after\n").unwrap();
        fs::write(repository.join("staged.txt"), "new\n").unwrap();
        git(&repository, &["add", "--", "staged.txt"]);
        let untracked = if cfg!(windows) {
            "new & 100% %PATH%.txt"
        } else {
            "new & 100% \"quoted\" $HOME.txt"
        };
        fs::write(repository.join(untracked), "untracked\n").unwrap();
        let directory = path(&repository);

        let status = ok(crate::repository::repository_status(
            app.state(),
            app.state(),
            id.clone(),
            directory.clone(),
            lease(),
        ))
        .await;
        let status = serde_json::to_value(status).unwrap();
        let root = status["path"].as_str().unwrap().to_owned();
        assert_eq!(
            fs::canonicalize(&root).unwrap(),
            fs::canonicalize(&repository).unwrap()
        );
        let changes = status["changes"].as_array().unwrap();
        let change = |file: &str| {
            changes
                .iter()
                .find(|change| change["path"] == file)
                .unwrap_or_else(|| panic!("{file} missing from {changes:?}"))
        };
        assert_eq!(change("tracked.txt")["worktree"], "M");
        assert_eq!(change("staged.txt")["index"], "M");
        assert_eq!(change(untracked)["index"], "?");

        let history = serde_json::to_value(
            ok(crate::repository::repository_history(
                app.state(),
                app.state(),
                id.clone(),
                root.clone(),
                None,
                None,
                lease(),
            ))
            .await,
        )
        .unwrap();
        assert_eq!(history[0]["subject"], message);
        let commit = history[0]["oid"].as_str().unwrap().to_owned();

        let diff = |file: &str, staged: bool| {
            crate::repository::repository_diff(
                app.state(),
                app.state(),
                id.clone(),
                root.clone(),
                file.to_owned(),
                staged,
                lease(),
            )
        };
        let unstaged = serde_json::to_value(ok(diff("tracked.txt", false)).await).unwrap();
        let patch = unstaged["patch"].as_str().unwrap();
        assert!(
            patch.contains("-before") && patch.contains("+after"),
            "{patch}"
        );
        let staged = serde_json::to_value(ok(diff("staged.txt", true)).await).unwrap();
        let patch = staged["patch"].as_str().unwrap();
        assert!(patch.contains("-old") && patch.contains("+new"), "{patch}");
        let whole = ok(crate::ssh::get_diff(
            lease(),
            app.state(),
            app.state(),
            id.clone(),
            directory.clone(),
            false,
        ))
        .await;
        assert!(
            whole.contains("+after") && !whole.contains("+new"),
            "{whole}"
        );

        let tree = serde_json::to_value(
            ok(crate::repository::repository_tree(
                app.state(),
                app.state(),
                id.clone(),
                root.clone(),
                commit,
                None,
                lease(),
            ))
            .await,
        )
        .unwrap();
        let blob = tree
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == "tracked.txt")
            .unwrap()["oid"]
            .as_str()
            .unwrap()
            .to_owned();
        let blob = serde_json::to_value(
            ok(crate::repository::repository_blob(
                app.state(),
                app.state(),
                id.clone(),
                root.clone(),
                blob,
                lease(),
            ))
            .await,
        )
        .unwrap();
        assert_eq!(blob["text"], "before\n");
        assert_eq!(blob["binary"], false);

        // `"` cannot be in an NTFS name, so it reaches Git as a pathspec that matches nothing.
        let quoted = serde_json::to_value(ok(diff("say \"hi\" & 100%.txt", false)).await).unwrap();
        assert_eq!(quoted["patch"], "");

        // UNC and device paths never reach Git, which would open an SMB share with them.
        #[cfg(windows)]
        for refused in [r"\\localhost\lazysh-missing\repo", r"\\?\C:\", r"\\.\C:\"] {
            let status = crate::repository::repository_status(
                app.state(),
                app.state(),
                id.clone(),
                refused.to_owned(),
                lease(),
            );
            assert_eq!(kind(status).await, "invalid_path", "{refused}");
            let whole = crate::ssh::get_diff(
                lease(),
                app.state(),
                app.state(),
                id.clone(),
                refused.to_owned(),
                false,
            );
            assert_eq!(kind(whole).await, "invalid_path", "{refused}");
        }
    }

    #[tokio::test]
    async fn local_exec_checks_revoked_lease_and_closed_session_before_spawn() {
        let (_temp, app, id, host) = resolved().await;
        let authority = AccessState::disabled();
        let stale = authority.lease(None).unwrap();
        authority.replace_renderer().unwrap();
        // If spawn is reached, this missing executable reports remote_command_failed.
        let command = Cmd::new(&[], &["lazysh-test-nonexistent-executable"]);
        let result = host
            .exec(&stale, &command, Duration::from_secs(1), 1024)
            .await;
        assert_eq!(result.unwrap_err().kind(), "app_locked");
        local_disconnect(app.state(), id).unwrap();
        let result = host
            .exec(&lease(), &command, Duration::from_secs(1), 1024)
            .await;
        assert_eq!(result.unwrap_err().kind(), "disconnected");
    }

    #[tokio::test]
    async fn local_exec_is_cancelled_by_closing_the_session() {
        let (_temp, app, id, host) = resolved().await;
        let access = lease();
        let slow = slow();
        let (result, ()) = tokio::join!(
            host.exec(&access, &slow, Duration::from_secs(60), 64 * 1024),
            async {
                tokio::time::sleep(Duration::from_millis(500)).await;
                local_disconnect(app.state(), id.clone()).unwrap();
            }
        );
        assert_eq!(result.unwrap_err().kind(), "disconnected");
        assert_eq!(
            Host::resolve(&app.state(), &app.state(), &id, &access)
                .await
                .err()
                .unwrap()
                .kind(),
            "disconnected"
        );
    }

    #[tokio::test]
    async fn local_exec_over_its_deadline_times_out_and_reaps_the_child() {
        let (temp, _app, _id, host) = resolved().await;
        let access = lease();
        let pid_file = temp.path().join("pid");
        let script;
        // PowerShell's first start on a busy runner can take most of a short deadline,
        // so it is warmed up outside the deadline, and a failed write ends the script
        // with its error on stderr instead of sleeping silently.
        let (command, deadline) = if cfg!(windows) {
            let warm = Command::new("powershell")
                .args(["-NoProfile", "-Command", "exit 0"])
                .status()
                .unwrap();
            assert!(warm.success(), "{warm:?}");
            script = format!(
                "$ErrorActionPreference = 'Stop'; Set-Content -LiteralPath '{}' -Value $PID; Start-Sleep 600",
                path(&pid_file)
            );
            (
                Cmd::new(&[], &["powershell", "-NoProfile", "-Command", &script]),
                Duration::from_secs(60),
            )
        } else {
            script = format!("echo $$ > '{}'; exec sleep 60", path(&pid_file));
            (
                Cmd::new(&[], &["sh", "-c", &script]),
                Duration::from_secs(15),
            )
        };
        let started = std::time::Instant::now();
        let result = host.exec(&access, &command, deadline, 64 * 1024).await;
        assert_eq!(
            result.as_ref().map(drop).unwrap_err().kind(),
            "timeout",
            "{result:?}"
        );
        assert!(started.elapsed() < deadline + Duration::from_secs(25));
        let pid: u32 = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        #[cfg(unix)]
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            -1,
            "timed-out child {pid} was not reaped"
        );
        #[cfg(windows)]
        {
            let listed = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            assert!(
                !String::from_utf8_lossy(&listed.stdout).contains(&format!("\"{pid}\"")),
                "timed-out child {pid} is still running"
            );
        }
        // A successful command still runs after a timeout in the same session.
        let version = host
            .run(&access, &Cmd::new(&[], &["git", "--version"]))
            .await
            .unwrap();
        assert!(version.starts_with("git version"), "{version}");
    }
}
