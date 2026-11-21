/// A temporary directory only the current user can reach: owner-only mode on Unix, a protected DACL on Windows.
pub fn private_tempdir() -> tempfile::TempDir {
    #[cfg(unix)]
    let directory = {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    };
    #[cfg(windows)]
    let directory = {
        let directory = tempfile::tempdir().unwrap();
        crate::windows_acl::fixtures::restrict(directory.path());
        directory
    };
    directory
}

/// Lets every account modify `path` (and, on Windows, what it holds).
pub fn expose(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o777)).unwrap();
    }
    #[cfg(windows)]
    crate::windows_acl::fixtures::expose(path);
}

/// A directory link at `link` that leads to `target`: a symbolic link on Unix, a junction on Windows.
pub fn link_directory(link: &std::path::Path, target: &std::path::Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    crate::windows_acl::fixtures::junction(link, target);
}

pub fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_uppercase)
        .collect()
}

pub fn word_error_rate(reference: &str, observed: &str) -> f64 {
    let reference = words(reference);
    let observed = words(observed);
    assert!(!reference.is_empty());
    let mut previous: Vec<usize> = (0..=observed.len()).collect();
    for (i, expected) in reference.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, actual) in observed.iter().enumerate() {
            row.push(
                (previous[j] + usize::from(expected != actual))
                    .min(previous[j + 1] + 1)
                    .min(row[j] + 1),
            );
        }
        previous = row;
    }
    previous[observed.len()] as f64 / reference.len() as f64
}

#[cfg(target_os = "linux")]
pub fn terminate_processes_matching(
    executable: &std::path::Path,
    exact_argument: &std::ffi::OsStr,
) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(command) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if matches_process(&command, executable, exact_argument.as_bytes()) {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
    }
}

#[cfg(target_os = "linux")]
fn matches_process(command: &[u8], executable: &std::path::Path, argument: &[u8]) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let args = command.split(|byte| *byte == 0).collect::<Vec<_>>();
    args.first().is_some_and(|arg| {
        std::path::Path::new(std::ffi::OsStr::from_bytes(arg)).file_name() == executable.file_name()
    }) && args.contains(&argument)
}

pub fn successful_output(command: &mut std::process::Command) -> String {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// Dev-feature adapter for the private validator observer seam; absent from normal builds.
pub fn observe_sidecar(
    kind: crate::private_state::SidecarKind,
    observe: impl FnMut() -> std::io::Result<Option<std::fs::Metadata>>,
) -> std::io::Result<()> {
    crate::private_state::observe_sidecar(kind, observe)
}
pub fn regular_state_metadata(
    path: &std::path::Path,
    message: &'static str,
) -> std::io::Result<Option<std::fs::Metadata>> {
    crate::private_state::regular_state_metadata(path, message)
}

/// A page that is one solid green and titled `Green`.
pub const GREEN_PAGE: &str =
    "<!doctype html><title>Green</title><body style=\"margin:0;background:#00c800\">";

/// A page on loopback, served to a real browser for `seconds`.
pub fn loopback_page(body: &'static str, seconds: u64) -> (u16, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        // The browser asks for the page and a favicon; stop when the test drops its relay and connections stop.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
        while std::time::Instant::now() < deadline {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            };
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (port, server)
}

#[cfg(test)]
mod tests {
    #[test]
    fn word_error_counts_insertions_deletions_and_substitutions() {
        assert_eq!(super::word_error_rate("hello world", "HELLO, world!"), 0.0);
        for observed in ["hello", "hello wide world", "hello there"] {
            assert_eq!(super::word_error_rate("hello world", observed), 0.5);
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn process_match_requires_executable_and_exact_private_argument() {
        let binary = std::path::Path::new("/fixture/etterminal");
        let command = b"/usr/bin/etterminal\0--fifo\0/private/fixture\0";
        assert!(super::matches_process(command, binary, b"/private/fixture"));
        assert!(!super::matches_process(
            command,
            binary,
            b"/private/fixture-other"
        ));
        assert!(!super::matches_process(
            command,
            std::path::Path::new("other"),
            b"/private/fixture"
        ));
    }
}

/// The id of the pane `herdr api snapshot` reports as not focused: the one a test reports an agent state for.
pub fn unfocused_herdr_pane(snapshot_json: &[u8]) -> String {
    let snapshot: serde_json::Value = serde_json::from_slice(snapshot_json).unwrap();
    let pane = snapshot["result"]["snapshot"]["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pane| pane["focused"] == false)
        .unwrap();
    pane["pane_id"].as_str().unwrap().to_owned()
}
