//! `lazysh-agent listeners`: TCP listeners bound to loopback or a wildcard address, with the owner's
//! process id, kernel name, user id and start time (ADR 0004, detection tier 1). The app uses it to
//! confirm that the port named by a sign-in URL is really being listened on by the user's own process.
//!
//! It never reads an argument vector or an environment, and a listener on any other address is not
//! listed. Linux reads `/proc`; other Unix systems parse `lsof -F`; Windows parses `Get-NetTCPConnection`.
use crate::{Error, Result};
use clap::Args;
use serde::Serialize;
use serde_json::{json, Value};
use std::net::IpAddr;

/// Output cap, so a host with thousands of sockets cannot flood the channel.
pub const MAX_LISTENERS: usize = 256;

#[derive(Args, Debug)]
pub struct Options {
    /// Report only these ports (repeatable).
    #[arg(long = "port", value_parser = clap::value_parser!(u16).range(1..))]
    pub ports: Vec<u16>,
    /// JSON is the only format; the flag is accepted so scripts can be explicit.
    #[arg(long)]
    pub json: bool,
    /// After the snapshot, print `listen` and `close` events until stdin closes.
    #[arg(long)]
    pub watch: bool,
    #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u64).range(250..=5000))]
    pub interval_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Bind {
    Loopback,
    Wildcard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub family: &'static str,
    pub address: String,
    pub bind: Bind,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    pub owned_by_session_user: bool,
    /// Absent when the owner cannot be read (another user's process).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comm: Option<String>,
    /// UTC start time of the owning process; absent where the platform tool does not report it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

/// Loopback and wildcard only: a listener on a specific interface address is not reachable as
/// `localhost` and never the callback of a sign-in.
fn classify(ip: IpAddr) -> Option<Bind> {
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    if ip.is_loopback() {
        Some(Bind::Loopback)
    } else if ip.is_unspecified() {
        Some(Bind::Wildcard)
    } else {
        None
    }
}

/// A process name is one short printable token; anything else is dropped rather than echoed.
fn safe_comm(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

fn listener(ip: IpAddr, port: u16) -> Option<Listener> {
    Some(Listener {
        family: if ip.is_ipv4() { "tcp4" } else { "tcp6" },
        address: ip.to_string(),
        bind: classify(ip)?,
        port,
        uid: None,
        owned_by_session_user: false,
        pid: None,
        comm: None,
        started_at: None,
    })
}

/// Sorted by port so the cap keeps a stable subset, filtered before the cap.
fn finish(mut listeners: Vec<Listener>, ports: &[u16]) -> Value {
    listeners.retain(|entry| ports.is_empty() || ports.contains(&entry.port));
    listeners.sort_by(|a, b| {
        (a.port, a.family, &a.address, a.pid).cmp(&(b.port, b.family, &b.address, b.pid))
    });
    listeners.dedup();
    let truncated = listeners.len() > MAX_LISTENERS;
    listeners.truncate(MAX_LISTENERS);
    let mut out = json!({"schemaVersion": 1, "event": "snapshot", "listeners": listeners});
    if truncated {
        out["truncated"] = Value::Bool(true);
    }
    out
}

pub fn run(options: &Options) -> Result<Option<Value>> {
    if options.watch {
        watch(options)?;
        return Ok(None);
    }
    Ok(Some(finish(platform::read()?, &options.ports)))
}

/// A listener is the same one while its address, port and owner stay the same.
type Key = (String, u16, Option<u32>);
fn keys(snapshot: &Value) -> Vec<(Key, Value)> {
    snapshot["listeners"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| {
            let key = (
                entry["address"].as_str().unwrap_or_default().to_owned(),
                entry["port"].as_u64().unwrap_or_default() as u16,
                entry["pid"].as_u64().map(|pid| pid as u32),
            );
            (key, entry.clone())
        })
        .collect()
}

/// One snapshot, then one `listen` or `close` line per change, and a `heartbeat` after 5 seconds of
/// silence so the app can tell a quiet host from a dead channel.
fn watch(options: &Options) -> Result<()> {
    use std::{
        io::{Read, Write},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    let closed = Arc::new(AtomicBool::new(false));
    let signal = closed.clone();
    std::thread::spawn(move || {
        let mut sink = [0u8; 256];
        while std::io::stdin().read(&mut sink).is_ok_and(|read| read > 0) {}
        signal.store(true, Ordering::Relaxed);
    });
    let mut stdout = std::io::stdout().lock();
    let mut emit = |value: Value| -> Result<()> {
        serde_json::to_writer(&mut stdout, &value)
            .map_err(|_| Error::Listeners("ListenersUnavailable"))?;
        writeln!(stdout)?;
        Ok(stdout.flush()?)
    };
    let first = finish(platform::read()?, &options.ports);
    let mut known = keys(&first);
    emit(first)?;
    let (mut polled, mut spoke) = (Instant::now(), Instant::now());
    while !closed.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(50));
        if polled.elapsed() >= Duration::from_millis(options.interval_ms) {
            let now = keys(&finish(platform::read()?, &options.ports));
            let appeared = now
                .iter()
                .filter(|(key, _)| !known.iter().any(|(old, _)| old == key));
            let gone = known
                .iter()
                .filter(|(key, _)| !now.iter().any(|(new, _)| new == key));
            for (event, (_, entry)) in appeared
                .map(|row| ("listen", row))
                .chain(gone.map(|row| ("close", row)))
            {
                emit(json!({"schemaVersion": 1, "event": event, "listener": entry}))?;
                spoke = Instant::now();
            }
            known = now;
            polled = Instant::now();
        }
        if spoke.elapsed() >= Duration::from_secs(5) {
            emit(json!({"schemaVersion": 1, "event": "heartbeat"}))?;
            spoke = Instant::now();
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
mod proc;

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    pub fn read() -> Result<Vec<Listener>> {
        // SAFETY: both calls only read process-wide constants.
        let (own_uid, ticks) = unsafe { (libc::geteuid(), libc::sysconf(libc::_SC_CLK_TCK)) };
        Ok(super::proc::read(
            std::path::Path::new("/proc"),
            own_uid,
            u64::try_from(ticks)
                .ok()
                .filter(|ticks| *ticks > 0)
                .unwrap_or(100),
        )?)
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
mod platform {
    use super::*;
    pub fn read() -> Result<Vec<Listener>> {
        // SAFETY: reads a process-wide constant.
        let own_uid = unsafe { libc::geteuid() };
        let mut command = std::process::Command::new("lsof");
        command.args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcuftn"]);
        let mut listeners = super::lsof::parse(&tool_output(command)?, own_uid);
        // lsof says nothing about age: `ps` gives the elapsed time of each owner. A host without it
        // simply reports no start time.
        let mut pids: Vec<String> = listeners
            .iter()
            .filter_map(|l| l.pid)
            .map(|p| p.to_string())
            .collect();
        pids.sort_unstable();
        pids.dedup();
        pids.truncate(512);
        if !pids.is_empty() {
            let mut ps = std::process::Command::new("sh");
            // `ps` exits 1 when one pid has already gone, and still prints the others.
            ps.args([
                "-c",
                "ps -o pid=,etime= -p \"$1\" 2>/dev/null; exit 0",
                "sh",
                &pids.join(","),
            ]);
            if let Ok(text) = tool_output(ps) {
                let elapsed = super::lsof::elapsed(&text);
                let now = chrono::Utc::now();
                for entry in &mut listeners {
                    entry.started_at =
                        entry
                            .pid
                            .and_then(|pid| elapsed.get(&pid))
                            .and_then(|secs| {
                                let secs = chrono::Duration::seconds(i64::try_from(*secs).ok()?);
                                Some(
                                    (now - secs).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                                )
                            });
                }
            }
        }
        Ok(listeners)
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    pub fn read() -> Result<Vec<Listener>> {
        let mut command = std::process::Command::new("powershell");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            super::powershell::SCRIPT,
        ]);
        super::powershell::parse(&tool_output(command)?)
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use super::*;
    pub fn read() -> Result<Vec<Listener>> {
        Err(Error::Listeners("ListenersUnsupported"))
    }
}

#[cfg(any(all(unix, not(target_os = "linux")), windows))]
fn tool_output(command: std::process::Command) -> Result<String> {
    use std::sync::{atomic::AtomicBool, Arc};
    let bytes = crate::devices::bounded_command(
        command,
        8 * 1024 * 1024,
        Arc::new(AtomicBool::new(false)),
        std::time::Duration::from_secs(10),
    )
    .map_err(|_| Error::Listeners("ListenersUnavailable"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(any(all(unix, not(target_os = "linux")), test))]
mod lsof {
    use super::*;
    use std::{
        collections::HashMap,
        net::{Ipv4Addr, Ipv6Addr},
    };

    /// `ps -o pid=,etime=`: seconds since each process started, from `[[dd-]hh:]mm:ss`.
    pub fn elapsed(text: &str) -> HashMap<u32, u64> {
        text.lines()
            .take(1024)
            .filter_map(|line| {
                let (pid, etime) = line
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .split_first()
                    .map(|(p, rest)| (*p, rest.first().copied()))?;
                let (days, clock) = match etime?.split_once('-') {
                    Some((days, clock)) => (days.parse::<u64>().ok()?, clock),
                    None => (0, etime?),
                };
                let mut seconds = 0u64;
                let parts: Vec<&str> = clock.split(':').collect();
                if parts.len() > 3 {
                    return None;
                }
                for part in parts {
                    seconds = seconds * 60 + part.parse::<u64>().ok()?;
                }
                Some((pid.parse().ok()?, days * 86_400 + seconds))
            })
            .collect()
    }

    /// `lsof -F pcuftn`: a `p` line starts a process (`c` name, `u` uid), an `f` line a descriptor
    /// (`t` IPv4 or IPv6, `n` the `address:port` name).
    pub fn parse(text: &str, own_uid: u32) -> Vec<Listener> {
        let mut out = Vec::new();
        let (mut pid, mut comm, mut uid) = (None, None, None);
        let mut kind = "";
        for line in text.lines().take(100_000) {
            let Some((tag, value)) = line.split_at_checked(1) else {
                continue;
            };
            match tag {
                "p" => (pid, comm, uid, kind) = (value.parse().ok(), None, None, ""),
                "c" => comm = safe_comm(value),
                "u" => uid = value.parse().ok(),
                "f" => kind = "",
                "t" => kind = if value == "IPv6" { "IPv6" } else { "IPv4" },
                "n" => {
                    let Some(mut entry) = name(value, kind) else {
                        continue;
                    };
                    entry.uid = uid;
                    entry.owned_by_session_user = uid == Some(own_uid);
                    entry.pid = pid;
                    entry.comm = comm.clone();
                    out.push(entry);
                }
                _ => {}
            }
        }
        out
    }

    /// `127.0.0.1:8080`, `*:8080` (the family comes from `t`) or `[::1]:8080`.
    fn name(value: &str, kind: &str) -> Option<Listener> {
        let (host, port) = value.rsplit_once(':')?;
        let port = port.parse().ok().filter(|port| *port != 0)?;
        let ip = match host {
            "*" if kind == "IPv6" => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            "*" => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            _ => host.trim_matches(['[', ']']).parse().ok()?,
        };
        listener(ip, port)
    }
}

#[cfg(any(windows, test))]
mod powershell {
    use super::*;

    /// One object per listening socket. `sameSession` stands in for "owned by this user": Windows
    /// reports no owner without elevation, but a process of another logon session (services) is not ours.
    #[cfg(windows)]
    pub const SCRIPT: &str = "$me=(Get-Process -Id $PID).SessionId; @(Get-NetTCPConnection -State Listen | \
        ForEach-Object { $p=Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; \
        [pscustomobject]@{address=$_.LocalAddress;port=$_.LocalPort;pid=$_.OwningProcess;\
        comm=$p.ProcessName;sameSession=($null -ne $p -and $p.SessionId -eq $me)} }) | ConvertTo-Json -Compress";

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        address: String,
        port: u16,
        pid: Option<u32>,
        comm: Option<String>,
        #[serde(default)]
        same_session: bool,
    }

    /// PowerShell prints a lone object without the array brackets and nothing for an empty list.
    pub fn parse(text: &str) -> Result<Vec<Listener>> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<Row> = if text.starts_with('[') {
            serde_json::from_str(text)
        } else {
            serde_json::from_str(text).map(|row| vec![row])
        }
        .map_err(|_| Error::Listeners("ListenersUnavailable"))?;
        Ok(rows
            .into_iter()
            .take(100_000)
            .filter_map(|row| {
                let ip: IpAddr = row.address.split('%').next()?.parse().ok()?;
                let mut entry = listener(ip, row.port).filter(|entry| entry.port != 0)?;
                entry.owned_by_session_user = row.same_session;
                entry.pid = row.pid.filter(|pid| *pid != 0);
                entry.comm = row.comm.as_deref().and_then(safe_comm);
                Some(entry)
            })
            .collect())
    }
}

#[cfg(test)]
mod tests;
