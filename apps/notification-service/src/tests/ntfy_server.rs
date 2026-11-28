use super::owned_server::{pinned_binary, private_directory, ready, spawn, tls};
use lazysh_notification_client::{ntfy::Reader, remote::PollError};
use std::{path::Path, process::Stdio};

const NEEDS_ATTENTION: &str = "An agent needs your attention.";

/// The JSON that Apprise 2.0.2's ntfy service posts for the relay's Apprise payload
/// (checked against the pinned official Apprise API image): the relay's title and body
/// verbatim, plus an icon URL.
fn apprise_event(alias: &str, body: &str) -> serde_json::Value {
    serde_json::json!({
        "topic": "lazysh-alerts",
        "title": format!("lazysh · {alias}"),
        "message": body,
        "icon": "https://example.invalid/apprise-warning-256x256.png",
    })
}

/// Runs one `ntfy` administration command against the owned auth database.
async fn administer(binary: &Path, home: &Path, password: Option<&str>, args: &[&str]) -> String {
    let mut command = tokio::process::Command::new(binary);
    command
        .current_dir(home)
        .env_clear()
        .env("HOME", home)
        .env("NTFY_AUTH_FILE", home.join("auth.db"))
        .env("NTFY_AUTH_DEFAULT_ACCESS", "deny-all");
    if let Some(password) = password {
        command.env("NTFY_PASSWORD", password);
    }
    let output = command
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .unwrap();
    let text =
        String::from_utf8(output.stdout).unwrap() + &String::from_utf8(output.stderr).unwrap();
    assert!(
        output.status.success(),
        "ntfy {} failed: {text}",
        args.join(" ")
    );
    text
}

#[tokio::test]
#[ignore = "requires the immutable owned official ntfy 2.38.0 Linux binary in LAZYSH_NTFY_SERVER"]
async fn real_ntfy_server_serves_the_desktop_receiver_a_scoped_token_over_verified_tls() {
    let directory = private_directory();
    let binary = pinned_binary(
        "LAZYSH_NTFY_SERVER",
        "1be73362c81b8863fd508d7881fde03c81a73fb61bf527a406c1375d495bd178",
        directory.path(),
    );
    let home = directory.path();
    let tls = tls(home).await;
    let mut server = spawn(
        tokio::process::Command::new(&binary)
            .arg("serve")
            .current_dir(home)
            .env_clear()
            .env("HOME", home)
            .env("NTFY_BASE_URL", &tls.origin)
            .env("NTFY_LISTEN_HTTP", "-")
            .env("NTFY_LISTEN_HTTPS", format!("127.0.0.1:{}", tls.port))
            .env("NTFY_CERT_FILE", &tls.certificate)
            .env("NTFY_KEY_FILE", &tls.key)
            .env("NTFY_CACHE_FILE", home.join("cache.db"))
            .env("NTFY_AUTH_FILE", home.join("auth.db"))
            .env("NTFY_AUTH_DEFAULT_ACCESS", "deny-all")
            .env("GOMAXPROCS", "2"),
    );
    let (origin, client) = (tls.origin, tls.client);
    ready(&mut server, &client, &format!("{origin}/v1/health")).await;
    // The server creates its auth database on first start, so users are added to the running one.
    // The relay's publisher may only write the topic; the desktop's user may only read it.
    administer(
        &binary,
        home,
        Some("relay-secret"),
        &["user", "add", "relay"],
    )
    .await;
    administer(&binary, home, Some("desk-secret"), &["user", "add", "desk"]).await;
    administer(
        &binary,
        home,
        None,
        &["access", "relay", "lazysh-alerts", "write-only"],
    )
    .await;
    administer(
        &binary,
        home,
        None,
        &["access", "desk", "lazysh-alerts", "read-only"],
    )
    .await;
    let created = administer(&binary, home, None, &["token", "add", "desk"]).await;
    let token = created
        .split_whitespace()
        .find(|word| word.starts_with("tk_"))
        .expect("ntfy printed the new token")
        .to_owned();

    let publish = |event: serde_json::Value| {
        let (client, origin) = (client.clone(), origin.clone());
        async move {
            client
                .post(&origin)
                .basic_auth("relay", Some("relay-secret"))
                .json(&event)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
        }
    };
    // The desktop connects first: what the topic already holds is only a baseline.
    publish(apprise_event("terminal", NEEDS_ATTENTION)).await;
    let mut desktop = Reader::new(client.clone(), &origin, "lazysh-alerts", &token).unwrap();
    assert!(desktop.poll().await.unwrap().is_empty());
    // Of what Apprise delivers, only needs-attention reaches the desktop, once.
    publish(apprise_event("terminal", "An agent is working.")).await;
    publish(apprise_event("terminal", NEEDS_ATTENTION)).await;
    publish(apprise_event("terminal", "An agent finished.")).await;
    assert_eq!(desktop.poll().await.unwrap().len(), 1);
    assert!(desktop.poll().await.unwrap().is_empty());
    // The scoped token reads nothing else, and the topic is refused without it or with a wrong one.
    let elsewhere = Reader::new(client.clone(), &origin, "other-topic", &token);
    assert_eq!(
        elsewhere.unwrap().poll().await.unwrap_err(),
        PollError::Unauthorized
    );
    let anonymous = Reader::new(client.clone(), &origin, "lazysh-alerts", "");
    assert_eq!(
        anonymous.unwrap().poll().await.unwrap_err(),
        PollError::Unauthorized
    );
    let wrong = Reader::new(
        client.clone(),
        &origin,
        "lazysh-alerts",
        "tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert_eq!(
        wrong.unwrap().poll().await.unwrap_err(),
        PollError::Unauthorized
    );
    // Removing the token at the server revokes it; the receiver is then rejected.
    administer(&binary, home, None, &["token", "remove", "desk", &token]).await;
    assert_eq!(desktop.poll().await.unwrap_err(), PollError::Unauthorized);
    server.kill().await.unwrap();
    assert!(server.try_wait().unwrap().is_some());
    directory.close().unwrap();
}
