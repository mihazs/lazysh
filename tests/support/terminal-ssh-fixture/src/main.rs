// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Loopback SSH peer for installed terminal acceptance. It never invokes a shell.
use russh::{
    keys::{Algorithm, HashAlg, PrivateKey},
    server::{self, Server},
    Channel, ChannelId, Pty,
};
use std::{sync::Arc, time::Duration};
use tokio::net::TcpListener;

const NATIVE_INPUT: &[u8] = b"LAZYSH_IOS_NATIVE";
const XTERM_INPUT: &[u8] = b"LAZYSH_IOS_XTERM";

#[derive(Clone, Copy, Default)]
enum InputStage {
    #[default]
    Native,
    Xterm,
    Complete,
}

impl InputStage {
    fn acknowledge(&mut self, line: &[u8]) -> Option<(&'static str, &'static [u8])> {
        match (*self, line) {
            (Self::Native, NATIVE_INPUT) => {
                *self = Self::Xterm;
                Some(("native", b"LAZYSH_IOS_ACK_NATIVE\r\n"))
            }
            (Self::Xterm, XTERM_INPUT) => {
                *self = Self::Complete;
                Some(("xterm", b"LAZYSH_IOS_ACK_XTERM\r\n"))
            }
            _ => None,
        }
    }
}

#[derive(Clone)]
struct Peer {
    password: Arc<str>,
    pty: Option<ChannelId>,
    line: Vec<u8>,
    input: InputStage,
}

impl Server for Peer {
    type Handler = Self;

    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for Peer {
    type Error = russh::Error;

    async fn auth_password(
        &mut self,
        username: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        Ok(
            if username == "terminal-fixture" && password == &*self.password {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            },
        )
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        terminal: &str,
        columns: u32,
        rows: u32,
        _pixel_width: u32,
        _pixel_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if terminal.is_empty() || columns == 0 || rows == 0 || self.pty.is_some() {
            return session.channel_failure(channel);
        }
        self.pty = Some(channel);
        session.channel_success(channel)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.pty != Some(channel) {
            return session.channel_failure(channel);
        }
        session.channel_success(channel)?;
        session.data(
            channel,
            b"\x1b[2J\x1b[H\x1b[41mLAZYSH_IOS_FRAME\x1b[0m\r\n".to_vec(),
        )
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.pty != Some(channel) {
            return Ok(());
        }
        for &byte in data {
            if matches!(byte, b'\r' | b'\n') {
                if let Some((engine, acknowledgement)) = self.input.acknowledge(&self.line) {
                    println!("terminal fixture received exact {engine} input");
                    session.data(channel, acknowledgement.to_vec())?;
                } else if matches!(self.line.as_slice(), NATIVE_INPUT | XTERM_INPUT) {
                    println!("terminal fixture rejected repeated or out-of-order input");
                }
                self.line.clear();
            } else if self.line.len() <= NATIVE_INPUT.len().max(XTERM_INPUT.len()) {
                self.line.push(byte);
            }
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let password = std::env::var("LAZYSH_TERMINAL_FIXTURE_PASSWORD")?;
    if password.len() != 32 || !password.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The test needs a generated 32-digit hexadecimal password".into());
    }

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256);
    let config = Arc::new(server::Config {
        keys: vec![key],
        inactivity_timeout: Some(Duration::from_secs(45)),
        ..Default::default()
    });
    let mut peer = Peer {
        password: password.into(),
        pty: None,
        line: Vec::new(),
        input: InputStage::default(),
    };
    println!("{} {fingerprint}", listener.local_addr()?.port());
    tokio::time::timeout(
        Duration::from_secs(300),
        peer.run_on_socket(config, &listener),
    )
    .await??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{InputStage, NATIVE_INPUT, XTERM_INPUT};

    #[test]
    fn acknowledges_each_engine_once_and_in_order_on_one_channel() {
        let mut stage = InputStage::default();
        assert_eq!(stage.acknowledge(XTERM_INPUT), None);
        assert_eq!(
            stage.acknowledge(NATIVE_INPUT).map(|(kind, _)| kind),
            Some("native")
        );
        assert_eq!(stage.acknowledge(NATIVE_INPUT), None);
        assert_eq!(
            stage.acknowledge(XTERM_INPUT).map(|(kind, _)| kind),
            Some("xterm")
        );
        assert_eq!(stage.acknowledge(XTERM_INPUT), None);
        assert_eq!(InputStage::default().acknowledge(XTERM_INPUT), None);
    }
}
