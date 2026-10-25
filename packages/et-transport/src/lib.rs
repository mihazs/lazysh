//! In-process client for released Eternal Terminal 7.0.0 (wire protocol 6).
//! Bootstrap is performed by the caller over a verified SSH connection.
//! Reconnect preserves crypto state; there is no cold-session restoration API.
mod crypto;
mod proto;

use crypto::Cipher;
use prost::Message;
use std::{collections::VecDeque, fmt, net::SocketAddr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use zeroize::Zeroizing;

pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_INPUT: usize = 64 * 1024;
const MAX_SETUP: usize = 8 * 1024 * 1024;
const MAX_HISTORY: usize = 8 * 1024 * 1024;
const MAX_DISCONNECTED: usize = 1024 * 1024;
const MAX_PACKETS: usize = 4096;
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);
const PEER_TIMEOUT: Duration = Duration::from_secs(15);
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Protocol(&'static str),
    Authentication,
    BufferFull,
    RecoveryHistoryUnavailable,
    FreshBootstrapRequired,
    UnsupportedHandshake,
    Closed,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "ET connection failed: {error}"),
            Self::Protocol(message) => write!(f, "{message}"),
            Self::Authentication => write!(f, "ET packet authentication failed"),
            Self::BufferFull => write!(f, "ET disconnected input buffer is full"),
            Self::RecoveryHistoryUnavailable => write!(
                f,
                "ET recovery exceeds retained history; create a fresh session"
            ),
            Self::FreshBootstrapRequired => {
                write!(f, "ET session already exists; create a fresh SSH bootstrap")
            }
            Self::UnsupportedHandshake => write!(
                f,
                "ET server requested an unsupported authenticated recovery handshake"
            ),
            Self::Closed => write!(f, "ET connection closed"),
        }
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Secret from one fresh, verified SSH bootstrap. It cannot be cloned or serialized.
pub struct SessionSecret {
    id: String,
    key: Zeroizing<[u8; 32]>,
}
impl fmt::Debug for SessionSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionSecret([redacted])")
    }
}
impl SessionSecret {
    pub fn from_bootstrap(output: &[u8]) -> Result<Self> {
        if output.len() > 65536 {
            return Err(Error::Protocol("ET bootstrap output exceeds limit"));
        }
        let output = std::str::from_utf8(output)
            .map_err(|_| Error::Protocol("Invalid ET bootstrap encoding"))?;
        let mut markers = output.match_indices("IDPASSKEY:");
        let start = markers
            .next()
            .ok_or(Error::Protocol("Missing ET bootstrap credentials"))?
            .0
            + 10;
        if markers.next().is_some() {
            return Err(Error::Protocol("Ambiguous ET bootstrap credentials"));
        }
        let payload = output
            .as_bytes()
            .get(start..start + 49)
            .ok_or(Error::Protocol("Incomplete ET bootstrap credentials"))?;
        if payload[16] != b'/'
            || !payload[..16]
                .iter()
                .chain(&payload[17..])
                .all(u8::is_ascii_alphanumeric)
            || output
                .as_bytes()
                .get(start + 49)
                .is_some_and(|value| !value.is_ascii_whitespace())
        {
            return Err(Error::Protocol("Invalid ET bootstrap credentials"));
        }
        Ok(Self {
            id: String::from_utf8(payload[..16].to_vec())
                .map_err(|_| Error::Protocol("Invalid ET client ID"))?,
            key: Zeroizing::new(
                payload[17..]
                    .try_into()
                    .map_err(|_| Error::Protocol("Invalid ET key"))?,
            ),
        })
    }
}

#[derive(Debug)]
pub enum Event {
    Output(Vec<u8>),
    Disconnected,
    Reconnected,
    Failed(Error),
}
enum Command {
    Input(Vec<u8>, oneshot::Sender<Result<()>>),
    Resize(u16, u16, oneshot::Sender<Result<()>>),
    Reconnect(SocketAddr, oneshot::Sender<Result<()>>),
}

/// Clonable input control, so reads and input can be selected concurrently.
#[derive(Clone)]
pub struct Control {
    commands: mpsc::Sender<Command>,
}
impl Control {
    /// Accept input into the bounded transport. Success does not claim remote execution.
    pub async fn send(&self, data: Vec<u8>) -> Result<()> {
        if data.is_empty() || data.len() > MAX_INPUT {
            return Err(Error::Protocol("ET input must be 1..65536 bytes"));
        }
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Input(data, reply))
            .await
            .map_err(|_| Error::Closed)?;
        result.await.map_err(|_| Error::Closed)?
    }
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        check_size(cols, rows)?;
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Resize(cols, rows, reply))
            .await
            .map_err(|_| Error::Closed)?;
        result.await.map_err(|_| Error::Closed)?
    }
    /// Recover the current in-memory session. The endpoint may follow ordinary DNS changes.
    pub async fn reconnect(&self, endpoint: SocketAddr) -> Result<()> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Reconnect(endpoint, reply))
            .await
            .map_err(|_| Error::Closed)?;
        result.await.map_err(|_| Error::Closed)?
    }
}
pub struct Client {
    control: Control,
    events: mpsc::Receiver<Event>,
    cancel: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}
impl Client {
    pub async fn connect(
        endpoint: SocketAddr,
        secret: SessionSecret,
        cols: u16,
        rows: u16,
    ) -> Result<Self> {
        check_size(cols, rows)?;
        let mut transport = Transport::new(secret);
        transport.initial_connect(endpoint, cols, rows).await?;
        let (commands, input) = mpsc::channel(32);
        let (events, output) = mpsc::channel(16);
        let (cancel, cancelled) = watch::channel(false);
        let task = tokio::spawn(async move {
            transport.run(input, events, cancelled).await;
        });
        Ok(Self {
            control: Control { commands },
            events: output,
            cancel,
            task: Some(task),
        })
    }
    pub fn control(&self) -> Control {
        self.control.clone()
    }
    pub async fn next_event(&mut self) -> Option<Event> {
        self.events.recv().await
    }
    pub async fn close(mut self) {
        self.cancel.send_replace(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
fn check_size(cols: u16, rows: u16) -> Result<()> {
    if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err(Error::Protocol("Invalid ET terminal size"));
    }
    Ok(())
}

struct Transport {
    secret: SessionSecret,
    socket: Option<TcpStream>,
    incoming: Vec<u8>,
    encrypt: Cipher,
    decrypt: Cipher,
    sent: i32,
    received: i32,
    history: VecDeque<Vec<u8>>,
    history_bytes: usize,
    disconnected_bytes: usize,
}
impl Transport {
    fn new(secret: SessionSecret) -> Self {
        let encrypt = Cipher::new(&secret.key, 0);
        let decrypt = Cipher::new(&secret.key, 1);
        Self {
            secret,
            socket: None,
            incoming: Vec::new(),
            encrypt,
            decrypt,
            sent: 0,
            received: 0,
            history: VecDeque::new(),
            history_bytes: 0,
            disconnected_bytes: 0,
        }
    }
    async fn socket(&self, endpoint: SocketAddr) -> Result<TcpStream> {
        let mut socket = deadline(async { Ok(TcpStream::connect(endpoint).await?) }).await?;
        socket.set_nodelay(true)?;
        write_proto(
            &mut socket,
            &proto::ConnectRequest {
                client_id: Some(self.secret.id.clone()),
                version: Some(6),
            },
        )
        .await?;
        let response: proto::ConnectResponse = read_proto(&mut socket).await?;
        if response.auth_challenge.is_some() || response.reset_required == Some(true) {
            return Err(Error::UnsupportedHandshake);
        }
        match response.status {
            Some(2) => Ok(socket),
            Some(1) => Err(Error::FreshBootstrapRequired),
            _ => Err(Error::Authentication),
        }
    }
    async fn initial_connect(&mut self, endpoint: SocketAddr, cols: u16, rows: u16) -> Result<()> {
        let mut socket = deadline(async { Ok(TcpStream::connect(endpoint).await?) }).await?;
        socket.set_nodelay(true)?;
        write_proto(
            &mut socket,
            &proto::ConnectRequest {
                client_id: Some(self.secret.id.clone()),
                version: Some(6),
            },
        )
        .await?;
        let response: proto::ConnectResponse = read_proto(&mut socket).await?;
        if response.auth_challenge.is_some() || response.reset_required == Some(true) {
            return Err(Error::UnsupportedHandshake);
        }
        match response.status {
            Some(1) => {}
            Some(2) => return Err(Error::FreshBootstrapRequired),
            _ => return Err(Error::Authentication),
        }
        self.socket = Some(socket);
        self.write_packet(
            253,
            &proto::InitialPayload {
                jumphost: Some(false),
            }
            .encode_to_vec(),
        )
        .await?;
        if self.socket.is_none() {
            return Err(Error::Closed);
        }
        let (kind, payload) = deadline(async {
            loop {
                if let Some(packet) = self.packet()? {
                    return Ok(packet);
                }
                self.read_more().await?;
            }
        })
        .await?;
        if kind != 252 {
            return Err(Error::Protocol("Missing ET initialization response"));
        }
        let response = proto::InitialResponse::decode(payload.as_slice())
            .map_err(|_| Error::Protocol("Invalid ET initialization response"))?;
        if response.error.is_some_and(|error| !error.is_empty()) {
            return Err(Error::Protocol("ET server refused initialization"));
        }
        self.write_resize(cols, rows).await?;
        if self.socket.is_none() {
            return Err(Error::Closed);
        }
        Ok(())
    }
    async fn read_more(&mut self) -> Result<()> {
        let socket = self.socket.as_mut().ok_or(Error::Closed)?;
        let mut chunk = [0; 16384];
        let count = socket.read(&mut chunk).await?;
        if count == 0 {
            return Err(Error::Closed);
        }
        if self.incoming.len() + count > MAX_FRAME + 4 + chunk.len() {
            return Err(Error::Protocol("ET frame exceeds limit"));
        }
        self.incoming.extend_from_slice(&chunk[..count]);
        Ok(())
    }
    fn packet(&mut self) -> Result<Option<(u8, Vec<u8>)>> {
        if self.incoming.len() < 4 {
            return Ok(None);
        }
        let length = u32::from_be_bytes(
            self.incoming[..4]
                .try_into()
                .map_err(|_| Error::Protocol("Invalid ET frame"))?,
        ) as usize;
        if !(18..=MAX_FRAME).contains(&length) {
            return Err(Error::Protocol("ET frame exceeds limit"));
        }
        if self.incoming.len() < length + 4 {
            return Ok(None);
        }
        let packet = self.incoming[4..length + 4].to_vec();
        self.incoming.drain(..length + 4);
        self.decode_packet(&packet).map(Some)
    }
    fn decode_packet(&mut self, packet: &[u8]) -> Result<(u8, Vec<u8>)> {
        if !(18..=MAX_FRAME).contains(&packet.len()) || packet[0] != 1 {
            return Err(Error::Protocol("Invalid encrypted ET packet"));
        }
        let plaintext = self.decrypt.decrypt(&packet[2..])?;
        self.received = self
            .received
            .checked_add(1)
            .ok_or(Error::Protocol("ET sequence exhausted"))?;
        Ok((packet[1], plaintext))
    }
    fn queue_packet(&mut self, kind: u8, payload: &[u8]) -> Result<Vec<u8>> {
        let length = payload.len() + 18;
        if length > MAX_FRAME {
            return Err(Error::Protocol("ET packet exceeds limit"));
        }
        if self.socket.is_none()
            && (self.disconnected_bytes + length > MAX_DISCONNECTED
                || self.history_bytes + length > MAX_HISTORY
                || self.history.len() >= MAX_PACKETS)
        {
            return Err(Error::BufferFull);
        }
        let sent = self
            .sent
            .checked_add(1)
            .ok_or(Error::Protocol("ET sequence exhausted"))?;
        let mut packet = vec![1, kind];
        packet.extend(self.encrypt.encrypt(payload)?);
        self.sent = sent;
        self.history_bytes += packet.len();
        self.history.push_back(packet.clone());
        if self.socket.is_some() {
            while self.history_bytes > MAX_HISTORY || self.history.len() > MAX_PACKETS {
                if let Some(old) = self.history.pop_front() {
                    self.history_bytes -= old.len();
                }
            }
        } else {
            self.disconnected_bytes += packet.len();
        }
        Ok(packet)
    }
    async fn write_packet(&mut self, kind: u8, payload: &[u8]) -> Result<()> {
        let packet = self.queue_packet(kind, payload)?;
        if let Some(socket) = self.socket.as_mut() {
            let result = deadline(async {
                socket
                    .write_all(&(packet.len() as u32).to_be_bytes())
                    .await?;
                socket.write_all(&packet).await?;
                Ok(())
            })
            .await;
            if result.is_err() {
                self.socket = None;
                self.incoming.clear();
                self.disconnected_bytes = packet.len();
            }
        }
        Ok(())
    }
    async fn write_resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.write_packet(
            2,
            &proto::TerminalInfo {
                id: None,
                row: Some(i32::from(rows)),
                column: Some(i32::from(cols)),
            }
            .encode_to_vec(),
        )
        .await
    }
    async fn recover(&mut self, endpoint: SocketAddr) -> Result<Vec<(u8, Vec<u8>)>> {
        self.socket = None;
        self.incoming.clear();
        let mut socket = self.socket(endpoint).await?;
        write_proto(
            &mut socket,
            &proto::SequenceHeader {
                sequence_number: Some(self.received),
                reset: None,
            },
        )
        .await?;
        let remote: proto::SequenceHeader = read_proto(&mut socket).await?;
        if remote.reset == Some(true) {
            return Err(Error::UnsupportedHandshake);
        }
        let received = remote
            .sequence_number
            .filter(|number| *number >= 0 && *number <= self.sent)
            .ok_or(Error::Protocol("Invalid ET recovery sequence"))?;
        let missing = (self.sent - received) as usize;
        if missing > self.history.len() {
            return Err(Error::RecoveryHistoryUnavailable);
        }
        let buffer = self
            .history
            .iter()
            .skip(self.history.len() - missing)
            .cloned()
            .collect();
        write_proto(&mut socket, &proto::CatchupBuffer { buffer }).await?;
        let encoded = read_proto_bytes(&mut socket).await?;
        validate_catchup(&encoded)?;
        let catchup = proto::CatchupBuffer::decode(encoded.as_slice())
            .map_err(|_| Error::Protocol("Invalid ET recovery buffer"))?;
        let mut packets = Vec::with_capacity(catchup.buffer.len());
        for packet in catchup.buffer {
            packets.push(self.decode_packet(&packet)?);
        }
        self.socket = Some(socket);
        self.disconnected_bytes = 0;
        Ok(packets)
    }
    async fn emit(
        events: &mpsc::Sender<Event>,
        cancel: &mut watch::Receiver<bool>,
        event: Event,
    ) -> bool {
        tokio::select! { _ = cancel.changed() => false, result = events.send(event) => result.is_ok() }
    }
    async fn output(
        events: &mpsc::Sender<Event>,
        cancel: &mut watch::Receiver<bool>,
        packet: (u8, Vec<u8>),
    ) -> Result<()> {
        match packet.0 {
            0 => {}
            1 => {
                let output = proto::TerminalBuffer::decode(packet.1.as_slice())
                    .map_err(|_| Error::Protocol("Invalid ET terminal buffer"))?;
                if let Some(output) = output.buffer {
                    for chunk in output.chunks(16384) {
                        if !Self::emit(events, cancel, Event::Output(chunk.to_vec())).await {
                            return Err(Error::Closed);
                        }
                    }
                }
            }
            _ => return Err(Error::Protocol("Unsupported ET terminal packet")),
        }
        Ok(())
    }
    async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        events: mpsc::Sender<Event>,
        mut cancel: watch::Receiver<bool>,
    ) {
        let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Successful TCP writes do not establish peer liveness (a blackholed
        // connection can accept them locally for minutes). Only complete,
        // authenticated peer packets, including keepalive echoes, reset this.
        let mut last_received = tokio::time::Instant::now();
        let result = async {
            loop {
                if *cancel.borrow() { return Ok(()); }
                if self.socket.is_some() { if let Some(packet) = self.packet()? { Self::output(&events, &mut cancel, packet).await?; last_received = tokio::time::Instant::now(); continue; } }
                tokio::select! {
                    _ = cancel.changed() => return Ok(()),
                    command = commands.recv() => {
                        let Some(command) = command else { return Ok(()) };
                        let connected = self.socket.is_some();
                        match command {
                            Command::Input(data, reply) => { let payload = proto::TerminalBuffer { buffer: Some(data) }.encode_to_vec(); let result = tokio::select! { _ = cancel.changed() => return Ok(()), result = self.write_packet(1, &payload) => result }; let _ = reply.send(result); },
                            Command::Resize(cols, rows, reply) => { let result = tokio::select! { _ = cancel.changed() => return Ok(()), result = self.write_resize(cols, rows) => result }; let _ = reply.send(result); },
                            Command::Reconnect(endpoint, reply) => {
                                let recovery = tokio::select! { _ = cancel.changed() => return Ok(()), result = self.recover(endpoint) => result };
                                match recovery {
                                    Ok(packets) => { let _ = reply.send(Ok(())); for packet in packets { Self::output(&events, &mut cancel, packet).await?; } last_received = tokio::time::Instant::now(); if !Self::emit(&events, &mut cancel, Event::Reconnected).await { return Ok(()); } },
                                    Err(error @ (Error::Authentication | Error::UnsupportedHandshake | Error::RecoveryHistoryUnavailable | Error::Protocol(_))) => { let _ = reply.send(Err(error)); return Err(Error::Protocol("ET recovery failed; create a fresh session")); },
                                    Err(error) => { let _ = reply.send(Err(error)); },
                                }
                            }
                        }
                        if connected && self.socket.is_none() && !Self::emit(&events, &mut cancel, Event::Disconnected).await { return Ok(()); }
                    },
                    result = self.read_more(), if self.socket.is_some() => {
                        if let Err(error) = result { if matches!(error, Error::Protocol(_)) { return Err(error); } self.socket = None; self.incoming.clear(); if !Self::emit(&events, &mut cancel, Event::Disconnected).await { return Ok(()); } }
                    },
                    _ = keepalive.tick(), if self.socket.is_some() => {
                        tokio::select! { _ = cancel.changed() => return Ok(()), result = self.write_packet(0, b"") => result }?;
                        if self.socket.is_none() && !Self::emit(&events, &mut cancel, Event::Disconnected).await { return Ok(()); }
                    },
                    _ = tokio::time::sleep_until(last_received + PEER_TIMEOUT), if self.socket.is_some() => {
                        self.socket = None;
                        self.incoming.clear();
                        if !Self::emit(&events, &mut cancel, Event::Disconnected).await { return Ok(()); }
                    },
                }
            }
        }.await;
        if let Err(error) = result {
            if !*cancel.borrow() {
                let _ = Self::emit(&events, &mut cancel, Event::Failed(error)).await;
            }
        }
    }
}

async fn deadline<T>(future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    timeout(IO_TIMEOUT, future).await.map_err(|_| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "ET operation timed out",
        ))
    })?
}
async fn write_proto<M: Message>(socket: &mut TcpStream, value: &M) -> Result<()> {
    let encoded = value.encode_to_vec();
    if encoded.len() > MAX_SETUP {
        return Err(Error::Protocol("ET setup frame exceeds limit"));
    }
    deadline(async {
        socket
            .write_all(&(encoded.len() as i64).to_le_bytes())
            .await?;
        socket.write_all(&encoded).await?;
        Ok(())
    })
    .await
}
async fn read_proto_bytes(socket: &mut TcpStream) -> Result<Vec<u8>> {
    deadline(async {
        let length = socket.read_i64_le().await?;
        if !(0..=MAX_SETUP as i64).contains(&length) {
            return Err(Error::Protocol("ET setup frame exceeds limit"));
        }
        let mut encoded = vec![0; length as usize];
        socket.read_exact(&mut encoded).await?;
        Ok(encoded)
    })
    .await
}
async fn read_proto<M: Message + Default>(socket: &mut TcpStream) -> Result<M> {
    M::decode(read_proto_bytes(socket).await?.as_slice())
        .map_err(|_| Error::Protocol("Invalid ET setup message"))
}
fn validate_catchup(encoded: &[u8]) -> Result<()> {
    let mut input = encoded;
    let mut count = 0;
    while !input.is_empty() {
        if input[0] != 10 {
            return Err(Error::Protocol("Unsupported ET recovery field"));
        }
        input = &input[1..];
        let length = prost::encoding::decode_varint(&mut input)
            .map_err(|_| Error::Protocol("Invalid ET recovery length"))?;
        if length > MAX_FRAME as u64 || length < 18 || length > input.len() as u64 {
            return Err(Error::Protocol("ET recovery packet exceeds limit"));
        }
        count += 1;
        if count > MAX_PACKETS {
            return Err(Error::Protocol("ET recovery packet count exceeds limit"));
        }
        input = &input[length as usize..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn secret() -> SessionSecret {
        SessionSecret::from_bootstrap(
            b"IDPASSKEY:abcdefghijklmnop/01234567890123456789012345678901\n",
        )
        .unwrap()
    }
    #[tokio::test]
    async fn blackholed_peer_disconnects_even_when_tcp_writes_succeed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (socket, peer) = tokio::join!(
            TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept()
        );
        let (mut peer_read, mut peer_write) = peer.unwrap().0.into_split();
        let (probes, mut observed_probes) = mpsc::channel(8);
        // Drain every probe so local TCP buffers never fill: this reproduces a
        // silent peer independently of socket write/read timeout behavior.
        let drain = tokio::spawn(async move {
            let mut cipher = Cipher::new(&secret().key, 0);
            while let Ok(length) = peer_read.read_u32().await {
                let mut packet = vec![0; length as usize];
                peer_read.read_exact(&mut packet).await.unwrap();
                assert_eq!(&packet[..2], &[1, 0]);
                assert!(cipher.decrypt(&packet[2..]).unwrap().is_empty());
                if probes.send(()).await.is_err() {
                    break;
                }
            }
        });
        let mut transport = Transport::new(secret());
        transport.socket = Some(socket.unwrap());
        let (commands, command_rx) = mpsc::channel(8);
        let (events, mut event_rx) = mpsc::channel(8);
        let (cancel, cancel_rx) = watch::channel(false);
        let worker = tokio::spawn(transport.run(command_rx, events, cancel_rx));
        observed_probes.recv().await.unwrap();
        // Keep the executor runnable so time advances only at these explicit
        // steps while the loopback TCP peer is scheduled independently.
        let clock_guard = tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        });
        tokio::time::pause();
        for _ in 0..2 {
            tokio::time::advance(KEEPALIVE_INTERVAL).await;
            observed_probes.recv().await.unwrap();
        }
        // A partial frame is no evidence of a live authenticated peer.
        peer_write.write_all(&[0, 0]).await.unwrap();
        tokio::time::advance(Duration::from_secs(4)).await;
        assert!(event_rx.try_recv().is_err());
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(matches!(event_rx.recv().await, Some(Event::Disconnected)));
        // Offline input remains queued for recovery, with no repeated timeout
        // notification and without terminating the transport actor.
        let (reply, receive) = oneshot::channel();
        commands
            .send(Command::Input(b"queued".to_vec(), reply))
            .await
            .unwrap();
        receive.await.unwrap().unwrap();
        tokio::time::advance(PEER_TIMEOUT * 4).await;
        assert!(event_rx.try_recv().is_err());
        cancel.send_replace(true);
        worker.await.unwrap();
        drain.abort();
        clock_guard.abort();
    }
    #[test]
    fn bootstrap_parser_is_strict_and_secret_debug_is_redacted() {
        assert_eq!(format!("{:?}", secret()), "SessionSecret([redacted])");
        for value in [
            b"missing".as_slice(),
            b"IDPASSKEY:abcdefghijklmnop/short",
            b"IDPASSKEY:abcdefghijklmnop/01234567890123456789012345678901suffix",
            b"IDPASSKEY:abcdefghijklmnop/01234567890123456789012345678901\nIDPASSKEY:another",
        ] {
            assert!(SessionSecret::from_bootstrap(value).is_err());
        }
        assert!(SessionSecret::from_bootstrap(&vec![b'a'; 65537]).is_err());
    }
    #[test]
    fn disconnected_queue_retains_exact_ciphertext_and_bounds_before_encrypting() {
        let mut transport = Transport::new(secret());
        let first = transport.queue_packet(1, b"one").unwrap();
        let second = transport.queue_packet(1, b"two").unwrap();
        assert_eq!(
            transport.history.iter().cloned().collect::<Vec<_>>(),
            [first.clone(), second.clone()]
        );
        let mut receiver = Cipher::new(&transport.secret.key, 0);
        assert_eq!(receiver.decrypt(&first[2..]).unwrap(), b"one");
        assert_eq!(receiver.decrypt(&second[2..]).unwrap(), b"two");
        let mut transport = Transport::new(secret());
        while transport.queue_packet(1, &vec![0; MAX_INPUT]).is_ok() {}
        let sent = transport.sent;
        assert!(matches!(
            transport.queue_packet(1, &vec![0; MAX_INPUT]),
            Err(Error::BufferFull)
        ));
        assert_eq!(transport.sent, sent);
    }
    #[test]
    fn packet_reader_rejects_lengths_before_allocation_and_preserves_partial_frames() {
        let mut transport = Transport::new(secret());
        transport
            .incoming
            .extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(transport.packet().is_err());
        let mut transport = Transport::new(secret());
        let mut server = Cipher::new(&transport.secret.key, 1);
        let mut frame = vec![1, 1];
        frame.extend(server.encrypt(b"payload").unwrap());
        transport
            .incoming
            .extend_from_slice(&(frame.len() as u32).to_be_bytes());
        transport.incoming.extend_from_slice(&frame[..3]);
        assert!(transport.packet().unwrap().is_none());
        assert_eq!(transport.received, 0);
        transport.incoming.extend_from_slice(&frame[3..]);
        assert_eq!(transport.packet().unwrap(), Some((1, b"payload".to_vec())));
        assert_eq!(transport.received, 1);
        assert!(transport.packet().unwrap().is_none());
    }
    #[test]
    fn catchup_validation_bounds_packet_count_before_protobuf_allocations() {
        assert!(validate_catchup(&[10, 0]).is_err());
        assert!(validate_catchup(&[10, 255, 255, 255, 255, 127]).is_err());
        let encoded = proto::CatchupBuffer {
            buffer: vec![vec![0; 18]; MAX_PACKETS + 1],
        }
        .encode_to_vec();
        assert!(validate_catchup(&encoded).is_err());
        let encoded = proto::CatchupBuffer {
            buffer: vec![vec![0; 18]; 2],
        }
        .encode_to_vec();
        assert!(validate_catchup(&encoded).is_ok());
    }
    #[tokio::test]
    async fn reused_session_is_rejected_before_any_fresh_counter_encryption() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request: proto::ConnectRequest = read_proto(&mut socket).await.unwrap();
            assert_eq!(request.version, Some(6));
            write_proto(
                &mut socket,
                &proto::ConnectResponse {
                    status: Some(2),
                    error: None,
                    auth_challenge: None,
                    reset_required: None,
                },
            )
            .await
            .unwrap();
            let mut extra = [0];
            assert_eq!(
                timeout(Duration::from_secs(2), socket.read(&mut extra))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        assert!(matches!(
            Client::connect(endpoint, secret(), 80, 24).await,
            Err(Error::FreshBootstrapRequired)
        ));
        server.await.unwrap();
    }
    #[tokio::test]
    async fn oversized_setup_and_advertised_challenge_fail_closed() {
        for challenge in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let _: proto::ConnectRequest = read_proto(&mut socket).await.unwrap();
                if challenge {
                    write_proto(
                        &mut socket,
                        &proto::ConnectResponse {
                            status: Some(1),
                            error: None,
                            auth_challenge: Some(vec![7; 32]),
                            reset_required: None,
                        },
                    )
                    .await
                    .unwrap();
                } else {
                    socket.write_i64_le(i64::MAX).await.unwrap();
                }
            });
            let result = Client::connect(endpoint, secret(), 80, 24).await;
            if challenge {
                assert!(matches!(result, Err(Error::UnsupportedHandshake)));
            } else {
                assert!(matches!(result, Err(Error::Protocol(_))));
            }
            server.await.unwrap();
        }
    }
}
