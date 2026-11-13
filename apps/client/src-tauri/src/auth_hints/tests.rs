use super::{scan::Scanner, Hint, SessionHints, Source};
use std::time::{Duration, SystemTime};

/// 2026-11-13T10:00:00Z plus `minutes`.
fn at(minutes: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_794_564_000 + minutes * 60)
}

/// Every way a transport might cut the same output into chunks must give the same hints.
const CHUNKS: [usize; 5] = [usize::MAX, 1, 3, 7, 61];

fn scan_with(bytes: &[u8], size: usize, ssh_port: Option<u16>) -> Vec<Hint> {
    let hints = SessionHints::new(ssh_port);
    bytes
        .chunks(size.min(bytes.len().max(1)))
        .flat_map(|chunk| hints.scan(chunk, at(0)))
        .collect()
}

type Shape = (Source, &'static str, u16, String, Option<String>, bool);
fn shape(hints: &[Hint]) -> Vec<Shape> {
    hints
        .iter()
        .map(|h| {
            (
                h.source,
                h.host,
                h.port,
                h.path.clone(),
                h.idp_host.clone(),
                h.pkce,
            )
        })
        .collect()
}
fn found(bytes: &[u8]) -> Vec<Shape> {
    let whole = shape(&scan_with(bytes, usize::MAX, None));
    for size in CHUNKS {
        assert_eq!(
            shape(&scan_with(bytes, size, None)),
            whole,
            "chunks of {size} bytes"
        );
    }
    whole
}
fn hint(
    source: Source,
    host: &'static str,
    port: u16,
    path: &str,
    idp: Option<&str>,
    pkce: bool,
) -> Shape {
    (source, host, port, path.into(), idp.map(Into::into), pkce)
}
fn url(redirect: &str) -> String {
    format!("https://idp.example/authorize?response_type=code&redirect_uri={redirect}&state=s&code_challenge=c\r\n\r\n")
}

macro_rules! fixture {
    ($name:literal) => {
        include_bytes!(concat!("fixtures/", $name))
    };
}

#[test]
fn recorded_logins_report_their_localhost_callback() {
    use Source::{Announcement, Url};
    let cases: [(&str, &[u8], Vec<Shape>); 10] = [
        (
            "aws sso login",
            fixture!("aws-sso-login.raw"),
            vec![hint(
                Url,
                "127.0.0.1",
                36871,
                "/oauth/callback",
                Some("127.0.0.1"),
                true,
            )],
        ),
        (
            "aws sso login --no-browser",
            fixture!("aws-sso-login-no-browser-flag.raw"),
            vec![hint(
                Url,
                "127.0.0.1",
                36151,
                "/oauth/callback",
                Some("127.0.0.1"),
                true,
            )],
        ),
        (
            "aws login",
            fixture!("aws-login.raw"),
            vec![hint(
                Url,
                "127.0.0.1",
                40177,
                "/oauth/callback",
                Some("us-east-1.signin.aws.amazon.com"),
                true,
            )],
        ),
        (
            "codex login",
            fixture!("codex-login.raw"),
            vec![
                hint(Announcement, "localhost", 1455, "/", None, false),
                hint(
                    Url,
                    "127.0.0.1",
                    1455,
                    "/auth/callback",
                    Some("auth.openai.com"),
                    true,
                ),
            ],
        ),
        (
            "gcloud auth login with a browser",
            fixture!("gcloud-auth-login-display.raw"),
            vec![hint(
                Url,
                "localhost",
                8085,
                "/",
                Some("accounts.google.com"),
                true,
            )],
        ),
        (
            "wrangler login",
            fixture!("wrangler-login.doc"),
            vec![hint(
                Url,
                "localhost",
                8976,
                "/oauth/callback",
                Some("dash.cloudflare.com"),
                true,
            )],
        ),
        (
            "firebase login (redirect is the last parameter)",
            fixture!("firebase-login.doc"),
            vec![hint(
                Url,
                "localhost",
                9005,
                "/",
                Some("accounts.google.com"),
                false,
            )],
        ),
        (
            "terraform login",
            fixture!("terraform-login.doc"),
            vec![hint(
                Url,
                "localhost",
                10000,
                "/login",
                Some("app.terraform.io"),
                true,
            )],
        ),
        (
            "vault login -method=oidc",
            fixture!("vault-login-oidc.doc"),
            vec![hint(
                Url,
                "localhost",
                8250,
                "/oidc/callback",
                Some("accounts.google.com"),
                false,
            )],
        ),
        (
            "kubelogin",
            fixture!("kubelogin.doc"),
            vec![hint(Announcement, "localhost", 8000, "/", None, false)],
        ),
    ];
    for (name, output, expected) in cases {
        assert_eq!(found(output), expected, "{name}");
    }
}

#[test]
fn recorded_logins_without_a_localhost_callback_report_nothing() {
    for (name, output) in [
        // The printed link is the paste-the-code one; the localhost one only reaches the launcher.
        ("claude auth login", &fixture!("claude-auth-login.raw")[..]),
        (
            "gcloud auth login, remote flow",
            fixture!("gcloud-auth-login-remote.raw"),
        ),
        // The terminal shows the address without its query: only the launcher knows the callback.
        (
            "az login with a launcher",
            fixture!("az-login-launcher.raw"),
        ),
        ("az login device code", fixture!("az-login-device-code.raw")),
        ("gh auth login --web", fixture!("gh-auth-login-web.raw")),
    ] {
        assert_eq!(found(output), vec![], "{name}");
    }
}

#[test]
fn colours_cursor_moves_and_other_escape_sequences_do_not_break_a_url() {
    let sequences = "\x1b[94m\x1b]0;title\x07\x1b[0G\x1b[2K\x1bP1$r0m\x1b\\\x1b(B\x1b[?25l";
    let link = "https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A4321%2Fcb&code_challenge_method=S256";
    // The colour changes in the middle of the address, as a pager or a syntax highlighter would do.
    let (head, tail) = link.split_at(30);
    let text = format!("{sequences}Open: {head}\x1b[1m\x1b[4m{tail}\x1b[0m\x1b[39m done\r\n");
    assert_eq!(
        found(text.as_bytes()),
        vec![hint(
            Source::Url,
            "localhost",
            4321,
            "/cb",
            Some("idp.example"),
            true
        )]
    );
}

#[test]
fn a_url_wrapped_by_the_program_is_joined_at_every_plausible_width() {
    let outputs: [&[u8]; 4] = [
        fixture!("aws-sso-login.raw"),
        fixture!("codex-login.raw"),
        fixture!("gcloud-auth-login-display.raw"),
        fixture!("firebase-login.doc"),
    ];
    for (index, output) in outputs.into_iter().enumerate() {
        let text = String::from_utf8_lossy(output).replace('\r', "");
        let expected: Vec<_> = shape(&scan_with(text.as_bytes(), usize::MAX, None))
            .into_iter()
            .map(|(source, host, port, path, idp, _)| (source, host, port, path, idp))
            .collect();
        assert!(!expected.is_empty());
        let mut failures = Vec::new();
        for width in 41..=120 {
            let wrapped = text
                .lines()
                .flat_map(|line| {
                    let bytes = line.as_bytes();
                    let pieces: Vec<String> =
                        if line.starts_with("http") || line.contains("] https") {
                            bytes
                                .chunks(width)
                                .map(|c| String::from_utf8_lossy(c).into_owned())
                                .collect()
                        } else {
                            vec![line.to_owned()]
                        };
                    pieces
                })
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            let got: Vec<_> = shape(&scan_with(wrapped.as_bytes(), 1, None))
                .into_iter()
                .map(|(source, host, port, path, idp, _)| (source, host, port, path, idp))
                .collect();
            if got != expected {
                failures.push((index, width));
            }
        }
        assert_eq!(
            failures,
            Vec::<(usize, usize)>::new(),
            "widths whose wrapped output was misread"
        );
    }
}

#[test]
fn a_hyperlink_is_read_by_its_target_when_the_text_shows_the_same_address() {
    // The program broke the text at 30 columns, too short for the text itself to be joined.
    let target = "https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A8123%2Fcb&x=1";
    let wrapped: Vec<_> = target
        .as_bytes()
        .chunks(30)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect();
    let text = format!(
        "\x1b]8;;{target}\x1b\\{}\x1b]8;;\x1b\\\n",
        wrapped.join("\n")
    );
    assert_eq!(
        found(text.as_bytes()),
        vec![hint(
            Source::Osc8,
            "localhost",
            8123,
            "/cb",
            Some("idp.example"),
            false
        )]
    );
    // The same with BEL as the terminator.
    let bel = text.replace("\x1b\\", "\x07");
    assert_eq!(found(bel.as_bytes()).len(), 1);
}

#[test]
fn a_hyperlink_whose_target_differs_from_its_text_is_ignored() {
    let evil = "https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb";
    for text in [
        "Sign in here",
        "https://login.example.com/start",
        "https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A9998%2Fcb",
    ] {
        let output = format!("\x1b]8;;{evil}\x1b\\{text}\x1b]8;;\x1b\\\r\n");
        assert_eq!(found(output.as_bytes()), vec![], "text {text:?}");
    }
    // A link that never closes cannot hide the rest of the output.
    let open = format!(
        "\x1b]8;;{evil}\x1b\\x\n{}\n",
        url("http%3A%2F%2Flocalhost%3A9001%2Fcb")
    );
    assert_eq!(found(open.as_bytes()).len(), 1);
}

#[test]
fn bare_localhost_addresses_and_foreign_redirects_are_not_hints() {
    for output in [
        "  Local:   http://localhost:5173/\r\n  Network: use --host to expose\r\n",
        "ready - started server on 0.0.0.0:3000, url: http://localhost:3000\r\n",
        "Listening on http://127.0.0.1:8080/api/login\r\n",
        "Visit http://localhost:3000/login to see the page\r\n",
        "2026-11-13 INFO request GET http://localhost:9229/json/list\r\n",
        // The redirect goes to a public host, an address that merely starts like a loopback one,
        // or one that hides a loopback name in the credentials.
        &url("https%3A%2F%2Fapp.example.com%2Fcb"),
        &url("http%3A%2F%2Fapp.example.com%3A8085%2Fcb"),
        &url("http%3A%2F%2Flocalhost.evil.example%3A8085%2Fcb"),
        &url("http%3A%2F%2F127.0.0.1.evil.example%3A8085%2Fcb"),
        &url("http%3A%2F%2Flocalhost%40evil.example%3A8085%2Fcb"),
        &url("http%3A%2F%2Fevil.example%40localhost%3A8085%2Fcb"),
        &url("https%3A%2F%2Flocalhost%3A8085%2Fcb"),
        &url("http%3A%2F%2F127.0.0.2%3A8085%2Fcb"),
        // Ports a callback cannot use or that need no tunnel.
        &url("http%3A%2F%2Flocalhost%2Fcb"),
        &url("http%3A%2F%2Flocalhost%3A80%2Fcb"),
        &url("http%3A%2F%2Flocalhost%3A1023%2Fcb"),
        &url("http%3A%2F%2Flocalhost%3A0%2Fcb"),
        &url("http%3A%2F%2Flocalhost%3A65536%2Fcb"),
        &url("http%3A%2F%2Flocalhost%3A%2Fcb"),
        &url("http%3A%2F%2Flocalhost%3Aabc%2Fcb"),
        // Not a redirect parameter.
        "https://idp.example/a?next=http%3A%2F%2Flocalhost%3A8085%2Fcb\r\n\r\n",
    ] {
        assert_eq!(found(output.as_bytes()), vec![], "{output:?}");
    }
}

#[test]
fn the_redirect_is_decoded_up_to_twice_and_ports_at_the_edges_count() {
    for (redirect, host, port, path) in [
        ("http%3A%2F%2F127.0.0.1%3A1024%2F", "127.0.0.1", 1024, "/"),
        (
            "http%3A%2F%2F%5B%3A%3A1%5D%3A65535%2Fa%2Fb",
            "[::1]",
            65535,
            "/a/b",
        ),
        ("http://localhost:8085", "localhost", 8085, "/"),
        ("HTTP%3A%2F%2FLOCALHOST%3A8085%2F", "localhost", 8085, "/"),
        // Encoded twice.
        (
            "http%253A%252F%252Flocalhost%253A8085%252Fcb",
            "localhost",
            8085,
            "/cb",
        ),
    ] {
        assert_eq!(
            found(url(redirect).as_bytes()),
            vec![hint(
                Source::Url,
                host,
                port,
                path,
                Some("idp.example"),
                true
            )],
            "{redirect}"
        );
    }
    for key in [
        "redirect_uri",
        "redirect_url",
        "redirectUri",
        "callback",
        "callback_url",
        "redirect",
    ] {
        let line =
            format!("https://idp.example/a?{key}=http%3A%2F%2Flocalhost%3A8085%2Fcb&x=y\r\n\r\n");
        assert_eq!(found(line.as_bytes()).len(), 1, "{key}");
    }
}

#[test]
fn a_url_longer_than_4096_bytes_is_refused_and_one_of_exactly_4096_is_read() {
    let head = "https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb&pad=";
    let make = |length: usize| format!("{head}{}\r\n\r\n", "a".repeat(length - head.len()));
    assert_eq!(found(make(4096).as_bytes()).len(), 1);
    assert_eq!(found(make(4097).as_bytes()), vec![]);
    assert_eq!(found(make(20_000).as_bytes()), vec![]);
    // The refusal covers one URL: the next line is read normally.
    let text = format!(
        "{}{}",
        make(5000),
        url("http%3A%2F%2Flocalhost%3A8086%2Fcb")
    );
    assert_eq!(found(text.as_bytes()).len(), 1);
}

#[test]
fn announcements_need_a_line_that_talks_about_signing_in() {
    for (line, expected) in [
        (
            "Starting local login server on http://localhost:1455.",
            Some(1455),
        ),
        ("Open http://localhost:8000 for authentication", Some(8000)),
        ("Please sign in at http://127.0.0.1:4000/start", Some(4000)),
        ("Authorize this device: (http://localhost:4001)", Some(4001)),
        ("Server ready at http://localhost:3000", None),
        ("http://localhost:3000/login", None),
        ("Starting local login server on http://localhost:80.", None),
        (
            "Starting local login server on http://localhost:3000?x=1.",
            None,
        ),
    ] {
        let hints = found(format!("{line}\r\n").as_bytes());
        assert_eq!(hints.first().map(|h| h.2), expected, "{line}");
        assert!(hints.iter().all(|h| h.0 == Source::Announcement));
    }
}

#[test]
fn a_hint_for_the_hosts_own_ssh_port_is_refused_and_a_sensitive_port_is_marked() {
    let line = url("http%3A%2F%2Flocalhost%3A2222%2Fcb");
    assert_eq!(scan_with(line.as_bytes(), usize::MAX, Some(2222)), vec![]);
    assert_eq!(scan_with(line.as_bytes(), usize::MAX, Some(22)).len(), 1);
    let database = scan_with(
        url("http%3A%2F%2Flocalhost%3A5432%2Fcb").as_bytes(),
        usize::MAX,
        None,
    );
    assert!(database[0].sensitive);
    let ordinary = scan_with(line.as_bytes(), usize::MAX, None);
    assert!(!ordinary[0].sensitive);
}

#[test]
fn the_same_callback_is_one_hint_until_ten_minutes_pass() {
    let hints = SessionHints::new(None);
    let text = url("http%3A%2F%2Flocalhost%3A8085%2Fcb");
    assert_eq!(hints.scan(text.as_bytes(), at(0)).len(), 1);
    assert_eq!(hints.scan(text.as_bytes(), at(9)).len(), 0);
    assert_eq!(hints.scan(text.as_bytes(), at(20)).len(), 1);
    assert_eq!(
        hints
            .scan(url("http%3A%2F%2Flocalhost%3A8086%2Fcb").as_bytes(), at(20))
            .len(),
        1
    );
}

#[test]
fn the_scanner_keeps_a_bounded_amount_of_output_whatever_it_is_fed() {
    let mut scanner = Scanner::new(None);
    let mut noise = Vec::new();
    let mut seed = 0x9e3779b97f4a7c15u64;
    for _ in 0..(2 << 20) {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        noise.push(seed as u8);
    }
    let huge_token = "x".repeat(1 << 20);
    let unclosed_osc = format!("\x1b]8;;{}", "a".repeat(1 << 20));
    let unclosed_dcs = format!("\x1bP{}", "b".repeat(1 << 20));
    let link = format!("\x1b]8;;https://a.example/\x1b\\{}", "c ".repeat(1 << 18));
    let wrapped = format!(
        "https://a.example/?q={}\n{}\n",
        "d".repeat(80),
        "e/".repeat(1 << 18)
    );
    for input in [
        noise,
        huge_token.into(),
        unclosed_osc.into(),
        unclosed_dcs.into(),
        link.into(),
        wrapped.into(),
    ] {
        for chunk in input.chunks(4096) {
            scanner.feed(chunk, at(0));
            assert!(
                scanner.retained() <= 24 * 1024,
                "{} bytes retained",
                scanner.retained()
            );
        }
    }
}

#[test]
fn no_part_of_the_query_reaches_a_hint_its_json_or_its_debug_text() {
    let secrets = [
        "S3CRETSTATE",
        "S3CRETCHALLENGE",
        "S3CRETLOGIN",
        "S3CRETCODE",
        "S3CRETNONCE",
        "S3CRETPATH",
    ];
    let text = "Starting login at http://localhost:7000/S3CRETPATH?code=S3CRETCODE&state=S3CRETSTATE\r\n\
         https://idp.example/authorize?login_hint=S3CRETLOGIN&nonce=S3CRETNONCE&state=S3CRETSTATE\
         &redirect_uri=http%3A%2F%2Flocalhost%3A7001%2Fcb%3Fcode%3DS3CRETCODE&code_challenge=S3CRETCHALLENGE\r\n\r\n";
    let hints = scan_with(text.as_bytes(), 1, None);
    assert_eq!(hints.len(), 1, "{hints:?}");
    let everything = format!("{hints:?} {}", serde_json::to_string(&hints).unwrap());
    for secret in secrets {
        assert!(
            !everything.contains(secret),
            "{secret} leaked: {everything}"
        );
    }
    assert_eq!((hints[0].port, hints[0].path.as_str()), (7001, "/cb"));
}

#[test]
fn timestamps_are_rfc3339_in_utc() {
    for (seconds, text) in [
        (0, "1970-01-01T00:00:00Z"),
        (951_782_400, "2000-02-29T00:00:00Z"),
        (1_709_164_799, "2024-02-28T23:59:59Z"),
        (1_794_564_000, "2026-11-13T10:00:00Z"),
        (4_102_444_800, "2100-01-01T00:00:00Z"),
    ] {
        assert_eq!(
            super::scan::rfc3339(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            text
        );
    }
}

#[test]
fn a_hint_serializes_to_the_documented_event_shape() {
    let hints = scan_with(
        url("http%3A%2F%2Flocalhost%3A8085%2Fcb").as_bytes(),
        usize::MAX,
        None,
    );
    let mut json = serde_json::to_value(&hints[0]).unwrap();
    assert!(json["id"].as_str().is_some_and(|id| id.len() == 36));
    json.as_object_mut().unwrap().remove("id");
    assert_eq!(
        json,
        serde_json::json!({
            "source": "url", "host": "localhost", "port": 8085, "path": "/cb",
            "idpHost": "idp.example", "pkce": true, "sensitive": false,
            "firstSeenAt": "2026-11-13T10:00:00Z"
        })
    );
}
