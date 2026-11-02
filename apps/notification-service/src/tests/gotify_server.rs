use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    process::Stdio,
};

#[tokio::test]
#[ignore = "requires the immutable owned official Gotify 3.1.1 Linux binary in LAZYSH_GOTIFY_SERVER"]
async fn real_gotify_server_stores_all_finite_relay_states_over_verified_tls() {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let binary =
        PathBuf::from(std::env::var_os("LAZYSH_GOTIFY_SERVER").expect("owned Gotify binary"));
    assert!(binary.is_absolute());
    let metadata = fs::symlink_metadata(&binary).unwrap();
    assert!(metadata.is_file() && metadata.nlink() == 1 && metadata.mode() & 0o222 == 0);
    assert_eq!(
        metadata.uid(),
        fs::metadata(directory.path()).unwrap().uid()
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(&binary).unwrap())),
        "7c5fbcce5fa130c8e7bf643fee4f069a3aed974ead16bc5a84a168e31930e7b7"
    );
    let identity = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let certificate = directory.path().join("server.pem");
    let key = directory.path().join("server-key.pem");
    client::write_private(&certificate, identity.cert.pem().as_bytes()).unwrap();
    client::write_private(&key, identity.signing_key.serialize_pem().as_bytes()).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let password = Uuid::new_v4().to_string();
    let mut server = tokio::process::Command::new(&binary)
        .current_dir(directory.path())
        .env_clear()
        .env("GOTIFY_CONFIG_FILE", "/dev/null")
        .env("GOTIFY_SERVER_LISTENADDR", "127.0.0.1")
        .env("GOTIFY_SERVER_PORT", "0")
        .env("GOTIFY_SERVER_SSL_ENABLED", "true")
        .env("GOTIFY_SERVER_SSL_REDIRECTTOHTTPS", "false")
        .env("GOTIFY_SERVER_SSL_LISTENADDR", "127.0.0.1")
        .env("GOTIFY_SERVER_SSL_PORT", port.to_string())
        .env("GOTIFY_SERVER_SSL_CERTFILE", &certificate)
        .env("GOTIFY_SERVER_SSL_CERTKEY", &key)
        .env("GOTIFY_DEFAULTUSER_PASS", &password)
        .env("GOMAXPROCS", "2")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let origin = format!("https://localhost:{port}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .add_root_certificate(
            reqwest::Certificate::from_pem(identity.cert.pem().as_bytes()).unwrap(),
        )
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            assert!(
                server.try_wait().unwrap().is_none(),
                "owned Gotify exited before readiness"
            );
            if client
                .get(format!("{origin}/health"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("owned Gotify readiness deadline");
    assert!(http_client()
        .unwrap()
        .get(format!("{origin}/health"))
        .send()
        .await
        .is_err());
    let rejected = client
        .post(format!("{origin}/message"))
        .header("X-Gotify-Key", "owned-invalid-token")
        .json(&serde_json::json!({"message":"must-not-be-stored"}))
        .send()
        .await
        .unwrap()
        .status();
    assert!(matches!(
        rejected,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ));
    let application: serde_json::Value = client
        .post(format!("{origin}/application"))
        .basic_auth("admin", Some(&password))
        .json(&serde_json::json!({"name":"owned-lazysh"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let reader: serde_json::Value = client
        .post(format!("{origin}/client"))
        .basic_auth("admin", Some(&password))
        .json(&serde_json::json!({"name":"owned-readback"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let config = Config::with_format(
        directory.path().join("relay"),
        ADMIN,
        &format!("{origin}/message"),
        application["token"].as_str().unwrap(),
        DestinationFormat::Gotify,
    )
    .unwrap();
    let service = Service::open_with(config, client.clone(), false).unwrap();
    let source_id = source(&service, SOURCE, "owned-terminal").await;
    enable(&service).await;
    let receipts = finite_state_receipts(&service).await;
    let (done, worker) = start(service.clone()).await;
    for receipt in receipts {
        state(&service, source_id, &receipt.receipt_id, "accepted").await;
    }
    stop(done, worker).await;
    let messages: serde_json::Value = client
        .get(format!("{origin}/message"))
        .header("X-Gotify-Key", reader["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let messages = messages["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    for (label, priority) in [("working", 2), ("needs_attention", 5), ("done", 2)] {
        let matches: Vec<_> = messages
            .iter()
            .filter(|row| row["message"] == format!("owned-terminal: {label}"))
            .collect();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["title"], "lazysh");
        assert_eq!(matches[0]["priority"], priority);
        assert_eq!(matches[0]["appid"], application["id"]);
    }
    server.kill().await.unwrap();
    assert!(server.try_wait().unwrap().is_some());
    drop(service);
    directory.close().unwrap();
}
