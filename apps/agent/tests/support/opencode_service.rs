//! A stand-in for OpenCode 2.x's loopback background service: the routes the companion calls, with the answers a real
//! 2.2.7 service gave (a request leaves the list once it is answered, a second answer is a 404 or 409). Every
//! POST that arrives is recorded, so a test can say exactly what the companion sent.
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub const PASSWORD: &str = "fixture-password-1d4c";
pub const SESSION: &str = "ses_fixture1";

#[derive(Default)]
struct State {
    permissions: Vec<Value>,
    forms: Vec<Value>,
    running: Vec<String>,
    posts: Vec<(String, Value)>,
    pause: Option<Pause>,
}

struct Pause {
    gate: Arc<Gate>,
    path: &'static str,
    skip: usize,
}

#[derive(Default)]
pub struct Gate {
    pub entered: AtomicBool,
    pub release: AtomicBool,
}

pub struct Service {
    pub port: u16,
    state: Arc<Mutex<State>>,
}

impl Service {
    pub fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = shared.clone();
                thread::spawn(move || serve(stream, &state));
            }
        });
        Self { port, state }
    }
    pub fn pause_next_permission_read(&self) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        self.state.lock().unwrap().pause = Some(Pause {
            gate: gate.clone(),
            path: "/permission/per_",
            skip: 0,
        });
        gate
    }
    pub fn pause_second_active_read(&self) -> Arc<Gate> {
        let gate = Arc::new(Gate::default());
        self.state.lock().unwrap().pause = Some(Pause {
            gate: gate.clone(),
            path: "/api/session/active",
            skip: 1,
        });
        gate
    }
    pub fn permission(&self, id: &str, action: &str, resources: &[&str], save: &[&str]) {
        self.state.lock().unwrap().permissions.push(
            json!({"id": id, "sessionID": SESSION, "action": action, "resources": resources, "save": save, "metadata": {"ignored": true}}),
        );
    }
    pub fn form(&self, id: &str, fields: Value) {
        self.state.lock().unwrap().forms.push(json!({"id": id, "sessionID": SESSION, "title": "Pick", "metadata": {}, "fields": fields}));
    }
    pub fn run(&self) {
        self.state.lock().unwrap().running.push(SESSION.into());
    }
    /// The service changed a pending request after it was listed.
    pub fn edit(&self, id: &str, resources: &[&str]) {
        for item in &mut self.state.lock().unwrap().permissions {
            if item["id"] == id {
                item["resources"] = json!(resources);
            }
        }
    }
    /// The request was answered somewhere else (the TUI itself, another device).
    pub fn answer_elsewhere(&self, id: &str) {
        let mut state = self.state.lock().unwrap();
        state.permissions.retain(|item| item["id"] != id);
        settle(&mut state.forms, id);
    }
    pub fn posts(&self) -> Vec<(String, Value)> {
        self.state.lock().unwrap().posts.clone()
    }
}

fn serve(mut stream: TcpStream, state: &Mutex<State>) {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    let (head, mut body) = loop {
        let read = stream.read(&mut chunk).unwrap_or(0);
        raw.extend_from_slice(&chunk[..read]);
        if let Some(at) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break (
                String::from_utf8_lossy(&raw[..at]).into_owned(),
                raw[at + 4..].to_vec(),
            );
        }
        if read == 0 {
            return;
        }
    };
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse().ok())
        })
        .unwrap_or(0usize);
    while body.len() < length {
        let read = stream.read(&mut chunk).unwrap_or(0);
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    let mut first = head.lines().next().unwrap_or_default().split_whitespace();
    let (method, path) = (
        first.next().unwrap_or_default().to_owned(),
        first.next().unwrap_or_default().to_owned(),
    );
    if method == "GET" {
        let gate = {
            let mut state = state.lock().unwrap();
            match state.pause.as_mut() {
                Some(pause) if path.contains(pause.path) && pause.skip > 0 => {
                    pause.skip -= 1;
                    None
                }
                Some(pause) if path.contains(pause.path) => {
                    state.pause.take().map(|pause| pause.gate)
                }
                _ => None,
            }
        };
        if let Some(gate) = gate {
            gate.entered.store(true, Ordering::SeqCst);
            let limit = Instant::now() + Duration::from_secs(4);
            while !gate.release.load(Ordering::SeqCst) && Instant::now() < limit {
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
    let authorized = head.lines().any(|line| {
        line.eq_ignore_ascii_case(&format!("Authorization: Basic {}", base64_basic(PASSWORD)))
    });
    let (status, payload) = if authorized {
        route(&method, &path, &body, state)
    } else {
        (401, json!({"_tag": "UnauthorizedError"}))
    };
    let text = if status == 204 {
        String::new()
    } else {
        payload.to_string()
    };
    let _ = write!(stream, "HTTP/1.0 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len());
}

fn base64_basic(password: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"))
}

fn route(method: &str, path: &str, body: &[u8], state: &Mutex<State>) -> (u16, Value) {
    let mut state = state.lock().unwrap();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let sent: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if method == "POST" {
        state.posts.push((path.to_owned(), sent));
    }
    match (method, parts.as_slice()) {
        ("GET", ["api", "session", "active"]) => (
            200,
            json!({"data": state.running.iter().map(|id| (id.clone(), json!({"type": "running"}))).collect::<serde_json::Map<_, _>>()}),
        ),
        (_, ["api", "session", session, ..]) if *session != SESSION => {
            (404, json!({"_tag": "SessionNotFoundError"}))
        }
        ("GET", ["api", "session", _, "permission"]) => (200, json!({"data": state.permissions})),
        ("GET", ["api", "session", _, "form"]) => (
            200,
            json!({"data": state.forms.iter().filter(|item| item["settled"].is_null()).collect::<Vec<_>>()}),
        ),
        ("GET", ["api", "session", _, "permission", id]) => {
            find(&state.permissions, id, |item| item.clone())
        }
        ("GET", ["api", "session", _, "form", id]) => find(&state.forms, id, |item| {
            let mut item = item.clone();
            item["state"] =
                json!({"status": if item["settled"].is_null() { "pending" } else { "answered" }});
            item
        }),
        ("POST", ["api", "session", _, "permission", id, "reply"]) => {
            let before = state.permissions.len();
            state.permissions.retain(|item| item["id"] != *id);
            if state.permissions.len() < before {
                (204, Value::Null)
            } else {
                (404, json!({"_tag": "PermissionNotFoundError"}))
            }
        }
        ("POST", ["api", "session", _, "form", id, "reply"]) => {
            let pending = state
                .forms
                .iter()
                .any(|item| item["id"] == *id && item["settled"].is_null());
            settle(&mut state.forms, id);
            if pending {
                (204, Value::Null)
            } else {
                (409, json!({"_tag": "FormAlreadySettledError"}))
            }
        }
        ("POST", ["api", "session", _, "interrupt"]) => {
            let was = !state.running.is_empty();
            state.running.clear();
            (200, json!({"interrupted": was}))
        }
        _ => (404, json!({"_tag": "NotFound"})),
    }
}

fn find(list: &[Value], id: &str, shape: impl Fn(&Value) -> Value) -> (u16, Value) {
    list.iter()
        .find(|item| item["id"] == id)
        .map_or((404, json!({"_tag": "NotFound"})), |item| {
            (200, json!({"data": shape(item)}))
        })
}

fn settle(forms: &mut [Value], id: &str) {
    for item in forms.iter_mut().filter(|item| item["id"] == id) {
        item["settled"] = json!(true);
    }
}
