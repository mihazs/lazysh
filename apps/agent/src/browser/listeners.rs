//! TCP ports the processes around a launcher are listening on, so the app can tell the tunnel
//! which port to expect. Only unprivileged loopback and wildcard listeners are reported.
use serde_json::Value;

/// "0100007F" as printed by /proc/net/tcp{,6}: little-endian 32-bit words.
#[cfg(target_os = "linux")]
fn address(hex: &str) -> Option<&'static str> {
    match hex {
        "0100007F" => Some("127.0.0.1"),
        "00000000" => Some("0.0.0.0"),
        "00000000000000000000000001000000" => Some("::1"),
        "00000000000000000000000000000000" => Some("::"),
        _ => None,
    }
}

/// (inode, port, address) of every listening socket in `/proc/net/tcp` or `tcp6` text.
#[cfg(target_os = "linux")]
fn parse(table: &str) -> Vec<(u64, u16, &'static str)> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (host, port) = fields.get(1)?.split_once(':')?;
            let port = u16::from_str_radix(port, 16)
                .ok()
                .filter(|port| *port >= 1024)?;
            (fields.get(3) == Some(&"0A")).then_some(())?;
            Some((fields.get(9)?.parse().ok()?, port, address(host)?))
        })
        .collect()
}

#[cfg(target_os = "linux")]
pub(super) fn of(owners: &[(u32, String)]) -> Vec<Value> {
    let sockets: Vec<_> = ["/proc/net/tcp", "/proc/net/tcp6"]
        .into_iter()
        .flat_map(|table| parse(&std::fs::read_to_string(table).unwrap_or_default()))
        .collect();
    let mut found = Vec::new();
    for (pid, name) in owners {
        let Ok(descriptors) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        for target in descriptors
            .flatten()
            .take(4096)
            .filter_map(|entry| std::fs::read_link(entry.path()).ok())
        {
            let inode = target
                .to_str()
                .and_then(|text| text.strip_prefix("socket:["))
                .and_then(|text| text.strip_suffix(']'))
                .and_then(|text| text.parse::<u64>().ok());
            if let Some((_, port, address)) = sockets.iter().find(|(id, ..)| Some(*id) == inode) {
                found.push(serde_json::json!({"port": port, "address": address, "process": name}));
            }
        }
    }
    found.truncate(8);
    found
}

// shortcut: no listener discovery on macOS (it needs lsof); the app falls back to the printed URL.
#[cfg(not(target_os = "linux"))]
pub(super) fn of(_: &[(u32, String)]) -> Vec<Value> {
    Vec::new()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn only_unprivileged_loopback_and_wildcard_listeners_are_kept() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
            0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000 100 0 0 10 0\n\
            1: 00000000:8E59 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000 100 0 0 10 0\n\
            2: 0100007F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333 1 0000 100 0 0 10 0\n\
            3: 0100007F:1F91 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 444 1 0000 100 0 0 10 0\n\
            4: 0A00A8C0:1F92 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0000 100 0 0 10 0\n";
        assert_eq!(
            parse(table),
            vec![(111, 8080, "127.0.0.1"), (222, 36441, "0.0.0.0")]
        );
        let six = "header\n0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 666 1\n";
        assert_eq!(parse(six), vec![(666, 8080, "::1")]);
    }
}
