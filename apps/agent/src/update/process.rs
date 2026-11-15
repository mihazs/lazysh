//! Run a companion binary the way every check here does: empty environment, hard time limit, capped output.
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_OUTPUT: u64 = 64 * 1024;

/// What a finished run left: whether it exited 0, and the first 64 KiB of stdout.
pub struct Run {
    pub success: bool,
    pub stdout: Vec<u8>,
}

/// Run `path` with only `env` set, `dir` as the working directory and `stdin` as input.
/// `None` when it cannot start, does not finish in `limit`, or is killed.
pub fn run(
    path: &Path,
    args: &[&str],
    env: &[(&str, &Path)],
    dir: &Path,
    stdin: &[u8],
    limit: Duration,
) -> Option<Run> {
    let mut command = Command::new(path);
    command
        .args(args)
        .env_clear()
        .envs(env.iter().copied())
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // A process on Windows cannot even start its networking and cryptography without it.
    #[cfg(windows)]
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    // A file that was just written can be briefly busy to exec while another descriptor to it closes.
    let mut child = (0..5)
        .find_map(|attempt| match command.spawn() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempt < 4 => {
                thread::sleep(Duration::from_millis(50));
                None
            }
            result => Some(result),
        })?
        .ok()?;
    // Input and output are small and pipes buffer them; a closed pipe is the child's own business.
    let _ = child.stdin.take()?.write_all(stdin);
    let mut output = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut output).take(MAX_OUTPUT).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait().ok()? {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    Some(Run {
        success: status.success(),
        stdout: reader.join().ok()?,
    })
}

const LIMIT: Duration = Duration::from_secs(20);

/// `path --version` in a cleared environment: the `X.Y.Z` after `lazysh-agent `, when it exits 0.
pub fn version_text(path: &Path, dir: &Path) -> Option<String> {
    let run = run(path, &["--version"], &[], dir, b"", LIMIT)?;
    let text = String::from_utf8(run.stdout).ok()?;
    let version = text.trim().strip_prefix("lazysh-agent ")?;
    (run.success && lazysh_companion_release::version(version).is_some())
        .then(|| version.to_owned())
}
