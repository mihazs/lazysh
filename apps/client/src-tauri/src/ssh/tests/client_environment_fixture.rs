//! Real OpenSSH receipt of the opt-in client marker in remote terminals.
use super::*;
use std::path::Path;

pub(super) fn environment(directory: &Path) -> String {
    // A private HOME must not trigger zsh's interactive first-user setup.
    fs::write(directory.join(".zshrc"), b"").unwrap();
    // `AcceptEnv LANG LC_*` is the common distribution default: the marker
    // must arrive without a lazysh-specific server rule.
    format!(
        "PermitUserRC no\nAcceptEnv LANG LC_*\nSetEnv HOME={0} ZDOTDIR={0} BASH_ENV=/dev/null ENV=/dev/null\n",
        directory.display()
    )
}

const PROBE: &str = r#"printf 'MARK<%s>\n' "${LC_TERMINAL-unset}""#;

/// Collects terminal output until the remote side closes, bounded in time and size.
async fn drain(mut channel: OwnedChannel, mut output: Vec<u8>) -> String {
    timeout(Duration::from_secs(8), async {
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::Close => break,
                _ => {}
            }
            assert!(output.len() <= 64 * 1024, "unbounded probe output");
        }
    })
    .await
    .expect("remote probe did not finish");
    String::from_utf8_lossy(&output).into_owned()
}

/// What an interactive login shell on this host reports for the marker.
async fn interactive(state: &AppState, host: &Host, key: &russh::keys::PrivateKey) -> String {
    let handle = key_handle(state, host, key).await;
    let (channel, initial) = open_terminal(&handle, 80, 24, None).await.unwrap();
    channel
        .data(format!("{PROBE}; exit\n").as_bytes())
        .await
        .unwrap();
    drain(channel, initial).await
}

pub(super) async fn verify(state: &AppState, host: &Host, key: &russh::keys::PrivateKey) {
    let flagged = Host {
        client_environment: true,
        ..host.clone()
    };
    // The PTY echoes the typed probe, which never contains a resolved value.
    let enabled = interactive(state, &flagged, key).await;
    assert!(enabled.contains("MARK<lazysh>"), "{enabled}");
    let disabled = interactive(state, host, key).await;
    assert!(disabled.contains("MARK<unset>"), "{disabled}");
    assert!(!disabled.contains("MARK<lazysh>"), "{disabled}");

    // Multiplexer attachment uses the same PTY channel with a remote command.
    let handle = key_handle(state, &flagged, key).await;
    let (channel, initial) = open_terminal(&handle, 80, 24, Some(PROBE.into()))
        .await
        .unwrap();
    let command = drain(channel, initial).await;
    assert!(command.contains("MARK<lazysh>"), "{command}");
}
