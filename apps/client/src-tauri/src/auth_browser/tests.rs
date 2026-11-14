use super::*;
use std::sync::{Arc, Mutex};

/// A page the fake device was asked to show, and whether the port its redirect needs listened at that moment.
#[derive(Debug, PartialEq, Eq)]
struct Shown {
    url: String,
    browser: Browser,
    listening_when_shown: bool,
}

/// Runs [`open`] against a fake device and returns the result and every page it was asked to show.
async fn attempt(url: &str, browser: Browser) -> (Result<Outcome, String>, Vec<Shown>) {
    let shown = Arc::new(Mutex::new(Vec::new()));
    let record = shown.clone();
    let result = open(url, browser, |url, browser| async move {
        let ports = inspect_validated(&url).unwrap().1;
        record.lock().unwrap().push(Shown {
            listening_when_shown: ports.iter().all(|(v6, port)| listening(*v6, *port)),
            url,
            browser,
        });
        Ok(Outcome::Opened)
    })
    .await;
    let shown = std::mem::take(&mut *shown.lock().unwrap());
    (result, shown)
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn authorize(redirect: &str) -> String {
    format!("https://idp.example/authorize?client_id=cli&state=SECRET-STATE&code_challenge=SECRET-PKCE&redirect_uri={redirect}")
}

#[tokio::test]
async fn a_redirect_to_the_device_loopback_opens_only_after_a_listener_holds_the_port() {
    let port = free_port();
    let url = authorize(&format!(
        "http%3A%2F%2F127.0.0.1%3A{port}%2Foauth%2Fcallback"
    ));
    let (refused, shown) = attempt(&url, Browser::InApp).await;
    assert!(refused.unwrap_err().contains(&port.to_string()));
    assert!(
        shown.is_empty(),
        "the page opened with no listener: {shown:?}"
    );

    let _tunnel = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let (opened, shown) = attempt(&url, Browser::InApp).await;
    assert_eq!(opened, Ok(Outcome::Opened));
    assert_eq!(
        shown,
        [Shown {
            url,
            browser: Browser::InApp,
            listening_when_shown: true
        }]
    );
}

#[tokio::test]
async fn the_listener_is_not_connected_to_so_it_receives_no_byte() {
    let tunnel = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    tunnel.set_nonblocking(true).unwrap();
    let port = tunnel.local_addr().unwrap().port();
    let url = authorize(&format!("http%3A%2F%2Flocalhost%3A{port}%2Fcb"));
    assert_eq!(attempt(&url, Browser::System).await.0, Ok(Outcome::Opened));
    assert_eq!(
        tunnel.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "the check connected to the sign-in tunnel"
    );
}

#[tokio::test]
async fn every_spelling_of_the_redirect_needs_its_listener() {
    let port = free_port();
    for redirect in [
        format!("http://localhost:{port}/cb"),
        format!("http%3A%2F%2Flocalhost%3A{port}%2Fcb"),
        format!("http%3A%2F%2F127.0.0.1%3A{port}"),
        // Some programs encode the whole redirect a second time.
        format!("http%253A%252F%252Flocalhost%253A{port}%252Fcb"),
    ] {
        for key in [
            "redirect_uri",
            "redirect_url",
            "redirectUri",
            "callback",
            "callback_url",
            "redirect",
        ] {
            let url = format!("https://idp.example/a?{key}={redirect}");
            let (result, shown) = attempt(&url, Browser::InApp).await;
            assert!(
                result.is_err() && shown.is_empty(),
                "{key}={redirect} opened without a listener"
            );
        }
    }
}

#[tokio::test]
async fn an_ipv6_redirect_needs_the_ipv6_listener() {
    let Ok(tunnel) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) else {
        return; // this machine has no IPv6 loopback
    };
    let port = tunnel.local_addr().unwrap().port();
    let url = authorize(&format!("http%3A%2F%2F%5B%3A%3A1%5D%3A{port}%2Fcb"));
    let (result, shown) = attempt(&url, Browser::InApp).await;
    assert_eq!(result, Ok(Outcome::Opened));
    assert!(shown[0].listening_when_shown);
    drop(tunnel);
    assert!(attempt(&url, Browser::InApp).await.0.is_err());
}

#[tokio::test]
async fn a_page_with_no_loopback_redirect_opens_without_any_tunnel() {
    for url in [
        "https://github.com/login/device",
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
        "https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
        // Not the device's loopback, though it spells "localhost".
        "https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost.evil.example%3A8085%2Fcb",
        "https://idp.example/a?note=http%3A%2F%2Flocalhost%3A8085%2Fcb",
    ] {
        let (result, shown) = attempt(url, Browser::InApp).await;
        assert_eq!(result, Ok(Outcome::Opened), "{url}");
        assert_eq!(shown.len(), 1, "{url}");
    }
}

#[tokio::test]
async fn a_loopback_address_no_tunnel_can_serve_opens_as_any_link_does() {
    for redirect in [
        "https%3A%2F%2Flocalhost%3A8443%2Fcb",
        "http%3A%2F%2Flocalhost%2Fcb",
        "http%3A%2F%2Flocalhost%3A80%2Fcb",
        "http%3A%2F%2F127.0.0.2%3A8085%2Fcb",
    ] {
        let (result, shown) = attempt(&authorize(redirect), Browser::InApp).await;
        assert_eq!(
            (result, shown.len()),
            (Ok(Outcome::Opened), 1),
            "{redirect}"
        );
    }
}

#[tokio::test]
async fn the_browser_choice_reaches_the_device_unchanged() {
    for browser in [Browser::InApp, Browser::System] {
        let (_, shown) = attempt("https://idp.example/login", browser).await;
        assert_eq!(shown[0].browser, browser);
    }
}

#[tokio::test]
async fn unsafe_pages_never_reach_the_device_and_no_error_repeats_the_query() {
    let port = free_port();
    for url in [
        "javascript:alert(1)".to_owned(),
        "file:///etc/passwd".to_owned(),
        "intent://scan/#Intent;scheme=zxing;end".to_owned(),
        "https://user:pass@idp.example/a?state=SECRET-STATE".to_owned(),
        "https://idp.example/a b?state=SECRET-STATE".to_owned(),
        "https://idp.example/\u{7}?state=SECRET-STATE".to_owned(),
        format!(
            "https://idp.example/{}?state=SECRET-STATE",
            "a".repeat(4096)
        ),
        authorize(&format!("http%3A%2F%2F127.0.0.1%3A{port}%2Fcb")),
    ] {
        let (result, shown) = attempt(&url, Browser::InApp).await;
        let error = result.unwrap_err();
        assert!(shown.is_empty(), "opened {url:?}");
        for secret in ["SECRET-STATE", "SECRET-PKCE"] {
            assert!(
                !error.contains(secret),
                "the error repeated a query value: {error}"
            );
        }
    }
}

#[test]
fn the_banner_gets_the_host_and_the_warnings_and_never_the_query() {
    let inspect = |url: &str| inspect_validated(url).unwrap().0;
    let plain = inspect(&authorize("http%3A%2F%2Flocalhost%3A8085%2Fcb"));
    assert_eq!(plain.host, "idp.example");
    assert_eq!(plain.callback_ports, [8085]);
    assert!(plain.warnings.is_empty());
    assert!(!serde_json::to_string(&plain).unwrap().contains("SECRET"));

    assert_eq!(
        inspect("http://idp.example/login").warnings,
        [Warning::Insecure]
    );
    assert!(inspect("http://localhost:8085/login").warnings.is_empty());
    // A host with non-ASCII letters is shown in its `xn--` form, which cannot imitate another name.
    let imitation = inspect("https://аpple.example/login");
    assert_eq!(imitation.host, "xn--pple-43d.example");
    assert_eq!(imitation.warnings, [Warning::Punycode]);
    assert_eq!(
        inspect("http://xn--pple-43d.example/").warnings,
        [Warning::Insecure, Warning::Punycode]
    );
}

#[test]
fn the_inspection_serializes_in_the_shape_the_renderer_reads() {
    let inspection =
        inspect_validated("http://idp.example/a?redirect_uri=http%3A%2F%2F127.0.0.1%3A36151%2Fcb")
            .unwrap()
            .0;
    assert_eq!(
        serde_json::to_value(&inspection).unwrap(),
        serde_json::json!({"host": "idp.example", "warnings": ["insecure"], "callbackPorts": [36151]})
    );
    assert_eq!(
        serde_json::to_string(&Outcome::Notified).unwrap(),
        "\"notified\""
    );
    assert_eq!(
        serde_json::from_str::<Browser>("\"system\"").unwrap(),
        Browser::System
    );
}
