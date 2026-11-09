//! Owned OpenSSH acceptance for repository review, Files Markdown and preview
//! listener discovery: every command runs over the real SSH session against a
//! real Git repository and real loopback listeners on the fixture host.
use super::*;
use serde_json::Value;
use std::path::Path;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

const PNG_V1: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-historical";
const PNG_V2: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-working-tree\0\xff";

fn json<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn git(repo: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture"])
        .args(["-c", "user.email=fixture@example.invalid", "-C"])
        .arg(repo)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

/// `repo` holds `file.txt` staged as "before" with "after" in the work tree.
pub(super) async fn verify(app: &App, id: &str, repo: &Path) {
    let path = repo.to_string_lossy().into_owned();
    git(repo, &["commit", "-qm", "first commit"]);
    fs::create_dir(repo.join("docs")).unwrap();
    fs::write(repo.join("docs/readme.md"), "# Review\n\n- item\n").unwrap();
    fs::write(repo.join("image.png"), PNG_V1).unwrap();
    git(repo, &["add", "--", "docs/readme.md", "image.png"]);
    git(repo, &["commit", "-qm", "second commit"]);
    fs::write(repo.join("image.png"), PNG_V2).unwrap();
    fs::create_dir(repo.join("notes")).unwrap();
    fs::write(repo.join("notes/untracked.txt"), "untracked\n").unwrap();
    fs::write(repo.join("staged-new.txt"), "staged addition\n").unwrap();
    git(repo, &["add", "--", "staged-new.txt"]);

    // Status from a subdirectory resolves the root and lists every change kind.
    let status = json(
        crate::repository::repository_status(
            app.state(),
            id.into(),
            repo.join("docs").to_string_lossy().into_owned(),
            access_lease(),
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap(),
    );
    assert_eq!(
        fs::canonicalize(status["path"].as_str().unwrap()).unwrap(),
        fs::canonicalize(repo).unwrap()
    );
    let change = |file: &str| {
        let found = status["changes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|change| change["path"] == file)
            .unwrap_or_else(|| panic!("{file} missing from {status}"));
        (
            found["index"].as_str().unwrap().to_owned(),
            found["worktree"].as_str().unwrap().to_owned(),
        )
    };
    assert_eq!(change("file.txt"), (" ".into(), "M".into()));
    assert_eq!(change("image.png"), (" ".into(), "M".into()));
    assert_eq!(change("staged-new.txt"), ("A".into(), " ".into()));
    assert_eq!(change("notes/untracked.txt"), ("?".into(), "?".into()));

    let diff = |file: &'static str, staged: bool| {
        let path = path.clone();
        async move {
            json(
                crate::repository::repository_diff(
                    app.state(),
                    id.into(),
                    path,
                    file.into(),
                    staged,
                    access_lease(),
                )
                .await
                .unwrap()
                .into_inner()
                .unwrap(),
            )
        }
    };
    let text = diff("file.txt", false).await;
    assert_eq!(text["binary"], false);
    let patch = text["patch"].as_str().unwrap();
    assert!(
        patch.contains("-before") && patch.contains("+after"),
        "{patch}"
    );
    assert_eq!(diff("image.png", false).await["binary"], true);
    let added = diff("staged-new.txt", true).await;
    assert!(added["patch"]
        .as_str()
        .unwrap()
        .contains("+staged addition"));

    // History pages newest first, by cursor and from a selected revision.
    let history = |offset: Option<u32>, revision: Option<String>| {
        let path = path.clone();
        async move {
            json(
                crate::repository::repository_history(
                    app.state(),
                    id.into(),
                    path,
                    offset,
                    revision,
                    access_lease(),
                )
                .await
                .unwrap()
                .into_inner()
                .unwrap(),
            )
        }
    };
    let commits = history(None, None).await;
    let subjects: Vec<_> = commits
        .as_array()
        .unwrap()
        .iter()
        .map(|commit| commit["subject"].as_str().unwrap())
        .collect();
    assert_eq!(subjects, ["second commit", "first commit"]);
    let second = commits[0]["oid"].as_str().unwrap().to_owned();
    let first = commits[1]["oid"].as_str().unwrap().to_owned();
    assert_eq!(history(Some(1), None).await[0]["oid"], first.as_str());
    assert_eq!(
        history(None, Some(first.clone()))
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Trees at each historical commit, including a nested directory.
    let tree = |revision: String, directory: Option<&'static str>| {
        let path = path.clone();
        async move {
            json(
                crate::repository::repository_tree(
                    app.state(),
                    id.into(),
                    path,
                    revision,
                    directory.map(Into::into),
                    access_lease(),
                )
                .await
                .unwrap()
                .into_inner()
                .unwrap(),
            )
        }
    };
    let entry = |entries: &Value, file: &str| {
        entries
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == file)
            .cloned()
    };
    let old_tree = tree(first.clone(), None).await;
    assert!(entry(&old_tree, "image.png").is_none());
    let old_file = entry(&old_tree, "file.txt").unwrap();
    let new_tree = tree(second.clone(), None).await;
    assert_eq!(entry(&new_tree, "docs").unwrap()["kind"], "tree");
    let image = entry(&new_tree, "image.png").unwrap();
    assert_eq!(image["kind"], "blob");
    assert_eq!(image["size"], PNG_V1.len());
    let readme = entry(&tree(second, Some("docs")).await, "docs/readme.md").unwrap();

    let blob = |object: &Value| {
        let path = path.clone();
        let object = object["oid"].as_str().unwrap().to_owned();
        async move {
            json(
                crate::repository::repository_blob(
                    app.state(),
                    id.into(),
                    path,
                    object,
                    access_lease(),
                )
                .await
                .unwrap()
                .into_inner()
                .unwrap(),
            )
        }
    };
    let historical = blob(&old_file).await;
    assert_eq!(
        (historical["text"].clone(), historical["binary"].clone()),
        ("before\n".into(), false.into())
    );
    let binary = blob(&image).await;
    assert_eq!(binary["binary"], true);
    assert_eq!(binary["text"], Value::Null);
    assert_eq!(binary["bytes"], PNG_V1.len());
    assert_eq!(blob(&readme).await["text"], "# Review\n\n- item\n");

    // Image previews read the working tree over SFTP and history through Git.
    let picture = |object: Option<String>| {
        let path = path.clone();
        async move {
            json(
                crate::repository::repository_image(
                    app.state(),
                    id.into(),
                    path,
                    "image.png".into(),
                    object,
                    access_lease(),
                )
                .await
                .unwrap()
                .into_inner()
                .unwrap(),
            )
        }
    };
    let working = picture(None).await;
    assert_eq!(working["mime"], "image/png");
    assert_eq!(working["data"], json(PNG_V2));
    let committed = picture(Some(image["oid"].as_str().unwrap().into())).await;
    assert_eq!(committed["data"], json(PNG_V1));

    // Files opens Markdown as text over the same SFTP channel.
    assert_eq!(
        read_file(
            access_lease(),
            app.state(),
            id.into(),
            repo.join("docs/readme.md").to_string_lossy().into_owned(),
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap(),
        "# Review\n\n- item\n"
    );
}

/// Serves `HEAD` probes until the test ends, identifying itself as Next.js.
async fn serve_http(listener: tokio::net::TcpListener) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        tokio::spawn(async move {
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") && request.len() < 4096 {
                if socket.read_exact(&mut byte).await.is_err() {
                    return;
                }
                request.push(byte[0]);
            }
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nX-Powered-By: Next.js\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        });
    }
}

/// Real `ss`/`lsof` discovery on the host, the HTTP probe through SSH, and the
/// optional allowlist filter.
pub(super) async fn verify_discovery(app: &App, id: &str) {
    // Six owned HTTP listeners alone exceed the session's four concurrent
    // channel openings, whatever else listens on the host.
    let mut http_ports = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..6 {
        let http = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        http_ports.push(http.local_addr().unwrap().port());
        servers.push(tokio::spawn(serve_http(http)));
    }
    let raw = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let raw_port = raw.local_addr().unwrap().port();
    let silent = tokio::spawn(async move {
        // Accept and close at once, so the probe sees no HTTP status line.
        while let Ok((socket, _)) = raw.accept().await {
            drop(socket);
        }
    });
    let discover = |ports: Option<Vec<u16>>, probe: bool| async move {
        json(
            crate::previews::discover_preview_ports(
                access_lease(),
                app.state(),
                id.into(),
                ports,
                Some(probe),
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap(),
        )
    };
    let listener = |rows: &Value, port: u16| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|row| row["port"] == port)
            .cloned()
    };
    let all = discover(None, true).await;
    for &http_port in &http_ports {
        let web = listener(&all, http_port).unwrap_or_else(|| panic!("{http_port} not in {all}"));
        assert_eq!(web["address"], "127.0.0.1");
        assert_eq!(web["pid"], std::process::id());
        assert!(
            web["process"].as_str().is_some_and(|name| !name.is_empty()),
            "{web}"
        );
        assert_eq!(web["http"], true, "{all}");
        assert_eq!(web["framework"], "nextJs");
    }
    assert_eq!(listener(&all, raw_port).unwrap()["http"], false);
    let ports: Vec<_> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["port"].as_u64().unwrap())
        .collect();
    assert!(ports.windows(2).all(|pair| pair[0] <= pair[1]), "{ports:?}");

    let allowed = discover(Some(vec![raw_port]), false).await;
    assert!(http_ports
        .iter()
        .all(|&port| listener(&allowed, port).is_none()));
    let only = listener(&allowed, raw_port).unwrap();
    assert_eq!(
        only["http"],
        Value::Null,
        "an unprobed listener stays unknown"
    );
    assert_eq!(
        discover(Some(Vec::new()), true).await,
        json(Vec::<()>::new())
    );
    for server in servers {
        server.abort();
    }
    silent.abort();
}
