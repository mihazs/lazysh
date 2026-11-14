//! `lazysh-agent listeners` against real sockets: a child process holds the listeners, the binary
//! under test reads them back.
#![cfg(unix)]
#[path = "support/binary.rs"]
mod binary;

use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    net::{Ipv4Addr, Ipv6Addr, TcpListener, UdpSocket},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant, SystemTime},
};

const HOLDER: &str = "LAZYSH_TEST_LISTENER_HOLDER";

/// Run by the tests below in a child process; a plain run of the suite returns at once.
#[test]
fn listener_holder() {
    if std::env::var_os(HOLDER).is_none() {
        return;
    }
    let loopback = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let wildcard = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let v6 = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).ok();
    let other = other_interface().and_then(|ip| TcpListener::bind((ip, 0)).ok());
    let port = |listener: &Option<TcpListener>| {
        listener
            .as_ref()
            .map_or(0, |l| l.local_addr().unwrap().port())
    };
    // libtest has already printed "test listener_holder ... " on this line, so start a new one.
    println!(
        "\nHOLDER {} {} {} {}",
        loopback.local_addr().unwrap().port(),
        wildcard.local_addr().unwrap().port(),
        port(&v6),
        port(&other)
    );
    std::io::stdout().flush().unwrap();
    // The parent closes our stdin when it has read what it needs.
    std::io::stdin().lines().for_each(drop);
}

/// An address of this host that is not loopback, found without sending a packet; none in a sandbox.
fn other_interface() -> Option<Ipv4Addr> {
    let probe = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    probe.connect("192.0.2.1:9").ok()?;
    match probe.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

struct Holder {
    child: Child,
    stdin: Option<ChildStdin>,
    /// Kept open so the child's closing lines do not hit a broken pipe.
    _stdout: BufReader<ChildStdout>,
    loopback: u16,
    wildcard: u16,
    v6: u16,
    other: u16,
}
impl Holder {
    fn start() -> Self {
        let mut holder = Command::new(std::env::current_exe().unwrap());
        holder
            .args([
                "listener_holder",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(HOLDER, "1");
        let mut child = piped(holder);
        let stdout = child.stdout.take().unwrap();
        let mut stdout = BufReader::new(stdout);
        let line = (&mut stdout)
            .lines()
            .map_while(Result::ok)
            .find(|line| line.starts_with("HOLDER "))
            .expect("the holder child announces its ports");
        let ports: Vec<u16> = line
            .split_whitespace()
            .skip(1)
            .map(|p| p.parse().unwrap())
            .collect();
        Self {
            _stdout: stdout,
            stdin: child.stdin.take(),
            loopback: ports[0],
            wildcard: ports[1],
            v6: ports[2],
            other: ports[3],
            child,
        }
    }
}
impl Drop for Holder {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.wait();
    }
}

/// A child whose standard input and output the test owns.
fn piped(mut command: Command) -> Child {
    command
        .stdout(Stdio::piped())
        .stdin(Stdio::piped())
        .spawn()
        .unwrap()
}

fn agent(args: &[&str]) -> Command {
    let mut command = Command::new(binary::path());
    command.arg("listeners").args(args).stdin(Stdio::null());
    command
}
fn snapshot(args: &[&str]) -> Value {
    let output = agent(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1,
        "one JSON line"
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn entries(value: &Value, port: u16) -> Vec<&Value> {
    value["listeners"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["port"] == port)
        .collect()
}

#[test]
fn reports_loopback_and_wildcard_listeners_of_another_process_and_nothing_else() {
    let holder = Holder::start();
    let started = SystemTime::now();
    let value = snapshot(&["--json"]);
    assert_eq!(
        (value["schemaVersion"].clone(), value["event"].clone()),
        (1.into(), "snapshot".into())
    );

    let own_uid = unsafe { libc::geteuid() };
    let exe = std::env::current_exe()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let pid = holder.child.id();
    for (port, address, bind, family) in [
        (holder.loopback, "127.0.0.1", "loopback", "tcp4"),
        (holder.wildcard, "0.0.0.0", "wildcard", "tcp4"),
        (holder.v6, "::1", "loopback", "tcp6"),
    ] {
        if port == 0 {
            continue; // this host has no IPv6 loopback
        }
        let found = entries(&value, port);
        assert_eq!(found.len(), 1, "port {port}: {found:?}");
        let found = found[0];
        assert_eq!(
            (
                found["address"].as_str(),
                found["bind"].as_str(),
                found["family"].as_str()
            ),
            (Some(address), Some(bind), Some(family))
        );
        assert_eq!(found["uid"], own_uid);
        assert_eq!(found["ownedBySessionUser"], true);
        assert_eq!(found["pid"], pid);
        let comm = found["comm"].as_str().unwrap();
        assert!(
            !comm.is_empty() && exe.starts_with(comm),
            "{comm} is a prefix of {exe}"
        );
        assert!(found.get("cmdline").is_none() && found.get("environ").is_none());
    }
    if holder.other != 0 {
        assert!(
            entries(&value, holder.other).is_empty(),
            "a listener on a specific interface address is not listed"
        );
    }
    #[cfg(target_os = "linux")]
    {
        let started_at = entries(&value, holder.loopback)[0]["startedAt"]
            .as_str()
            .unwrap()
            .parse::<chrono::DateTime<chrono::Utc>>()
            .unwrap();
        let age = entries(&value, holder.loopback)[0]["ageSeconds"]
            .as_u64()
            .unwrap();
        assert!(age <= 120, "the holder had run {age} s");
        let age = chrono::DateTime::<chrono::Utc>::from(started)
            .signed_duration_since(started_at)
            .num_seconds();
        assert!(
            (-2..=120).contains(&age),
            "the holder started {age} s before the read"
        );
    }
}

#[test]
fn port_filter_keeps_only_those_ports_and_the_cap_is_256() {
    let holder = Holder::start();
    let value = snapshot(&[
        "--port",
        &holder.loopback.to_string(),
        "--port",
        &holder.wildcard.to_string(),
    ]);
    let mut ports: Vec<_> = value["listeners"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["port"].as_u64().unwrap())
        .collect();
    ports.sort_unstable();
    assert_eq!(
        ports
            .iter()
            .filter(|p| **p == u64::from(holder.loopback))
            .count(),
        1
    );
    assert!(ports
        .iter()
        .all(|p| *p == u64::from(holder.loopback) || *p == u64::from(holder.wildcard)));

    let many: Vec<_> = (0..300)
        .map(|_| TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap())
        .collect();
    let capped = snapshot(&[]);
    assert_eq!(capped["listeners"].as_array().unwrap().len(), 256);
    assert_eq!(capped["truncated"], true);
    drop(many);
}

#[test]
fn watch_reports_a_new_listener_its_close_and_a_heartbeat_then_ends_with_stdin() {
    let mut child = piped(agent(&["--watch", "--interval-ms", "250"]));
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut next =
        move || -> Value { serde_json::from_str(&lines.next().expect("a line").unwrap()).unwrap() };
    assert_eq!(next()["event"], "snapshot");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut wait_for = |event: &str| loop {
        let value = next();
        if value["event"] == event && (event == "heartbeat" || value["listener"]["port"] == port) {
            return value;
        }
    };
    assert_eq!(wait_for("listen")["listener"]["address"], "127.0.0.1");
    drop(listener);
    wait_for("close");
    let quiet = Instant::now();
    wait_for("heartbeat");
    assert!(
        quiet.elapsed() >= Duration::from_secs(3),
        "a heartbeat only after a quiet spell"
    );
    drop(child.stdin.take());
    let ended = Instant::now();
    assert!(child.wait().unwrap().success());
    assert!(
        ended.elapsed() < Duration::from_secs(5),
        "closing stdin ends the watch"
    );
}

#[test]
fn a_port_of_zero_is_refused_by_the_cli() {
    assert_eq!(
        agent(&["--port", "0"]).output().unwrap().status.code(),
        Some(2)
    );
}
