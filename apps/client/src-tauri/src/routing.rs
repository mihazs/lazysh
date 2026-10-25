use crate::ssh::{AppState, Host, Result, SshError, SshHandle};
use crate::vault::Credentials;
use std::{sync::Arc, time::Duration};
use tokio::time::timeout;

pub(crate) fn validate(host: &Host, hosts: &[Host]) -> Result<()> {
    let Some(jump_id) = host.jump_host_id.as_deref() else {
        return Ok(());
    };
    let jump = hosts
        .iter()
        .find(|saved| saved.id == jump_id)
        .ok_or_else(|| {
            SshError::new(
                "invalid_route",
                "Choose an existing direct SSH host as the bastion",
            )
        })?;
    if jump_id == host.id
        || jump.jump_host_id.is_some()
        || hosts
            .iter()
            .any(|saved| saved.jump_host_id.as_deref() == Some(&host.id))
    {
        return Err(SshError::new(
            "invalid_route",
            "Bastion routes support one hop and cannot contain cycles",
        ));
    }
    Ok(())
}

pub(crate) async fn verified_target(
    app: tauri::AppHandle,
    state: &AppState,
    host: &Host,
    jump_credentials: Option<Credentials>,
    operation: &tauri_plugin_lazysh_vault::CredentialOperation,
) -> Result<SshHandle> {
    let Some(jump_id) = host.jump_host_id.as_deref() else {
        if jump_credentials.is_some() {
            return Err(SshError::new(
                "invalid_route",
                "This host has no configured bastion",
            ));
        }
        return crate::ssh::verified_connection(state, host).await;
    };
    let (jump, _jump_guard) = locked_jump(state, host, jump_id).await?;
    if jump.id == host.id || jump.jump_host_id.is_some() {
        return Err(SshError::new(
            "invalid_route",
            "Bastion routes support one hop and cannot contain cycles",
        ));
    }
    let handle = crate::ssh::verified_connection(state, &jump).await?;
    let credentials = match jump_credentials {
        Some(credentials) => credentials,
        None => crate::vault::load_for_operation(app, jump.clone(), operation.clone())
            .await
            .map_err(|message| {
                SshError::new(
                    "jump_credentials_required",
                    format!("Bastion {}: {message}", jump.name),
                )
                .for_host(&jump.id)
            })?,
    };
    let jump_handle =
        crate::ssh::authenticate_for_operation(handle, &jump, &credentials, operation)
            .await
            .map_err(|error| error.for_host(&jump.id))?;
    through_bastion(state, host, Arc::new(jump_handle)).await
}

async fn locked_jump(
    state: &AppState,
    host: &Host,
    jump_id: &str,
) -> Result<(Host, tokio::sync::OwnedMutexGuard<()>)> {
    if jump_id == host.id {
        return Err(SshError::new(
            "invalid_route",
            "A host cannot route through itself",
        ));
    }
    // The caller holds the target guard; validated one-hop routes cannot form reverse lock dependencies.
    let guard = state.credential_guard(jump_id).await;
    let jump = state.host(jump_id)?;
    Ok((jump, guard))
}

async fn through_bastion(
    state: &AppState,
    target: &Host,
    jump: Arc<SshHandle>,
) -> Result<SshHandle> {
    let channel = timeout(
        Duration::from_secs(30),
        jump.channel_open_direct_tcpip(
            target.hostname.clone(),
            u32::from(target.port),
            "127.0.0.1",
            0,
        ),
    )
    .await
    .map_err(|_| SshError::new("timeout", "Opening the bastion route timed out"))??;
    crate::ssh::verified_connection_on_stream(state, target, channel.into_stream(), Some(jump))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{
        keys::{Algorithm, HashAlg, PrivateKey},
        server,
    };
    use std::sync::Mutex;

    #[derive(Clone)]
    struct Server {
        password: &'static str,
        forwarded_port: Option<u16>,
        attempts: Arc<Mutex<Vec<String>>>,
    }
    impl server::Server for Server {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }
    impl server::Handler for Server {
        type Error = russh::Error;
        async fn auth_password(
            &mut self,
            _: &str,
            password: &str,
        ) -> std::result::Result<server::Auth, Self::Error> {
            self.attempts.lock().unwrap().push(password.into());
            Ok(if password == self.password {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<server::Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            if host != "127.0.0.1" || self.forwarded_port.map(u32::from) != Some(port) {
                return Ok(());
            }
            let mut socket = tokio::net::TcpStream::connect((host, port as u16)).await?;
            reply.accept().await;
            tokio::spawn(async move {
                let mut channel = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut channel).await;
            });
            Ok(())
        }
    }
    async fn server(
        id: &str,
        password: &'static str,
        forwarded_port: Option<u16>,
    ) -> (Host, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        use server::Server;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let host = Host {
            id: id.into(),
            name: id.into(),
            hostname: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            username: "tester".into(),
            fingerprint: Some(key.public_key().fingerprint(HashAlg::Sha256).to_string()),
            jump_host_id: None,
            forward_agent: false,
            credentials_stored: false,
            biometric_unlock: false,
        };
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(1)),
            ..Default::default()
        });
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let mut runner = self::Server {
            password,
            forwarded_port,
            attempts: attempts.clone(),
        };
        let task = tokio::spawn(async move {
            runner.run_on_socket(config, &listener).await.unwrap();
        });
        (host, attempts, task)
    }
    fn state(dir: &tempfile::TempDir, hosts: &[Host]) -> AppState {
        std::fs::write(
            dir.path().join("hosts.json"),
            serde_json::to_vec(hosts).unwrap(),
        )
        .unwrap();
        AppState::new(dir.path().into()).unwrap()
    }
    fn host(id: &str, jump: Option<&str>) -> Host {
        Host {
            id: id.into(),
            name: id.into(),
            hostname: id.into(),
            port: 22,
            username: "me".into(),
            fingerprint: None,
            jump_host_id: jump.map(str::to_owned),
            forward_agent: false,
            credentials_stored: false,
            biometric_unlock: false,
        }
    }

    #[tokio::test]
    async fn routed_auth_waits_for_jump_edits_and_holds_jump_until_authentication_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let mut jump = host("jump", None);
        jump.credentials_stored = true;
        let target = host("target", Some("jump"));
        let state = state(&dir, &[jump, target.clone()]);
        let edit = state.credential_guard("jump").await;
        let task = {
            let state = state.clone();
            tokio::spawn(async move {
                let _target = state.credential_guard("target").await;
                locked_jump(&state, &target, "jump").await.unwrap()
            })
        };
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        state.mark_credentials("jump", false).unwrap();
        drop(edit);
        let (fresh, authenticated) = task.await.unwrap();
        assert!(!fresh.credentials_stored);
        let forget = {
            let state = state.clone();
            tokio::spawn(async move {
                let _guard = state.credential_guard("jump").await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!forget.is_finished());
        drop(authenticated);
        forget.await.unwrap();
        assert!(locked_jump(&state, &host("jump", None), "jump")
            .await
            .is_err());
    }

    #[test]
    fn route_validation_rejects_missing_hosts_cycles_and_second_hops() {
        let jump = host("jump", None);
        let target = host("target", Some("jump"));
        let other = host("other", None);
        let hosts = vec![jump.clone(), target.clone(), other.clone()];
        assert!(validate(&target, &hosts).is_ok());
        assert!(validate(&host("target", Some("missing")), &hosts).is_err());
        assert!(validate(&host("jump", Some("jump")), &hosts).is_err());
        assert!(validate(&host("jump", Some("other")), &hosts).is_err());
        assert!(validate(&host("third", Some("target")), &hosts).is_err());
    }

    #[tokio::test]
    async fn nested_ssh_verifies_each_key_and_keeps_credentials_separate() {
        let (mut target, target_attempts, target_task) =
            server("target", "target-secret", None).await;
        let (jump, jump_attempts, jump_task) =
            server("jump", "jump-secret", Some(target.port)).await;
        target.jump_host_id = Some(jump.id.clone());
        let dir = tempfile::tempdir().unwrap();
        let state = state(&dir, &[jump.clone(), target.clone()]);
        let jump_handle = crate::ssh::verified_connection(&state, &jump)
            .await
            .unwrap();
        let jump_handle = crate::ssh::authenticate_handle(
            jump_handle,
            &jump,
            Some("jump-secret".into()),
            None,
            None,
        )
        .await
        .unwrap();
        let target_handle = through_bastion(&state, &target, Arc::new(jump_handle))
            .await
            .unwrap();
        let target_handle = crate::ssh::authenticate_handle(
            target_handle,
            &target,
            Some("target-secret".into()),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(*jump_attempts.lock().unwrap(), ["jump-secret"]);
        assert_eq!(*target_attempts.lock().unwrap(), ["target-secret"]);
        target_handle
            .disconnect(russh::Disconnect::ByApplication, "done", "en")
            .await
            .unwrap();
        jump_task.abort();
        target_task.abort();
    }

    #[tokio::test]
    async fn unknown_jump_and_changed_target_receive_no_credentials_for_that_peer() {
        let (mut target, target_attempts, target_task) =
            server("target", "target-secret", None).await;
        let (jump, jump_attempts, jump_task) =
            server("jump", "jump-secret", Some(target.port)).await;
        target.jump_host_id = Some(jump.id.clone());
        let dir = tempfile::tempdir().unwrap();
        let unknown_jump = Host {
            fingerprint: None,
            ..jump.clone()
        };
        let state = state(&dir, &[unknown_jump.clone(), target.clone()]);
        let error = crate::ssh::verified_connection(&state, &unknown_jump)
            .await
            .err()
            .unwrap();
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["kind"], "unknown_host_key");
        assert_eq!(value["hostId"], "jump");
        assert!(jump_attempts.lock().unwrap().is_empty());
        assert!(target_attempts.lock().unwrap().is_empty());
        let jump_handle = crate::ssh::verified_connection(&state, &jump)
            .await
            .unwrap();
        let jump_handle = crate::ssh::authenticate_handle(
            jump_handle,
            &jump,
            Some("jump-secret".into()),
            None,
            None,
        )
        .await
        .unwrap();
        let changed_target = Host {
            fingerprint: Some("SHA256:changed".into()),
            ..target
        };
        let error = through_bastion(&state, &changed_target, Arc::new(jump_handle))
            .await
            .err()
            .unwrap();
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["kind"], "host_key_changed");
        assert_eq!(value["hostId"], "target");
        assert_eq!(*jump_attempts.lock().unwrap(), ["jump-secret"]);
        assert!(target_attempts.lock().unwrap().is_empty());
        jump_task.abort();
        target_task.abort();
    }
}
