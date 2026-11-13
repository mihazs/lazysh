use super::*;
use std::net::Ipv4Addr;

fn ports(value: &Value) -> Vec<u64> {
    value["listeners"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["port"].as_u64().unwrap())
        .collect()
}

const LSOF: &str = "p501\ncaws\nu501\nf9\ntIPv4\nn*:36151\nf10\ntIPv6\nn*:36151\n\
p77\ncpython3.1\nu501\nf3\ntIPv4\nn127.0.0.1:8085\nf4\ntIPv6\nn[::1]:8085\n\
p9\ncnetbird\nu0\nf5\ntIPv4\nn192.168.1.20:53000\nf6\ntIPv4\nn127.0.0.1:0\n\
p10\ncbad\x07name\nu501\nf3\ntIPv4\nn10.1.2.3:22\n";

#[test]
fn lsof_records_keep_owner_family_and_drop_other_interfaces() {
    let listeners = lsof::parse(LSOF, 501);
    let summary: Vec<_> = listeners
        .iter()
        .map(|entry| {
            (
                entry.port,
                entry.family,
                entry.bind,
                entry.pid,
                entry.owned_by_session_user,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (36151, "tcp4", Bind::Wildcard, Some(501), true),
            (36151, "tcp6", Bind::Wildcard, Some(501), true),
            (8085, "tcp4", Bind::Loopback, Some(77), true),
            (8085, "tcp6", Bind::Loopback, Some(77), true),
        ]
    );
    assert_eq!(listeners[0].comm.as_deref(), Some("aws"));
    assert_eq!(listeners[2].comm.as_deref(), Some("python3.1"));
}

#[test]
fn ps_elapsed_time_is_read_in_every_format() {
    let parsed =
        lsof::elapsed("  412 00:07\n9 12:34\n77 03:04:05\n5 2-03:04:05\nx 01:01\n8 1:2:3:4\n");
    assert_eq!(parsed.get(&412), Some(&7));
    assert_eq!(parsed.get(&9), Some(&754));
    assert_eq!(parsed.get(&77), Some(&11_045));
    assert_eq!(parsed.get(&5), Some(&183_845));
    assert_eq!(parsed.len(), 4, "a malformed row is skipped");
}

#[cfg(unix)]
#[test]
fn the_real_ps_reports_this_process_as_young() {
    let output = std::process::Command::new("sh")
        .args([
            "-c",
            "ps -o pid=,etime= -p \"$1\"",
            "sh",
            &std::process::id().to_string(),
        ])
        .output()
        .unwrap();
    let parsed = lsof::elapsed(&String::from_utf8_lossy(&output.stdout));
    assert!(parsed[&std::process::id()] < 3600);
}

#[cfg(unix)]
#[test]
fn the_real_lsof_lists_a_socket_this_process_holds() {
    let socket = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = socket.local_addr().unwrap().port();
    let Ok(output) = std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcuftn"])
        .output()
    else {
        return; // no lsof on this host: nothing to read
    };
    // SAFETY: reads a process-wide constant.
    let own_uid = unsafe { libc::geteuid() };
    let listeners = lsof::parse(&String::from_utf8_lossy(&output.stdout), own_uid);
    let ours = listeners
        .iter()
        .find(|entry| entry.port == port)
        .expect("our listener");
    assert_eq!(
        (ours.pid, ours.owned_by_session_user, ours.bind),
        (Some(std::process::id()), true, Bind::Loopback)
    );
    assert!(ours.comm.as_deref().is_some_and(|name| !name.is_empty()));
}

#[test]
fn lsof_listener_of_another_user_is_not_ours() {
    let listeners = lsof::parse("p9\ncnetbird\nu0\nf5\ntIPv4\nn*:53000\n", 501);
    assert_eq!(listeners.len(), 1);
    assert!(!listeners[0].owned_by_session_user);
    assert_eq!(listeners[0].uid, Some(0));
}

#[test]
fn powershell_accepts_one_object_many_objects_and_nothing() {
    let one = r#"{"address":"127.0.0.1","port":8085,"pid":412,"comm":"gcloud","sameSession":true}"#;
    let parsed = powershell::parse(one).unwrap();
    assert_eq!(
        (
            parsed[0].port,
            parsed[0].pid,
            parsed[0].owned_by_session_user
        ),
        (8085, Some(412), true)
    );
    let many = r#"[{"address":"::","port":53000,"pid":4,"comm":"netbird","sameSession":false},
        {"address":"fe80::1%12","port":9,"pid":1,"comm":"x","sameSession":true},
        {"address":"::1","port":1455,"pid":0,"comm":null,"sameSession":true}]"#;
    let parsed = powershell::parse(many).unwrap();
    assert_eq!(
        parsed.iter().map(|entry| entry.port).collect::<Vec<_>>(),
        [53000, 1455]
    );
    assert!(!parsed[0].owned_by_session_user);
    assert_eq!(parsed[1].pid, None, "a zero owning process is no owner");
    assert!(powershell::parse("").unwrap().is_empty());
    assert!(powershell::parse("not json").is_err());
}

#[test]
fn output_is_filtered_by_port_sorted_and_capped_at_256() {
    let many: Vec<Listener> = (1..=300u16)
        .map(|port| listener(IpAddr::V4(Ipv4Addr::LOCALHOST), 2000 + port).unwrap())
        .collect();
    let capped = finish(many.clone(), &[]);
    assert_eq!(capped["listeners"].as_array().unwrap().len(), MAX_LISTENERS);
    assert_eq!(capped["truncated"], true);
    assert_eq!(ports(&capped)[0], 2001);
    let one = finish(many, &[2100, 9]);
    assert_eq!(ports(&one), [2100]);
    assert!(one.get("truncated").is_none());
    assert_eq!(one["schemaVersion"], 1);
    assert_eq!(one["event"], "snapshot");
}

#[cfg(all(unix, target_endian = "little"))]
mod fake_proc {
    use super::*;
    use std::{fs, os::unix::fs::symlink, path::Path};

    const HEADER: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    fn row(local: &str, state: &str, uid: u32, inode: u64) -> String {
        format!("   0: {local} 00000000:0000 {state} 00000000:00000000 00:00000000 00000000  {uid}        0 {inode} 1 0000000000000000 100 0 0 10 0\n")
    }
    fn process(root: &Path, pid: u32, comm: &str, start_ticks: u64, inodes: &[u64]) {
        let dir = root.join(pid.to_string());
        fs::create_dir_all(dir.join("fd")).unwrap();
        fs::write(dir.join("comm"), format!("{comm}\n")).unwrap();
        // The name may hold spaces and parentheses; `starttime` is field 22 after the last `)`.
        let stat = format!(
            "{pid} ({comm} (x) y) S 1 {pid} {pid} 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 {start_ticks} 1000 1 0\n"
        );
        fs::write(dir.join("stat"), stat).unwrap();
        for (index, inode) in inodes.iter().enumerate() {
            symlink(
                format!("socket:[{inode}]"),
                dir.join("fd").join(index.to_string()),
            )
            .unwrap();
        }
    }

    fn host() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("net")).unwrap();
        fs::write(root.path().join("stat"), "cpu 1 2 3\nbtime 1700000000\n").unwrap();
        let tcp = [
            HEADER.to_owned(),
            row("0100007F:1F90", "0A", 1000, 111), // 127.0.0.1:8080, ours
            row("00000000:8D37", "0A", 1000, 222), // 0.0.0.0:36151, ours
            row("0100007F:0050", "01", 1000, 333), // established, not listening
            row("1401A8C0:CF08", "0A", 1000, 444), // 192.168.1.20:53000, another interface
            row("0100007F:D431", "0A", 0, 555),    // 127.0.0.1:54321, root's, owner unreadable
            row("0200007F:0BB8", "0A", 1000, 666), // 127.0.0.2:3000, loopback range
        ]
        .concat();
        let tcp6 = [
            HEADER.to_owned(),
            row("00000000000000000000000001000000:1F90", "0A", 1000, 777), // [::1]:8080
            row("00000000000000000000000000000000:05AF", "0A", 1000, 888), // [::]:1455
            row("000080FE000000000000000001000000:23A3", "0A", 1000, 999), // fe80::1, not loopback
            row("0000000000000000FFFF00000100007F:2710", "0A", 1000, 1010), // ::ffff:127.0.0.1:10000
        ]
        .concat();
        fs::write(root.path().join("net/tcp"), tcp).unwrap();
        fs::write(root.path().join("net/tcp6"), tcp6).unwrap();
        process(root.path(), 4242, "aws", 12345, &[111, 888]);
        process(root.path(), 4100, "aws", 100, &[222]);
        process(root.path(), 4300, "dev", 200, &[222, 666]);
        root
    }

    #[test]
    fn linux_listeners_have_owner_name_start_time_and_only_loopback_or_wildcard_binds() {
        let root = host();
        let listeners = proc::read(root.path(), 1000, 100).unwrap();
        let by_port = |port: u16| listeners.iter().filter(move |entry| entry.port == port);
        assert_eq!(
            by_port(53000).count(),
            0,
            "a specific interface address is never listed"
        );
        assert_eq!(by_port(80).count(), 0, "only the listening state counts");
        assert_eq!(
            by_port(9123).count(),
            0,
            "a non-loopback IPv6 address is never listed"
        );

        let web = by_port(8080).collect::<Vec<_>>();
        assert_eq!(web.len(), 2);
        let v4 = web.iter().find(|entry| entry.family == "tcp4").unwrap();
        assert_eq!(
            (v4.address.as_str(), v4.bind, v4.pid),
            ("127.0.0.1", Bind::Loopback, Some(4242))
        );
        assert_eq!(v4.comm.as_deref(), Some("aws"));
        assert!(v4.owned_by_session_user && v4.uid == Some(1000));
        // btime 1700000000 + 12345 ticks / 100 per second, rounded down.
        assert_eq!(v4.started_at.as_deref(), Some("2023-11-14T22:15:23Z"));
        let v6 = web.iter().find(|entry| entry.family == "tcp6").unwrap();
        assert_eq!(
            (v6.address.as_str(), v6.bind, v6.pid),
            ("::1", Bind::Loopback, None)
        );

        let wildcard = by_port(36151).next().unwrap();
        assert_eq!(wildcard.bind, Bind::Wildcard);
        assert_eq!(
            wildcard.pid,
            Some(4100),
            "a socket shared by two processes reports the lowest pid"
        );
        assert_eq!(by_port(1455).next().unwrap().address, "::");
        assert_eq!(
            by_port(10000).next().unwrap().bind,
            Bind::Loopback,
            "an IPv4-mapped loopback is loopback"
        );
        assert_eq!(by_port(3000).next().unwrap().address, "127.0.0.2");

        let root_owned = by_port(54321).next().unwrap();
        assert!(!root_owned.owned_by_session_user);
        assert_eq!(
            (
                root_owned.pid,
                root_owned.comm.clone(),
                root_owned.started_at.clone()
            ),
            (None, None, None)
        );
    }

    #[test]
    fn linux_listing_never_contains_arguments_or_environment() {
        let root = host();
        fs::write(
            root.path().join("4242/cmdline"),
            "aws\0sso\0login\0--secret-argument\0",
        )
        .unwrap();
        fs::write(
            root.path().join("4242/environ"),
            "TOKEN=secret-environment\0",
        )
        .unwrap();
        let text = serde_json::to_string(&finish(proc::read(root.path(), 1000, 100).unwrap(), &[]))
            .unwrap();
        assert!(!text.contains("secret"), "{text}");
    }

    #[test]
    fn a_host_without_proc_is_an_error_and_without_ipv6_is_not() {
        let root = tempfile::tempdir().unwrap();
        assert!(proc::read(root.path(), 1000, 100).is_err());
        fs::create_dir_all(root.path().join("net")).unwrap();
        fs::write(root.path().join("net/tcp"), HEADER).unwrap();
        assert!(proc::read(root.path(), 1000, 100).unwrap().is_empty());
    }
}
