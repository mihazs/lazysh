//! A prepared transition records only lazysh assets and file identities, never provider contents.
use super::json::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Agent {
    Claude,
    Codex,
    Droid,
    Gemini,
    Cursor,
    Opencode,
    Cline,
}
impl Agent {
    pub(super) fn is_plugin(self) -> bool {
        matches!(self, Self::Opencode | Self::Cline)
    }
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Droid => "droid",
            Self::Gemini => "gemini",
            Self::Cursor => "cursor",
            Self::Opencode => "opencode",
            Self::Cline => "cline",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Identity {
    pub device: u64,
    pub inode: u64,
    pub owner: u32,
    pub mode: u32,
    pub links: u64,
    pub bytes: u64,
    pub modified: [i64; 2],
    pub changed: [i64; 2],
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Binary {
    pub path: PathBuf,
    pub sha256: String,
    pub identity: Identity,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum FileState {
    Missing,
    Present { identity: Identity, sha256: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Owned {
    pub template_version: u8,
    pub package_version: String,
    pub binary: Binary,
    pub entries: Vec<Entry>,
    pub plugin_sha256: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub schema_version: u8,
    pub product: String,
    pub agent: Agent,
    pub profile: PathBuf,
    pub profile_identity: [u64; 2],
    pub previous: Option<Owned>,
    pub next: Option<Owned>,
    pub provider_before: FileState,
    pub provider_after_sha256: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    record: Record,
    sha256: String,
}
pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn valid_path(path: &std::path::Path) -> bool {
    path.is_absolute()
        && path
            .to_str()
            .is_some_and(|value| value.len() <= 4096 && !value.chars().any(char::is_control))
        && !path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
}
impl Record {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != 1
            || self.product != "lazysh"
            || !valid_path(&self.profile)
            || (self.previous.is_some() && self.provider_before == FileState::Missing)
            || (self.next.is_some() && self.provider_after_sha256.is_none())
            || (!self.agent.is_plugin()
                && self.provider_after_sha256.is_none()
                && (self.previous.is_some() || self.next.is_some()))
            || (self.agent.is_plugin()
                && self.previous.is_none()
                && self.provider_before != FileState::Missing)
            || self
                .provider_after_sha256
                .as_ref()
                .is_some_and(|digest| !lazysh_common::valid_sha256(digest))
            || matches!(&self.provider_before,FileState::Present{sha256,..} if !lazysh_common::valid_sha256(sha256))
        {
            return Err("HooksInvalidRecord");
        }
        if self.previous.is_none() && self.next.is_none() {
            let before = match &self.provider_before {
                FileState::Missing => None,
                FileState::Present { sha256, .. } => Some(sha256),
            };
            return (before == self.provider_after_sha256.as_ref())
                .then_some(())
                .ok_or("HooksInvalidRecord");
        }
        for owned in [&self.previous, &self.next].into_iter().flatten() {
            if owned.template_version != 1
                || owned.package_version.is_empty()
                || owned.package_version.len() > 64
                || !valid_path(&owned.binary.path)
                || !lazysh_common::valid_sha256(&owned.binary.sha256)
                || owned.binary.identity.bytes == 0
                || owned.binary.identity.bytes > 64 * 1024 * 1024
            {
                return Err("HooksInvalidRecord");
            }
            match self.agent {
                Agent::Opencode | Agent::Cline
                    if owned.entries.is_empty()
                        && owned
                            .plugin_sha256
                            .as_ref()
                            .is_some_and(|digest| lazysh_common::valid_sha256(digest)) => {}
                Agent::Claude | Agent::Codex | Agent::Droid | Agent::Gemini | Agent::Cursor
                    if owned.plugin_sha256.is_none()
                        && !owned.entries.is_empty()
                        && owned.entries.len() <= 16 =>
                {
                    let mut events = std::collections::BTreeSet::new();
                    for entry in &owned.entries {
                        if !events.insert(&entry.event)
                            || entry
                                != &super::render::v1_entry(
                                    self.agent,
                                    &owned.binary.path,
                                    &entry.event,
                                )?
                        {
                            return Err("HooksInvalidRecord");
                        }
                    }
                }
                _ => return Err("HooksInvalidRecord"),
            }
        }
        if self.agent.is_plugin()
            && self
                .next
                .as_ref()
                .and_then(|owned| owned.plugin_sha256.as_ref())
                != self.provider_after_sha256.as_ref()
        {
            return Err("HooksInvalidRecord");
        }
        if self.agent.is_plugin()
            && matches!((&self.previous,&self.provider_before),
            (Some(owned),FileState::Present{sha256,..}) if owned.plugin_sha256.as_ref()!=Some(sha256))
        {
            return Err("HooksInvalidRecord");
        }
        Ok(())
    }
    pub(super) fn encode(&self) -> Result<Vec<u8>, &'static str> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| "HooksInvalidRecord")?;
        let bytes = serde_json::to_vec(&Receipt {
            record: self.clone(),
            sha256: hash(&bytes),
        })
        .map_err(|_| "HooksInvalidRecord")?;
        if bytes.len() > 64 * 1024 {
            return Err("HooksInvalidRecord");
        }
        Ok(bytes)
    }
    pub(super) fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() > 64 * 1024 {
            return Err("HooksInvalidRecord");
        }
        let text = std::str::from_utf8(bytes).map_err(|_| "HooksInvalidRecord")?;
        super::json::document(text).map_err(|_| "HooksInvalidRecord")?;
        let receipt: Receipt = serde_json::from_slice(bytes).map_err(|_| "HooksInvalidRecord")?;
        let canonical = serde_json::to_vec(&receipt.record).map_err(|_| "HooksInvalidRecord")?;
        if receipt.sha256 != hash(&canonical) {
            return Err("HooksModifiedRecord");
        }
        receipt.record.validate()?;
        Ok(receipt.record)
    }
}
