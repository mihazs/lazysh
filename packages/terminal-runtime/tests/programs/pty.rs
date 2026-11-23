//! A real program on a pty with the core as its terminal: the program's output is fed to a
//! `TerminalRuntime`, the replies the core produces (device attributes, mode and version queries)
//! go back to the program the way a transport writes them, and keys are encoded by the core
//! before they reach the program. What a test asserts is what the program did with that.

use lazysh_terminal_runtime::{
    Config, DomKey, KeyInput, Offer, RgbColor, Size, TerminalRuntime, Theme,
};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);

/// Programs the `herdr-native` job installs or builds, so a missing one fails a CI run. The agent TUIs
/// are not installable there: their tests skip wherever the program is missing.
const CI_INSTALLED: [&str; 4] = ["tmux", "vim", "herdr", "bash"];

/// The executable for `name`: `LAZYSH_TEST_<NAME>` or the PATH.
pub fn find(name: &str) -> Option<PathBuf> {
    let var = format!("LAZYSH_TEST_{}", name.to_ascii_uppercase());
    let found = std::env::var_os(&var).map(PathBuf::from).or_else(|| {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        assert!(
            std::env::var_os("CI").is_none() || !CI_INSTALLED.contains(&name),
            "{name} is not installed (set {var})"
        );
        eprintln!("skipped: {name} is not installed (set {var})");
    }
    found
}

const MARKER: &str = "LAZYSH_TEST_PROGRAM";

/// Names this test process's programs: a daemon that detaches (its own session, parent init) keeps it.
fn marker() -> String {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{n}", std::process::id())
}

/// Whether `pid` is running. A process that was killed and is not yet reaped by its parent (a zombie, `Z`,
/// or `X`) keeps its `/proc/<pid>` entry but runs nothing, so only an absent or such an entry is not running.
pub fn running(pid: i32) -> bool {
    // The state is the first field after the command name, which is in parentheses and may contain any byte.
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rsplit_once(')')
            .and_then(|(_, fields)| fields.trim_start().chars().next())
            .is_some_and(|state| !matches!(state, 'Z' | 'X'))
    })
}

/// Kill every process whose environment carries `marker` (Linux; elsewhere nothing is found) and wait,
/// bounded, until they are no longer running. A killed process stops showing its environment as soon as it
/// releases its memory, which is before it has exited, so the processes killed are waited for by pid.
pub fn reap_descendants(marker: &str) {
    let needle = format!("{MARKER}={marker}");
    let found = || -> Vec<i32> {
        let me = std::process::id() as i32;
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return vec![];
        };
        dir.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
            .filter(|pid| *pid != me)
            .filter(|pid| {
                std::fs::read(format!("/proc/{pid}/environ"))
                    .is_ok_and(|env| env.split(|b| *b == 0).any(|v| v == needle.as_bytes()))
            })
            .collect()
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut killed: Vec<i32> = Vec::new();
    loop {
        let pids = found();
        killed.extend(&pids);
        if (pids.is_empty() && !killed.iter().any(|pid| running(*pid))) || Instant::now() > deadline
        {
            return;
        }
        for pid in pids {
            // SAFETY: signalling a pid has no memory effects.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A scratch directory that is removed with the guard.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(label: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("lazysh-programs-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    /// A new directory under the scratch directory, as the string an environment variable takes.
    pub fn dir(&self, name: &str) -> String {
        std::fs::create_dir_all(self.path(name)).unwrap();
        self.path(name).into_os_string().into_string().unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Program {
    pub rt: TerminalRuntime,
    /// What the core sent to the program unasked: every reply to a query.
    pub replies: Vec<u8>,
    /// Everything the program printed.
    pub printed: Vec<u8>,
    master: File,
    output: Receiver<Vec<u8>>,
    child: Child,
    /// Commands that stop what the program leaves behind (a server that outlives its client).
    cleanup: Vec<Command>,
    marker: String,
}

impl Program {
    /// Start `program` on a pty of `cols` by `rows` with a private environment: `TERM=xterm-256color`
    /// (what lazysh sets) and `env`, nothing inherited but `PATH`.
    pub fn start(
        program: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        cols: u16,
        rows: u16,
    ) -> Self {
        Self::start_themed(program, args, env, cols, rows, Theme::default())
    }

    /// As `start`, with the core answering colour queries from `theme`.
    pub fn start_themed(
        program: &Path,
        args: &[&str],
        env: &[(&str, &str)],
        cols: u16,
        rows: u16,
        theme: Theme,
    ) -> Self {
        let (mut master, mut slave) = (0, 0);
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: both out-pointers are valid, the name and termios arguments may be null.
        let opened = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                &size,
            )
        };
        assert_eq!(opened, 0, "openpty: {}", std::io::Error::last_os_error());
        // SAFETY: openpty returned two descriptors that nothing else owns.
        let (master, slave) = unsafe { (File::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        let marker = marker();
        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("TERM", "xterm-256color")
            .env("LANG", "C.UTF-8")
            .env(MARKER, &marker)
            .envs(env.iter().copied())
            .stdin(slave.try_clone().unwrap())
            .stdout(slave.try_clone().unwrap())
            .stderr(slave);
        // SAFETY: only async-signal-safe calls run between fork and exec.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                Ok(())
            });
        }
        let child = command
            .spawn()
            .unwrap_or_else(|e| panic!("{program:?}: {e}"));
        let (sender, output) = channel();
        let mut reader = master.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut buffer = vec![0; 16 * 1024];
            // A read fails with EIO once the program and every child of its session are gone.
            while let Ok(n @ 1..) = reader.read(&mut buffer) {
                if sender.send(buffer[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let rt = TerminalRuntime::new(Config {
            size: Size::new(cols, rows),
            theme,
            ..Config::default()
        })
        .expect("runtime");
        Self {
            rt,
            replies: Vec::new(),
            printed: Vec::new(),
            master,
            output,
            child,
            cleanup: Vec::new(),
            marker,
        }
    }

    pub fn cleanup_with(&mut self, command: Command) {
        self.cleanup.push(command);
    }

    /// Feed the core what the program prints for `wait`, answering its queries as they come.
    pub fn pump(&mut self, wait: Duration) {
        let deadline = Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.output.recv_timeout(left) {
                Ok(chunk) => self.feed(chunk),
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    fn feed(&mut self, chunk: Vec<u8>) {
        self.printed.extend_from_slice(&chunk);
        assert!(matches!(self.rt.offer(chunk), Offer::Accepted));
        self.rt.pump(usize::MAX);
        let (reply, _) = self.rt.take_replies();
        if !reply.is_empty() {
            self.master.write_all(&reply).unwrap();
            self.replies.extend_from_slice(&reply);
        }
    }

    pub fn screen(&self) -> String {
        self.rt.viewport_text().unwrap()
    }

    /// The text of the cell at column `x`, row `y` of the visible screen ("" when it is blank).
    pub fn cell(&mut self, x: u16, y: u16) -> String {
        let frame = self.rt.snapshot().unwrap();
        let row = frame.dirty.iter().find(|row| row.y == y).unwrap();
        row.cells[usize::from(x)].text.clone()
    }

    /// The background colour most cells of the visible screen have: what the program painted its screen with.
    pub fn dominant_background(&mut self) -> Option<RgbColor> {
        let frame = self.rt.snapshot().unwrap();
        let mut counts = std::collections::HashMap::new();
        for cell in frame.dirty.iter().flat_map(|row| &row.cells) {
            if let Some(bg) = cell.bg {
                *counts.entry((bg.r, bg.g, bg.b)).or_insert(0usize) += 1;
            }
        }
        let (&(r, g, b), _) = counts.iter().max_by_key(|(_, n)| **n)?;
        Some(RgbColor { r, g, b })
    }

    /// Resize the pty (the program gets SIGWINCH) and the core's grid together, as a window change does.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: the master descriptor is open and `size` is a valid winsize.
        let done = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &size) };
        assert_eq!(done, 0, "TIOCSWINSZ: {}", std::io::Error::last_os_error());
        self.rt.request_size(Size::new(cols, rows)).unwrap();
    }

    /// Run the program until `done` accepts the visible text, and return that text.
    pub fn wait_for(&mut self, what: &str, done: impl Fn(&str) -> bool) -> String {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            self.pump(Duration::from_millis(50));
            let screen = self.screen();
            if done(&screen) {
                return screen;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}; the screen shows:\n{screen}\nthe core sent back {} bytes",
                self.replies.len()
            );
        }
    }

    /// Run the program until it has printed `bytes`: a TUI reads its first key only once it has set its modes
    /// (Codex pushes its keyboard flags after drawing the first screen), so a test that presses a key waits for it.
    pub fn wait_for_output(&mut self, bytes: &[u8]) {
        let deadline = Instant::now() + TIMEOUT;
        while !self.printed.windows(bytes.len()).any(|w| w == bytes) {
            self.pump(Duration::from_millis(50));
            assert!(
                Instant::now() < deadline,
                "timed out waiting for the program to print {:?}",
                bytes.escape_ascii().to_string()
            );
        }
    }

    pub fn wait_for_text(&mut self, text: &str) -> String {
        self.wait_for(text, |screen| screen.contains(text))
    }

    /// Press a key as a browser would report it: the core encodes it for the modes the program has set.
    pub fn press(&mut self, code: &str, key: &str, mods: u16) -> Vec<u8> {
        let event = DomKey {
            code,
            key,
            mods,
            ..DomKey::default()
        };
        let bytes = self.rt.encode_key(&KeyInput::from_dom(event)).unwrap();
        self.write(&bytes);
        bytes
    }

    /// Press a key again every few seconds until `done` accepts the screen: a TUI that has drawn its first screen
    /// may not be reading keys yet, and a key it never read is not a defect of the core. Returns the bytes sent.
    pub fn press_until(&mut self, code: &str, key: &str, done: impl Fn(&str) -> bool) -> Vec<u8> {
        let mut sent = Vec::new();
        for _ in 0..8 {
            let bytes = self.press(code, key, 0);
            assert!(
                sent.is_empty() || sent == bytes,
                "the same key encodes the same way"
            );
            sent = bytes;
            self.pump(Duration::from_secs(2));
            if done(&self.screen()) {
                break;
            }
        }
        sent
    }

    /// Type text through the core, a character at a time, as a soft keyboard does.
    pub fn type_text(&mut self, text: &str) {
        for c in text.chars() {
            self.press("", &c.to_string(), 0);
        }
    }

    pub fn write(&mut self, bytes: &[u8]) {
        self.master.write_all(bytes).unwrap();
    }
}

impl Drop for Program {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        reap_descendants(&self.marker);
        for command in &mut self.cleanup {
            let _ = command.output();
        }
    }
}
