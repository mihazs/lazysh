//! `update-state.json`: what the last update operations left behind. Readers ignore unknown fields,
//! because a rollback can run an older companion over a newer file; a damaged file reads as empty.
use crate::private_json;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;

const NAME: &str = "update-state.json";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub previous: Option<Previous>,
    #[serde(default)]
    pub last_check: Option<Value>,
    #[serde(default)]
    pub last_operation: Option<Value>,
}
#[derive(Clone, Deserialize)]
pub struct Previous {
    pub version: String,
    pub sha256: String,
}
impl State {
    /// Absent or unreadable state is empty; reading never creates anything.
    pub fn read(directory: &Path) -> Self {
        let state: Self = private_json::read(directory, NAME)
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            previous: state.previous.filter(|previous| {
                lazysh_companion_release::version(&previous.version).is_some()
                    && lazysh_common::valid_sha256(&previous.sha256)
            }),
            ..state
        }
    }
}

/// What `record` does with the kept previous copy.
#[derive(Clone)]
pub enum Retained {
    /// Another copy of the same version stays, or nothing was replaced.
    Keep,
    Set(Previous),
    /// The replaced binary could not be kept.
    Clear,
}
/// Write the outcome of an installing operation. Unknown fields already in the file stay, because a
/// rollback can run an older companion over a newer file. Best effort: the binary is already
/// replaced when this runs, so a state file that cannot be written must not fail the update.
pub fn record(directory: &Path, retained: Retained, operation: Value) {
    let _ = try_record(directory, retained, operation);
}
fn try_record(directory: &Path, retained: Retained, operation: Value) -> crate::Result<()> {
    let _lock =
        private_json::lock(directory, "update-state.lock")?.ok_or(crate::Error::InvalidArgument)?;
    let mut value = private_json::read(directory, NAME)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    value["schemaVersion"] = 1.into();
    match retained {
        Retained::Keep => {}
        Retained::Set(previous) => {
            value["previous"] =
                serde_json::json!({"version":previous.version,"sha256":previous.sha256})
        }
        Retained::Clear => {
            value.as_object_mut().unwrap().remove("previous");
        }
    }
    value["lastOperation"] = operation;
    let bytes = serde_json::to_vec(&value).map_err(|_| crate::Error::InvalidArgument)?;
    if bytes.len() as u64 >= private_json::MAX_CONFIG {
        return Err(crate::Error::InvalidArgument);
    }
    private_json::write(directory, NAME, &bytes)
}
