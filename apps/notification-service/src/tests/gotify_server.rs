use super::owned_server::{pinned_binary, private_directory, ready, spawn, tls};
use super::*;

#[tokio::test]
#[ignore = "requires the immutable owned official Gotify 3.1.1 Linux binary in LAZYSH_GOTIFY_SERVER"]
async fn real_gotify_server_stores_all_finite_relay_states_over_verified_tls() {
    let directory = private_directory();
    let binary = pinned_binary(
        "LAZYSH_GOTIFY_SERVER",
        "7c5fbcce5fa130c8e7bf643fee4f069a3aed974ead16bc5a84a168e31930e7b7",
        directory.path(),
    );
    let tls = tls(directory.path()).await;
    let password = Uuid::new_v4().to_string();
    let mut server = spawn(
        tokio::process::Command::new(&binary)
            .current_dir(directory.path())
            .env_clear()
            .env("GOTIFY_CONFIG_FILE", "/dev/null")
            .env("GOTIFY_SERVER_LISTENADDR", "127.0.0.1")
            .env("GOTIFY_SERVER_PORT", "0")
            .env("GOTIFY_SERVER_SSL_ENABLED", "true")
            .env("GOTIFY_SERVER_SSL_REDIRECTTOHTTPS", "false")
            .env("GOTIFY_SERVER_SSL_LISTENADDR", "127.0.0.1")
            .env("GOTIFY_SERVER_SSL_PORT", tls.port.to_string())
            .env("GOTIFY_SERVER_SSL_CERTFILE", &tls.certificate)
            .env("GOTIFY_SERVER_SSL_CERTKEY", &tls.key)
            .env("GOTIFY_DEFAULTUSER_PASS", &password)
            .env("GOMAXPROCS", "2"),
    );
    let (origin, client) = (tls.origin, tls.client);
    ready(&mut server, &client, &format!("{origin}/health")).await;
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
    // The desktop receiver connects first: what the server already holds is only a baseline.
    let mut desktop = lazysh_notification_client::gotify::Reader::new(
        client.clone(),
        &origin,
        reader["token"].as_str().unwrap(),
    )
    .unwrap();
    assert!(desktop.poll().await.unwrap().is_empty());
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
    // Of the three finite states the relay published, only needs-attention reaches the desktop, once.
    assert_eq!(desktop.poll().await.unwrap().len(), 1);
    assert!(desktop.poll().await.unwrap().is_empty());
    // Deleting the client in Gotify revokes the token on the server; the receiver is then rejected.
    client
        .delete(format!("{origin}/client/{}", reader["id"]))
        .basic_auth("admin", Some(&password))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        desktop.poll().await.unwrap_err(),
        lazysh_notification_client::remote::PollError::Unauthorized
    );
    server.kill().await.unwrap();
    assert!(server.try_wait().unwrap().is_some());
    drop(service);
    directory.close().unwrap();
}
