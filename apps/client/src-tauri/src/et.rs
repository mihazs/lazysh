use crate::ssh::{AppState, Connected, Input, Result, Session, SshError, SshEvent};
use lazysh_et_transport::{Client, Event, SessionSecret};
use rand::distr::{Alphanumeric, SampleString};
use russh::ChannelMsg;
use serde::Deserialize;
use std::{net::SocketAddr, time::Duration};
use tauri::{ipc::Channel, State};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(default = "default_server")]
    server_path: String,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    server_fifo: Option<String>,
}
fn default_server() -> String {
    "etterminal".into()
}
fn default_port() -> u16 {
    2022
}
impl Default for Options {
    fn default() -> Self {
        Self {
            server_path: default_server(),
            port: default_port(),
            server_fifo: None,
        }
    }
}
impl Options {
    fn validate(&self) -> Result<()> {
        if self.port == 0
            || self.server_path.trim().is_empty()
            || self.server_path.len() > 4096
            || self.server_path.chars().any(char::is_control)
            || self.server_fifo.as_ref().is_some_and(|path| {
                !path.starts_with('/') || path.len() > 4096 || path.chars().any(char::is_control)
            })
        {
            return Err(SshError::new(
                "invalid_et_options",
                "Choose an ET executable, valid TCP port and optional absolute server FIFO path",
            ));
        }
        Ok(())
    }
    fn command(&self) -> String {
        let mut command = crate::ssh::quote(&self.server_path);
        command.push_str(" --logtostdout");
        if let Some(path) = &self.server_fifo {
            command.push_str(" --serverfifo ");
            command.push_str(&crate::ssh::quote(path));
        }
        command
    }
}
pub(crate) struct Bootstrap {
    secret: SessionSecret,
    endpoint: SocketAddr,
}

pub(crate) async fn bootstrap(
    session: &Session,
    options: Options,
    cols: u32,
    rows: u32,
) -> Result<Bootstrap> {
    options.validate()?;
    crate::ssh::check_size(cols, rows)?;
    if session.handle.agent_forwarding_enabled() {
        return Err(SshError::new("et_agent_forwarding", "Selected-identity forwarding is available in SSH terminals. Disable forwarding before using Eternal Terminal."));
    }
    let mut endpoint = session.handle.peer_address.ok_or_else(|| SshError::new("et_unsupported_route", "Eternal Terminal requires a direct SSH connection; bastion routes support SSH terminals"))?;
    endpoint.set_port(options.port);
    let mut cancelled = session.cancel.subscribe();
    if *cancelled.borrow() {
        return Err(SshError::new("cancelled", "ET connection was cancelled"));
    }
    let mut channel = tokio::select! {
        _ = cancelled.changed() => return Err(SshError::new("cancelled", "ET connection was cancelled")),
        result = timeout(Duration::from_secs(15), session.handle.channel_open_session()) => result.map_err(|_| SshError::new("et_bootstrap", "Opening ET bootstrap channel timed out"))??,
    };
    let key = Zeroizing::new(Alphanumeric.sample_string(&mut rand::rng(), 32));
    let input = Zeroizing::new(format!(
        "XXX{}/{}_xterm-256color\n",
        Alphanumeric.sample_string(&mut rand::rng(), 13),
        key.as_str()
    ));
    let operation = async {
        channel.exec(true, options.command()).await?;
        channel.data(input.as_bytes()).await?;
        channel.eof().await?;
        let mut output = Zeroizing::new(Vec::new());
        let mut received = 0usize;
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    received = received.saturating_add(data.len());
                    if received > 65536 {
                        return Err(SshError::new(
                            "et_bootstrap",
                            "ET bootstrap output exceeds 64 KiB",
                        ));
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    received = received.saturating_add(data.len());
                    if received > 65536 {
                        return Err(SshError::new(
                            "et_bootstrap",
                            "ET bootstrap output exceeds 64 KiB",
                        ));
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
        if status != Some(0) {
            return Err(SshError::new("et_bootstrap", "ET helper did not start. Check its executable, running etserver and optional FIFO path."));
        }
        let secret = SessionSecret::from_bootstrap(&output).map_err(|_| {
            SshError::new(
                "et_bootstrap",
                "The host did not return valid bounded ET bootstrap credentials",
            )
        })?;
        Ok(Bootstrap { secret, endpoint })
    };
    let result = tokio::select! { _ = cancelled.changed() => Err(SshError::new("cancelled", "ET connection was cancelled")), result = timeout(Duration::from_secs(15), operation) => match result { Ok(result) => result, Err(_) => Err(SshError::new("et_bootstrap", "ET bootstrap timed out")) } };
    let _ = timeout(Duration::from_secs(2), channel.close()).await;
    result
}

#[tauri::command]
pub async fn connect_et(
    state: State<'_, AppState>,
    session_id: String,
    options: Options,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<Connected> {
    let parent = state.session(&session_id).await?;
    let bootstrap = bootstrap(&parent, options, cols, rows).await?;
    crate::ssh::spawn_native_terminal(
        &state,
        parent,
        events,
        "ET",
        crate::ssh::check_size,
        move |input, cancelled, initial_cancel, output, ready| {
            tauri::async_runtime::spawn(run(
                bootstrap,
                cols,
                rows,
                input,
                cancelled,
                initial_cancel,
                output,
                ready,
            ))
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run(
    bootstrap: Bootstrap,
    cols: u32,
    rows: u32,
    mut input: mpsc::Receiver<Input>,
    mut cancelled: watch::Receiver<bool>,
    mut initial_cancel: watch::Receiver<bool>,
    output: mpsc::Sender<Vec<u8>>,
    ready: oneshot::Sender<Result<()>>,
) -> Result<()> {
    let mut ready = Some(ready);
    let result: Result<()> = async {
        if *cancelled.borrow() || *initial_cancel.borrow() { return Err(SshError::new("cancelled", "ET connection was cancelled")); }
        let endpoint = bootstrap.endpoint;
        let mut client = tokio::select! {
            _ = cancelled.changed() => return Err(SshError::new("cancelled", "ET connection was cancelled")),
            _ = initial_cancel.changed() => return Err(SshError::new("cancelled", "ET connection was cancelled")),
            result = Client::connect(endpoint, bootstrap.secret, cols as u16, rows as u16) => result.map_err(|error| SshError::new("et", error))?,
        };
        let control = client.control(); let mut input_cancel = cancelled.clone();
        let mut input_job = tauri::async_runtime::spawn(async move {
            loop {
                let value = tokio::select! { _ = input_cancel.changed() => return Ok(()), value = input.recv() => value };
                let Some(value) = value else { return Ok(()) };
                let result = match value {
                    Input::Data(data) if data.is_empty() => continue,
                    Input::Data(data) => tokio::select! { _ = input_cancel.changed() => return Ok(()), result = control.send(data.into_bytes()) => result },
                    Input::Resize(cols, rows) => tokio::select! { _ = input_cancel.changed() => return Ok(()), result = control.resize(cols as u16, rows as u16) => result },
                };
                result.map_err(|error| SshError::new("et", error))?;
            }
        });
        let (reconnect, mut disconnected) = watch::channel(false);
        let reconnect_state = reconnect.clone(); let mut reconnect_cancel = cancelled.clone(); let control = client.control();
        let mut reconnect_job = tauri::async_runtime::spawn(async move {
            let mut delay = Duration::from_secs(1);
            loop {
                while !*disconnected.borrow() { tokio::select! { _ = reconnect_cancel.changed() => return Ok(()), value = disconnected.changed() => { if value.is_err() { return Ok(()); } } } }
                tokio::select! { _ = reconnect_cancel.changed() => return Ok(()), _ = tokio::time::sleep(delay) => {} }
                if !*disconnected.borrow() { continue; }
                let result = tokio::select! { _ = reconnect_cancel.changed() => return Ok(()), result = control.reconnect(endpoint) => result };
                match result {
                    Ok(()) => { reconnect_state.send_replace(false); delay = Duration::from_secs(1); },
                    Err(lazysh_et_transport::Error::Io(_)) => delay = (delay * 2).min(Duration::from_secs(30)),
                    Err(error) => return Err(SshError::new("et_reconnect", error)),
                }
            }
        });
        if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
        let delivery: Result<()> = async {
            loop {
                tokio::select! {
                    _ = cancelled.changed() => return Ok(()),
                    result = &mut input_job => return result.map_err(|_| SshError::new("et", "ET input worker ended unexpectedly"))?,
                    result = &mut reconnect_job => return result.map_err(|_| SshError::new("et", "ET reconnect worker ended unexpectedly"))?,
                    event = client.next_event() => match event {
                        Some(Event::Output(bytes)) => { tokio::select! { _ = cancelled.changed() => return Ok(()), result = output.send(bytes) => if result.is_err() { return Ok(()); } } },
                        Some(Event::Disconnected) => { reconnect.send_replace(true); },
                        Some(Event::Reconnected) => { reconnect.send_replace(false); },
                        Some(Event::Failed(error)) => return Err(SshError::new("et", error)),
                        None => return Ok(()),
                    }
                }
            }
        }.await;
        input_job.abort(); reconnect_job.abort(); client.close().await;
        delivery
    }.await;
    if let Some(ready) = ready {
        let response = match &result {
            Err(error) => error.clone(),
            Ok(()) => SshError::new("cancelled", "ET ended before authentication completed"),
        };
        let _ = ready.send(Err(response));
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    #[test]
    fn validates_and_quotes_options_without_treating_paths_as_shell_fragments() {
        let options = Options {
            server_path: "safe'name;touch /tmp/nope".into(),
            port: 2022,
            server_fifo: Some("/private/fifo with spaces".into()),
        };
        options.validate().unwrap();
        assert_eq!(
            options.command(),
            "'safe'\\''name;touch /tmp/nope' --logtostdout --serverfifo '/private/fifo with spaces'"
        );
        assert!(Options {
            port: 0,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Options {
            server_fifo: Some("relative".into()),
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(Options {
            server_path: "etterminal\ncommand".into(),
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    #[cfg(target_os = "linux")]
    pub(crate) async fn openssh_interoperability(
        app: &tauri::App<tauri::test::MockRuntime>,
        parent: String,
        directory: &std::path::Path,
    ) {
        use std::os::unix::ffi::OsStrExt;
        use tauri::Manager;
        struct Server {
            process: std::process::Child,
            fifo: std::path::PathBuf,
            terminal: std::path::PathBuf,
        }
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.process.kill();
                let _ = self.process.wait();
                if let Ok(entries) = std::fs::read_dir("/proc") {
                    for entry in entries.flatten() {
                        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
                            continue;
                        };
                        let Ok(command) = std::fs::read(entry.path().join("cmdline")) else {
                            continue;
                        };
                        let args = command.split(|byte| *byte == 0).collect::<Vec<_>>();
                        if args.first().is_some_and(|arg| {
                            std::path::Path::new(std::ffi::OsStr::from_bytes(arg)).file_name()
                                == self.terminal.file_name()
                        }) && args
                            .iter()
                            .any(|arg| *arg == self.fifo.as_os_str().as_encoded_bytes())
                        {
                            let _ = std::process::Command::new("kill")
                                .args(["-TERM", &pid.to_string()])
                                .status();
                        }
                    }
                }
            }
        }
        let server = std::env::var_os("ET_SERVER_BIN")
            .expect("Set ET_SERVER_BIN to official ET 7.0.0 etserver");
        let terminal = std::path::PathBuf::from(
            std::env::var_os("ET_TERMINAL_BIN")
                .expect("Set ET_TERMINAL_BIN to official ET 7.0.0 etterminal"),
        );
        let fifo = directory.join("et-ssh-test.fifo");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let process = std::process::Command::new(server)
            .arg("--port")
            .arg(address.port().to_string())
            .args(["--bindip", "127.0.0.1", "--serverfifo"])
            .arg(&fifo)
            .arg("--logdir")
            .arg(directory)
            .arg("--logtostdout")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .env("HOME", directory)
            .env("LANG", "C.UTF-8")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut server = Server {
            process,
            fifo: fifo.clone(),
            terminal: terminal.clone(),
        };
        timeout(Duration::from_secs(5), async {
            loop {
                assert!(server.process.try_wait().unwrap().is_none());
                if tokio::net::TcpStream::connect(address).await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let invalid = Options {
            server_path: directory
                .join("missing-helper")
                .to_string_lossy()
                .into_owned(),
            ..Default::default()
        };
        assert!(connect_et(
            app.state(),
            parent.clone(),
            invalid,
            80,
            24,
            Channel::new(|_| Ok(()))
        )
        .await
        .is_err());
        let (send, mut receive) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let _ = send.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            }
            Ok(())
        });
        let options = Options {
            server_path: terminal.to_string_lossy().into_owned(),
            port: address.port(),
            server_fifo: Some(fifo.to_string_lossy().into_owned()),
        };
        let connected = connect_et(app.state(), parent.clone(), options, 80, 24, events)
            .await
            .unwrap();
        let id = connected.session_id;
        crate::ssh::disconnect(app.state(), parent).await.unwrap();
        let file = directory.join("et-control.txt");
        std::fs::write(&file, "retained SSH control").unwrap();
        assert_eq!(
            crate::ssh::read_file(app.state(), id.clone(), file.to_string_lossy().into_owned())
                .await
                .unwrap(),
            "retained SSH control"
        );
        crate::ssh::resize(app.state(), id.clone(), 111, 36)
            .await
            .unwrap();
        crate::ssh::write_stdin(
            app.state(),
            id.clone(),
            "printf '\\n__ET_NATIVE_世界__\\n'; stty size\r".into(),
        )
        .await
        .unwrap();
        timeout(Duration::from_secs(8), async {
            let mut output = Vec::new();
            loop {
                let event = receive.recv().await.unwrap();
                assert_ne!(event["type"], "closed", "{event}");
                if let Some(data) = event["data"].as_array() {
                    output.extend(data.iter().map(|byte| byte.as_u64().unwrap() as u8));
                    crate::ssh::ack_output(app.state(), id.clone(), data.len() as u32)
                        .await
                        .unwrap();
                }
                assert!(output.len() < 1024 * 1024);
                let text = String::from_utf8_lossy(&output);
                if text.contains("\r\n__ET_NATIVE_世界__\r\n36 111\r\n") {
                    break;
                }
            }
        })
        .await
        .unwrap();
        crate::ssh::write_stdin(app.state(), id.clone(), "exit\r".into())
            .await
            .unwrap();
        crate::ssh::disconnect(app.state(), id.clone())
            .await
            .unwrap();
        timeout(Duration::from_secs(3), async {
            loop {
                let event = receive.recv().await.unwrap();
                if event["type"] == "closed" {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(app.state::<AppState>().session(&id).await.is_err());
    }
}
