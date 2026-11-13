//! Linux: `/proc/net/tcp{,6}` lists the sockets, `/proc/PID/fd` says which process holds each one.
//! A root other than `/proc` lets tests describe a host, including other users' processes.
use super::{listener, safe_comm, Listener};
use std::{
    collections::HashMap,
    fs, io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
};

/// `/proc/PID/fd` entries read in one pass, so a host with a huge descriptor table stays bounded.
const MAX_DESCRIPTORS: usize = 2_000_000;
const LISTEN: &str = "0A";

struct Socket {
    ip: IpAddr,
    port: u16,
    uid: u32,
    inode: u64,
}

/// `0100007F:1F90`: each 32-bit word of the address is printed as a native-endian integer, so its
/// native bytes are the network-order octets on any host; the port is plain hex.
fn address(value: &str) -> Option<(IpAddr, u16)> {
    let (host, port) = value.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let word = |part: &str| u32::from_str_radix(part, 16).ok().map(u32::to_ne_bytes);
    let ip = match host.len() {
        8 => IpAddr::V4(Ipv4Addr::from(word(host)?)),
        32 => {
            let mut octets = [0u8; 16];
            for (index, chunk) in octets.chunks_mut(4).enumerate() {
                chunk.copy_from_slice(&word(host.get(index * 8..index * 8 + 8)?)?);
            }
            IpAddr::V6(Ipv6Addr::from(octets))
        }
        _ => return None,
    };
    Some((ip, port))
}

fn sockets(text: &str) -> Vec<Socket> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.get(3) != Some(&LISTEN) {
                return None;
            }
            let (ip, port) = address(fields.get(1)?)?;
            Some(Socket {
                ip,
                port,
                uid: fields.get(7)?.parse().ok()?,
                inode: fields.get(9)?.parse().ok()?,
            })
        })
        .collect()
}

/// socket inode -> lowest owning pid (a forked server shares its socket), for the pids this user may
/// inspect; others are skipped silently.
fn owners(root: &Path, wanted: &[u64]) -> HashMap<u64, u32> {
    let mut found = HashMap::new();
    let mut scanned = 0usize;
    let Ok(processes) = fs::read_dir(root) else {
        return found;
    };
    for process in processes.flatten() {
        let Some(pid) = process
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(descriptors) = fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        for descriptor in descriptors.flatten() {
            scanned += 1;
            if scanned > MAX_DESCRIPTORS {
                return found;
            }
            let Ok(target) = fs::read_link(descriptor.path()) else {
                continue;
            };
            let inode = target
                .to_str()
                .and_then(|target| target.strip_prefix("socket:["))
                .and_then(|target| target.strip_suffix(']'))
                .and_then(|inode| inode.parse::<u64>().ok());
            if let Some(inode) = inode.filter(|inode| wanted.contains(inode)) {
                found
                    .entry(inode)
                    .and_modify(|owner| *owner = (*owner).min(pid))
                    .or_insert(pid);
            }
        }
    }
    found
}

/// Seconds since the epoch at which `pid` started: boot time plus the `starttime` tick count, the
/// 22nd field of `stat`, counted after the closing parenthesis of the process name.
fn started(root: &Path, pid: u32, boot: Option<u64>, ticks: u64) -> Option<String> {
    let stat = fs::read_to_string(root.join(pid.to_string()).join("stat")).ok()?;
    let after_name = stat.rsplit_once(')')?.1;
    let start: u64 = after_name.split_whitespace().nth(19)?.parse().ok()?;
    let seconds = i64::try_from(boot? + start / ticks).ok()?;
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

pub fn read(root: &Path, own_uid: u32, ticks: u64) -> io::Result<Vec<Listener>> {
    let mut all = Vec::new();
    for table in ["tcp", "tcp6"] {
        match fs::read_to_string(root.join("net").join(table)) {
            Ok(text) => all.extend(sockets(&text)),
            // A host without IPv6 has no tcp6; a missing tcp table is a missing /proc.
            Err(error) if table == "tcp6" && error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let all: Vec<Socket> = all
        .into_iter()
        .filter(|socket| socket.port != 0 && super::classify(socket.ip).is_some())
        .collect();
    let inodes: Vec<u64> = all.iter().map(|socket| socket.inode).collect();
    let owners = owners(root, &inodes);
    let boot = fs::read_to_string(root.join("stat")).ok().and_then(|text| {
        text.lines()
            .find_map(|line| line.strip_prefix("btime ")?.trim().parse::<u64>().ok())
    });
    let mut by_pid: HashMap<u32, (Option<String>, Option<String>)> = HashMap::new();
    Ok(all
        .into_iter()
        .filter_map(|socket| {
            let mut entry = listener(socket.ip, socket.port)?;
            entry.uid = Some(socket.uid);
            entry.owned_by_session_user = socket.uid == own_uid;
            if let Some(pid) = owners.get(&socket.inode).copied() {
                let (comm, since) = by_pid.entry(pid).or_insert_with(|| {
                    let comm = fs::read_to_string(root.join(pid.to_string()).join("comm"))
                        .ok()
                        .and_then(|name| safe_comm(&name));
                    (comm, started(root, pid, boot, ticks))
                });
                entry.pid = Some(pid);
                entry.comm = comm.clone();
                entry.started_at = since.clone();
            }
            Some(entry)
        })
        .collect())
}
