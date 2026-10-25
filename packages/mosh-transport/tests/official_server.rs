#![cfg(any(target_os = "linux", target_os = "macos"))]
use lazysh_mosh_transport::Client;
use std::{
    ffi::CStr,
    net::UdpSocket,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Server {
    pid: libc::pid_t,
    port: u16,
    key: String,
}
impl Server {
    fn start() -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let output = Command::new("mosh-server")
            .args(["new", "-i", "127.0.0.1", "-p", &port.to_string(), "-c", "256", "--", "sh", "-c", "printf 'READY\n'; while IFS= read -r line; do case \"$line\" in size) set -- $(stty size); printf 'SIZE_ROWS_%s_COLS_%s\n' \"$1\" \"$2\";; quit) exit;; *) printf 'RECEIVED_%s_END\n' \"$line\";; esac; done"])
            .env("LANG", "C.UTF-8").env("LC_ALL", "C.UTF-8").env("TERM", "xterm-256color")
            .env("MOSH_SERVER_NETWORK_TMOUT", "20")
            .stdin(Stdio::null()).output().expect("requires official mosh-server on PATH");
        assert!(output.status.success(), "mosh-server fixture did not start");
        let text = String::from_utf8(output.stdout).unwrap();
        let words: Vec<_> = text
            .lines()
            .find(|line| line.starts_with("MOSH CONNECT "))
            .expect("missing bootstrap response")
            .split_whitespace()
            .collect();
        assert_eq!(words.len(), 4);
        assert_eq!(words[2].parse::<u16>().unwrap(), port);
        let errors = String::from_utf8(output.stderr).unwrap();
        let pid = errors
            .split("[mosh-server detached, pid = ")
            .nth(1)
            .and_then(|tail| tail.split(']').next())
            .and_then(|text| text.parse::<libc::pid_t>().ok())
            .expect("missing fixture process identity");
        assert!(pid > 1);
        Self {
            pid,
            port,
            key: words[3].to_owned(),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        // SAFETY: this PID comes only from the mosh-server fixture launched by this test, with a bounded 20-second lifetime.
        unsafe {
            libc::kill(self.pid, libc::SIGTERM);
        }
    }
}
fn until(client: &mut Client, marker: &str) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut output = Vec::new();
    while Instant::now() < deadline {
        let update = client.poll().unwrap();
        output.extend_from_slice(&update.bytes);
        assert!(output.len() < 8 * 1024 * 1024);
        if String::from_utf8_lossy(&output).contains(marker) {
            return output;
        }
        assert!(!update.finished, "server ended before expected marker");
        thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for expected terminal marker: {marker}");
}
fn session(label: &str) {
    let server = Server::start();
    let mut client = Client::new(
        &server.key,
        format!("127.0.0.1:{}", server.port).parse().unwrap(),
        80,
        24,
    )
    .unwrap();
    until(&mut client, "READY");
    client.write(format!("{label}_世界\n").as_bytes()).unwrap();
    until(&mut client, &format!("RECEIVED_{label}_世界_END"));
    client.resize(120, 40).unwrap();
    client.write(b"size\n").unwrap();
    until(&mut client, "SIZE_ROWS_40_COLS_120");
    client.shutdown().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if client.poll().unwrap().finished {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Mosh shutdown was not acknowledged"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
#[ignore = "requires official mosh-server; run cargo test --test official_server -- --ignored"]
fn official_server_utf8_input_resize_shutdown_and_parallel_isolation() {
    let version = Command::new("mosh-server")
        .arg("--version")
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&version.stdout).contains("mosh 1.4.0"),
        "fixture must be official Mosh 1.4.0"
    );
    // SAFETY: these operations read the current process's locale, signal disposition, and stdin flags without changing them.
    let (locale, signal, stdin) = unsafe {
        let locale = CStr::from_ptr(libc::setlocale(libc::LC_CTYPE, std::ptr::null())).to_owned();
        let mut action: libc::sigaction = std::mem::zeroed();
        assert_eq!(
            libc::sigaction(libc::SIGWINCH, std::ptr::null(), &mut action),
            0
        );
        (
            locale,
            (action.sa_sigaction, action.sa_flags),
            libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL),
        )
    };
    let first = thread::spawn(|| session("ONE"));
    let second = thread::spawn(|| session("TWO"));
    first.join().unwrap();
    second.join().unwrap();
    // SAFETY: identical read-only inspection after both clients have shut down.
    unsafe {
        assert_eq!(
            locale.as_c_str(),
            CStr::from_ptr(libc::setlocale(libc::LC_CTYPE, std::ptr::null()))
        );
        let mut action: libc::sigaction = std::mem::zeroed();
        assert_eq!(
            libc::sigaction(libc::SIGWINCH, std::ptr::null(), &mut action),
            0
        );
        assert_eq!(signal, (action.sa_sigaction, action.sa_flags));
        assert_eq!(stdin, libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL));
    }
}
