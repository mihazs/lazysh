//! Real-process contract of the host browser shim. A fake CLI calls the installed wrappers
//! against a real `browser-watch` process, in a temporary home with a private runtime directory.
#![cfg(any(target_os = "linux", target_os = "macos"))]
#[path = "support/binary.rs"]
mod binary;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs,
    io::{BufRead, BufReader},
    os::unix::{
        fs::{symlink, MetadataExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

const URL: &str =
    "https://login.example.com/authorize?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F";
const BEGIN: &str = "# >>> lazysh browser shim >>>";

struct Host {
    _guard: tempfile::TempDir,
    root: PathBuf,
    binary: PathBuf,
}
impl Host {
    fn new() -> Self {
        let guard = tempfile::tempdir().unwrap();
        let root = guard.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("home/.local/share")).unwrap();
        for name in ["real", "run"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::set_permissions(root.join("run"), fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            _guard: guard,
            root,
            binary: binary::path(),
        }
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn shims(&self) -> PathBuf {
        self.home().join(".local/share/lazysh/companion/shims")
    }
    fn socket_directory(&self) -> PathBuf {
        self.root.join("run/lazysh")
    }
    /// Only the wrappers and the recording openers are on `PATH`: no opener of the machine under test.
    fn command(&self, program: impl AsRef<OsStr>) -> Command {
        let mut command = Command::new(program);
        command
            .env_clear()
            .env("HOME", self.home())
            .env("XDG_RUNTIME_DIR", self.root.join("run"))
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    self.shims().display(),
                    self.root.join("real").display()
                ),
            );
        command
    }
    fn agent(&self, args: &[&str]) -> Command {
        let mut command = self.command(&self.binary);
        command.args(args);
        command
    }
    fn shim(&self, action: &str) -> Output {
        self.agent(&["browser-shim", action, "--json"])
            .output()
            .unwrap()
    }
    fn report(&self, action: &str) -> Value {
        serde_json::from_slice(&self.shim(action).stdout).unwrap()
    }
    fn install(&self) -> Value {
        let output = self.shim("install");
        assert!(output.status.success(), "{}", text(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn launch(&self, name: &str, args: &[&str]) -> Output {
        self.command(self.shims().join(name))
            .args(args)
            .output()
            .unwrap()
    }
    /// An opener on `PATH` that appends "name|arguments|BROWSER|shims-on-PATH" to a log.
    fn recorder(&self, name: &str) {
        let script = format!(
            "#!/bin/sh\ncase \":$PATH:\" in *\":{}:\"*) s=yes;; *) s=no;; esac\nprintf '%s|%s|BROWSER=%s|SHIMS=%s\\n' \"${{0##*/}}\" \"$*\" \"${{BROWSER-unset}}\" \"$s\" >> '{}'\n",
            self.shims().display(),
            self.root.join("opened.log").display()
        );
        let path = self.root.join("real").join(name);
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn opened(&self) -> Vec<String> {
        let log = fs::read_to_string(self.root.join("opened.log")).unwrap_or_default();
        log.lines().map(str::to_owned).collect()
    }
    fn recorded(&self, program: &str, arguments: &str) -> String {
        format!("{program}|{arguments}|BROWSER=unset|SHIMS=no")
    }
    fn write(&self, relative: &str, content: &[u8]) -> PathBuf {
        let path = self.home().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }
    fn watch(&self, heartbeat: &str) -> Watcher {
        let mut child = self
            .agent(&[
                "browser-watch",
                "--protocol",
                "1",
                "--heartbeat-seconds",
                heartbeat,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let (frames, inbox) = mpsc::channel();
        std::thread::spawn(move || {
            for line in output.lines().map_while(Result::ok) {
                let _ = frames.send(serde_json::from_str::<Value>(&line).unwrap());
            }
        });
        let watcher = Watcher { child, inbox };
        assert_eq!(watcher.frame()["type"], "hello");
        watcher
    }
}

struct Watcher {
    child: Child,
    inbox: mpsc::Receiver<Value>,
}
impl Watcher {
    fn frame(&self) -> Value {
        self.inbox
            .recv_timeout(Duration::from_secs(10))
            .expect("a frame")
    }
    /// The next frame that is not a heartbeat.
    fn event(&self) -> Value {
        loop {
            let frame = self.frame();
            if frame["type"] != "heartbeat" {
                return frame;
            }
        }
    }
    fn end(&mut self) -> Value {
        drop(self.child.stdin.take());
        let frame = self.event();
        assert!(self.child.wait().unwrap().success());
        frame
    }
}
impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
/// Every path under `root` with its mode and content, or its link target.
fn tree(root: &Path) -> BTreeMap<String, String> {
    fn walk(path: &Path, root: &Path, into: &mut BTreeMap<String, String>) {
        let metadata = fs::symlink_metadata(path).unwrap();
        let description = if metadata.is_dir() {
            "directory".to_owned()
        } else if metadata.is_symlink() {
            format!("link {}", fs::read_link(path).unwrap().display())
        } else {
            format!("{:o} {}", metadata.mode(), text(&fs::read(path).unwrap()))
        };
        into.insert(
            path.strip_prefix(root).unwrap().display().to_string(),
            description,
        );
        if metadata.is_dir() {
            for entry in fs::read_dir(path).unwrap() {
                walk(&entry.unwrap().path(), root, into);
            }
        }
    }
    let mut into = BTreeMap::new();
    walk(root, root, &mut into);
    into
}
/// The report row of a wrapper (section "shims") or startup file (section "startup") by name.
fn entry<'a>(report: &'a Value, section: &str, name: &str) -> &'a Value {
    let (rows, key) = if section == "shims" {
        (&report["shims"]["entries"], "name")
    } else {
        (&report["startup"], "path")
    };
    rows.as_array()
        .unwrap()
        .iter()
        .find(|row| row[key].as_str().unwrap().ends_with(name))
        .unwrap_or(&Value::Null)
}
fn state(report: &Value, section: &str, name: &str) -> String {
    entry(report, section, name)["state"]
        .as_str()
        .unwrap_or("not listed")
        .to_owned()
}

#[test]
fn a_fake_cli_reaches_the_device_through_every_launcher_it_may_use() {
    let host = Host::new();
    host.install();
    let mut watcher = host.watch("15");
    let script = host.root.join("fake-sso-cli");
    fs::write(
        &script,
        "#!/bin/sh\nxdg-open \"$U1\" || exit 11\nsensible-browser \"$U2\" || exit 12\nx-www-browser \"$U3\" || exit 13\nlazysh-open --new-window \"$U4\" || exit 14\n$BROWSER \"$U5\" || exit 15\n\"$AGENT\" browser-open \"$U6\" || exit 16\n",
    )
    .unwrap();
    let urls: Vec<String> = (1..=6)
        .map(|n| format!("https://idp.example.com/start/{n}?state=s{n}"))
        .collect();
    let mut cli = host.command("/bin/sh");
    cli.arg(&script)
        .env("BROWSER", "lazysh-open")
        .env("AGENT", &host.binary);
    for (n, url) in urls.iter().enumerate() {
        cli.env(format!("U{}", n + 1), url);
    }
    let output = cli.output().unwrap();
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(output.stdout.is_empty() && output.stderr.is_empty());
    let launchers = [
        "xdg-open",
        "sensible-browser",
        "x-www-browser",
        "lazysh-open",
        "lazysh-open",
        "browser-open",
    ];
    for (url, launcher) in urls.iter().zip(launchers) {
        let frame = watcher.event();
        assert_eq!(frame["type"], "open");
        assert_eq!(frame["url"], url.as_str());
        assert_eq!(frame["launcher"], launcher);
        assert_eq!(frame["id"].as_str().unwrap().len(), 36);
        assert!(frame["pid"].as_u64().unwrap() > 1 && frame["at"].as_str().unwrap().ends_with('Z'));
        // The command that asked is named, never its arguments.
        let chain = frame["chain"].as_array().unwrap();
        assert!(
            matches!(chain[0].as_str(), Some("sh" | "bash" | "dash")),
            "{chain:?}"
        );
    }
    assert_eq!(watcher.end()["reason"], "stdin-closed");
}

#[cfg(target_os = "linux")]
#[test]
fn the_frame_names_the_ports_the_asking_process_listens_on() {
    let host = Host::new();
    host.install();
    let watcher = host.watch("15");
    // This test process plays the CLI: it owns the callback listener and is the launcher's parent.
    let callback = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = callback.local_addr().unwrap().port();
    assert!(host.launch("xdg-open", &[URL]).status.success());
    let frame = watcher.event();
    let listeners = frame["listeners"].as_array().unwrap();
    assert!(
        listeners
            .iter()
            .any(|l| l["port"] == port && l["address"] == "127.0.0.1"),
        "{frame}"
    );
    assert!(listeners
        .iter()
        .all(|l| l["port"].as_u64().unwrap() >= 1024));
}

#[test]
fn python_webbrowser_with_browser_set_is_caught() {
    if Command::new("python3").arg("--version").output().is_err() {
        eprintln!("python3 is not installed here; the webbrowser check is not run");
        return;
    }
    let host = Host::new();
    host.install();
    let watcher = host.watch("15");
    let path = format!("{}:/usr/bin:/bin", host.shims().display());
    let status = host
        .command("python3")
        .env("PATH", path)
        .env("BROWSER", "lazysh-open")
        .args([
            "-I",
            "-c",
            "import sys, webbrowser; webbrowser.open(sys.argv[1])",
            URL,
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let frame = watcher.event();
    assert_eq!(frame["url"], URL);
    assert!(
        frame["chain"][0].as_str().unwrap().starts_with("python"),
        "{frame}"
    );
}

#[test]
fn an_attached_device_answers_inside_100_ms_and_a_repeat_is_not_delivered_twice() {
    let host = Host::new();
    host.install();
    let watcher = host.watch("15");
    let mut elapsed = Vec::new();
    for _ in 0..9 {
        let started = Instant::now();
        let output = host.launch("xdg-open", &[URL]);
        elapsed.push(started.elapsed());
        assert!(output.status.success() && output.stdout.is_empty() && output.stderr.is_empty());
    }
    elapsed.sort();
    assert!(
        elapsed[4] < Duration::from_millis(100),
        "median of {elapsed:?}"
    );
    host.launch("xdg-open", &["https://other.example.com/"]);
    assert_eq!(watcher.event()["url"], URL);
    assert_eq!(watcher.event()["url"], "https://other.example.com/");
}

#[test]
fn a_watcher_that_never_answers_delays_a_launcher_by_its_deadline_not_longer() {
    let host = Host::new();
    host.install();
    host.recorder("xdg-open");
    fs::create_dir(host.socket_directory()).unwrap();
    fs::set_permissions(host.socket_directory(), fs::Permissions::from_mode(0o700)).unwrap();
    let silent = UnixListener::bind(host.socket_directory().join("browser.sock")).unwrap();
    let started = Instant::now();
    assert!(host.launch("xdg-open", &[URL]).status.success());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(host.opened(), [host.recorded("xdg-open", URL)]);
    drop(silent);
}

#[test]
fn without_a_device_the_real_opener_gets_the_request_with_the_users_own_environment() {
    let host = Host::new();
    host.install();
    host.recorder("xdg-open");
    host.recorder("firefox-fake");
    assert!(host
        .launch("xdg-open", &["--new-window", URL])
        .status
        .success());
    assert_eq!(
        host.opened(),
        [host.recorded("xdg-open", &format!("--new-window {URL}"))]
    );
    // The user's BROWSER, saved by the startup block, comes first, with %s replaced.
    let mut browser = host.command(host.shims().join("lazysh-open"));
    browser
        .arg(URL)
        .env("BROWSER", "lazysh-open")
        .env("LAZYSH_ORIGINAL_BROWSER", "firefox-fake --private %s");
    assert!(browser.status().unwrap().success());
    assert_eq!(
        host.opened()[1],
        format!("firefox-fake|--private {URL}|BROWSER=firefox-fake --private %s|SHIMS=no")
    );
    // With none saved the platform's usual opener runs, and BROWSER=lazysh-open is not forwarded to it.
    host.launch("lazysh-open", &[URL]);
    assert_eq!(host.opened()[2], host.recorded("xdg-open", URL));
}

#[test]
fn with_no_opener_and_no_device_the_url_is_printed_for_link_detection() {
    let host = Host::new();
    host.install();
    // A stale copy of the wrappers earlier on PATH is skipped, never run in a loop.
    let stale = host.root.join("stale");
    fs::create_dir(&stale).unwrap();
    symlink(
        fs::read_link(host.shims().join("xdg-open")).unwrap(),
        stale.join("xdg-open"),
    )
    .unwrap();
    let output = host
        .command(host.shims().join("xdg-open"))
        .arg(URL)
        .env(
            "PATH",
            format!("{}:{}", stale.display(), host.shims().display()),
        )
        .output()
        .unwrap();
    assert!(output.status.success() && output.stdout.is_empty());
    assert_eq!(
        text(&output.stderr),
        format!("lazysh: open this on your device: {URL}\n")
    );
    // Not a URL: nothing to print, and the caller learns that no opener exists.
    assert_eq!(
        host.launch("xdg-open", &["/etc/hosts"]).status.code(),
        Some(3)
    );
}

#[test]
fn requests_that_are_not_clean_web_urls_never_reach_the_device() {
    let host = Host::new();
    host.install();
    host.recorder("xdg-open");
    let watcher = host.watch("15");
    let oversized = format!("https://example.com/{}", "a".repeat(5000));
    let hostile = [
        "file:///etc/passwd",
        "mailto:root@example.com",
        "myapp://callback?code=1",
        "https://user:secret@example.com/",
        "https://example.com/\u{1b}]52;c;AAAA\u{7}",
        "https://example.com/with space",
        oversized.as_str(),
    ];
    for argument in hostile {
        assert!(host.launch("xdg-open", &[argument]).status.success());
    }
    assert_eq!(host.opened().len(), hostile.len());
    assert_eq!(
        host.opened()[2],
        host.recorded("xdg-open", "myapp://callback?code=1")
    );
    host.launch("xdg-open", &["https://after.example.com/"]);
    // Had any hostile request been queued it would arrive before this one.
    assert_eq!(watcher.event()["url"], "https://after.example.com/");
}

#[test]
fn a_raw_client_cannot_queue_what_the_launcher_would_refuse() {
    use std::io::{Read, Write};
    let host = Host::new();
    let watcher = host.watch("15");
    let ask = |request: &[u8]| {
        let mut stream =
            std::os::unix::net::UnixStream::connect(host.socket_directory().join("browser.sock"))
                .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let _ = stream.write_all(request);
        let mut reply = String::new();
        let _ = stream.read_to_string(&mut reply);
        reply
    };
    for request in [
        &b"{\"v\":1,\"op\":\"open\",\"url\":\"javascript:alert(1)\"}\n"[..],
        b"{\"v\":1,\"op\":\"open\",\"url\":\"file:///etc/passwd\"}\n",
        b"{\"v\":9,\"op\":\"open\",\"url\":\"https://example.com/\"}\n",
        b"{\"v\":1,\"op\":\"open\",\"url\":\"https://u:p@example.com/\"}\n",
        b"\xff\xfe not json\n",
    ] {
        assert!(ask(request).contains("\"ok\":false"), "{}", text(request));
    }
    // Far more than a request may be: the connection is cut without a queued open.
    ask(&vec![b'a'; 200_000]);
    assert!(
        ask(b"{\"v\":1,\"op\":\"open\",\"url\":\"https://fine.example.com/\"}\n")
            .contains("\"ok\":true")
    );
    assert_eq!(watcher.event()["url"], "https://fine.example.com/");
}

#[test]
fn a_flood_of_launchers_is_limited_and_the_watcher_stays_up() {
    let host = Arc::new(Host::new());
    host.install();
    let watcher = host.watch("15");
    let runs: Vec<_> = (0..100)
        .map(|n| {
            let host = host.clone();
            std::thread::spawn(move || {
                host.launch("xdg-open", &[&format!("https://flood.example.com/{n}")])
            })
        })
        .collect();
    let outputs: Vec<Output> = runs.into_iter().map(|run| run.join().unwrap()).collect();
    let refused: Vec<&Output> = outputs
        .iter()
        .filter(|output| output.status.code() == Some(1))
        .collect();
    assert!(outputs
        .iter()
        .all(|output| matches!(output.status.code(), Some(0 | 1))));
    assert!(
        !refused.is_empty()
            && refused
                .iter()
                .all(|output| text(&output.stderr).contains("rate-limited"))
    );
    // Six a minute reach the app, whatever the load; the seventh never does.
    let delivered: std::collections::BTreeSet<String> = (0..6)
        .map(|_| watcher.event()["url"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(delivered.len(), 6);
    assert!(watcher
        .inbox
        .recv_timeout(Duration::from_millis(500))
        .is_err());
    assert_eq!(host.report("status")["watcher"]["attached"], true);
    // The same URL from a hundred processes is one open.
    let host2 = Arc::new(Host::new());
    host2.install();
    let watcher = host2.watch("15");
    let runs: Vec<_> = (0..100)
        .map(|_| {
            let host = host2.clone();
            std::thread::spawn(move || host.launch("xdg-open", &[URL]))
        })
        .collect();
    assert!(runs
        .into_iter()
        .all(|run| run.join().unwrap().status.success()));
    assert_eq!(watcher.event()["url"], URL);
    assert!(watcher
        .inbox
        .recv_timeout(Duration::from_millis(500))
        .is_err());
}

#[test]
fn the_last_watcher_to_attach_wins_and_a_closed_one_leaves_no_socket() {
    let host = Host::new();
    host.install();
    let mut first = host.watch("1");
    let mut second = host.watch("1");
    assert_eq!(first.event()["reason"], "replaced");
    assert!(first.child.wait().unwrap().success());
    host.launch("xdg-open", &[URL]);
    assert_eq!(second.event()["url"], URL);
    assert_eq!(second.frame()["type"], "heartbeat");
    let socket = host.socket_directory().join("browser.sock");
    assert!(socket.exists());
    assert_eq!(second.end()["reason"], "stdin-closed");
    assert!(!socket.exists());
    assert_eq!(host.report("status")["watcher"]["attached"], false);
}

#[test]
fn a_terminated_watcher_says_so_and_cleans_up() {
    let host = Host::new();
    let mut watcher = host.watch("15");
    // SAFETY: signals the child this test spawned.
    unsafe { libc::kill(watcher.child.id() as i32, libc::SIGTERM) };
    assert_eq!(watcher.event()["reason"], "terminated");
    assert!(watcher.child.wait().unwrap().success());
    assert!(!host.socket_directory().join("browser.sock").exists());
}

#[test]
fn an_unknown_protocol_is_refused_so_the_app_can_ask_for_a_companion_update() {
    let host = Host::new();
    let output = host
        .agent(&["browser-watch", "--protocol", "2"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn the_socket_directory_is_private_and_unsafe_ones_are_refused_by_both_sides() {
    let host = Host::new();
    host.install();
    let mut watcher = host.watch("15");
    let directory = host.socket_directory();
    let (dir, socket) = (
        fs::metadata(&directory).unwrap(),
        fs::metadata(directory.join("browser.sock")).unwrap(),
    );
    assert_eq!((dir.mode() & 0o777, socket.mode() & 0o777), (0o700, 0o600));
    watcher.end();
    for open in [true, false] {
        let _ = fs::remove_dir_all(&directory);
        let planted = if open {
            fs::create_dir(&directory).unwrap();
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
            directory.clone()
        } else {
            let elsewhere = host.root.join("elsewhere");
            fs::create_dir(&elsewhere).unwrap();
            symlink(&elsewhere, &directory).unwrap();
            elsewhere
        };
        let output = host
            .agent(&["browser-watch", "--protocol", "1"])
            .output()
            .unwrap();
        assert!(
            !output.status.success()
                && text(&output.stderr).contains("BrowserUnsafeSocketDirectory")
        );
        // A socket someone else planted there is never connected to: the URL stays on the host.
        let squatter = UnixListener::bind(planted.join("browser.sock")).unwrap();
        squatter.set_nonblocking(true).unwrap();
        let output = host.launch("xdg-open", &[URL]);
        assert_eq!(
            text(&output.stderr),
            format!("lazysh: open this on your device: {URL}\n")
        );
        assert_eq!(
            squatter.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}

#[test]
fn a_wrapper_whose_binary_is_gone_is_skipped_by_the_shell_in_favour_of_the_next_opener() {
    let host = Host::new();
    host.recorder("xdg-open");
    let dangling = host.root.join("dangling");
    fs::create_dir(&dangling).unwrap();
    symlink("/nonexistent/lazysh-agent", dangling.join("xdg-open")).unwrap();
    let path = format!(
        "{}:{}",
        dangling.display(),
        host.root.join("real").display()
    );
    let status = host
        .command("/bin/sh")
        .args(["-c", "xdg-open \"$0\""])
        .arg(URL)
        .env("PATH", path)
        .status()
        .unwrap();
    assert!(status.success());
    assert_eq!(host.opened(), [host.recorded("xdg-open", URL)]);
}

#[test]
fn install_status_and_uninstall_are_idempotent_and_leave_a_fresh_home_as_it_was() {
    let host = Host::new();
    let before = tree(&host.home());
    let installed = host.install();
    assert_eq!(installed["complete"], true);
    let target = fs::canonicalize(&host.binary).unwrap();
    for entry in installed["shims"]["entries"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        assert_eq!(entry["state"], "linked");
        assert_eq!(fs::read_link(host.shims().join(name)).unwrap(), target);
    }
    assert_eq!(
        fs::read_to_string(host.home().join(".profile"))
            .unwrap()
            .matches(BEGIN)
            .count(),
        1
    );
    assert_eq!(fs::metadata(host.shims()).unwrap().mode() & 0o777, 0o700);
    let snapshot = tree(&host.home());
    let again = host.install();
    assert_eq!(state(&again, "shims", "xdg-open"), "unchanged");
    assert_eq!(state(&again, "startup", ".profile"), "unchanged");
    assert_eq!(tree(&host.home()), snapshot);
    let status = host.report("status");
    assert_eq!(
        (&status["installed"], &status["watcher"]["attached"]),
        (&Value::Bool(true), &Value::Bool(false))
    );
    let human = text(
        &host
            .agent(&["browser-shim", "status"])
            .output()
            .unwrap()
            .stdout,
    );
    assert!(
        human.contains("  xdg-open: present") && human.contains("device attached: no"),
        "{human}"
    );
    let watcher = host.watch("15");
    assert_eq!(host.report("status")["watcher"]["attached"], true);
    drop(watcher);
    assert_eq!(host.report("uninstall")["complete"], true);
    assert_eq!(tree(&host.home()), before);
    assert_eq!(host.report("status")["installed"], false);
}

/// What a shell of this host sees after install, through the shell's own startup files.
fn shell_view(
    host: &Host,
    shell: &str,
    flag: &str,
    script: &str,
    browser: Option<&str>,
) -> Option<String> {
    let mut command = Command::new(shell);
    command
        .env_clear()
        .env("HOME", host.home())
        .env("PATH", "/usr/bin:/bin")
        .args([flag, script]);
    if let Some(browser) = browser {
        command.env("BROWSER", browser);
    }
    let output = command.output().ok()?;
    Some(
        text(&output.stdout)
            .lines()
            .last()
            .unwrap_or_default()
            .to_owned(),
    )
}

#[test]
fn existing_startup_files_are_edited_in_place_and_restored_byte_for_byte() {
    let host = Host::new();
    host.write(".profile", b"export A=1");
    host.write(".bashrc", b"# bashrc\nalias x=y\n");
    host.write(".bash_profile", b"x\r\n\xff\n");
    host.write("dotfiles/zshrc", b"# zsh\n\n");
    symlink("dotfiles/zshrc", host.home().join(".zshrc")).unwrap();
    fs::create_dir_all(host.home().join(".config/fish")).unwrap();
    let before = tree(&host.home());
    let installed = host.install();
    for file in [
        ".profile",
        ".bashrc",
        ".bash_profile",
        ".zshrc",
        "lazysh-browser.fish",
    ] {
        assert_eq!(state(&installed, "startup", file), "installed", "{file}");
    }
    assert!(fs::symlink_metadata(host.home().join(".zshrc"))
        .unwrap()
        .is_symlink());
    assert!(fs::read_to_string(host.home().join("dotfiles/zshrc"))
        .unwrap()
        .starts_with("# zsh\n\n\n# >>> lazysh"));
    assert!(fs::read(host.home().join(".bash_profile"))
        .unwrap()
        .starts_with(b"x\r\n\xff\n"));
    let shims = host.shims().display().to_string();
    // Each shell, started the way a terminal starts it, puts the wrappers first and takes over BROWSER.
    let posix = "printf '%s|%s|%s\\n' \"$BROWSER\" \"${PATH%%:*}\" \"$LAZYSH_ORIGINAL_BROWSER\"";
    let fish = "printf '%s|%s|%s\\n' $BROWSER $PATH[1] $LAZYSH_ORIGINAL_BROWSER";
    for (shell, script) in [("bash", posix), ("zsh", posix), ("fish", fish)] {
        let Some(view) = shell_view(&host, shell, "-ic", script, Some("firefox")) else {
            eprintln!("{shell} is not installed here; its startup block is not run");
            continue;
        };
        assert_eq!(view, format!("lazysh-open|{shims}|firefox"), "{shell}");
    }
    // A nested shell must not save the wrapper as the user's browser; a scripted one is left alone.
    let nested = shell_view(
        &host,
        "bash",
        "-ic",
        "bash -ic 'echo $LAZYSH_ORIGINAL_BROWSER'",
        Some("firefox"),
    );
    assert_eq!(nested.unwrap(), "firefox");
    let scripted = shell_view(
        &host,
        "bash",
        "-c",
        ". ~/.profile; echo ${BROWSER-unset}",
        None,
    );
    assert_eq!(scripted.unwrap(), "unset");
    let removed = host.report("uninstall");
    assert_eq!(removed["complete"], true);
    // fish writes its own state while it runs, and keeps the empty conf.d directory it was given.
    let mut after = tree(&host.home());
    after.retain(|path, _| {
        ![
            ".cache",
            ".local/share/fish",
            ".config/fish/fish_variables",
            ".config/fish/conf.d",
        ]
        .iter()
        .any(|own| path.starts_with(own))
    });
    assert_eq!(after, before);
}

#[test]
fn startup_files_that_cannot_be_edited_safely_are_reported_and_left_alone() {
    let host = Host::new();
    let outside = tempfile::tempdir().unwrap();
    let elsewhere = outside.path().join("bashrc");
    fs::write(&elsewhere, "# not in the home\n").unwrap();
    symlink(&elsewhere, host.home().join(".bashrc")).unwrap();
    let unterminated = format!("keep\n{BEGIN}\nhand edited\n");
    host.write(".zshrc", unterminated.as_bytes());
    let readonly = host.write(".bash_profile", b"# read only\n");
    fs::set_permissions(&readonly, fs::Permissions::from_mode(0o444)).unwrap();
    let before = (tree(outside.path()), tree(&host.home()));
    let output = host.shim("install");
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["complete"], false);
    assert_eq!(state(&report, "startup", ".bashrc"), "skipped");
    assert_eq!(
        entry(&report, "startup", ".bashrc")["reason"],
        "outsideHome"
    );
    assert_eq!(
        entry(&report, "startup", ".zshrc")["reason"],
        "unterminatedBlock"
    );
    assert_eq!(
        entry(&report, "startup", ".bash_profile")["reason"],
        "readOnly"
    );
    assert_eq!(state(&report, "startup", ".zshrc"), "failed");
    assert_eq!(state(&report, "startup", ".bash_profile"), "skipped");
    assert_eq!(state(&report, "startup", ".profile"), "installed");
    assert_eq!(tree(outside.path()), before.0);
    assert_eq!(
        fs::read_to_string(host.home().join(".zshrc")).unwrap(),
        unterminated
    );
    // Uninstall removes what was written and still names what it could not touch.
    let output = host.shim("uninstall");
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(state(&report, "startup", ".profile"), "removed");
    let mut after = tree(&host.home());
    after.retain(|path, _| !path.starts_with(".local/share/lazysh"));
    assert_eq!(after, before.1);
}

#[test]
fn a_wrapper_name_taken_by_another_file_is_never_replaced() {
    let host = Host::new();
    fs::create_dir_all(host.shims()).unwrap();
    fs::set_permissions(host.shims(), fs::Permissions::from_mode(0o700)).unwrap();
    let mine = host.shims().join("xdg-open");
    fs::write(&mine, "#!/bin/sh\necho mine\n").unwrap();
    let output = host.shim("install");
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(state(&report, "shims", "xdg-open"), "conflict");
    assert_eq!(state(&report, "shims", "lazysh-open"), "linked");
    assert_eq!(fs::read_to_string(&mine).unwrap(), "#!/bin/sh\necho mine\n");
    let report = host.report("uninstall");
    assert_eq!(state(&report, "shims", "xdg-open"), "kept");
    assert_eq!(state(&report, "shims", "lazysh-open"), "removed");
    assert_eq!(fs::read_dir(host.shims()).unwrap().count(), 1);
}

#[test]
fn nothing_is_written_outside_the_home_or_into_a_directory_that_cannot_be_written() {
    let host = Host::new();
    let outside = tempfile::tempdir().unwrap();
    let output = host
        .agent(&["browser-shim", "install"])
        .env("XDG_DATA_HOME", outside.path())
        .output()
        .unwrap();
    assert!(!output.status.success() && text(&output.stderr).contains("BrowserOutsideHome"));
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    assert!(!host.home().join(".profile").exists());
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!(
            "running as root: directory permissions do not bind, the read-only checks are not run"
        );
        return;
    }
    host.write(".bashrc", b"# bashrc\n");
    let before = tree(&host.home());
    let data = host.home().join(".local/share");
    fs::set_permissions(&data, fs::Permissions::from_mode(0o555)).unwrap();
    let output = host.shim("install");
    fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!output.status.success() && text(&output.stderr).contains("BrowserHomeNotWritable"));
    assert_eq!(tree(&host.home()), before);
    // A home whose files cannot be replaced: each failure is named, nothing is half written.
    fs::create_dir_all(host.shims()).unwrap();
    fs::set_permissions(host.shims(), fs::Permissions::from_mode(0o700)).unwrap();
    let before = tree(&host.home());
    fs::set_permissions(host.home(), fs::Permissions::from_mode(0o555)).unwrap();
    let output = host.shim("install");
    fs::set_permissions(host.home(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["complete"], false);
    for file in [".profile", ".bashrc"] {
        assert_eq!(
            (
                state(&report, "startup", file).as_str(),
                entry(&report, "startup", file)["reason"].as_str()
            ),
            ("failed", Some("notWritable"))
        );
    }
    let mut after = tree(&host.home());
    after.retain(|path, _| !path.starts_with(".local/share/lazysh/companion/shims/"));
    assert_eq!(after, before);
}
