//! Real local sessions: `test:local` selects these through the `local::` path segment.
pub(crate) mod local {
    use crate::{
        app_lock::{AccessLease, AccessState, Guarded, GuardedError},
        host::{process_gone, Chunk, Cmd, Host, LocalHost, LocalStream},
        local::{adopted_test_session, local_disconnect, LocalState},
        ssh::{AppState, SshError},
    };
    use std::{
        fs,
        future::Future,
        path::{Path, PathBuf},
        process::Command,
        time::Duration,
    };
    use tauri::{test::MockRuntime, App, Manager};

    type Answer<T> = std::result::Result<Guarded<T>, GuardedError<SshError>>;
    // Boxed before awaiting: the command futures are too large for a test thread's stack in debug.
    pub(crate) fn ok<T>(answer: impl Future<Output = Answer<T>>) -> impl Future<Output = T> {
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
    pub(crate) fn lease() -> AccessLease {
        AccessState::disabled().lease(None).unwrap()
    }
    async fn app(directory: &Path) -> (App<MockRuntime>, String) {
        let app = tauri::test::mock_app();
        app.manage(AppState::new(directory.join("state")).unwrap());
        app.manage(LocalState::default());
        let id = adopted_test_session(&app.state::<LocalState>(), lease()).await;
        (app, id)
    }
    /// A temporary home for real tmux, Zellij and Herdr state. Host-tool commands of a session
    /// from [`Isolated::session`] and the test's own [`Isolated::command`]s see only this
    /// directory, never the user's multiplexers or their configuration.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) struct Isolated(tempfile::TempDir);
    #[cfg_attr(not(unix), allow(dead_code))]
    impl Isolated {
        pub(crate) fn new() -> Self {
            let home = Self(tempfile::tempdir().unwrap());
            // No first-run dialogs or update checks over the attached screen.
            fs::create_dir(home.path().join("zellij")).unwrap();
            fs::write(
                home.path().join("zellij/config.kdl"),
                "show_release_notes false\nshow_startup_tips false\n",
            )
            .unwrap();
            fs::write(
                home.path().join("config.toml"),
                "[update]\nversion_check = false\nmanifest_check = false\n",
            )
            .unwrap();
            home
        }
        pub(crate) fn path(&self) -> &Path {
            self.0.path()
        }
        fn variables(&self) -> Vec<(String, String)> {
            [
                "HOME",
                "TMUX_TMPDIR",
                "XDG_RUNTIME_DIR",
                "XDG_CACHE_HOME",
                "XDG_CONFIG_HOME",
            ]
            .map(|name| (name.to_owned(), path(self.path())))
            .into_iter()
            .chain(
                // Windows tools read their state from the profile folders, not from XDG variables.
                ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]
                    .into_iter()
                    .filter(|_| cfg!(windows))
                    .map(|name| (name.to_owned(), path(self.path()))),
            )
            .chain([
                ("TERM".to_owned(), "xterm-256color".to_owned()),
                (
                    "ZELLIJ_CONFIG_DIR".to_owned(),
                    path(&self.path().join("zellij")),
                ),
                (
                    "HERDR_CONFIG_PATH".to_owned(),
                    path(&self.path().join("config.toml")),
                ),
            ])
            .collect()
        }
        /// An adopted local session, with its application state beside the isolated home.
        pub(crate) async fn session(&self) -> (App<MockRuntime>, String) {
            let (app, id) = app(self.path()).await;
            app.state::<LocalState>().set_test_env(self.variables());
            (app, id)
        }
        /// A program started as the session's host tools start one, for setup and teardown.
        pub(crate) fn command(&self, program: &str) -> Command {
            let mut command = Command::new(program);
            command.envs(self.variables());
            for name in [
                "TMUX",
                "ZELLIJ",
                "ZELLIJ_SESSION_NAME",
                "HERDR_SOCKET_PATH",
                "HERDR_SESSION",
            ] {
                command.env_remove(name);
            }
            command
        }
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
        // `~` expands against the same absolute home the relative paths start in.
        let home = crate::local::home_dir().unwrap();
        let reported = ok(crate::ssh::host_home(
            lease(),
            app.state(),
            app.state(),
            id.clone(),
        ))
        .await;
        assert_eq!(std::path::PathBuf::from(reported), home);
    }

    /// A staging area and the transfers it owns, beside a live local session.
    async fn staging(directory: &Path) -> (crate::file_transfer::Transfers, PathBuf) {
        let downloads = directory.join("Downloads");
        (
            crate::file_transfer::Transfers::new(
                directory.join("staging"),
                Some(downloads.clone()),
            ),
            downloads,
        )
    }
    fn request<'a>(
        id: &'a str,
        file: &Path,
        follow_link: bool,
        allow_large: bool,
    ) -> crate::file_transfer::Request<'a> {
        crate::file_transfer::Request {
            session_id: "local",
            id,
            path: path(file),
            options: crate::file_transfer::Options {
                follow_link,
                allow_large,
            },
        }
    }

    #[tokio::test]
    async fn local_downloads_stage_exact_bytes_report_progress_and_never_run_or_overwrite() {
        let (temp, _app, _id, host) = resolved().await;
        let (transfers, downloads) = staging(temp.path()).await;
        let source = temp.path().join("Résumé 世界 & 100%.txt");
        let bytes: Vec<u8> = (0..3_000_000u32).map(|n| (n % 251) as u8).collect();
        fs::write(&source, &bytes).unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let id = uuid::Uuid::new_v4().to_string();
        let staged = crate::file_transfer::download(
            &transfers,
            &host,
            &lease(),
            request(&id, &source, false, false),
            |progress| {
                seen.lock()
                    .unwrap()
                    .push(serde_json::to_value(progress).unwrap())
            },
        )
        .await
        .unwrap();
        let staged = serde_json::to_value(staged).unwrap();
        assert_eq!(staged["name"], "Résumé 世界 & 100%.txt");
        assert_eq!(staged["size"], bytes.len());
        let copy = temp
            .path()
            .join("staging")
            .join(&id)
            .join("Résumé 世界 & 100%.txt");
        assert_eq!(fs::read(&copy).unwrap(), bytes);
        #[cfg(unix)]
        assert_eq!(
            std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&copy).unwrap().permissions())
                & 0o111,
            0,
            "a staged copy must never be executable"
        );
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.first().unwrap()["bytes"], 0);
        assert_eq!(seen.last().unwrap()["bytes"], bytes.len());
        assert_eq!(seen.last().unwrap()["total"], bytes.len());
        assert!(seen
            .windows(2)
            .all(|pair| pair[0]["bytes"].as_u64() <= pair[1]["bytes"].as_u64()));
        // Saving twice keeps both and never touches an existing file.
        fs::create_dir_all(&downloads).unwrap();
        fs::write(downloads.join("Résumé 世界 & 100%.txt"), "mine").unwrap();
        let saved =
            crate::file_transfer::save_to(&downloads, &copy, "Résumé 世界 & 100%.txt").unwrap();
        assert_eq!(saved.file_name().unwrap(), "Résumé 世界 & 100% (1).txt");
        assert_eq!(
            fs::read_to_string(downloads.join("Résumé 世界 & 100%.txt")).unwrap(),
            "mine"
        );
        // The same id cannot be reused, and a missing source leaves no staging directory.
        let reused = crate::file_transfer::download(
            &transfers,
            &host,
            &lease(),
            request(&id, &source, false, false),
            |_| {},
        )
        .await;
        assert_eq!(reused.unwrap_err().kind(), "transfer_unavailable");
        let missing_id = uuid::Uuid::new_v4().to_string();
        let missing = crate::file_transfer::download(
            &transfers,
            &host,
            &lease(),
            request(&missing_id, &temp.path().join("absent"), false, false),
            |_| {},
        )
        .await;
        assert!(missing.is_err());
        assert!(!temp.path().join("staging").join(&missing_id).exists());
    }

    #[tokio::test]
    async fn local_downloads_refuse_directories_unconfirmed_links_and_unconfirmed_large_files() {
        let (temp, _app, _id, host) = resolved().await;
        let (transfers, _) = staging(temp.path()).await;
        let folder = temp.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let target = temp.path().join("target.txt");
        fs::write(&target, "linked").unwrap();
        let big = temp.path().join("big.bin");
        fs::File::create(&big)
            .unwrap()
            .set_len(crate::file_transfer::LARGE + 1)
            .unwrap();
        let run = |file: PathBuf, follow: bool, large: bool| {
            let (transfers, host) = (&transfers, &host);
            async move {
                let id = uuid::Uuid::new_v4().to_string();
                let result = crate::file_transfer::download(
                    transfers,
                    host,
                    &lease(),
                    request(&id, &file, follow, large),
                    |_| {},
                )
                .await;
                (id, result)
            }
        };
        assert_eq!(
            run(folder.clone(), false, false)
                .await
                .1
                .unwrap_err()
                .kind(),
            "not_regular_file"
        );
        let (id, large) = run(big.clone(), false, false).await;
        assert_eq!(large.unwrap_err().kind(), "file_large");
        assert!(
            !temp.path().join("staging").join(id).exists(),
            "a refused download leaves nothing behind"
        );
        let (id, confirmed) = run(big, false, true).await;
        assert_eq!(
            serde_json::to_value(confirmed.unwrap()).unwrap()["size"],
            crate::file_transfer::LARGE + 1
        );
        assert!(temp.path().join("staging").join(id).exists());
        #[cfg(unix)]
        {
            let link = temp.path().join("link.txt");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            let stat = host.stat_file(&lease(), path(&link)).await.unwrap();
            assert_eq!((stat.kind, stat.size), (crate::host::Kind::File, 6));
            assert_eq!(
                stat.link.as_deref().map(Path::new),
                Some(fs::canonicalize(&target).unwrap().as_path())
            );
            assert_eq!(
                run(link.clone(), false, false).await.1.unwrap_err().kind(),
                "symlink_unconfirmed"
            );
            let (id, followed) = run(link, true, false).await;
            followed.unwrap();
            assert_eq!(
                fs::read_to_string(temp.path().join("staging").join(id).join("link.txt")).unwrap(),
                "linked"
            );
        }
        assert_eq!(
            host.stat_file(&lease(), path(&folder)).await.unwrap().kind,
            crate::host::Kind::Directory
        );
        assert!(host
            .stat_file(&lease(), path(&temp.path().join("absent")))
            .await
            .is_err());
    }

    /// Downloads an 8 MiB file while `interfere` runs at every progress report with the bytes copied so far.
    async fn interrupted(
        interfere: impl Fn(&crate::file_transfer::Transfers, &Path, &str, u64),
    ) -> (tempfile::TempDir, String, SshError) {
        let (temp, _app, _id, host) = resolved().await;
        let (transfers, _) = staging(temp.path()).await;
        let source = temp.path().join("big.bin");
        fs::write(&source, vec![7u8; 8 * 1024 * 1024]).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let error = crate::file_transfer::download(
            &transfers,
            &host,
            &lease(),
            request(&id, &source, false, false),
            |value| {
                let bytes = serde_json::to_value(value).unwrap()["bytes"]
                    .as_u64()
                    .unwrap();
                interfere(&transfers, &source, &id, bytes);
            },
        )
        .await
        .unwrap_err();
        assert!(!temp.path().join("staging").join(&id).exists());
        (temp, id, error)
    }

    #[tokio::test]
    async fn cancelling_a_local_download_stops_it_and_removes_the_partial_copy() {
        // The user pressed Cancel once data was flowing.
        let (_temp, _id, error) = interrupted(|transfers, _, id, bytes| {
            if bytes > 0 {
                transfers.cancel(id, "local", &lease());
            }
        })
        .await;
        assert_eq!(error.kind(), "transfer_cancelled");
        // A finished download is discarded by the same call.
        let (temp, _app, _id, host) = resolved().await;
        let (transfers, _) = staging(temp.path()).await;
        let source = temp.path().join("done.bin");
        fs::write(&source, b"done").unwrap();
        let kept = uuid::Uuid::new_v4().to_string();
        crate::file_transfer::download(
            &transfers,
            &host,
            &lease(),
            request(&kept, &source, false, false),
            |_| {},
        )
        .await
        .unwrap();
        assert!(temp.path().join("staging").join(&kept).exists());
        transfers.cancel(&kept, "local", &lease());
        assert!(!temp.path().join("staging").join(&kept).exists());
    }

    #[tokio::test]
    async fn only_the_three_newest_finished_copies_stay_staged_for_other_apps() {
        let (temp, _app, _id, host) = resolved().await;
        let (transfers, _) = staging(temp.path()).await;
        let source = temp.path().join("note.txt");
        fs::write(&source, b"note").unwrap();
        let mut ids = Vec::new();
        for _ in 0..5 {
            let id = uuid::Uuid::new_v4().to_string();
            crate::file_transfer::download(
                &transfers,
                &host,
                &lease(),
                request(&id, &source, false, false),
                |_| {},
            )
            .await
            .unwrap();
            ids.push(id);
        }
        let staged = |id: &String| temp.path().join("staging").join(id).exists();
        assert_eq!(
            ids.iter().map(staged).collect::<Vec<_>>(),
            [false, false, true, true, true]
        );
    }

    #[tokio::test]
    async fn a_file_that_shrinks_during_a_local_download_fails_and_leaves_nothing() {
        let (_temp, _id, error) = interrupted(|_, source, _, bytes| {
            if bytes > 0 && bytes < 8 * 1024 * 1024 {
                fs::OpenOptions::new()
                    .write(true)
                    .open(source)
                    .unwrap()
                    .set_len(bytes)
                    .unwrap();
            }
        })
        .await;
        assert_eq!(error.kind(), "file_changed");
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
        let stream = local_arm(&host).spawn_stream(&lease(), &command).await;
        assert_eq!(stream.err().unwrap().kind(), "disconnected");
    }

    fn local_arm(host: &Host) -> &LocalHost {
        match host {
            Host::Local(local) => local,
            Host::Remote(_) => panic!("a local session resolves to the local arm"),
        }
    }
    async fn started(host: &Host, command: &Cmd) -> LocalStream {
        local_arm(host)
            .spawn_stream(&lease(), command)
            .await
            .unwrap()
    }
    /// All of a started command's output, and how it ended.
    async fn drained(mut stream: LocalStream) -> (Vec<u8>, &'static str) {
        let mut output = Vec::new();
        loop {
            match stream.next().await.unwrap() {
                Chunk::Data(data) => output.extend(data),
                Chunk::Failed => return (output, "failed"),
                Chunk::Closed => return (output, "closed"),
                Chunk::Other => {}
            }
        }
    }
    #[tokio::test]
    async fn a_local_stream_hands_out_output_and_says_how_the_command_ended() {
        let (_temp, _app, _id, host) = resolved().await;
        let (output, end) =
            drained(started(&host, &Cmd::new(&[], &["git", "--version"])).await).await;
        assert!(String::from_utf8(output)
            .unwrap()
            .starts_with("git version"));
        assert_eq!(end, "closed");
        let failing = Cmd::new(&[], &["git", "--no-such-flag"]);
        let (output, end) = drained(started(&host, &failing).await).await;
        assert!(output.is_empty());
        assert_eq!(end, "failed");
    }
    #[tokio::test]
    async fn closing_or_dropping_a_local_stream_removes_a_child_that_ignores_end_of_input() {
        let (_temp, _app, _id, host) = resolved().await;
        let closed = started(&host, &slow()).await;
        let pid = closed.child.id().unwrap();
        closed.close().await;
        assert!(
            process_gone(pid).await,
            "closed child {pid} was not removed"
        );
        let dropped = started(&host, &slow()).await;
        let pid = dropped.child.id().unwrap();
        drop(dropped);
        assert!(
            process_gone(pid).await,
            "dropped child {pid} was not removed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_run_status_returns_a_failing_exit_as_data_where_run_refuses_it() {
        let (_temp, _app, _id, host) = resolved().await;
        let access = lease();
        let command = Cmd::new(&[], &["sh", "-c", "echo out; echo problem >&2; exit 3"]);
        let output = host.run_status(&access, &command).await.unwrap();
        assert_eq!(output.status, Some(3));
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"problem\n");
        let refused = host.run(&access, &command).await.unwrap_err();
        assert_eq!(
            (refused.kind(), refused.message()),
            ("remote_command_failed", "problem")
        );
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
        assert!(
            process_gone(pid).await,
            "timed-out child {pid} was not reaped"
        );
        // A successful command still runs after a timeout in the same session.
        let version = host
            .run(&access, &Cmd::new(&[], &["git", "--version"]))
            .await
            .unwrap();
        assert!(version.starts_with("git version"), "{version}");
    }

    /// Removes what a test created outside its temporary directory, even when it fails.
    struct Remove(Vec<String>);
    impl Drop for Remove {
        fn drop(&mut self) {
            for file in &self.0 {
                let _ = fs::remove_file(file);
            }
        }
    }
    async fn upload(
        app: &App<MockRuntime>,
        id: &str,
        name: &str,
        data: &[u8],
        temporary: bool,
    ) -> Answer<crate::attachment_upload::Uploaded> {
        let reserved = ok(crate::attachment_upload::upload_reserve(
            lease(),
            app.state(),
            app.state(),
            id.into(),
            data.len(),
        ))
        .await;
        crate::attachment_upload::upload_file(
            lease(),
            app.state(),
            app.state(),
            id.into(),
            reserved.upload_id,
            name.into(),
            data.to_vec(),
            Some(temporary),
        )
        .await
    }

    #[tokio::test]
    async fn local_uploads_create_private_distinct_files_and_never_replace_one() {
        let temp = tempfile::tempdir().unwrap();
        let (app, id) = app(temp.path()).await;
        let first = ok(upload(&app, &id, "shot.png", b"one", true)).await.path;
        let second = ok(upload(&app, &id, "shot.png", b"two", true)).await.path;
        let _remove = Remove(vec![first.clone(), second.clone()]);
        assert_ne!(first, second);
        let shared = if cfg!(unix) {
            PathBuf::from("/tmp")
        } else {
            std::env::temp_dir()
        };
        for (created, content) in [(&first, b"one"), (&second, b"two")] {
            let created = Path::new(created);
            assert_eq!(created.parent().unwrap(), shared);
            let name = created.file_name().unwrap().to_str().unwrap();
            assert!(
                name.starts_with("lazysh-") && name.ends_with("-shot.png"),
                "{name}"
            );
            assert_eq!(fs::read(created).unwrap(), content);
            #[cfg(unix)]
            assert_eq!(
                std::os::unix::fs::PermissionsExt::mode(
                    &fs::metadata(created).unwrap().permissions()
                ) & 0o777,
                0o600
            );
        }
        // An explicit path is created once and never replaced.
        let explicit = temp.path().join("explicit.txt");
        let uploaded = ok(upload(&app, &id, &path(&explicit), b"keep", false))
            .await
            .path;
        assert_eq!(Path::new(&uploaded), explicit);
        assert_eq!(
            kind(upload(&app, &id, &path(&explicit), b"replace", false)).await,
            "file_exists"
        );
        assert_eq!(fs::read(&explicit).unwrap(), b"keep");
        // A dangling link is a name in use: it is neither followed nor replaced.
        #[cfg(unix)]
        {
            let missing = temp.path().join("missing.txt");
            let link = temp.path().join("link.txt");
            std::os::unix::fs::symlink(&missing, &link).unwrap();
            assert_eq!(
                kind(upload(&app, &id, &path(&link), b"x", false)).await,
                "file_exists"
            );
            assert!(!missing.exists());
        }
        // Names are one file name, and a closed session takes no more uploads.
        assert_eq!(
            kind(upload(&app, &id, "folder/shot.png", b"x", true)).await,
            "invalid_path"
        );
        local_disconnect(app.state(), id.clone()).unwrap();
        assert_eq!(
            kind(crate::attachment_upload::upload_reserve(
                lease(),
                app.state(),
                app.state(),
                id,
                1
            ))
            .await,
            "disconnected"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_filesystem_that_ignores_chmod_never_receives_a_private_attachment() {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let create = |name: &str| {
            let file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o666)
                .open(temp.path().join(name))
                .unwrap();
            file.set_permissions(fs::Permissions::from_mode(0o644))
                .unwrap();
            file
        };
        let exposed = create("exposed");
        let refused = crate::host::local_fs::keep_private_with(&exposed, |_| {});
        assert_eq!(refused.unwrap_err().kind(), "upload_not_private");
        let repaired = create("repaired");
        crate::host::local_fs::keep_private(&repaired).unwrap();
        assert_eq!(
            repaired.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    /// An HTTP server on this device's loopback that answers every request with `local`.
    async fn http_listener(address: &str) -> Option<u16> {
        let server = tokio::net::TcpListener::bind((address, 0)).await.ok()?;
        let port = server.local_addr().ok()?.port();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut socket, _)) = server.accept().await {
                tokio::spawn(async move {
                    let mut request = [0u8; 1024];
                    let _ = socket.read(&mut request).await;
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nlocal",
                        )
                        .await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Some(port)
    }
    async fn get(port: u16) -> std::io::Result<String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        socket
            .write_all(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await?;
        let mut answer = String::new();
        socket.read_to_string(&mut answer).await?;
        Ok(answer)
    }
    async fn refuses(port: u16) -> bool {
        for _ in 0..50 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
            {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    #[tokio::test]
    async fn local_previews_proxy_http_report_discovery_and_stop_with_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let (app, id) = app(temp.path()).await;
        app.manage(crate::previews::PreviewState::default());
        let port = http_listener("127.0.0.1").await.unwrap();
        // Hosts without IPv6 loopback skip the second family.
        let v6 = http_listener("::1").await;
        let wanted: Vec<u16> = [Some(port), v6].into_iter().flatten().collect();
        let listeners = ok(crate::previews::discover_preview_ports(
            lease(),
            app.state(),
            app.state(),
            id.clone(),
            Some(wanted.clone()),
            Some(true),
        ))
        .await;
        let found = serde_json::to_value(listeners).unwrap();
        let found = found.as_array().unwrap();
        assert_eq!(found.len(), wanted.len(), "{found:?}");
        for row in found {
            assert_eq!(row["http"], true, "{row}");
        }
        assert!(found
            .iter()
            .any(|row| row["port"] == port && row["address"] == "127.0.0.1"));
        if let Some(v6) = v6 {
            assert!(found
                .iter()
                .any(|row| row["port"] == v6 && row["address"] == "[::1]"));
        }
        // A preview is a fresh loopback port in front of the dev server, which keeps its own.
        let start = || {
            crate::previews::start_preview(
                lease(),
                app.state(),
                app.state(),
                app.state(),
                id.clone(),
                port,
                None,
                None,
            )
        };
        let first = serde_json::to_value(ok(start()).await).unwrap();
        let second = serde_json::to_value(ok(start()).await).unwrap();
        let proxied = |preview: &serde_json::Value| preview["localPort"].as_u64().unwrap() as u16;
        assert_ne!(proxied(&first), port);
        assert_ne!(proxied(&first), proxied(&second));
        assert!(get(proxied(&first)).await.unwrap().ends_with("local"));
        assert!(get(port).await.unwrap().ends_with("local"));
        let listed = ok(crate::previews::list_previews(
            lease(),
            app.state(),
            app.state(),
            app.state(),
            id.clone(),
        ))
        .await;
        assert_eq!(listed.len(), 2);
        crate::previews::stop_preview(
            app.state(),
            id.clone(),
            first["id"].as_str().unwrap().into(),
        )
        .await
        .unwrap();
        assert!(refuses(proxied(&first)).await);
        assert!(get(proxied(&second)).await.unwrap().ends_with("local"));
        // Closing the session stops the proxy that is left.
        local_disconnect(app.state(), id).unwrap();
        assert!(refuses(proxied(&second)).await);
        assert!(get(port).await.unwrap().ends_with("local"));
    }

    /// A WSL session on a machine without WSL: `wsl.exe` is a script that checks the argument
    /// shape, runs the command from the home directory and answers `wslpath`, and the share root
    /// is `/`, so every Linux path of the "distribution" is a path of this machine.
    #[cfg(unix)]
    mod wsl {
        use super::*;
        use crate::local::Wsl;
        use std::os::unix::fs::PermissionsExt;

        fn script(path: &Path, text: &str) -> PathBuf {
            fs::write(path, text).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
            path.to_owned()
        }
        /// Written once: executing a script that another test is still writing fails with
        /// "text file busy". A session passes `WSL_LOG` and `WSL_DRIVE` in its environment.
        fn fake_wsl() -> PathBuf {
            static SCRIPT: std::sync::OnceLock<(tempfile::TempDir, PathBuf)> =
                std::sync::OnceLock::new();
            SCRIPT
                .get_or_init(|| {
                    let dir = tempfile::tempdir().unwrap();
                    let path = script(
                        &dir.path().join("wsl.exe"),
                        r#"#!/bin/sh
{ for argument in "$@"; do printf '%s\n' "$argument"; done; echo --; } >> "${WSL_LOG:-/dev/null}"
[ "$1 $2 $3 $4 $5" = '-d Ubuntu --cd ~ -e' ] || { echo "unexpected wsl.exe arguments: $*" >&2; exit 2; }
shift 5
cd "$HOME" || exit 3
if [ "$1" = wslpath ]; then
  [ "$2 $3" = '-u -a' ] || exit 4
  printf '%s%s\n' "$WSL_DRIVE" "$(printf '%s' "$4" | cut -c3- | tr '\\' '/')"
  exit 0
fi
exec "$@"
"#,
                    );
                    (dir, path)
                })
                .1
                .clone()
        }
        fn log(dir: &Path) -> String {
            fs::read_to_string(dir.join("wsl.log")).unwrap_or_default()
        }
        /// The environment the fake `wsl.exe` of a session in `dir` reads.
        fn environment(dir: &Path) -> Vec<(String, String)> {
            vec![
                ("WSL_LOG".into(), path(&dir.join("wsl.log"))),
                ("WSL_DRIVE".into(), path(&dir.join("c"))),
            ]
        }
        async fn session(root: &str) -> (tempfile::TempDir, App<MockRuntime>, String) {
            let temp = tempfile::tempdir().unwrap();
            let wsl = Wsl::with_root(fake_wsl(), "Ubuntu", PathBuf::from(root));
            let (app, id) = app(temp.path()).await;
            app.state::<LocalState>().bind_wsl(&id, wsl);
            app.state::<LocalState>()
                .set_test_env(environment(temp.path()));
            (temp, app, id)
        }
        async fn host(app: &App<MockRuntime>, id: &str) -> Host {
            Host::resolve(&app.state(), &app.state(), id, &lease())
                .await
                .unwrap()
        }

        #[tokio::test]
        async fn every_command_runs_through_wsl_exe_from_the_home_directory_with_its_environment() {
            let (temp, app, id) = session("/").await;
            let host = host(&app, &id).await;
            static ENVIRONMENT: [(&str, &str); 1] = [("LAZYSH_FROM_COMMAND", "a b; $(x)")];
            let printed = Box::pin(host.run(
                &lease(),
                &Cmd::new(&ENVIRONMENT, &["printenv", "LAZYSH_FROM_COMMAND"]),
            ))
            .await
            .unwrap();
            assert_eq!(printed, "a b; $(x)\n");
            // No shell sits between lazysh and the program, so no argument is split or expanded.
            let printed = Box::pin(host.run(
                &lease(),
                &Cmd::new(&[], &["printf", "%s|", "a b", "c;d", "$HOME", "`x`"]),
            ))
            .await
            .unwrap();
            assert_eq!(printed, "a b|c;d|$HOME|`x`|");
            // The argument list wsl.exe received, one argument per line.
            assert!(
                log(temp.path()).starts_with(
                    "-d\nUbuntu\n--cd\n~\n-e\nenv\nLAZYSH_FROM_COMMAND=a b; $(x)\nprintenv\nLAZYSH_FROM_COMMAND\n--\n-d\nUbuntu\n--cd\n~\n-e\nprintf\n%s|\na b\n"
                ),
                "{}",
                log(temp.path())
            );
            // The home directory is the distribution user's, reported as the command ran in it.
            let home = Box::pin(host.home(&lease())).await.unwrap();
            assert_eq!(
                fs::canonicalize(home).unwrap(),
                fs::canonicalize(crate::local::home_dir().unwrap()).unwrap()
            );
            // The Windows companion cannot serve a distribution.
            let companion = Box::pin(host.companion(&lease(), "lazysh-agent snapshot".into()))
                .await
                .unwrap_err();
            assert_eq!(companion.kind(), "remote_command_failed");
            // Uploads and previews would act on Windows, not in the distribution.
            for what in ["Attachments", "Previews"] {
                let refused = host.refuse_in_wsl(what).unwrap_err();
                assert_eq!(refused.kind(), "remote_command_failed");
                assert!(refused.message().contains(what), "{}", refused.message());
            }
        }

        #[tokio::test]
        async fn files_and_a_repository_diff_are_read_inside_the_distribution() {
            let (temp, app, id) = session("/").await;
            let files = temp.path().join("my files & 100%");
            fs::create_dir_all(files.join("folder")).unwrap();
            fs::write(files.join("note.txt"), "hello 世界").unwrap();
            let list = |directory: &Path| {
                crate::ssh::list_directory(
                    lease(),
                    app.state(),
                    app.state(),
                    id.clone(),
                    path(directory),
                )
            };
            let names = ok(list(&files))
                .await
                .into_iter()
                .map(|entry| (entry.name, entry.is_dir))
                .collect::<Vec<_>>();
            assert_eq!(
                names,
                [("folder".to_owned(), true), ("note.txt".to_owned(), false)]
            );
            let read = crate::ssh::read_file(
                lease(),
                app.state(),
                app.state(),
                id.clone(),
                path(&files.join("note.txt")),
            );
            assert_eq!(ok(read).await, "hello 世界");

            let repository = temp.path().join("repo");
            fs::create_dir(&repository).unwrap();
            git(&repository, &["init", "-q"]);
            git(&repository, &["config", "user.name", "Wsl Test"]);
            git(
                &repository,
                &["config", "user.email", "wsl@example.invalid"],
            );
            fs::write(repository.join("tracked.txt"), "before\n").unwrap();
            git(&repository, &["add", "--", "."]);
            git(&repository, &["commit", "-qm", "first"]);
            fs::write(repository.join("tracked.txt"), "after\n").unwrap();
            let directory = path(&repository);
            let status = serde_json::to_value(
                ok(crate::repository::repository_status(
                    app.state(),
                    app.state(),
                    id.clone(),
                    directory.clone(),
                    lease(),
                ))
                .await,
            )
            .unwrap();
            assert_eq!(status["changes"][0]["path"], "tracked.txt");
            assert_eq!(status["changes"][0]["worktree"], "M");
            let diff = serde_json::to_value(
                ok(crate::repository::repository_diff(
                    app.state(),
                    app.state(),
                    id.clone(),
                    status["path"].as_str().unwrap().to_owned(),
                    "tracked.txt".to_owned(),
                    false,
                    lease(),
                ))
                .await,
            )
            .unwrap();
            assert!(diff.to_string().contains("+after"), "{diff}");
            // Git ran inside the distribution, not on this machine.
            assert!(log(temp.path()).contains("-e\nenv\nGIT_OPTIONAL_LOCKS=0\n"));
        }

        #[tokio::test]
        async fn only_this_distributions_paths_are_read_and_a_drive_path_is_translated_by_wslpath()
        {
            let (temp, app, id) = session("/").await;
            let note = temp.path().join("c").join("data").join("note.txt");
            fs::create_dir_all(note.parent().unwrap()).unwrap();
            fs::write(&note, "from the drive").unwrap();
            fs::write(temp.path().join("plain.txt"), "plain").unwrap();
            let read = |file: String| {
                crate::ssh::read_file(lease(), app.state(), app.state(), id.clone(), file)
            };
            let plain = path(&temp.path().join("plain.txt"));
            assert_eq!(ok(read(plain.clone())).await, "plain");
            let unc = format!(r"\\wsl.localhost\Ubuntu{}", plain.replace('/', r"\"));
            assert_eq!(ok(read(unc)).await, "plain");
            assert_eq!(ok(read(r"C:\data\note.txt".into())).await, "from the drive");
            assert!(log(temp.path()).contains("-e\nwslpath\n-u\n-a\nC:\\data\\note.txt\n"));
            let spawned = log(temp.path());

            for refused in [
                r"\\server\share\plain.txt".to_owned(),
                r"\\wsl.localhost\Debian\tmp\plain.txt".to_owned(),
                r"\\?\C:\Windows\win.ini".to_owned(),
                r"\\.\pipe\lazysh".to_owned(),
                format!("{}/../plain.txt", path(&temp.path().join("c"))),
                r"C:\data\..\..\Windows\win.ini".to_owned(),
                "plain.txt".to_owned(),
            ] {
                assert_eq!(
                    kind(read(refused.clone())).await,
                    "invalid_path",
                    "{refused}"
                );
            }
            // A directory for Git is a Linux path of the distribution.
            let status = crate::repository::repository_status(
                app.state(),
                app.state(),
                id.clone(),
                r"C:\data".into(),
                lease(),
            );
            assert_eq!(kind(status).await, "invalid_path");
            // Refusals never reach wsl.exe.
            assert_eq!(log(temp.path()), spawned);
        }

        #[tokio::test]
        async fn a_link_resolves_to_a_path_of_the_distribution_and_never_outside_it() {
            // The share root is compared with resolved link targets, so it is under the canonical temporary
            // directory: macOS's is behind the /var symlink.
            let temp = tempfile::Builder::new()
                .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
                .unwrap();
            let share = temp.path().join("share");
            fs::create_dir_all(share.join("home/me")).unwrap();
            fs::write(share.join("home/me/target.txt"), "target").unwrap();
            std::os::unix::fs::symlink(
                share.join("home/me/target.txt"),
                share.join("home/me/inside"),
            )
            .unwrap();
            std::os::unix::fs::symlink(temp.path(), share.join("home/me/outside")).unwrap();
            let (app, id) = app(temp.path()).await;
            let wsl = Wsl::with_root(fake_wsl(), "Ubuntu", share);
            app.state::<LocalState>().bind_wsl(&id, wsl);
            let host = host(&app, &id).await;
            let stat = Box::pin(host.stat_file(&lease(), "/home/me/inside".into()))
                .await
                .unwrap();
            assert_eq!(stat.link.as_deref(), Some("/home/me/target.txt"));
            let stat = Box::pin(host.stat_file(&lease(), "/home/me/outside".into()))
                .await
                .unwrap_err();
            assert_eq!(stat.kind(), "invalid_path");
        }

        #[tokio::test]
        async fn a_distribution_reports_files_and_repository_only_when_git_starts_inside_it() {
            let temp = tempfile::tempdir().unwrap();
            let working = Wsl::with_root(fake_wsl(), "Ubuntu", PathBuf::from("/"));
            let reported = serde_json::to_value(working.tools().await).unwrap();
            assert_eq!(
                reported,
                serde_json::json!({"files": true, "repository": true, "companion": false, "companionSource": null, "attachments": false, "previews": false, "devices": false})
            );
            // `wsl.exe` fails when the distribution has no `git`.
            let missing = script(&temp.path().join("no-git.exe"), "#!/bin/sh\nexit 1\n");
            let reported = Wsl::with_root(missing, "Ubuntu", PathBuf::from("/"))
                .tools()
                .await;
            assert_eq!(
                serde_json::to_value(reported).unwrap(),
                serde_json::json!({"files": false, "repository": false, "companion": false, "companionSource": null, "attachments": false, "previews": false, "devices": false})
            );
        }
    }
}

/// Herdr is found on the PATH first and in its owner-checked user install directory last.
#[cfg(unix)]
mod herdr_install {
    use crate::host::with_herdr_install;
    use std::{ffi::OsString, fs, os::unix::fs::PermissionsExt, path::PathBuf};

    fn install(home: &std::path::Path) -> PathBuf {
        let directory = home.join(".local/bin");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("herdr"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(directory.join("herdr"), fs::Permissions::from_mode(0o755)).unwrap();
        directory
    }

    #[test]
    fn the_user_install_directory_comes_after_the_path_and_a_path_hit_wins() {
        let temp = tempfile::tempdir().unwrap();
        // The admission walk refuses symbolic links, and some temporary roots are one.
        let home = fs::canonicalize(temp.path()).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let (empty, found) = (home.join("empty"), home.join("found"));
        fs::create_dir_all(&found).unwrap();
        fs::create_dir_all(&empty).unwrap();
        fs::write(found.join("herdr"), "").unwrap();
        let join = |directories: &[&std::path::Path]| std::env::join_paths(directories).unwrap();
        // No install yet: the PATH is returned as it was.
        assert_eq!(
            with_herdr_install(Some(join(&[&empty])), Some(home.clone())),
            Some(join(&[&empty]))
        );
        let directory = install(&home);
        assert_eq!(
            with_herdr_install(Some(join(&[&empty])), Some(home.clone())),
            Some(join(&[&empty, &directory]))
        );
        let on_path: Option<OsString> = Some(join(&[&found, &empty]));
        assert_eq!(
            with_herdr_install(on_path.clone(), Some(home.clone())),
            on_path
        );
        // A group-writable install directory is not trusted.
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o775)).unwrap();
        assert_eq!(
            with_herdr_install(Some(join(&[&empty])), Some(home)),
            Some(join(&[&empty]))
        );
    }
}

mod sdk {
    use std::{ffi::OsString, fs, path::Path};

    fn adb_in(directory: &Path) {
        fs::create_dir_all(directory).unwrap();
        let name = if cfg!(windows) { "adb.exe" } else { "adb" };
        let path = directory.join(name);
        fs::write(&path, b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn non_executable_adb_is_not_a_usable_device_capability() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("platform-tools");
        adb_in(&dir);
        let adb = dir.join("adb");
        fs::set_permissions(&adb, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            std::process::Command::new(&adb).spawn().unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(!crate::host::adb_resolves(
            Some(temp.path().into()),
            &OsString::new(),
            temp.path()
        ));
    }
    #[cfg(unix)]
    #[test]
    fn device_tool_follows_executable_symlinks_and_skips_unusable_path_entries() {
        use std::os::unix::{
            fs::{symlink, PermissionsExt},
            process::CommandExt,
        };
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        adb_in(&first);
        adb_in(&second);
        fs::set_permissions(first.join("adb"), fs::Permissions::from_mode(0o644)).unwrap();
        fs::write(second.join("adb"), b"#!/bin/sh\nexit 0\n").unwrap();
        symlink(second.join("adb"), temp.path().join("linked-adb")).unwrap();
        assert!(crate::host::device_tool(
            &temp.path().join("linked-adb"),
            temp.path()
        ));
        let sdk = temp.path().join("sdk");
        fs::create_dir_all(sdk.join("platform-tools")).unwrap();
        let link = sdk.join("platform-tools/adb");
        symlink(first.join("adb"), &link).unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert!(crate::host::device_tool_on_path("adb", &path, temp.path()));
        assert!(!crate::host::adb_resolves(
            Some(sdk.clone().into()),
            &path,
            temp.path()
        ));
        fs::remove_file(&link).unwrap();
        symlink(second.join("adb"), &link).unwrap();
        assert!(crate::host::adb_resolves(
            Some(sdk.into()),
            &path,
            temp.path()
        ));
        let error = std::process::Command::new(temp.path().join("linked-adb"))
            .arg0("adb")
            .status()
            .unwrap();
        assert!(error.success());
    }
    #[cfg(unix)]
    #[test]
    fn relative_sdk_and_path_are_checked_from_the_child_directory() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let app = temp.path().join("app");
        fs::create_dir_all(&app).unwrap();
        adb_in(&home.join("sdk/platform-tools"));
        fs::write(home.join("sdk/platform-tools/adb"), b"#!/bin/sh\nexit 0\n").unwrap();
        let path = OsString::from("sdk/platform-tools");
        assert!(crate::host::adb_resolves(None, &path, &home));
        assert!(!crate::host::adb_resolves(None, &path, &app));
        assert!(crate::host::adb_resolves(
            Some("sdk".into()),
            &OsString::new(),
            &home
        ));
        assert!(!crate::host::adb_resolves(
            Some("sdk".into()),
            &OsString::new(),
            &app
        ));
        assert!(std::process::Command::new("adb")
            .env("PATH", &path)
            .current_dir(&home)
            .status()
            .unwrap()
            .success());
        assert_eq!(
            std::process::Command::new("adb")
                .env("PATH", &path)
                .current_dir(&app)
                .status()
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotFound
        );
        adb_in(&home);
        assert!(crate::host::adb_resolves(None, &OsString::new(), &home));
        assert!(!crate::host::adb_resolves(None, &OsString::new(), &app));
    }
    #[test]
    fn adb_is_found_only_where_the_companion_looks_for_it() {
        use crate::host::adb_resolves;
        let temp = tempfile::tempdir().unwrap();
        let (sdk, empty_sdk, bin) = (
            temp.path().join("sdk"),
            temp.path().join("empty-sdk"),
            temp.path().join("bin"),
        );
        fs::create_dir_all(&empty_sdk).unwrap();
        let path = std::env::join_paths([&bin]).unwrap();
        let sdk_root = |root: &Path| Some(OsString::from(root));
        assert!(!adb_resolves(None, &path, temp.path()));
        adb_in(&sdk.join("platform-tools"));
        // An SDK root is enough on its own, without any PATH.
        assert!(adb_resolves(sdk_root(&sdk), &OsString::new(), temp.path()));
        // adb on the PATH counts only when no SDK root is set: the companion never falls back.
        adb_in(&bin);
        assert!(adb_resolves(None, &path, temp.path()));
        assert!(!adb_resolves(sdk_root(&empty_sdk), &path, temp.path()));
    }
}
