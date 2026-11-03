//! Headless official Mosh protocol core. Keep each client on its creating worker thread.
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    marker::PhantomData,
    net::SocketAddr,
    ptr::NonNull,
    rc::Rc,
    sync::{Mutex, MutexGuard},
    time::Duration,
};
use zeroize::Zeroizing;

static CORE: Mutex<()> = Mutex::new(());
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
fn numeric_host(remote: SocketAddr) -> String {
    match remote {
        SocketAddr::V6(address) if address.scope_id() != 0 => {
            format!("{}%{}", address.ip(), address.scope_id())
        }
        _ => remote.ip().to_string(),
    }
}

#[derive(Debug)]
pub struct Error(String);
impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
type Result<T> = std::result::Result<T, Error>;
fn locked() -> Result<MutexGuard<'static, ()>> {
    CORE.lock()
        .map_err(|_| Error("Mosh core lock failed".into()))
}

unsafe extern "C" {
    fn lazysh_mosh_new(
        key: *const c_char,
        address: *const c_char,
        port: u32,
        cols: u32,
        rows: u32,
        result: *mut *mut c_void,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    fn lazysh_mosh_write(
        client: *mut c_void,
        bytes: *const u8,
        length: usize,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    fn lazysh_mosh_resize(
        client: *mut c_void,
        cols: u32,
        rows: u32,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    fn lazysh_mosh_step(
        client: *mut c_void,
        length: *mut usize,
        finished: *mut c_int,
        connected: *mut c_int,
        input_capacity: *mut usize,
        next_poll: *mut u32,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    fn lazysh_mosh_pause_output(
        client: *mut c_void,
        paused: c_int,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    fn lazysh_mosh_wait(
        client: *mut c_void,
        wait_ms: u32,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    fn lazysh_mosh_copy(client: *mut c_void, output: *mut u8, length: usize) -> c_int;
    fn lazysh_mosh_shutdown(client: *mut c_void, error: *mut c_char, capacity: usize) -> c_int;
    fn lazysh_mosh_free(client: *mut c_void);
    #[cfg(test)]
    fn lazysh_mosh_validate(
        bytes: *const u8,
        length: usize,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    #[cfg(any(test, feature = "test-fixtures"))]
    fn lazysh_mosh_test_packet(
        instruction: c_int,
        old_num: u64,
        new_num: u64,
        throwaway: u64,
        data: *const u8,
        length: usize,
        output: *mut u8,
        capacity: usize,
        written: *mut usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> c_int;
    #[cfg(feature = "test-fixtures")]
    fn lazysh_mosh_test_ack(
        bytes: *const u8,
        length: usize,
        ack: *mut u64,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
    #[cfg(test)]
    fn lazysh_mosh_test_state_num(client: *mut c_void) -> u64;
    #[cfg(test)]
    fn lazysh_mosh_test_set_errno(value: c_int);
    #[cfg(test)]
    fn lazysh_mosh_test_receive_mtu() -> usize;
    #[cfg(test)]
    fn lazysh_mosh_test_receive_empty(
        client: *mut c_void,
        error: *mut c_char,
        capacity: usize,
    ) -> c_int;
}

fn operation(call: impl FnOnce(*mut c_char, usize) -> c_int) -> Result<()> {
    let mut error = [0 as c_char; 1024];
    if call(error.as_mut_ptr(), error.len()) == 0 {
        return Ok(());
    }
    // SAFETY: the native boundary receives this buffer's exact capacity and always NUL-terminates it.
    Err(Error(
        unsafe { CStr::from_ptr(error.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
    ))
}

pub struct Update {
    pub bytes: Vec<u8>,
    pub finished: bool,
    pub connected: bool,
    pub input_capacity: usize,
    pub next_poll: Duration,
}

pub struct Client {
    pointer: NonNull<c_void>,
    _worker: PhantomData<Rc<()>>,
}
impl Client {
    pub fn new(key: &str, remote: SocketAddr, cols: u16, rows: u16) -> Result<Self> {
        if key.len() != 22
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
            || remote.port() == 0
            || remote.ip().is_unspecified()
        {
            return Err(Error(
                "Invalid Mosh bootstrap credentials or endpoint".into(),
            ));
        }
        let _guard = locked()?;
        let mut key_bytes = Zeroizing::new(key.as_bytes().to_vec());
        key_bytes.push(0);
        let address =
            CString::new(numeric_host(remote)).map_err(|_| Error("Invalid Mosh address".into()))?;
        let mut pointer = std::ptr::null_mut();
        operation(|error, capacity| {
            // SAFETY: all strings are NUL-terminated; result/error point to live writable buffers; the C boundary catches exceptions.
            unsafe {
                lazysh_mosh_new(
                    key_bytes.as_ptr().cast(),
                    address.as_ptr(),
                    remote.port().into(),
                    cols.into(),
                    rows.into(),
                    &mut pointer,
                    error,
                    capacity,
                )
            }
        })?;
        Ok(Self {
            pointer: NonNull::new(pointer)
                .ok_or_else(|| Error("Mosh core did not create a client".into()))?,
            _worker: PhantomData,
        })
    }
    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let _guard = locked()?;
        operation(|error, capacity| {
            // SAFETY: this client is live and exclusively borrowed; bytes and error buffers remain valid for the call.
            unsafe {
                lazysh_mosh_write(
                    self.pointer.as_ptr(),
                    bytes.as_ptr(),
                    bytes.len(),
                    error,
                    capacity,
                )
            }
        })
    }
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let _guard = locked()?;
        operation(|error, capacity| {
            // SAFETY: this client is live and exclusively borrowed; the native side validates dimensions before allocating.
            unsafe {
                lazysh_mosh_resize(
                    self.pointer.as_ptr(),
                    cols.into(),
                    rows.into(),
                    error,
                    capacity,
                )
            }
        })
    }
    /// Keep receiving authenticated UDP state while suppressing display deltas.
    /// Resuming forces a full redraw of the latest bounded framebuffer.
    pub fn pause_output(&mut self, paused: bool) -> Result<()> {
        let _guard = locked()?;
        operation(|error, capacity| {
            // SAFETY: this live client is exclusively borrowed and native exceptions are contained.
            unsafe {
                lazysh_mosh_pause_output(self.pointer.as_ptr(), i32::from(paused), error, capacity)
            }
        })
    }
    /// Poll without blocking while holding the shared core lock. Use socket readiness or next_poll outside this call.
    pub fn poll(&mut self) -> Result<Update> {
        let _guard = locked()?;
        let (mut length, mut finished, mut connected, mut input_capacity, mut next_poll) =
            (0, 0, 0, 0, 0);
        operation(|error, capacity| {
            // SAFETY: every output parameter points to a live correctly typed variable.
            unsafe {
                lazysh_mosh_step(
                    self.pointer.as_ptr(),
                    &mut length,
                    &mut finished,
                    &mut connected,
                    &mut input_capacity,
                    &mut next_poll,
                    error,
                    capacity,
                )
            }
        })?;
        if length > OUTPUT_LIMIT {
            return Err(Error("Mosh output exceeds 8 MiB".into()));
        }
        let mut bytes = vec![0; length];
        // SAFETY: the native output length was bounded above; the lock prevents mutation between length and copy.
        if unsafe { lazysh_mosh_copy(self.pointer.as_ptr(), bytes.as_mut_ptr(), bytes.len()) } != 0
        {
            return Err(Error("Mosh output changed during copy".into()));
        }
        Ok(Update {
            bytes,
            finished: finished != 0,
            connected: connected != 0,
            input_capacity,
            next_poll: Duration::from_millis(next_poll.into()),
        })
    }
    /// Wait for this worker-owned client's UDP sockets without holding the shared protocol lock.
    pub fn wait(&mut self, timeout: Duration) -> Result<()> {
        let milliseconds = timeout.as_millis().min(200) as u32;
        operation(|error, capacity| {
            // SAFETY: exclusive ownership keeps this client's socket handles alive; waiting touches no shared core globals.
            unsafe { lazysh_mosh_wait(self.pointer.as_ptr(), milliseconds, error, capacity) }
        })
    }
    pub fn shutdown(&mut self) -> Result<()> {
        let _guard = locked()?;
        operation(|error, capacity| {
            // SAFETY: the live client's shutdown protocol remains inside the exception boundary.
            unsafe { lazysh_mosh_shutdown(self.pointer.as_ptr(), error, capacity) }
        })
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _guard = CORE.lock().unwrap_or_else(|error| error.into_inner());
        // SAFETY: this is the unique owner, and destruction is serialized with all other native operations.
        unsafe { lazysh_mosh_free(self.pointer.as_ptr()) };
    }
}

/// Fixed-key encrypted peers for native integration tests, opt-in development builds only.
#[cfg(feature = "test-fixtures")]
pub fn fixture_packet(old: u64, new: u64, bytes: &[u8]) -> Result<Vec<u8>> {
    let _guard = locked()?;
    let mut output = vec![0; 2048];
    let mut written = 0;
    operation(|error, capacity| {
        // SAFETY: all slices/capacities are live and bounded; the C++ boundary contains exceptions.
        unsafe {
            lazysh_mosh_test_packet(
                1,
                old,
                new,
                0,
                bytes.as_ptr(),
                bytes.len(),
                output.as_mut_ptr(),
                output.len(),
                &mut written,
                error,
                capacity,
            )
        }
    })?;
    if written > output.len() {
        return Err(Error("Invalid fixture packet length".into()));
    }
    output.truncate(written);
    Ok(output)
}
#[cfg(feature = "test-fixtures")]
pub fn fixture_ack(bytes: &[u8]) -> Result<u64> {
    let _guard = locked()?;
    let mut ack = 0;
    operation(|error, capacity| {
        // SAFETY: the fixed-key test decoder receives exact input length and a live output pointer.
        unsafe { lazysh_mosh_test_ack(bytes.as_ptr(), bytes.len(), &mut ack, error, capacity) }
    })?;
    Ok(ack)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_ipv6_addresses_preserve_the_interface_for_the_numeric_resolver() {
        let address = SocketAddr::V6(std::net::SocketAddrV6::new(
            "fe80::1".parse().unwrap(),
            60001,
            0,
            7,
        ));
        assert_eq!(numeric_host(address), "fe80::1%7");
    }
    fn validate(bytes: &[u8]) -> Result<()> {
        let _guard = locked()?;
        operation(|error, capacity| {
            // SAFETY: slices/error buffers are valid for this call and exceptions cannot cross the C boundary.
            unsafe { lazysh_mosh_validate(bytes.as_ptr(), bytes.len(), error, capacity) }
        })
    }
    #[test]
    fn malformed_or_huge_remote_state_returns_errors_without_aborting() {
        assert!(validate(&[0xff, 0xff, 0xff]).is_err());
        assert!(validate(&[
            0x0a, 0x0e, 0x1a, 0x0c, 0x28, 0xff, 0xff, 0xff, 0xff, 0x07, 0x30, 0xff, 0xff, 0xff,
            0xff, 0x07
        ])
        .is_err());
        assert!(validate(&vec![0; 4 * 1024 * 1024 + 1]).is_err());
        assert!(validate(&[]).is_ok());
        assert!(validate(&[0x0a, 0x06, 0x1a, 0x04, 0x28, 80, 0x30, 24]).is_ok());
        assert!(validate(&[0x0a, 8, 0x12, 6, 0x22, 4, 0x1b, b'[', b'5', b'n']).is_err());
    }

    fn packet(instruction: bool, old: u64, new: u64, throwaway: u64, data: &[u8]) -> Vec<u8> {
        let _guard = locked().unwrap();
        let mut result = vec![0; 2048];
        let mut written = 0;
        operation(|error, capacity| {
            // SAFETY: fixture data and output buffers remain live, with exact capacities passed to the exception boundary.
            unsafe {
                lazysh_mosh_test_packet(
                    instruction.into(),
                    old,
                    new,
                    throwaway,
                    data.as_ptr(),
                    data.len(),
                    result.as_mut_ptr(),
                    result.len(),
                    &mut written,
                    error,
                    capacity,
                )
            }
        })
        .unwrap();
        result.truncate(written);
        result
    }
    fn host_bytes(text: &str) -> Vec<u8> {
        assert!(text.len() < 100);
        let mut bytes = vec![
            0x0a,
            text.len() as u8 + 4,
            0x12,
            text.len() as u8 + 2,
            0x22,
            text.len() as u8,
        ];
        bytes.extend_from_slice(text.as_bytes());
        bytes
    }
    fn fake_server() -> (Client, std::net::UdpSocket, SocketAddr) {
        let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        socket.set_nonblocking(true).unwrap();
        let mut client = Client::new(
            "AAAAAAAAAAAAAAAAAAAAAA",
            socket.local_addr().unwrap(),
            80,
            24,
        )
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            client.poll().unwrap();
            if let Ok((_, address)) = socket.recv_from(&mut [0; 2048]) {
                return (client, socket, address);
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn next_owned_frame(client: &mut Client) -> Vec<u8> {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let update = client.poll().unwrap();
            assert!(!update.finished);
            assert!(update.bytes.len() <= OUTPUT_LIMIT);
            if !update.bytes.is_empty() {
                assert!(update.connected);
                return update.bytes;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned display frame missing"
            );
            client.wait(Duration::from_millis(10)).unwrap();
        }
    }

    fn frame_parts(bytes: &[u8]) -> (u64, u16, u16, &[u8]) {
        let prefix = b"\x1b]7777;lazysh-mosh;1;begin;";
        assert!(bytes.starts_with(prefix));
        let split = bytes.windows(2).position(|part| part == b"\x1b\\").unwrap();
        let fields: Vec<_> = std::str::from_utf8(&bytes[prefix.len()..split])
            .unwrap()
            .split(';')
            .collect();
        assert_eq!(fields.len(), 3);
        let id: u64 = fields[0].parse().unwrap();
        assert!((1..=9_007_199_254_740_991).contains(&id));
        let cols: u16 = fields[1].parse().unwrap();
        let rows: u16 = fields[2].parse().unwrap();
        let suffix = format!("\x1b]7777;lazysh-mosh;1;end;{id}\x1b\\");
        assert!(bytes.ends_with(suffix.as_bytes()));
        (
            id,
            cols,
            rows,
            &bytes[split + 2..bytes.len() - suffix.len()],
        )
    }

    #[test]
    fn authenticated_resize_frames_preserve_the_remote_top_rows_without_reflow() {
        let (mut client, socket, address) = fake_server();
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../apps/client/e2e/fixtures/mosh-resize-frames.json"
        ))
        .unwrap();
        let mut frames = Vec::new();
        let mut last_frame_id = 0;
        for (index, (cols, rows)) in [
            (40_u16, 12_u16),
            (40, 6),
            (40, 12),
            (41, 12),
            (20, 12),
            (40, 12),
        ]
        .into_iter()
        .enumerate()
        {
            client.resize(cols, rows).unwrap();
            // HostBuffers.HostMessage.resize, with these fixed one-byte dimensions.
            // The peer input is application paint; captured output comes ONLY from
            // Client.poll's production Display.new_frame, not a guessed ANSI frame.
            let mut data = vec![0x0a, 6, 0x1a, 4, 0x28, cols as u8, 0x30, rows as u8];
            if index == 0 || index == 3 {
                data.extend(host_bytes("\x1b[H\x1b[2J"));
                for row in 0..12 {
                    let suffix = if row == 4 {
                        "_世界"
                    } else if row == 1 {
                        "_0123456789ABCDEFGHIJKLMN"
                    } else {
                        ""
                    };
                    let style = if row == 0 { "\x1b[1;31m" } else { "\x1b[0m" };
                    data.extend(host_bytes(&format!(
                        "\x1b[{};1H{style}OWNED_ROW_{row:02}{suffix}",
                        row + 1
                    )));
                }
                data.extend(host_bytes("\x1b[0m\x1b[12;33H"));
            }
            assert!(data.len() <= 512);
            let state = index as u64 + 1;
            socket
                .send_to(&packet(true, state - 1, state, 0, &data), address)
                .unwrap();
            let output = next_owned_frame(&mut client);
            {
                let _guard = locked().unwrap();
                // SAFETY: this unit owns the client and holds the same core lock.
                assert_eq!(
                    unsafe { lazysh_mosh_test_state_num(client.pointer.as_ptr()) },
                    state
                );
            }
            let (frame_id, frame_cols, frame_rows, body) = frame_parts(&output);
            assert!(frame_id > last_frame_id);
            last_frame_id = frame_id;
            assert_eq!((frame_cols, frame_rows), (cols, rows));
            // Emission IDs depend on initial blank polling and forced redraws;
            // body bytes (including UTF8, cursor and styles) do not get normalized.
            let expected = &golden["frames"][index];
            assert_eq!(expected["cols"], cols);
            assert_eq!(expected["rows"], rows);
            let hex = expected["bodyHex"].as_str().unwrap();
            let expected_body: Vec<u8> = hex
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            assert_eq!(body, expected_body);
            let clear = b"\x1b[r\x1b[0m\x1b[H\x1b[2J";
            assert!(output.windows(clear.len()).any(|part| part == clear));
            let visible_rows = if index == 0 || index >= 3 { 12 } else { 6 };
            for row in 0..visible_rows {
                let marker = format!("OWNED_ROW_{row:02}");
                assert_eq!(
                    output
                        .windows(marker.len())
                        .filter(|part| *part == marker.as_bytes())
                        .count(),
                    1
                );
            }
            if index == 1 || index == 2 {
                for row in 6..12 {
                    let marker = format!("OWNED_ROW_{row:02}");
                    assert!(!output
                        .windows(marker.len())
                        .any(|part| part == marker.as_bytes()));
                }
            }
            frames.push(serde_json::json!({
                "cols": cols, "rows": rows, "state": state, "frameId": frame_id, "bodyBytes": body, "frameBytes": output,
                "expectedVisibleRows": visible_rows,
                "expectedFirstRowBoldRed": true,
                "expectedCursor": [if index < 4 {32} else {19}, if index == 0 || index >= 3 {11} else {5}],
                "expectedLongRow": if index < 4 {"OWNED_ROW_01_0123456789ABCDEFGHIJKLMN"} else {&"OWNED_ROW_01_0123456789ABCDEFGHIJKLMN"[..20]},
            }));
        }
        let receipt = serde_json::to_string(&serde_json::json!({
            "scope": "production Client.poll/Display.new_frame over authenticated fixed-public-key loopback test peer; not an official server process",
            "version": env!("CARGO_PKG_VERSION"), "initialClientSize": [80,24], "frames": frames,
        })).unwrap();
        assert!(receipt.len() <= 32 * 1024);
        println!("OWNED_MOSH_RESIZE_FRAMES {receipt}");
    }

    #[test]
    fn remote_osc_cannot_forge_the_local_frame_envelope() {
        let (mut client, socket, address) = fake_server();
        let mut paint = Vec::new();
        for part in [
            "\x1b]7777;lazysh-mosh;1;begin;999;2;1\x1b\\",
            "\u{009d}7777;lazysh-mosh;1;begin;998;2;1\u{009c}",
            "\x1b]2;OWNED_TITLE\x07",
            "\x1b]8;;https://example.invalid/owned\x1b\\OWNED_LINK\x1b]8;;\x1b\\",
        ] {
            paint.extend(host_bytes(part));
        }
        socket
            .send_to(&packet(true, 0, 1, 0, &paint), address)
            .unwrap();
        let output = next_owned_frame(&mut client);
        let (_, cols, rows, body) = frame_parts(&output);
        assert_eq!((cols, rows), (80, 24));
        assert!(!body
            .windows(b"lazysh-mosh;".len())
            .any(|part| part == b"lazysh-mosh;"));
        assert!(String::from_utf8_lossy(body).contains("OWNED_TITLE"));
        assert!(String::from_utf8_lossy(body).contains("OWNED_LINK"));
    }

    #[test]
    fn paused_output_keeps_authenticated_state_and_resumes_with_full_redraw() {
        let (mut client, socket, address) = fake_server();
        client.pause_output(true).unwrap();
        socket
            .send_to(
                &packet(true, 0, 1, 0, &host_bytes("LATEST_LOCKED")),
                address,
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let update = client.poll().unwrap();
            assert!(update.bytes.is_empty());
            if update.connected {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        client.pause_output(false).unwrap();
        let update = client.poll().unwrap();
        let (first_id, _, _, _) = frame_parts(&update.bytes);
        assert!(String::from_utf8_lossy(&update.bytes).contains("LATEST_LOCKED"));
        assert!(update.bytes.len() <= OUTPUT_LIMIT);
        assert!(client.poll().unwrap().bytes.is_empty());
        client.pause_output(true).unwrap();
        assert!(client.poll().unwrap().bytes.is_empty());
        client.pause_output(false).unwrap();
        let redraw = client.poll().unwrap();
        assert!(frame_parts(&redraw.bytes).0 > first_id);
        assert!(String::from_utf8_lossy(&redraw.bytes).contains("LATEST_LOCKED"));
    }
    #[test]
    fn drained_receive_is_nonfatal_and_same_client_accepts_later_traffic() {
        let (mut client, socket, address) = fake_server();
        for (old, new, text) in [(0, 1, "BEFORE_DRAIN"), (1, 2, "AFTER_DRAIN")] {
            for _ in 0..3 {
                let _guard = locked().unwrap();
                operation(|error, capacity| {
                    // SAFETY: this client is exclusively owned, its sockets are empty,
                    // and the serialized native boundary contains all exceptions.
                    unsafe {
                        lazysh_mosh_test_receive_empty(client.pointer.as_ptr(), error, capacity)
                    }
                })
                .unwrap();
            }
            socket
                .send_to(&packet(true, old, new, 0, &host_bytes(text)), address)
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                let update = client.poll().unwrap();
                assert!(!update.finished);
                if String::from_utf8_lossy(&update.bytes).contains(text) {
                    assert!(update.connected);
                    break;
                }
                assert!(std::time::Instant::now() < deadline);
                client.wait(Duration::from_millis(10)).unwrap();
            }
        }
    }
    #[test]
    fn unauthenticated_oversize_datagram_is_dropped_before_valid_traffic() {
        // SAFETY: this getter returns the native receive-buffer constant and
        // touches no client, pointer, clock, locale, or mutable shared state.
        let receive_mtu = unsafe { lazysh_mosh_test_receive_mtu() };
        assert!(receive_mtu < 65507);
        for size in [receive_mtu + 1, 65507] {
            let (mut client, socket, address) = fake_server();
            match socket.send_to(&vec![0; size], address) {
                Ok(written) => assert_eq!(written, size),
                Err(error) if size == 65507 => {
                    // Darwin can reject the IPv4 maximum at its UDP send limit.
                    // The buffer+1 case above MUST be delivered on every target,
                    // exercising the same pre-authentication MSG_TRUNC path.
                    assert_eq!(error.raw_os_error(), Some(libc::EMSGSIZE));
                }
                Err(error) => {
                    panic!("buffer+1 oversize datagram must reach the native receiver: {error}")
                }
            }
            // SAFETY: errno is thread-local; clearing stale EAGAIN makes this
            // reproduce the pre-authentication failure independently of errno.
            unsafe { lazysh_mosh_test_set_errno(0) };
            assert!(client.poll().is_ok());
            socket
                .send_to(&packet(true, 0, 1, 0, &host_bytes("SURVIVED")), address)
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut output = Vec::new();
            loop {
                output.extend(client.poll().unwrap().bytes);
                if String::from_utf8_lossy(&output).contains("SURVIVED") {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "valid authenticated traffic must recover after the oversized datagram"
                );
                client.wait(Duration::from_millis(10)).unwrap();
            }
        }
    }
    #[test]
    fn authenticated_fragment_bounds_and_invalid_tags_do_not_abort() {
        let (mut client, socket, address) = fake_server();
        socket.send_to(&[0; 32], address).unwrap();
        assert!(client.poll().is_ok());
        let oversized_index = [0, 0, 0, 0, 0, 0, 0, 1, 0xff, 0xff];
        socket
            .send_to(&packet(false, 0, 0, 0, &oversized_index), address)
            .unwrap();
        assert!(client.poll().is_err());
    }
    #[test]
    fn hostile_reference_and_state_flood_preserve_a_bounded_recoverable_client() {
        let (mut client, socket, address) = fake_server();
        socket
            .send_to(&packet(true, 0, 1, 1, &host_bytes("UNSAFE")), address)
            .unwrap();
        assert!(client.poll().is_ok());
        let mut output = Vec::new();
        for state in 1..=100 {
            let text = format!("\x1b[H\x1b[2JSTATE_{state}");
            socket
                .send_to(&packet(true, 0, state, 0, &host_bytes(&text)), address)
                .unwrap();
            output.extend(client.poll().unwrap().bytes);
        }
        assert!(!output.is_empty());
        {
            let _guard = locked().unwrap();
            // SAFETY: this test owns the live client and serializes inspection with every native operation.
            assert_eq!(
                unsafe { lazysh_mosh_test_state_num(client.pointer.as_ptr()) },
                31
            );
        }
        // Queue more than one native poll's 64-datagram budget before recovery.
        // Each excess state must still be rejected by the retained-state bound.
        for state in 101..=200 {
            socket
                .send_to(&packet(true, 0, state, 0, &host_bytes("EXCESS")), address)
                .unwrap();
        }
        socket
            .send_to(
                &packet(true, 31, 201, 31, &host_bytes("\x1b[H\x1b[2JRECOVERED")),
                address,
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        output.clear();
        loop {
            output.extend(client.poll().unwrap().bytes);
            if String::from_utf8_lossy(&output).contains("RECOVERED") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "authenticated recovery must arrive after draining the bounded state flood"
            );
            client.wait(Duration::from_millis(10)).unwrap();
        }
    }
    #[test]
    fn invalid_key_endpoint_dimensions_and_backlog_are_rejected() {
        let remote = "127.0.0.1:60000".parse().unwrap();
        assert!(Client::new("secret", remote, 80, 24).is_err());
        assert!(Client::new("AAAAAAAAAAAAAAAAAAAAAA", remote, 0, 24).is_err());
        assert!(Client::new("AAAAAAAAAAAAAAAAAAAAAA", remote, 512, 256).is_err());
        let mut client = Client::new("AAAAAAAAAAAAAAAAAAAAAA", remote, 80, 24).unwrap();
        assert!(client.write(&vec![b'x'; 65537]).is_err());
        assert!(client.resize(80, 0).is_err());
        client.write(b"hello").unwrap();
        assert!(client.poll().unwrap().bytes.len() <= OUTPUT_LIMIT);
    }
    #[cfg(feature = "test-fixtures")]
    #[test]
    fn fixture_codec_enforces_bounds_and_direction_without_bypassing_core_lock() {
        assert!(fixture_packet(0, 1, &[0; 513]).is_err());
        let to_client = fixture_packet(0, 1, &[]).unwrap();
        assert!(fixture_ack(&to_client).is_err());
        assert!(fixture_ack(&[]).is_err());
    }
}
