use crate::ssh::{quote, Result, Session, SshError};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, time::Duration};
#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
))]
use tokio::sync::watch;
use tokio::time::timeout;
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(default = "default_server")]
    server_path: String,
    #[serde(default = "default_min")]
    port_min: u16,
    #[serde(default = "default_max")]
    port_max: u16,
}
fn default_server() -> String {
    "mosh-server".into()
}
fn default_min() -> u16 {
    60000
}
fn default_max() -> u16 {
    61000
}
impl Default for Options {
    fn default() -> Self {
        Self {
            server_path: default_server(),
            port_min: default_min(),
            port_max: default_max(),
        }
    }
}
impl Options {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.server_path.trim().is_empty()
            || self.server_path.len() > 4096
            || self.server_path.chars().any(char::is_control)
            || self.port_min == 0
            || self.port_max < self.port_min
            || self.port_max - self.port_min > 1000
        {
            return Err(SshError::new("invalid_mosh_options", "Choose a server executable and a UDP port range of at most 1001 ports from 1 to 65535"));
        }
        Ok(())
    }
    fn command(&self, locale: &str) -> String {
        format!(
            "{} new -s -c 256 -p {}:{} -l {}",
            quote(&self.server_path),
            self.port_min,
            self.port_max,
            quote(&format!("LC_ALL={locale}"))
        )
    }
}
#[derive(Serialize)]
pub struct Capabilities {
    mosh: bool,
    et: bool,
}
#[tauri::command]
pub fn transport_capabilities() -> Capabilities {
    Capabilities {
        mosh: cfg!(any(
            target_os = "linux",
            target_os = "macos",
            target_os = "android",
            target_os = "ios"
        )),
        et: true,
    }
}

pub(crate) fn check_size(cols: u32, rows: u32) -> Result<()> {
    if cols == 0
        || rows == 0
        || cols > 512
        || rows > 256
        || u64::from(cols) * u64::from(rows) > 32768
    {
        return Err(SshError::new(
            "invalid_mosh_size",
            "Mosh supports at most 512 columns, 256 rows, and 32768 screen cells",
        ));
    }
    Ok(())
}
pub(crate) struct Bootstrap {
    key: Zeroizing<String>,
    remote: SocketAddr,
}
fn parse_bootstrap(bytes: &[u8], mut address: SocketAddr, options: &Options) -> Result<Bootstrap> {
    let fail = || {
        SshError::new(
            "mosh_bootstrap",
            "The host did not return a valid bounded Mosh bootstrap reply",
        )
    };
    if bytes.len() > 8192 {
        return Err(fail());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| fail())?;
    let mut replies = text
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("MOSH CONNECT "));
    let line = replies.next().ok_or_else(fail)?;
    if replies.next().is_some() {
        return Err(fail());
    }
    let words: Vec<_> = line.split_ascii_whitespace().collect();
    if words.len() != 4 {
        return Err(fail());
    }
    let port = words[2].parse::<u16>().map_err(|_| fail())?;
    let key = words[3];
    if !(options.port_min..=options.port_max).contains(&port)
        || key.len() != 22
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
    {
        return Err(fail());
    }
    address.set_port(port);
    Ok(Bootstrap {
        key: Zeroizing::new(key.to_owned()),
        remote: address,
    })
}
fn utf8_locale(bytes: &[u8]) -> Result<String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| SshError::new("mosh_locale", "The host did not return UTF-8 locale names"))?;
    let mut candidates: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 64
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.@-".contains(&byte))
                && name
                    .to_ascii_lowercase()
                    .replace(['-', '_', '.'], "")
                    .contains("utf8")
        })
        .collect();
    candidates.sort_by_key(|name| {
        let normalized = name.to_ascii_lowercase().replace(['-', '_', '.'], "");
        if normalized == "cutf8" {
            0
        } else if normalized == "enusutf8" {
            1
        } else {
            2
        }
    });
    candidates
        .first()
        .map(|name| (*name).to_owned())
        .ok_or_else(|| {
            SshError::new(
                "mosh_locale",
                "Install a UTF-8 locale on the host before using Mosh",
            )
        })
}
async fn bootstrap_exec(session: &Session, command: String) -> Result<Zeroizing<Vec<u8>>> {
    let mut cancelled = session.cancel.subscribe();
    if *cancelled.borrow() {
        return Err(SshError::new("cancelled", "Mosh connection was cancelled"));
    }
    let mut channel = tokio::select! {
        _ = cancelled.changed() => return Err(SshError::new("cancelled", "Mosh connection was cancelled")),
        result = timeout(Duration::from_secs(15), session.handle.channel_open_session()) => result.map_err(|_| SshError::new("mosh_bootstrap", "Opening Mosh bootstrap channel timed out"))??,
    };
    let result = tokio::select! {
        _ = cancelled.changed() => Err(SshError::new("cancelled", "Mosh connection was cancelled")),
        result = timeout(Duration::from_secs(15), async {
            channel.exec(true, command).await?;
            let mut bytes = Zeroizing::new(Vec::new());
            let mut received = 0usize;
            let mut status = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        received = received.saturating_add(data.len());
                        if received > 8192 { return Err(SshError::new("mosh_bootstrap", "Mosh bootstrap output exceeds 8 KiB")); }
                        bytes.extend_from_slice(&data);
                    },
                    ChannelMsg::ExtendedData { data, .. } => {
                        received = received.saturating_add(data.len());
                        if received > 8192 { return Err(SshError::new("mosh_bootstrap", "Mosh bootstrap output exceeds 8 KiB")); }
                    },
                    ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                    _ => {},
                }
            }
            if status != Some(0) { return Err(SshError::new("mosh_bootstrap", "Mosh server failed to start. Check its executable path and UTF-8 locales.")); }
            Ok(bytes)
        }) => match result { Ok(result) => result, Err(_) => Err(SshError::new("mosh_bootstrap", "Mosh bootstrap timed out")) },
    };
    let _ = timeout(Duration::from_secs(2), channel.close()).await;
    result
}
pub(crate) async fn bootstrap(
    session: &Session,
    options: Options,
    cols: u32,
    rows: u32,
) -> Result<Bootstrap> {
    options.validate()?;
    check_size(cols, rows)?;
    if !cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    )) {
        return Err(SshError::new(
            "mosh_unsupported",
            "Mosh is currently supported on Linux, macOS, Android and iOS builds",
        ));
    }
    if session.handle.agent_forwarding_enabled() {
        return Err(SshError::new("mosh_unsupported_forwarding", "Agent forwarding is currently supported only by SSH terminals. Disable forwarding before selecting Mosh."));
    }
    let address = session.handle.peer_address.ok_or_else(|| {
        SshError::new(
            "mosh_unsupported_route",
            "Mosh requires a direct SSH connection; bastion routes currently support SSH terminals",
        )
    })?;
    let locales = bootstrap_exec(session, "locale -a".into()).await?;
    let locale = utf8_locale(&locales)?;
    let bytes = bootstrap_exec(session, options.command(&locale)).await?;
    parse_bootstrap(&bytes, address, &options)
}

#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    bootstrap: Bootstrap,
    cols: u32,
    rows: u32,
    access: crate::app_lock::AccessState,
    mut input: tokio::sync::mpsc::Receiver<crate::ssh::Input>,
    cancelled: watch::Receiver<bool>,
    initial_cancel: watch::Receiver<bool>,
    output: tokio::sync::mpsc::Sender<Vec<u8>>,
    ready: tokio::sync::oneshot::Sender<Result<()>>,
) -> Result<()> {
    let mut ready = Some(ready);
    let result = (|| -> Result<()> {
        let mut client = lazysh_mosh_transport::Client::new(
            &bootstrap.key,
            bootstrap.remote,
            cols as u16,
            rows as u16,
        )
        .map_err(|error| SshError::new("mosh", error))?;
        drop(bootstrap);
        let result = (|| -> Result<()> {
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            let mut pending: Option<(
                crate::terminal_input::InputSequence,
                crate::app_lock::AccessLease,
            )> = None;
            loop {
                if *cancelled.borrow()
                    || output.is_closed()
                    || (ready.is_some() && *initial_cancel.borrow())
                {
                    return Ok(());
                }
                let output_paused = access.is_locked() || output.capacity() == 0;
                client
                    .pause_output(output_paused)
                    .map_err(|error| SshError::new("mosh", error))?;
                let update = client
                    .poll()
                    .map_err(|error| SshError::new("mosh", error))?;
                if update.finished && ready.is_some() {
                    return Err(SshError::new(
                        "mosh_closed",
                        "Mosh server closed before the connection completed",
                    ));
                }
                if ready.is_some() {
                    if update.connected {
                        if let Some(sender) = ready.take() {
                            let _ = sender.send(Ok(()));
                        }
                    } else if std::time::Instant::now() >= deadline {
                        return Err(SshError::new("mosh_udp_unreachable", "Mosh did not receive an authenticated UDP reply. Allow the configured UDP range to this SSH host."));
                    }
                }
                let mut accepted = true;
                if !update.bytes.is_empty() {
                    match output.try_send(update.bytes) {
                        Ok(()) => {}
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return Ok(()),
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            accepted = false;
                            // No UDP-loop blocking: next accepted output is a full redraw.
                            client
                                .pause_output(true)
                                .map_err(|error| SshError::new("mosh", error))?;
                        }
                    }
                }
                if update.finished {
                    if !output_paused && accepted {
                        return Ok(());
                    }
                    // Protocol completion does not retire a paused final screen.
                    // Keep the bounded native framebuffer until resume forces a
                    // full redraw; cancellation above still takes priority.
                    client
                        .wait(update.next_poll.min(Duration::from_millis(20)))
                        .map_err(|error| SshError::new("mosh", error))?;
                    continue;
                }
                let mut available = update.input_capacity;
                for _ in 0..32 {
                    if pending
                        .as_ref()
                        .is_some_and(|(_, lease)| lease.check().is_err())
                    {
                        pending = None;
                    }
                    if let Some((data, lease)) = &mut pending {
                        if !data.delay().is_zero() {
                            break;
                        }
                        let count = data.bytes().len().min(available).min(16384);
                        if count == 0 {
                            break;
                        }
                        match lease.with_current(|| client.write(&data.bytes()[..count])) {
                            Ok(result) => result.map_err(|error| SshError::new("mosh", error))?,
                            Err(_) => {
                                pending = None;
                                continue;
                            }
                        }
                        data.advance(count);
                        available -= count;
                        if data.is_empty() {
                            pending = None;
                        } else {
                            continue;
                        }
                    }
                    if available == 0 {
                        break;
                    }
                    match input.try_recv() {
                        Ok(crate::ssh::Input::Data(data, lease))
                            if !data.is_empty() && lease.check().is_ok() =>
                        {
                            pending = Some((data, lease))
                        }
                        Ok(crate::ssh::Input::Data(_, _)) => {}
                        Ok(crate::ssh::Input::Resize(cols, rows, lease)) => {
                            if let Ok(result) =
                                lease.with_current(|| client.resize(cols as u16, rows as u16))
                            {
                                result.map_err(|error| SshError::new("mosh", error))?;
                            }
                            available -= 1;
                        }
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return Ok(()),
                    }
                }
                client
                    .wait(update.next_poll.min(Duration::from_millis(20)))
                    .map_err(|error| SshError::new("mosh", error))?;
            }
        })();
        let _ = client.shutdown();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match client.poll() {
                Ok(update) if update.finished => break,
                Err(_) => break,
                _ => {}
            }
            let _ = client.wait(Duration::from_millis(20));
        }
        result
    })();
    if let Some(sender) = ready {
        let response = match &result {
            Err(error) => Err(error.clone()),
            Ok(()) => Err(SshError::new(
                "cancelled",
                "Mosh connection ended before authentication completed",
            )),
        };
        let _ = sender.send(response);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_rejects_ambiguous_unbounded_or_out_of_range_secrets_without_echoing_them() {
        let options = Options::default();
        let address = "127.0.0.1:22".parse().unwrap();
        let valid = b"MOSH CONNECT 60001 AAAAAAAAAAAAAAAAAAAAAA\n";
        assert_eq!(
            parse_bootstrap(valid, address, &options)
                .unwrap()
                .remote
                .port(),
            60001
        );
        for bytes in [b"MOSH CONNECT 22 secret\n".as_slice(), b"MOSH CONNECT 60001 AAAAAAAAAAAAAAAAAAAAAA extra\n", b"MOSH CONNECT 60001 AAAAAAAAAAAAAAAAAAAAAA\nMOSH CONNECT 60002 AAAAAAAAAAAAAAAAAAAAAA\n", &vec![b'x'; 8193]] {
            let error = parse_bootstrap(bytes, address, &options).err().unwrap();
            assert!(!format!("{error:?}").contains("AAAAAAAA"));
        }
    }
    #[test]
    fn options_and_locale_names_are_bounded_and_shell_quoted() {
        let options = Options {
            server_path: "safe'name;touch /tmp/nope".into(),
            ..Default::default()
        };
        options.validate().unwrap();
        assert!(options
            .command("C.utf8")
            .starts_with("'safe'\\''name;touch /tmp/nope' new -s"));
        assert_eq!(utf8_locale(b"C\nen_US.UTF-8\nC.utf8\n").unwrap(), "C.utf8");
        assert!(utf8_locale(b"en_US.UTF-8;touch /tmp/nope\nC\n").is_err());
        assert!(Options {
            port_min: 0,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Options {
            port_max: 62000,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(check_size(512, 256).is_err());
    }
    #[test]
    fn bootstrap_preserves_scoped_ipv6_peer_identity() {
        let endpoint = SocketAddr::V6(std::net::SocketAddrV6::new(
            "fe80::1".parse().unwrap(),
            22,
            0,
            7,
        ));
        let reply = parse_bootstrap(
            b"MOSH CONNECT 60001 AAAAAAAAAAAAAAAAAAAAAA\n",
            endpoint,
            &Options::default(),
        )
        .unwrap();
        let SocketAddr::V6(address) = reply.remote else {
            panic!("IPv6 endpoint was changed")
        };
        assert_eq!(address.scope_id(), 7);
        assert_eq!(address.port(), 60001);
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[derive(Clone, Copy)]
    enum FinalScreenCase {
        Locked,
        OutputFull,
        Cancel,
        Rebind,
        ClosedReceiver,
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    async fn finished_screen_fixture(scenario: FinalScreenCase) {
        use crate::app_lock::AccessState;
        use lazysh_mosh_transport::{fixture_ack, fixture_packet};
        use tokio::sync::{mpsc, oneshot};
        struct Cancel(watch::Sender<bool>);
        impl Drop for Cancel {
            fn drop(&mut self) {
                self.0.send_replace(true);
            }
        }
        fn screen(text: &str) -> Vec<u8> {
            assert!(text.len() < 100);
            let mut data = vec![
                0x0a,
                text.len() as u8 + 4,
                0x12,
                text.len() as u8 + 2,
                0x22,
                text.len() as u8,
            ];
            data.extend_from_slice(text.as_bytes());
            data
        }
        async fn until(output: &mut mpsc::Receiver<Vec<u8>>, marker: &str) {
            timeout(Duration::from_secs(5), async {
                let mut text = Vec::new();
                loop {
                    text.extend(
                        output
                            .recv()
                            .await
                            .expect("Mosh ended before its final screen was delivered"),
                    );
                    assert!(text.len() <= 8 * 1024 * 1024);
                    if String::from_utf8_lossy(&text).contains(marker) {
                        break;
                    }
                }
            })
            .await
            .expect("Mosh final display timed out");
        }
        let access = AccessState::default();
        access.initialize(true, true, "fixture".into()).unwrap();
        access.authorize(access.generation().unwrap()).unwrap();
        access.ready(access.generation().unwrap()).unwrap();
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let bootstrap = Bootstrap {
            key: Zeroizing::new("AAAAAAAAAAAAAAAAAAAAAA".into()),
            remote: socket.local_addr().unwrap(),
        };
        let (_input, input) = mpsc::channel(1);
        let (cancel, cancelled) = watch::channel(false);
        let cancellation = Cancel(cancel);
        let (_parent, parent) = watch::channel(false);
        let (output, mut received) = mpsc::channel(1);
        let filler = output.clone();
        let (ready, connected) = oneshot::channel();
        let authority = access.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            run(
                bootstrap, 80, 24, authority, input, cancelled, parent, output, ready,
            )
        });
        let mut datagram = [0; 2048];
        let (_, peer) = timeout(Duration::from_secs(5), socket.recv_from(&mut datagram))
            .await
            .unwrap()
            .unwrap();
        socket
            .send_to(&fixture_packet(0, 1, &screen("BASE")).unwrap(), peer)
            .await
            .unwrap();
        timeout(Duration::from_secs(5), connected)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        until(&mut received, "BASE").await;
        if matches!(scenario, FinalScreenCase::OutputFull) {
            filler.try_send(b"BLOCKER".to_vec()).unwrap();
        } else {
            access.lock().unwrap();
        }
        drop(filler);
        socket
            .send_to(
                &fixture_packet(1, u64::MAX, &screen("FINAL_SCREEN")).unwrap(),
                peer,
            )
            .await
            .unwrap();
        // An authenticated ACK for the terminal shutdown state proves that the
        // native poll saw the final framebuffer while this output gate was closed.
        timeout(Duration::from_secs(5), async {
            loop {
                let (size, sender) = socket.recv_from(&mut datagram).await.unwrap();
                assert_eq!(sender, peer);
                if fixture_ack(&datagram[..size]).unwrap() == u64::MAX {
                    break;
                }
            }
        })
        .await
        .expect("peer did not acknowledge the final native state");
        match scenario {
            FinalScreenCase::ClosedReceiver => {
                drop(received);
                assert!(access.is_locked());
                assert!(!*cancellation.0.borrow());
                timeout(Duration::from_secs(3), worker)
                    .await
                    .expect("closed output receiver must not wait for unlock or cancellation")
                    .unwrap()
                    .unwrap();
                assert!(access.is_locked());
                assert!(!*cancellation.0.borrow());
                return;
            }
            FinalScreenCase::Cancel | FinalScreenCase::Rebind => {
                if matches!(scenario, FinalScreenCase::Rebind) {
                    access.replace_renderer().unwrap();
                }
                cancellation.0.send_replace(true);
                timeout(Duration::from_secs(3), worker)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert!(received.recv().await.is_none());
                return;
            }
            FinalScreenCase::Locked | FinalScreenCase::OutputFull => {}
        }
        if matches!(scenario, FinalScreenCase::OutputFull) {
            assert_eq!(received.recv().await.unwrap(), b"BLOCKER");
        } else {
            assert!(
                received.try_recv().is_err(),
                "final output escaped the locked gate"
            );
            access.authorize(access.generation().unwrap()).unwrap();
            access.ready(access.generation().unwrap()).unwrap();
        }
        until(&mut received, "FINAL_SCREEN").await;
        timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(received.recv().await.is_none());
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[tokio::test]
    async fn final_screen_survives_server_shutdown_while_locked() {
        finished_screen_fixture(FinalScreenCase::Locked).await;
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[tokio::test]
    async fn final_screen_survives_server_shutdown_while_output_is_full() {
        finished_screen_fixture(FinalScreenCase::OutputFull).await;
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[tokio::test]
    async fn renderer_rebind_cancels_a_finished_locked_client_without_final_output() {
        finished_screen_fixture(FinalScreenCase::Rebind).await;
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[tokio::test]
    async fn cancellation_does_not_wait_for_final_screen_unlock() {
        finished_screen_fixture(FinalScreenCase::Cancel).await;
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    ))]
    #[tokio::test]
    async fn closed_receiver_does_not_wait_for_final_screen_unlock_or_cancellation() {
        finished_screen_fixture(FinalScreenCase::ClosedReceiver).await;
    }
}
