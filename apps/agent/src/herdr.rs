//! One bounded public Herdr focus operation, never terminal input or a generic RPC.
use crate::{Error, Result};
#[cfg(any(unix, test))]
use serde::Deserialize;
#[cfg(any(unix, test))]
use serde_json::json;
use serde_json::Value;
#[cfg(unix)]
use std::{
    process::Command,
    time::{Duration, Instant},
};
#[cfg(unix)]
const MAX_OUTPUT: usize = 1024 * 1024;
#[cfg(unix)]
const BUDGET: Duration = Duration::from_secs(3);
fn invalid() -> Error {
    Error::Herdr("HerdrFocusInvalid")
}
#[cfg(any(unix, test))]
#[derive(Deserialize)]
struct Sessions {
    sessions: Vec<Session>,
}
#[cfg(any(unix, test))]
#[derive(Deserialize)]
struct Session {
    name: String,
    running: bool,
    socket_path: String,
}
#[cfg(any(unix, test))]
fn socket_path(bytes: &[u8], name: &str) -> Result<String> {
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
        || !session.socket_path.starts_with('/')
        || session.socket_path.len() > 4096
        || session.socket_path.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(session.socket_path)
}
#[cfg(any(unix, test))]
fn response(bytes: &[u8], pane: &str) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
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
pub fn focus_pane(name: &str, pane: &str) -> Result<Value> {
    if name.is_empty()
        || name.len() > 200
        || name.chars().any(char::is_control)
        || !lazysh_common::valid_herdr_id(pane, Some('p'))
    {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        let started = Instant::now();
        let cancelled = crate::devices::cancellation_signal()?;
        let mut command = Command::new("herdr");
        command.args(["session", "list", "--json"]);
        let bytes =
            crate::devices::bounded_command(command, MAX_OUTPUT, cancelled.clone(), BUDGET)?;
        let path = socket_path(&bytes, name)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let remaining = BUDGET
                .checked_sub(started.elapsed())
                .ok_or(Error::Herdr("HerdrFocusTimeout"))?;
            let operation = async {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut stream = tokio::net::UnixStream::connect(path).await?;
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
            };
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
    #[cfg(not(unix))]
    {
        Err(Error::Herdr("HerdrFocusPlatformUnsupported"))
    }
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
        for value in [
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
            assert!(socket_path(&serde_json::to_vec(&sessions).unwrap(), "owned").is_err());
        }
    }
}
