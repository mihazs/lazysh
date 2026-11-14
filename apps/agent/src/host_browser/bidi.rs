//! A minimal WebSocket client (RFC 6455) for the one loopback endpoint a managed Firefox serves WebDriver BiDi
//! on (docs/host-browser.md, "Adapters and capabilities").
//!
//! Firefox accepts a connection only with a `Host` that is a loopback address carrying its real port, and refuses
//! any `Origin`, so the request is written by hand: a library that adds an `Origin`, or a web view, cannot connect.
//! Only what BiDi needs exists: text messages in both directions, ping answered, close understood, and every size
//! bounded.
//!
//! shortcut: the server's `Sec-WebSocket-Accept` is not checked. The peer is a loopback port that the relay found in
//! the private profile of the Firefox it just started; upgrade this if the endpoint ever comes from elsewhere.
use base64::Engine;
use std::{
    io::{self, BufRead, BufReader, ErrorKind, Read, Write},
    net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream},
    sync::{Arc, Mutex},
    time::Duration,
};

/// The largest message either side may carry; a screenshot reply is a base64 JPEG inside one JSON object.
pub const MAX_MESSAGE: usize = 8 << 20;
const MAX_HEAD: u64 = 8 << 10;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TEXT: u8 = 1;
const CONTINUATION: u8 = 0;
const CLOSE: u8 = 8;
const PING: u8 = 9;
const PONG: u8 = 10;

fn invalid() -> io::Error {
    ErrorKind::InvalidData.into()
}

/// Four or sixteen random bytes: a v4 UUID is that many bytes from the operating system's generator.
fn random() -> [u8; 16] {
    *uuid::Uuid::new_v4().as_bytes()
}

/// The sending half. Cloning it shares one socket; whole frames are written under a lock.
#[derive(Clone)]
pub struct Writer(Arc<Mutex<TcpStream>>);
impl Writer {
    fn frame(&self, opcode: u8, payload: &[u8]) -> io::Result<()> {
        let mask: [u8; 4] = random()[..4].try_into().expect("four bytes");
        let mut bytes = Vec::with_capacity(14 + payload.len());
        bytes.push(0x80 | opcode);
        match payload.len() {
            length @ 0..=125 => bytes.push(0x80 | length as u8),
            length @ 126..=65535 => {
                bytes.push(0x80 | 126);
                bytes.extend_from_slice(&(length as u16).to_be_bytes());
            }
            length => {
                bytes.push(0x80 | 127);
                bytes.extend_from_slice(&(length as u64).to_be_bytes());
            }
        }
        bytes.extend_from_slice(&mask);
        bytes.extend(payload.iter().zip(mask.iter().cycle()).map(|(b, m)| b ^ m));
        let mut stream = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // shortcut: a peer that stays alive but stops reading blocks this write; the relay's own exit ends it.
        stream.write_all(&bytes)
    }

    pub fn send(&self, text: &str) -> io::Result<()> {
        if text.len() > MAX_MESSAGE {
            return Err(invalid());
        }
        self.frame(TEXT, text.as_bytes())
    }

    /// Say goodbye and close the socket, which also ends a reader that waits on it.
    pub fn close(&self) {
        let _ = self.frame(CLOSE, &[]);
        let stream = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = stream.shutdown(Shutdown::Both);
    }
}

/// The receiving half.
pub struct Reader {
    stream: BufReader<TcpStream>,
    writer: Writer,
}
impl Reader {
    /// The next text message, or `None` when the peer closed. A frame this client does not accept (binary, a
    /// masked server frame, reserved bits, an oversize or broken message) is `InvalidData`.
    pub fn read(&mut self) -> io::Result<Option<String>> {
        let mut message = Vec::new();
        let mut started = false;
        loop {
            let mut head = [0u8; 2];
            match self.stream.read_exact(&mut head) {
                Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
                other => other?,
            }
            let (last, opcode) = (head[0] & 0x80 != 0, head[0] & 0x0f);
            if head[0] & 0x70 != 0 || head[1] & 0x80 != 0 {
                return Err(invalid());
            }
            let length = match head[1] & 0x7f {
                126 => {
                    let mut bytes = [0u8; 2];
                    self.stream.read_exact(&mut bytes)?;
                    u16::from_be_bytes(bytes) as u64
                }
                127 => {
                    let mut bytes = [0u8; 8];
                    self.stream.read_exact(&mut bytes)?;
                    u64::from_be_bytes(bytes)
                }
                length => length as u64,
            };
            if length > (MAX_MESSAGE - message.len()) as u64 || (opcode >= CLOSE && length > 125) {
                return Err(invalid());
            }
            let mut payload = vec![0; length as usize];
            self.stream.read_exact(&mut payload)?;
            match opcode {
                // A text frame starts a message and a continuation extends one; the other order is broken.
                TEXT | CONTINUATION if (opcode == TEXT) == started => return Err(invalid()),
                TEXT | CONTINUATION => {
                    started = true;
                    message.extend_from_slice(&payload);
                    if last {
                        return String::from_utf8(message).map(Some).map_err(|_| invalid());
                    }
                }
                CLOSE => return Ok(None),
                PING if last => self.writer.frame(PONG, &payload)?,
                PONG if last => {}
                _ => return Err(invalid()),
            }
        }
    }
}

/// Open `ws://127.0.0.1:<port><path>` with the one `Host` header Firefox accepts and no `Origin`.
pub fn connect(port: u16, path: &str) -> io::Result<(Reader, Writer)> {
    let stream = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        CONNECT_TIMEOUT,
    )?;
    stream.set_nodelay(true)?;
    let key = base64::engine::general_purpose::STANDARD.encode(random());
    let writer = Writer(Arc::new(Mutex::new(stream.try_clone()?)));
    writer.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).write_all(
        format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        .as_bytes(),
    )?;
    let mut stream = BufReader::new(stream);
    let mut head = String::new();
    let mut lines = (&mut stream).take(MAX_HEAD);
    // The status line, then headers up to the blank line; whatever follows belongs to the frame reader.
    lines.read_line(&mut head)?;
    if !head.starts_with("HTTP/1.1 101") {
        return Err(io::Error::new(ErrorKind::ConnectionRefused, "no upgrade"));
    }
    loop {
        let mut line = String::new();
        if lines.read_line(&mut line)? == 0 {
            return Err(invalid());
        }
        if line == "\r\n" {
            break;
        }
    }
    Ok((
        Reader {
            stream,
            writer: writer.clone(),
        },
        writer,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// What a peer sends on its side: an unmasked server frame.
    fn server_frame(first: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![first];
        match payload.len() {
            length @ 0..=125 => bytes.push(length as u8),
            length => {
                bytes.push(126);
                bytes.extend_from_slice(&(length as u16).to_be_bytes());
            }
        }
        bytes.extend_from_slice(payload);
        bytes
    }

    /// A server that reads the upgrade request, answers it, runs `then` with its end of the socket, and returns
    /// the request it saw.
    fn serve(
        then: impl FnOnce(&mut TcpStream) + Send + 'static,
    ) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            while !request.ends_with("\r\n\r\n") {
                reader.read_line(&mut request).unwrap();
            }
            stream
                .write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n")
                .unwrap();
            then(&mut stream);
            request
        });
        (port, server)
    }

    #[test]
    fn the_request_carries_the_exact_host_and_no_origin() {
        let (port, server) = serve(|_| {});
        let _client = connect(port, "/session").unwrap();
        let request = server.join().unwrap();
        assert!(
            request.starts_with("GET /session HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.contains(&format!("\r\nHost: 127.0.0.1:{port}\r\n")),
            "{request}"
        );
        assert!(
            !request.to_ascii_lowercase().contains("origin"),
            "{request}"
        );
    }

    #[test]
    fn a_refused_upgrade_is_an_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        });
        assert!(connect(port, "/session").is_err());
    }

    #[test]
    fn messages_are_masked_out_and_fragments_and_pings_are_handled_in() {
        let (port, server) = serve(|stream| {
            // The client's text message arrives masked and whole.
            let mut head = [0u8; 2];
            stream.read_exact(&mut head).unwrap();
            assert_eq!(head[0], 0x81);
            assert_eq!(head[1] & 0x80, 0x80, "a client frame must be masked");
            let length = (head[1] & 0x7f) as usize;
            let mut rest = vec![0; 4 + length];
            stream.read_exact(&mut rest).unwrap();
            let text: Vec<u8> = rest[4..]
                .iter()
                .zip(rest[..4].iter().cycle())
                .map(|(b, m)| b ^ m)
                .collect();
            assert_eq!(text, b"{\"id\":1}");
            // A ping between the fragments of one message, then the message, then a whole one.
            for bytes in [
                server_frame(0x01, b"{\"a\":"),
                server_frame(0x89, b"hi"),
                server_frame(0x80, b"1}"),
                server_frame(0x81, "{\"é\":2}".as_bytes()),
            ] {
                stream.write_all(&bytes).unwrap();
            }
            // The ping is answered with a masked pong that echoes it.
            let mut pong = [0u8; 8];
            stream.read_exact(&mut pong).unwrap();
            assert_eq!((pong[0], pong[1]), (0x8a, 0x82));
            stream.write_all(&server_frame(0x88, b"")).unwrap();
        });
        let (mut reader, writer) = connect(port, "/session").unwrap();
        writer.send("{\"id\":1}").unwrap();
        assert_eq!(reader.read().unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(reader.read().unwrap().as_deref(), Some("{\"é\":2}"));
        assert_eq!(reader.read().unwrap(), None, "a close ends the stream");
        server.join().unwrap();
    }

    #[test]
    fn long_messages_use_the_extended_lengths_both_ways() {
        let long = format!("\"{}\"", "x".repeat(70_000));
        let echo = long.clone();
        let (port, server) = serve(move |stream| {
            let mut head = [0u8; 2];
            stream.read_exact(&mut head).unwrap();
            assert_eq!(
                head[1] & 0x7f,
                127,
                "a 64 bit length for a message over 65535 bytes"
            );
            let mut length = [0u8; 8];
            stream.read_exact(&mut length).unwrap();
            let mut rest = vec![0; 4 + u64::from_be_bytes(length) as usize];
            stream.read_exact(&mut rest).unwrap();
            let mut bytes = vec![0x81, 127];
            bytes.extend_from_slice(&(echo.len() as u64).to_be_bytes());
            bytes.extend_from_slice(echo.as_bytes());
            stream.write_all(&bytes).unwrap();
        });
        let (mut reader, writer) = connect(port, "/session").unwrap();
        writer.send(&long).unwrap();
        assert_eq!(reader.read().unwrap().as_deref(), Some(long.as_str()));
        server.join().unwrap();
    }

    #[test]
    fn frames_this_client_does_not_accept_are_errors_not_messages() {
        let too_long = {
            let mut bytes = vec![0x81, 127];
            bytes.extend_from_slice(&((MAX_MESSAGE as u64) + 1).to_be_bytes());
            bytes
        };
        for bad in [
            server_frame(0x82, b"binary"),
            server_frame(0xc1, b"reserved bit"),
            server_frame(0x80, b"continuation with nothing to continue"),
            server_frame(0x01, b"a, then a text frame that starts a second message")
                .into_iter()
                .chain(server_frame(0x81, b"b"))
                .collect(),
            server_frame(0x81, &[0xff, 0xfe]),
            server_frame(0x09, b"a ping that is not final"),
            vec![0x81, 0x80, 0, 0, 0, 0],
            too_long,
        ] {
            let (port, server) = serve(move |stream| {
                let _ = stream.write_all(&bad);
            });
            let (mut reader, _writer) = connect(port, "/session").unwrap();
            let error = reader.read().unwrap_err();
            assert_eq!(error.kind(), ErrorKind::InvalidData);
            server.join().unwrap();
        }
    }
}
