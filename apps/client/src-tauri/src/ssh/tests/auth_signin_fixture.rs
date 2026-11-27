//! Owned OpenSSH acceptance of the whole sign-in (#1515), end to end over real SSH: a fake identity provider (a loopback
//! HTTP server with `authorize` and `token`), a fake CLI that behaves like `aws sso login` (a callback server on
//! `0.0.0.0`, a printed authorize URL, the redirect URI repeated at the token endpoint) or uses a device code, an owned
//! `sshd`, and the app's real terminal output path, scanner and tunnel engine. Nothing needs a credential and nothing
//! leaves loopback. A tool that only calls `xdg-open` is covered by the companion's `browser_shim` tests.
//!
//! Limits, stated: the host and the device are one machine here, so the device listener takes another port than the host's
//! callback server (the engine's own test override), and the fake "browser" swaps the port when it follows the redirect.
//! The decision to allow a tunnel is the renderer's (TypeScript); this test makes the call the Allow button makes, and
//! the banner itself is covered by the web tests with a mocked bridge. The Android and iOS browsers are not here.
use super::*;
use crate::auth_tunnel::testing::{callback_request, event_log as collector, event_where as until};
use crate::auth_tunnel::{begin, AuthTunnelState, Config, Consent, Hint, Limits};
use crate::previews::PreviewState;
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;
type Seen = Arc<std::sync::Mutex<Vec<Value>>>;

const IDP: &str = r#"
import base64, hashlib, http.server, json, secrets, sys, urllib.parse
codes = {}
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, status, body, kind='application/json'):
        data = body.encode()
        self.send_response(status); self.send_header('Content-Type', kind); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        url = urllib.parse.urlparse(self.path); query = urllib.parse.parse_qs(url.query)
        if url.path == '/authorize':
            code = secrets.token_hex(8)
            codes[code] = {'redirect_uri': query['redirect_uri'][0], 'challenge': query['code_challenge'][0]}
            target = query['redirect_uri'][0] + '?' + urllib.parse.urlencode({'code': code, 'state': query['state'][0]})
            self.send_response(302); self.send_header('Location', target); self.send_header('Content-Length', '0'); self.end_headers()
        elif url.path == '/device':
            self.reply(200, 'enter the code', 'text/plain')
        else:
            self.reply(404, '{}')
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        entry = codes.pop(body.get('code'), None)
        verifier = hashlib.sha256(body.get('code_verifier', '').encode()).digest()
        challenge = base64.urlsafe_b64encode(verifier).rstrip(b'=').decode()
        # RFC 6749 4.1.3: the redirect URI must be exactly the one the authorization request used.
        if entry and entry['redirect_uri'] == body.get('redirect_uri') and entry['challenge'] == challenge:
            self.reply(200, json.dumps({'access_token': 'TOKEN-' + secrets.token_hex(6)}))
        else:
            self.reply(400, json.dumps({'error': 'invalid_grant'}))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
"#;

const CLI: &str = r#"
import base64, hashlib, http.server, json, secrets, sys, threading, urllib.parse, urllib.request
mode, idp, result = sys.argv[1], sys.argv[2], sys.argv[3]
if mode == 'device':
    print('Open ' + idp + '/device and enter the code ABCD-1234', flush=True)
    urllib.request.urlopen(idp + '/device').read()
    open(result, 'w').write('{"device": true}')
    print('Login complete', flush=True)
    sys.exit(0)
verifier = secrets.token_urlsafe(32)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
state = 'STATE-' + secrets.token_hex(6)
got = {}
done = threading.Event()
class Callback(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        url = urllib.parse.urlparse(self.path); query = urllib.parse.parse_qs(url.query)
        if url.path == '/oauth/callback' and query.get('state') == [state] and 'code' in query:
            got['code'] = query['code'][0]
            body = b'<p>You can close this window.</p>'
            self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            done.set()
        else:
            self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers()
# Like the AWS CLI: all interfaces, a random port, one callback path.
server = http.server.ThreadingHTTPServer(('', 0), Callback)
port = server.server_address[1]
redirect = 'http://127.0.0.1:%d/oauth/callback' % port
authorize = idp + '/authorize?' + urllib.parse.urlencode({'client_id': 'fake-cli', 'response_type': 'code', 'redirect_uri': redirect, 'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
threading.Thread(target=server.serve_forever, daemon=True).start()
print('Browser will not be automatically opened.\nPlease visit the following URL:\n\n' + authorize + '\n\nWaiting for authorization...', flush=True)
if not done.wait(float(sys.argv[4]) if len(sys.argv) > 4 else 20):
    print('Timed out waiting for the browser', flush=True)
    sys.exit(3)
request = urllib.request.Request(idp + '/token', data=json.dumps({'code': got['code'], 'redirect_uri': redirect, 'code_verifier': verifier}).encode(), method='POST')
token = json.load(urllib.request.urlopen(request))['access_token']
open(result, 'w').write(json.dumps({'access_token': token, 'redirect_uri': redirect}))
print('Login complete', flush=True)
"#;

/// What is true of every fake sign-in: where its files are, and the host's loopback.
struct Rig {
    cli: std::path::PathBuf,
    idp: String,
    _idp: owned_sshd::Process,
}
impl Rig {
    fn start(directory: &Path) -> Self {
        let script = directory.join("fake_idp.py");
        fs::write(&script, IDP).unwrap();
        fs::write(directory.join("fake_cli.py"), CLI).unwrap();
        let mut child = std::process::Command::new("python3")
            .arg(&script)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.take().unwrap()),
            &mut line,
        )
        .unwrap();
        Self {
            cli: directory.join("fake_cli.py"),
            idp: format!(
                "http://127.0.0.1:{}",
                line.trim()
                    .parse::<u16>()
                    .expect("the fake identity provider prints its port")
            ),
            _idp: owned_sshd::Process(child),
        }
    }
    /// Types the fake CLI's command into the terminal, as a person would.
    async fn run(&self, app: &App, session: &str, mode: &str, result: &Path, seconds: u32) {
        let command = format!(
            "python3 {} {mode} {} {} {seconds}\n",
            self.cli.display(),
            self.idp,
            result.display()
        );
        crate::ssh::write_stdin(access_lease(), app.state(), session.into(), command, None)
            .await
            .unwrap();
    }
}

fn output(seen: &Seen) -> String {
    let bytes: Vec<u8> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "data")
        .flat_map(|event| {
            event["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
        })
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}
async fn printed(seen: &Seen, text: &str) {
    timeout(Duration::from_secs(15), async {
        while !output(seen).contains(text) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the terminal never printed {text:?}: {}", output(seen)));
}
fn query_of(url: &str, name: &str) -> String {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}
async fn closed(port: u16) {
    timeout(Duration::from_secs(5), async {
        while tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the device listener on {port} must close"));
}
/// The person's browser: it asks the identity provider, follows the redirect to `localhost:HOST_PORT` as it does on a device,
/// where that address is the device's own loopback (here, the tunnel's port), and returns what the host command answered.
async fn browse(url: &str, device_port: u16) -> String {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client.get(url).send().await.unwrap();
    assert_eq!(
        response.status(),
        302,
        "the identity provider redirects the browser to the callback address"
    );
    let location = response.headers()["location"].to_str().unwrap().to_owned();
    let target = reqwest::Url::parse(&location).unwrap();
    let request = callback_request(
        device_port,
        &format!("{}?{}", target.path(), target.query().unwrap()),
        "Sec-Fetch-Mode: navigate\r\n",
    );
    String::from_utf8_lossy(
        &crate::auth_tunnel::testing::exchange("127.0.0.1".parse().unwrap(), device_port, &request)
            .await,
    )
    .into_owned()
}

fn hint(port: u16, path: &str, evidence: &str) -> Hint {
    serde_json::from_value(json!({"port": port, "path": path, "evidence": evidence})).unwrap()
}
fn allow() -> Consent {
    serde_json::from_value(json!({"kind": "allow"})).unwrap()
}
async fn tunnel(
    app: &App,
    session: &str,
    hint: Hint,
    device_port: u16,
) -> (crate::auth_tunnel::AuthTunnel, Seen) {
    let (events, seen) = collector();
    let tunnel = begin(
        &access_lease(),
        &app.state(),
        &app.state(),
        &app.state(),
        session.into(),
        hint,
        allow(),
        events,
        Config {
            limits: Limits::quick(),
            device_port: Some(device_port),
        },
    )
    .await
    .unwrap();
    (tunnel, seen)
}

/// The sshd environment: a private home and an empty shell profile, so the person's own shell setup (prompts, spelling
/// correction) cannot change what the typed command does. One SetEnv line: sshd keeps only the first.
pub(super) fn environment(directory: &Path) -> String {
    fs::write(directory.join(".zshrc"), b"").unwrap();
    format!(
        "SetEnv HOME={} ZDOTDIR={} BASH_ENV=/dev/null ENV=/dev/null\n",
        directory.display(),
        directory.display()
    )
}

pub(super) async fn verify(
    app: &App,
    host: &Host,
    key: &russh::keys::PrivateKey,
    directory: &Path,
) {
    app.manage(AuthTunnelState::default());
    app.manage(PreviewState::default());
    let rig = Rig::start(directory);
    let key = key.to_openssh(Default::default()).unwrap().to_string();
    let terminal = || async {
        let (events, seen) = collector();
        let connected = start_session(
            &app.state(),
            host.id.clone(),
            None,
            Some(key.clone()),
            None,
            100,
            30,
            events,
        )
        .await
        .unwrap();
        (connected.session_id, seen)
    };

    // 1. The printed address becomes a hint; nothing listens on the device until the user allows; allowing carries the
    //    callback to the host command, which finishes its login with the redirect URI it started with.
    let (session, seen) = terminal().await;
    let result = directory.join("callback.json");
    rig.run(app, &session, "callback", &result, 20).await;
    let hint_event = until(&seen, |event| event["type"] == "authHint").await;
    let found = &hint_event["hint"];
    let (host_port, device_port) = (
        found["port"].as_u64().unwrap() as u16,
        owned_sshd::free_port(),
    );
    assert_eq!(
        (
            found["path"].as_str(),
            found["source"].as_str(),
            found["pkce"].as_bool()
        ),
        (Some("/oauth/callback"), Some("url"), Some(true))
    );
    let authorize = output(&seen)
        .lines()
        .find(|line| line.contains("/authorize?"))
        .unwrap()
        .trim()
        .to_owned();
    assert!(
        !hint_event
            .to_string()
            .contains(&query_of(&authorize, "state")),
        "the hint never carries the state: {hint_event}"
    );
    assert!(
        !hint_event
            .to_string()
            .contains(&query_of(&authorize, "code_challenge")),
        "nor the challenge: {hint_event}"
    );
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", device_port))
            .await
            .is_err(),
        "nothing is tunnelled without consent"
    );
    assert!(!result.exists());
    let (flow, flow_seen) = tunnel(
        app,
        &session,
        hint(host_port, "/oauth/callback", "url"),
        device_port,
    )
    .await;
    assert_eq!(flow.port, device_port);
    let page = browse(&authorize, device_port).await;
    assert!(
        page.starts_with("HTTP/1.0 200") || page.starts_with("HTTP/1.1 200"),
        "{page}"
    );
    assert!(page.contains("You can close this window."));
    printed(&seen, "Login complete").await;
    let login: Value = serde_json::from_str(&fs::read_to_string(&result).unwrap()).unwrap();
    assert!(login["access_token"]
        .as_str()
        .unwrap()
        .starts_with("TOKEN-"));
    assert_eq!(
        login["redirect_uri"],
        format!("http://127.0.0.1:{host_port}/oauth/callback"),
        "the redirect URI reaches the token endpoint unchanged"
    );
    until(&flow_seen, |event| event["type"] == "callback").await;
    until(&flow_seen, |event| {
        event["type"] == "ended" && event["reason"] == "callbackDelivered"
    })
    .await;
    closed(device_port).await;
    assert!(
        app.state::<AuthTunnelState>().is_empty().await,
        "the tunnel leaves nothing behind"
    );
    // What the app kept: the fixed texts of the engine and the scanner's hint, never a code, a state or a verifier.
    let everything = format!(
        "{}{}",
        flow_seen
            .lock()
            .unwrap()
            .iter()
            .map(Value::to_string)
            .collect::<String>(),
        hint_event
    );
    for secret in [
        query_of(&authorize, "state"),
        login["access_token"].as_str().unwrap().to_owned(),
    ] {
        assert!(!everything.contains(&secret), "{secret} reached an event");
    }

    // 2. A login that uses a device code prints no redirect: nothing is detected, so nothing could be tunnelled.
    let (session, seen) = terminal().await;
    let device = directory.join("device.json");
    rig.run(app, &session, "device", &device, 20).await;
    printed(&seen, "Login complete").await;
    assert!(device.exists());
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .all(|event| event["type"] != "authHint"),
        "a device-code login is not a sign-in tunnel"
    );
}
