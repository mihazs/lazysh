//! The fixtures headless xterm.js wrote (`fixtures/<name>.json`) and a core fed the bytes of one of their cases.
//! Apart from `support`, which the wgpu renderer's tests also include and which has no JSON parser to offer.
use crate::support::feed;
use lazysh_terminal_runtime::{Config, Size, TerminalRuntime};
use serde_json::Value;

/// The cases of `fixtures/<name>.json`, which xterm.js wrote and the core must match.
pub fn fixture_cases(name: &str) -> Vec<Value> {
    let path = format!("{}/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let json: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    json["cases"].as_array().unwrap().clone()
}

/// A runtime sized as `case` says that has been fed the case's bytes.
pub fn replay(case: &Value) -> TerminalRuntime {
    let number = |key: &str| case[key].as_u64().unwrap();
    let mut rt = TerminalRuntime::new(Config {
        size: Size::new(number("cols") as u16, number("rows") as u16),
        scrollback_bytes: 1 << 20,
        ..Config::default()
    })
    .unwrap();
    feed(&mut rt, case["write"].as_str().unwrap().as_bytes());
    rt
}
