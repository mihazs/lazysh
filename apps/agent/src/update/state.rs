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
#[derive(Deserialize)]
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
