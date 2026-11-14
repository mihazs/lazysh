//! Shared independently authored recorded data; not an official CLI capture.
// Each test binary includes this file and uses some of it.
#![allow(dead_code)]
use serde_json::{json, Value};

pub fn specification() -> Value {
    serde_json::from_str(include_str!("../fixtures/recorded-conversations.json")).unwrap()
}

/// A new OpenCode database at `path` with the recorded schema of `version` (`v1` or `v2`).
pub fn opencode_database(path: &std::path::Path, version: &str) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(path).unwrap();
    db.execute_batch(
        specification()["opencodeSchemas"][version]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    db
}

pub fn messages(specification: &Value, kind: &str) -> Vec<Value> {
    specification["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| {
            let mut value = message.clone();
            value["text"] = json!(format!(
                "{}: {}",
                specification["labels"][kind].as_str().unwrap(),
                message["text"].as_str().unwrap()
            ));
            value
        })
        .collect()
}

pub fn assert_messages(actual: &[Value], expected: &[Value]) {
    assert_eq!(actual.len(), expected.len());
    for (message, original) in actual.iter().zip(expected) {
        assert_eq!(message["role"], original["role"]);
        assert_eq!(
            message["blocks"],
            json!([{"type":"text","text":original["text"]}])
        );
    }
}
