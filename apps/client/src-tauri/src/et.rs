use crate::app_lock::AccessLease;
use crate::ssh::{AccessResult, AppState, Connected, Input, Result, Session, SshError, SshEvent};
use lazysh_et_transport::{Client, Event, SessionSecret};
use rand::distr::{Alphanumeric, SampleString};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, time::Duration};
use tauri::{ipc::Channel, State};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::timeout,
};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    server_path: String,
    port: u16,
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
    pub(crate) fn validate(&self) -> Result<()> {
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

pub(crate) async fn read_bootstrap(
    channel: &mut russh::Channel<russh::client::Msg>,
    limit: usize,
    kind: &'static str,
    overflow: &str,
) -> Result<(Zeroizing<Vec<u8>>, Option<u32>)> {
    let mut output = Zeroizing::new(Vec::new());
    let mut received = 0usize;
    let mut status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                received = received.saturating_add(data.len());
                if received > limit {
                    return Err(SshError::new(kind, overflow));
                }
                output.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { data, .. } => {
                received = received.saturating_add(data.len());
                if received > limit {
                    return Err(SshError::new(kind, overflow));
                }
            }
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            _ => {}
        }
    }
    Ok((output, status))
}

pub(crate) async fn bootstrap(
    session: &Session,
    lease: &crate::app_lock::AccessLease,
    options: Options,
) -> Result<Bootstrap> {
    options.validate()?;
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
        result = crate::ssh::open_owned_channel(&session.handle, lease, tokio::time::Instant::now() + Duration::from_secs(15)) => result?,
    };
    let key = Zeroizing::new(Alphanumeric.sample_string(&mut rand::rng(), 32));
    let input = Zeroizing::new(format!(
        "XXX{}/{}_xterm-256color\n",
        Alphanumeric.sample_string(&mut rand::rng(), 13),
        key.as_str()
    ));
    let operation = async {
        lease.check()?;
        channel.exec(true, options.command()).await?;
        channel.data(input.as_bytes()).await?;
        channel.eof().await?;
        let (output, status) = read_bootstrap(
            &mut channel,
            65536,
            "et_bootstrap",
            "ET bootstrap output exceeds 64 KiB",
        )
        .await?;
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
    lease: AccessLease,

    state: State<'_, AppState>,
    session_id: String,
    options: Options,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> AccessResult<Connected> {
    lease
        .run(async {
            let parent = state.session(&session_id).await?;
            crate::ssh::check_size(cols, rows)?;
            let bootstrap = bootstrap(&parent, &lease, options).await?;
            crate::ssh::spawn_native_terminal(
                &state,
                lease.clone(),
                parent,
                events,
                crate::ssh::NativeTerminalKind::EternalTerminal,
                crate::ssh::check_size,
                move |_access, input, cancelled, initial_cancel, output, ready| {
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
        })
        .await
}

fn startup_error(error: lazysh_et_transport::Error) -> SshError {
    use lazysh_et_transport::Error;
    let kind = match &error {
        Error::Io(_) => "et_unreachable",
        Error::Closed => "et_closed",
        Error::UnsupportedHandshake => "et_unsupported_handshake",
        Error::Authentication => "et_authentication",
        _ => "et_protocol",
    };
    SshError::new(kind, error)
}

async fn dispatch_input<F, Fut>(
    mut data: crate::terminal_input::InputSequence,
    lease: &crate::app_lock::AccessLease,
    cancelled: &mut watch::Receiver<bool>,
    losses: &mut watch::Receiver<Option<tokio::time::Instant>>,
    mut send: F,
) -> Result<()>
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let paced = data.is_paced();
    let lost = *losses.borrow_and_update();
    // Discard queued chords as well as an in-flight remainder; ordinary input is unchanged.
    if paced && lost.is_some_and(|when| data.admitted_at() <= when) {
        return Ok(());
    }
    while !data.is_empty() && lease.check().is_ok() && !*cancelled.borrow() {
        tokio::select! {biased;
            _=lease.cancelled()=>break,
            _=cancelled.changed()=>break,
            _=losses.changed(),if paced=>break,
            _=tokio::time::sleep_until(data.ready_at())=>{}
        }
        let count = data.bytes().len();
        tokio::select! {biased;
            _=lease.cancelled()=>break,
            _=cancelled.changed()=>break,
            _=losses.changed(),if paced=>break,
            result=send(data.bytes().to_vec())=>{result?;data.advance(count);}
        }
    }
    Ok(())
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
            result = Client::connect(endpoint, bootstrap.secret, cols as u16, rows as u16) => result.map_err(startup_error)?,
        };
        let control = client.control(); let mut input_cancel = cancelled.clone();
        let (losses,mut input_losses)=watch::channel(None);
        let mut input_job = tauri::async_runtime::spawn(async move {
            let send_control=&control;
            loop {
                if *input_cancel.borrow() {return Ok(());}
                let value = tokio::select! { _ = input_cancel.changed() => return Ok(()), value = input.recv() => value };
                let Some(value) = value else { return Ok(()) };
                let result = match value {
                    Input::Data(data, _) if data.is_empty() => continue,
                    Input::Data(data, lease) => {
                        dispatch_input(data,&lease,&mut input_cancel,&mut input_losses,|bytes|async move{send_control.send(bytes).await.map_err(|error|SshError::new("et",error))}).await?;
                        continue;
                    },
                    Input::Resize(cols, rows, lease) => { if lease.check().is_err() { continue; } tokio::select! { biased; _ = lease.cancelled() => continue, _ = input_cancel.changed() => return Ok(()), result = control.resize(cols as u16, rows as u16) => result } },
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
                        // Reconnected/duplicate connected updates never invalidate a fresh chord.
                        Some(Event::Disconnected) => { losses.send_replace(Some(tokio::time::Instant::now())); reconnect.send_replace(true); },
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
    fn access_lease() -> crate::app_lock::AccessLease {
        crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap()
    }
    use super::*;
    async fn record_dispatch(
        input: crate::terminal_input::InputSequence,
        cancelled: &mut watch::Receiver<bool>,
        losses: &mut watch::Receiver<Option<tokio::time::Instant>>,
        sent: &mpsc::UnboundedSender<Vec<u8>>,
    ) {
        dispatch_input(input, &access_lease(), cancelled, losses, |bytes| {
            sent.send(bytes).unwrap();
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
    }
    #[tokio::test(start_paused = true)]
    async fn paced_input_does_not_resume_after_connection_loss_and_new_input_can_start_fresh() {
        let (cancel, mut cancelled) = watch::channel(false);
        let (loss, mut losses) = watch::channel(None);
        let (sent, mut received) = mpsc::unbounded_channel();
        let mut input = crate::terminal_input::InputSequence::parse(
            String::new(),
            Some(vec!["A".into(), "B".into()]),
        )
        .unwrap();
        let queued = crate::terminal_input::InputSequence::parse(
            String::new(),
            Some(vec!["old1".into(), "old2".into()]),
        )
        .unwrap();
        let lease = access_lease();
        let sender = sent.clone();
        let first_dispatch = tokio::time::Instant::now();
        let task = tokio::spawn(async move {
            dispatch_input(input, &lease, &mut cancelled, &mut losses, |bytes| {
                sender.send(bytes).unwrap();
                std::future::ready(Ok(()))
            })
            .await
            .unwrap();
        });
        assert_eq!(received.recv().await.unwrap(), b"A");
        assert_eq!(tokio::time::Instant::now(), first_dispatch);
        loss.send_replace(Some(tokio::time::Instant::now()));
        task.await.unwrap();
        tokio::time::advance(crate::terminal_input::STEP_DELAY).await;
        assert!(received.try_recv().is_err());
        let mut cancelled = cancel.subscribe();
        let mut losses = loss.subscribe();
        record_dispatch(queued, &mut cancelled, &mut losses, &sent).await;
        assert!(
            received.try_recv().is_err(),
            "queued pre-loss chord must also be discarded"
        );
        // Reconnection does not change the loss marker. New input uses the new connection.
        input = crate::terminal_input::InputSequence::parse(
            String::new(),
            Some(vec!["fresh1".into(), "fresh2".into()]),
        )
        .unwrap();
        let fresh_dispatch = tokio::time::Instant::now();
        record_dispatch(input, &mut cancelled, &mut losses, &sent).await;
        assert_eq!(
            tokio::time::Instant::now() - fresh_dispatch,
            crate::terminal_input::STEP_DELAY
        );
        assert_eq!(received.try_recv().unwrap(), b"fresh1");
        assert_eq!(received.try_recv().unwrap(), b"fresh2");
    }
    #[tokio::test(start_paused = true)]
    async fn ordinary_input_retains_its_existing_connection_loss_behavior() {
        let (_cancel, mut cancelled) = watch::channel(false);
        let (loss, mut losses) = watch::channel(None);
        let input = crate::terminal_input::InputSequence::parse("literal".into(), None).unwrap();
        loss.send_replace(Some(tokio::time::Instant::now()));
        let mut sent = Vec::new();
        dispatch_input(
            input,
            &access_lease(),
            &mut cancelled,
            &mut losses,
            |bytes| {
                sent.push(bytes);
                std::future::ready(Ok(()))
            },
        )
        .await
        .unwrap();
        assert_eq!(sent, vec![b"literal".to_vec()]);
    }
    #[test]
    fn startup_errors_keep_authentication_and_protocol_distinct_from_unreachable_transport() {
        use lazysh_et_transport::Error;
        let kind = |error| serde_json::to_value(startup_error(error)).unwrap()["kind"].clone();
        assert_eq!(kind(Error::Authentication), "et_authentication");
        assert_eq!(kind(Error::Protocol("invalid frame")), "et_protocol");
        assert_eq!(
            kind(Error::Io(std::io::ErrorKind::ConnectionRefused.into())),
            "et_unreachable"
        );
        assert_eq!(
            kind(Error::UnsupportedHandshake),
            "et_unsupported_handshake"
        );
    }
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
                lazysh_common::test_support::terminate_processes_matching(
                    &self.terminal,
                    self.fifo.as_os_str(),
                );
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
            access_lease(),
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
        let connected = connect_et(
            access_lease(),
            app.state(),
            parent.clone(),
            options,
            80,
            24,
            events,
        )
        .await
        .unwrap()
        .into_inner()
        .unwrap();
        let id = connected.session_id;
        crate::ssh::disconnect(app.state(), parent).await.unwrap();
        let file = directory.join("et-control.txt");
        std::fs::write(&file, "retained SSH control").unwrap();
        assert_eq!(
            crate::ssh::read_file(
                access_lease(),
                app.state(),
                id.clone(),
                file.to_string_lossy().into_owned()
            )
            .await
            .unwrap()
            .into_inner()
            .unwrap(),
            "retained SSH control"
        );
        crate::ssh::resize(access_lease(), app.state(), id.clone(), 111, 36)
            .await
            .unwrap()
            .into_inner()
            .unwrap();
        crate::ssh::write_stdin(
            access_lease(),
            app.state(),
            id.clone(),
            String::new(),
            Some(vec![
                "printf '\\n__ET_NATIVE_世界__\\n'; stty size".into(),
                "\r".into(),
            ]),
        )
        .await
        .unwrap()
        .into_inner()
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
        crate::ssh::write_stdin(
            access_lease(),
            app.state(),
            id.clone(),
            "exit\r".into(),
            None,
        )
        .await
        .unwrap()
        .into_inner()
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
