//! Developer prototype for the host browser (docs/host-browser.md, "Prototype").
//!
//! Starts a Chrome-family browser with a throwaway profile and a random loopback debug port, reports where it
//! listens, and stops it and deletes the profile when stdin closes, on SIGINT/SIGTERM or when the browser exits.
//! Off unless the host setting `hostBrowserEnabled` is on (see [`settings`]) and `LAZYSH_DEV_HOST_BROWSER=1`:
//! the product relay is a separate, later slice.
use crate::{Error, Result};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub mod profile;
pub mod settings;

pub const ENABLE_VARIABLE: &str = "LAZYSH_DEV_HOST_BROWSER";
const CANDIDATES: [&str; 5] = [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "chrome",
];
// A cold browser on a loaded CI runner needs well over the 1 s a developer machine takes.
const START_TIMEOUT: Duration = Duration::from_secs(90);

pub struct Launch<'a> {
    /// The companion state directory: where the setting and the profiles live.
    pub state: &'a Path,
    /// **Keep profile**: reuse one profile that outlives the session, until **Clear browser data**.
    pub keep_profile: bool,
    pub binary: Option<&'a Path>,
    pub allow_origins: &'a [String],
    /// First page; `about:blank` when absent.
    pub url: Option<&'a str>,
    pub headed: bool,
    pub no_sandbox: bool,
}

/// An exact scheme://host[:port] origin; a wildcard or list would let any page drive the browser.
fn valid_origin(origin: &str) -> bool {
    let rest = ["http://", "https://", "tauri://"]
        .iter()
        .find_map(|scheme| origin.strip_prefix(scheme));
    rest.is_some_and(|rest| {
        !rest.is_empty()
            && origin.len() <= 200
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
    })
}

/// The same schemes a person may type in the product address bar: no file:, chrome:, javascript: or data:.
fn valid_url(url: &str) -> bool {
    url == "about:blank"
        || ((url.starts_with("http://") || url.starts_with("https://"))
            && url.len() <= 2048
            && url.chars().all(|c| c.is_ascii_graphic()))
}

fn find_binary(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return path
            .is_file()
            .then(|| path.to_path_buf())
            .ok_or(Error::Browser("BrowserNotFound"));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .flat_map(|dir| CANDIDATES.map(|name| dir.join(name)))
        .find(|candidate| candidate.is_file())
        .ok_or(Error::Browser("BrowserNotFound"))
}

/// `DevToolsActivePort`: first line the port, second the browser WebSocket path.
fn parse_active_port(text: &str) -> Option<(u16, String)> {
    let mut lines = text.lines();
    let port = lines
        .next()?
        .trim()
        .parse()
        .ok()
        .filter(|port| *port != 0)?;
    let path = lines.next()?.trim();
    path.starts_with("/devtools/browser/")
        .then(|| (port, path.to_string()))
}

pub fn run(launch: &Launch) -> Result<()> {
    // Before anything else: the switch is off by default and an off switch must start nothing.
    settings::require_enabled(launch.state)?;
    if std::env::var(ENABLE_VARIABLE).as_deref() != Ok("1") {
        return Err(Error::Browser("HostBrowserDevFlagOff"));
    }
    if !launch
        .allow_origins
        .iter()
        .all(|origin| valid_origin(origin))
    {
        return Err(Error::Browser("BrowserOriginInvalid"));
    }
    let url = launch.url.unwrap_or("about:blank");
    if !valid_url(url) {
        return Err(Error::Browser("BrowserUrlInvalid"));
    }
    let binary = find_binary(launch.binary)?;
    // Listening before the profile exists: a signal or a closed channel at any later point still cleans up.
    let (stop, stopped) = mpsc::channel::<()>();
    let closed = stop.clone();
    std::thread::spawn(move || {
        let mut sink = [0u8; 64];
        let mut input = io::stdin();
        while matches!(input.read(&mut sink), Ok(read) if read > 0) {}
        let _ = closed.send(());
    });
    // Also covers SIGINT, SIGTERM and SIGHUP through ctrlc's termination feature.
    let _ = ctrlc::set_handler(move || {
        let _ = stop.send(());
    });
    // Removed on drop, on every exit path below, unless the user asked to keep it. The browser keeps cookies and
    // sessions here, so it is private.
    let profile = profile::create(launch.state, launch.keep_profile)?;
    let mut command = Command::new(&binary);
    command
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-background-networking",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // The browser's own start-up errors are the only diagnosis of a browser that never listens.
        .stderr(Stdio::inherit());
    if !launch.headed {
        command.args(["--headless=new", "--disable-gpu"]);
    }
    if launch.no_sandbox {
        command.arg("--no-sandbox");
    }
    if !launch.allow_origins.is_empty() {
        command.arg(format!(
            "--remote-allow-origins={}",
            launch.allow_origins.join(",")
        ));
    }
    own_process_group(&mut command);
    die_with_launcher(&mut command);
    let mut child = command.arg(url).spawn()?;
    let started = Instant::now();
    let endpoint = loop {
        if let Ok(text) = std::fs::read_to_string(profile.path().join("DevToolsActivePort")) {
            if let Some(endpoint) = parse_active_port(&text) {
                break endpoint;
            }
        }
        if stopped.try_recv().is_ok() {
            terminate(&mut child);
            return Ok(());
        }
        if child.try_wait()?.is_some() {
            return Err(Error::Browser("BrowserExited"));
        }
        if started.elapsed() > START_TIMEOUT {
            terminate(&mut child);
            return Err(Error::Browser("BrowserStartTimeout"));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let report = serde_json::json!({
        "schemaVersion": 1,
        "port": endpoint.0,
        "path": endpoint.1,
        "pid": child.id(),
        "profile": profile.path(),
    });
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{report}")?;
    stdout.flush()?;
    drop(stdout);

    while !matches!(
        stopped.recv_timeout(Duration::from_millis(100)),
        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected)
    ) && child.try_wait()?.is_none()
    {}
    terminate(&mut child);
    Ok(())
}

/// The browser and its helper processes share one group, so one signal reaches all of them.
#[cfg(unix)]
fn own_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}
#[cfg(not(unix))]
fn own_process_group(_: &mut Command) {}

/// A launcher that is killed outright (SIGKILL, the OOM killer) cannot stop its browser, so the kernel does.
// shortcut: Linux only; elsewhere the browser stays until the host user stops it, and only its profile is
// removed at the next start. The product relay uses a pipe, which has no such gap.
#[cfg(target_os = "linux")]
fn die_with_launcher(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: prctl is async-signal-safe and the closure touches no memory of the parent.
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
}
#[cfg(not(target_os = "linux"))]
fn die_with_launcher(_: &mut Command) {}

#[cfg(unix)]
fn terminate(child: &mut Child) {
    let group = child.id() as i32;
    // SAFETY: killpg takes plain integers and only signals the group this process created.
    unsafe { libc::killpg(group, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
        std::thread::sleep(Duration::from_millis(25));
    }
    unsafe { libc::killpg(group, libc::SIGKILL) };
    let _ = child.wait();
}
// shortcut: Windows kills only the main process, the prototype is Unix-first; the product relay owns this.
#[cfg(not(unix))]
fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_must_be_exact() {
        for good in [
            "http://127.0.0.1:1420",
            "https://example.com",
            "tauri://localhost",
            "http://[::1]:80",
        ] {
            assert!(valid_origin(good), "{good}");
        }
        for bad in [
            "*",
            "http://*",
            "http://a.com,http://b.com",
            "http://a.com/path",
            "http://",
            "ftp://a.com",
            "http://a b",
            "localhost",
        ] {
            assert!(!valid_origin(bad), "{bad}");
        }
    }

    #[test]
    fn first_page_is_web_or_blank() {
        for good in [
            "about:blank",
            "http://127.0.0.1:3000/a?b=1",
            "https://example.com",
        ] {
            assert!(valid_url(good), "{good}");
        }
        for bad in [
            "file:///etc/passwd",
            "chrome://settings",
            "javascript:alert(1)",
            "data:text/html,x",
            "http://a b",
            "--no-sandbox",
            "",
        ] {
            assert!(!valid_url(bad), "{bad}");
        }
    }

    #[test]
    fn active_port_file_needs_a_port_and_a_browser_path() {
        assert_eq!(
            parse_active_port("9222\n/devtools/browser/abc\n"),
            Some((9222, "/devtools/browser/abc".into()))
        );
        for bad in [
            "",
            "0\n/devtools/browser/x",
            "9222\n/other",
            "x\n/devtools/browser/x",
            "9222",
        ] {
            assert_eq!(parse_active_port(bad), None, "{bad:?}");
        }
    }
}
