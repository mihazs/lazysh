//! One bounded public Herdr focus operation, never terminal input or a generic RPC.
use crate::{Error, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    process::Command,
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_OUTPUT: usize = 1024 * 1024;
const BUDGET: Duration = Duration::from_secs(3);
const PIPE_PREFIX: &str = r"\\.\pipe\";

fn invalid() -> Error {
    Error::Herdr("HerdrFocusInvalid")
}
#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<Session>,
}
#[derive(Deserialize)]
struct Session {
    name: String,
    running: bool,
    socket_path: String,
}
/// Herdr serves its API on a Unix socket; the reported path is that socket.
fn unix_socket(path: &str) -> Option<String> {
    path.starts_with('/').then(|| path.to_owned())
}
/// On Windows Herdr listens on the named pipe `\\.\pipe\<socket path>` while the session list
/// reports only the path (`platform::windows::probe_local_server` joins them the same way), so a
/// drive path is mapped onto its pipe and an already spelled `\\.\pipe\...` name is kept. Empty,
/// `.` and `..` components are refused: Win32 resolves them, so `\\.\pipe\..\C:\x` would leave
/// the pipe namespace. Anything else, such as a UNC path, is not a Herdr endpoint.
fn pipe_name(path: &str) -> Option<String> {
    let name = match path.get(..PIPE_PREFIX.len()) {
        Some(prefix) if prefix.eq_ignore_ascii_case(PIPE_PREFIX) => &path[PIPE_PREFIX.len()..],
        _ if matches!(path.as_bytes(), [drive, b':', b'\\', ..] if drive.is_ascii_alphabetic()) => {
            path
        }
        _ => return None,
    };
    name.split(['\\', '/'])
        .all(|part| !matches!(part, "" | "." | ".."))
        .then(|| format!("{PIPE_PREFIX}{name}"))
}
fn socket_path(bytes: &[u8], name: &str, endpoint: fn(&str) -> Option<String>) -> Result<String> {
    let sessions: Sessions = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if sessions.sessions.len() > 1000 {
        return Err(invalid());
    }
    let mut matching = sessions
        .sessions
        .into_iter()
        .filter(|session| session.name == name);
    let session = matching
        .next()
        .filter(|session| session.running)
        .ok_or_else(invalid)?;
    if matching.next().is_some()
        || session.socket_path.len() > 4096
        || session.socket_path.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    endpoint(&session.socket_path).ok_or_else(invalid)
}
fn response(bytes: &[u8], pane: &str) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    // A pane closed on the host is a distinct, recoverable class; other errors stay invalid.
    if value.get("id").and_then(Value::as_str) == Some("lazysh:focus-pane")
        && value.pointer("/error/code").and_then(Value::as_str) == Some("pane_not_found")
    {
        return Err(Error::Herdr("HerdrFocusMissing"));
    }
    if value.get("id").and_then(Value::as_str) != Some("lazysh:focus-pane")
        || value.get("error").is_some()
        || value.pointer("/result/type").and_then(Value::as_str) != Some("pane_info")
        || value
            .pointer("/result/pane/pane_id")
            .and_then(Value::as_str)
            != Some(pane)
    {
        return Err(invalid());
    }
    Ok(json!({"schemaVersion":1,"status":"focused","paneId":pane}))
}
#[cfg(unix)]
async fn connect(path: &str) -> std::io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(path).await
}
#[cfg(windows)]
async fn connect(path: &str) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    const ERROR_PIPE_BUSY: i32 = 231;
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(path) {
            // Every instance is serving a client for a moment; the caller's budget bounds the wait.
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            opened => return opened,
        }
    }
}
async fn focus(stream: &mut (impl AsyncRead + AsyncWrite + Unpin), pane: &str) -> Result<Value> {
    let mut request = serde_json::to_vec(&json!({
        "id":"lazysh:focus-pane", "method":"pane.focus", "params":{"pane_id":pane}
    }))
    .map_err(|_| invalid())?;
    request.push(b'\n');
    stream.write_all(&request).await?;
    let mut output = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err(Error::Herdr("HerdrFocusIncomplete"));
        }
        if output.len() + count > MAX_OUTPUT {
            return Err(Error::Herdr("HerdrFocusTooLarge"));
        }
        output.extend_from_slice(&chunk[..count]);
        if let Some(end) = output.iter().position(|byte| *byte == b'\n') {
            if output[end + 1..]
                .iter()
                .any(|byte| !byte.is_ascii_whitespace())
            {
                return Err(invalid());
            }
            return response(&output[..end], pane);
        }
    }
}
pub fn focus_pane(name: &str, pane: &str) -> Result<Value> {
    if name.is_empty()
        || name.len() > 200
        || name.chars().any(char::is_control)
        || !lazysh_common::valid_herdr_id(pane, Some('p'))
    {
        return Err(invalid());
    }
    let started = Instant::now();
    let cancelled = crate::devices::cancellation_signal()?;
    let mut command = Command::new("herdr");
    command.args(["session", "list", "--json"]);
    let bytes = crate::devices::bounded_command(command, MAX_OUTPUT, cancelled.clone(), BUDGET)?;
    let endpoint: fn(&str) -> Option<String> = if cfg!(windows) {
        pipe_name
    } else {
        unix_socket
    };
    let path = socket_path(&bytes, name, endpoint)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let remaining = BUDGET
            .checked_sub(started.elapsed())
            .ok_or(Error::Herdr("HerdrFocusTimeout"))?;
        let operation = async { focus(&mut connect(&path).await?, pane).await };
        let cancellation = async {
            while !cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::select! { biased;
            _ = cancellation => Err(Error::Herdr("HerdrFocusCancelled")),
            result = tokio::time::timeout(remaining, operation) =>
                result.map_err(|_| Error::Herdr("HerdrFocusTimeout"))?,
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_focus_is_exact_and_never_accepts_error_or_other_target() {
        let body = json!({"id":"lazysh:focus-pane","result":{"type":"pane_info","pane":{"pane_id":"w2E:pF"}}});
        assert_eq!(
            response(&serde_json::to_vec(&body).unwrap(), "w2E:pF").unwrap(),
            json!({"schemaVersion":1,"status":"focused","paneId":"w2E:pF"})
        );
        let missing =
            json!({"id":"lazysh:focus-pane","error":{"code":"pane_not_found","message":"x"}});
        assert_eq!(
            response(&serde_json::to_vec(&missing).unwrap(), "w2E:pF")
                .unwrap_err()
                .class(),
            "HerdrFocusMissing"
        );
        for value in [
            json!({"id":"wrong","error":missing["error"]}),
            json!({"id":"lazysh:focus-pane","error":{"code":"server_unavailable"}}),
            json!({"id":"wrong","result":body["result"]}),
            json!({"id":"lazysh:focus-pane","result":body["result"],"error":{}}),
            body,
        ] {
            assert!(response(&serde_json::to_vec(&value).unwrap(), "w2E:pG").is_err());
        }
        for sessions in [
            json!({"sessions":[]}),
            json!({"sessions":[{"name":"owned","running":false,"socket_path":"/owned/socket"}]}),
            json!({"sessions":[{"name":"owned","running":true,"socket_path":"relative"}]}),
        ] {
            assert!(socket_path(
                &serde_json::to_vec(&sessions).unwrap(),
                "owned",
                unix_socket
            )
            .is_err());
        }
    }
    fn owned_endpoint(path: &str) -> Result<String> {
        let sessions = json!({"sessions":[
            {"name":"owned","running":true,"socket_path":path},
            {"name":"other","running":true,"socket_path":r"C:\other\herdr.sock"}
        ]});
        socket_path(&serde_json::to_vec(&sessions).unwrap(), "owned", pipe_name)
    }
    #[test]
    fn windows_endpoint_is_the_pipe_herdr_listens_on_and_never_leaves_the_pipe_namespace() {
        for (reported, pipe) in [
            (
                r"C:\Users\me\AppData\Roaming\herdr\sessions\work\herdr.sock",
                r"\\.\pipe\C:\Users\me\AppData\Roaming\herdr\sessions\work\herdr.sock",
            ),
            (r"d:\herdr\herdr.sock", r"\\.\pipe\d:\herdr\herdr.sock"),
            (r"\\.\pipe\herdr-work", r"\\.\pipe\herdr-work"),
            (r"\\.\PIPE\LOCAL\herdr-work", r"\\.\pipe\LOCAL\herdr-work"),
        ] {
            assert_eq!(owned_endpoint(reported).unwrap(), pipe, "{reported}");
        }
        for rejected in [
            "",
            "herdr.sock",
            "/owned/socket",
            "C:herdr.sock",
            "C:/herdr/herdr.sock",
            r"C:\herdr\..\herdr.sock",
            r"\\server\share\herdr.sock",
            r"\\?\pipe\herdr-work",
            r"\\.\c:\file",
            r"\\.\pipe\",
            r"\\.\pipe\\",
            r"\\.\pipe\herdr-work\",
            r"\\.\pipe\..\C:\Windows\x",
            r"\\.\pipe\a\.\b",
            r"\\.\pipe\a/../b",
            "\\\\.\\pipe\\bad\0name",
            "\\\\.\\pipe\\bad\nname",
        ] {
            assert!(owned_endpoint(rejected).is_err(), "{rejected:?}");
        }
        assert!(owned_endpoint(&format!(r"\\.\pipe\{}", "a".repeat(4096))).is_err());
    }
    /// A real Windows named pipe owned by the test; never a user's Herdr server.
    #[cfg(windows)]
    #[tokio::test]
    async fn real_named_pipe_carries_the_focus_request_and_reports_a_missing_pipe() {
        use tokio::{io::AsyncBufReadExt, net::windows::named_pipe::ServerOptions};
        let pipe = format!(r"\\.\pipe\lazysh-herdr-focus-{}", std::process::id());
        assert_eq!(
            connect(&pipe).await.unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)
            .unwrap();
        let host = tokio::spawn(async move {
            server.connect().await.unwrap();
            let mut lines = tokio::io::BufReader::new(server);
            let mut request = String::new();
            lines.read_line(&mut request).await.unwrap();
            let reply = json!({"id":"lazysh:focus-pane","result":{"type":"pane_info","pane":{"pane_id":"w2E:pF"}}});
            lines
                .get_mut()
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
            request
        });
        let mut client = connect(&pipe).await.unwrap();
        assert_eq!(
            focus(&mut client, "w2E:pF").await.unwrap(),
            json!({"schemaVersion":1,"status":"focused","paneId":"w2E:pF"})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&host.await.unwrap()).unwrap(),
            json!({"id":"lazysh:focus-pane","method":"pane.focus","params":{"pane_id":"w2E:pF"}})
        );
    }
}
