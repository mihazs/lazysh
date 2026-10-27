// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Proposed optional protocol, not a stock Herdr API. Secret-bearing values
//! use redacted Debug; errors contain finite codes only.

use std::io;

use serde::{Deserialize, Serialize};

pub(crate) const CAPABILITY: &str = "lazysh.guarded-input.v1";
pub(crate) const MAX_ENVELOPE: usize = 32 * 1024;
pub(crate) const MAX_TEXT: usize = 4096;
pub(crate) const MAX_OPERATION: u64 = (1_u64 << 53) - 1;
pub(crate) const MAX_BINDINGS: usize = 64;
pub(crate) const REGISTER_TTL: std::time::Duration = std::time::Duration::from_secs(30);
pub(crate) const BINDING_TTL: std::time::Duration = std::time::Duration::from_secs(60);
pub(crate) const CHALLENGE_TTL: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "String")]
pub struct Secret(String);

impl Secret {
    pub(crate) fn generate() -> io::Result<Self> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| io::Error::other("guard_unavailable"))?;
        let mut encoded = String::with_capacity(64);
        for byte in bytes {
            use std::fmt::Write;
            // String formatting cannot fail.
            let _ = write!(encoded, "{byte:02x}");
        }
        Ok(Self(encoded))
    }
}

impl TryFrom<String> for Secret {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        canonical_digest(&value)
            .then_some(Self(value))
            .ok_or("guard_invalid")
    }
}

#[path = "../common/src/hex_digest.rs"]
mod hex_digest;
pub(crate) use hex_digest::valid_sha256 as canonical_digest;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub(crate) workspace: String,
    pub(crate) tab: String,
    pub(crate) pane: String,
    pub(crate) terminal: String,
    pub(crate) runtime_generation: u64,
    pub(crate) viewport: Viewport,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub(crate) x: u16,
    pub(crate) y: u16,
    pub(crate) width: u16,
    pub(crate) height: u16,
}

impl Target {
    pub(crate) fn valid(&self) -> bool {
        [&self.workspace, &self.tab, &self.pane, &self.terminal]
            .iter()
            .all(|value| {
                !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
            })
            && self.runtime_generation > 0
            && self.viewport.width > 0
            && self.viewport.height > 0
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    Send { text: String },
    RequestStop,
}

impl Input {
    pub(crate) fn valid(&self) -> bool {
        match self {
            Self::Send { text } => {
                !text.is_empty()
                    && text.len() <= MAX_TEXT
                    && !text.chars().any(|character| {
                        (character.is_control() && !matches!(character, '\n' | '\t'))
                            || matches!(character, '\u{2028}' | '\u{2029}')
                    })
            }
            Self::RequestStop => true,
        }
    }
}

pub(crate) fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, &'static str> {
    if bytes.len() > MAX_ENVELOPE {
        return Err("guard_invalid");
    }
    serde_json::from_slice(bytes).map_err(|_| "guard_invalid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_secret_grammar_and_finite_errors() {
        let token = "ab".repeat(32);
        let serialized = serde_json::to_vec(&token).unwrap();
        assert!(decode::<Secret>(&serialized).is_ok());
        for invalid in ["AB".repeat(32), format!("{token}\n"), "a".repeat(63)] {
            assert_eq!(
                decode::<Secret>(&serde_json::to_vec(&invalid).unwrap()).err(),
                Some("guard_invalid")
            );
        }
        assert_eq!(
            decode::<Secret>(&vec![b' '; MAX_ENVELOPE + 1]).err(),
            Some("guard_invalid")
        );
    }

    #[test]
    fn send_matches_confirmed_chat_utf8_and_multiline_bounds() {
        for text in ["hello", "one\ntwo\tthree", "é🙂"] {
            assert!(Input::Send { text: text.into() }.valid());
        }
        for text in ["", "\r", "\0", "\u{1b}", "\u{2028}", "\u{2029}"] {
            assert!(!Input::Send { text: text.into() }.valid());
        }
        assert!(Input::Send {
            text: "é".repeat(MAX_TEXT / 2)
        }
        .valid());
        assert!(!Input::Send {
            text: "é".repeat(MAX_TEXT / 2 + 1)
        }
        .valid());
        assert!(Input::RequestStop.valid());
    }
}

/// Values bearing tickets or payloads must never inherit derived wire Debug.
impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret([redacted])")
    }
}

pub(crate) const REGISTERED_KIND: &str = "lazysh.guard.registered.v1";
pub(crate) const CHALLENGE_KIND: &str = "lazysh.guard.challenge.v1";
pub(crate) const COMMIT_KIND: &str = "lazysh.guard.commit.v1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Registered {
    pub(crate) boot: Secret,
    pub(crate) nonce: Secret,
    pub(crate) ticket: Secret,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Commit {
    pub(crate) boot: Secret,
    pub(crate) challenge: Secret,
    pub(crate) accepted: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClientChallenge {
    pub(crate) boot: Secret,
    pub(crate) nonce: Secret,
    pub(crate) target: Target,
}

#[derive(Clone, Default)]
pub struct Cancellation(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Cancellation {
    pub(crate) fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
    pub(crate) fn cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
}
impl PartialEq for Cancellation {
    fn eq(&self, _other: &Self) -> bool {
        true
    } // Process-local state is not wire identity.
}

macro_rules! guard_parameters {
    ($name:ident { $($fields:tt)* }) => {
        #[derive(Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
        #[serde(deny_unknown_fields)]
        pub struct $name { $($fields)* }
    };
}

guard_parameters! { PrepareParams {
    pub(crate) boot: Secret,
    pub(crate) ownership: Secret,
    pub(crate) preparation: u64,
    pub(crate) source: String,
    #[serde(skip)]
    #[schemars(skip)]
    pub(crate) cancellation: Cancellation,
}}

guard_parameters! { InputParams {
    pub(crate) boot: Secret,
    pub(crate) receipt: Secret,
    pub(crate) source: String,
    pub(crate) operation: u64,
    pub(crate) input: Input,
    #[serde(skip)]
    #[schemars(skip)]
    pub(crate) cancellation: Cancellation,
}}

guard_parameters! { ReleaseParams {
    pub(crate) boot: Secret,
    pub(crate) receipt: Secret,
}}

fn redacted(formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str("GuardRequest([redacted])")
}

impl PrepareParams {
    pub(crate) fn valid(&self) -> bool {
        canonical_digest(&self.source) && valid_operation(self.preparation)
    }
}
impl InputParams {
    pub(crate) fn valid(&self) -> bool {
        canonical_digest(&self.source)
            && self.operation > 0
            && self.operation <= MAX_OPERATION
            && self.input.valid()
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PreparedReply {
    pub(crate) boot: Secret,
    pub(crate) receipt: Secret,
    pub(crate) target: Target,
    pub(crate) preparation: u64,
    pub(crate) source: String,
}

guard_parameters! { ClaimParams {
    pub(crate) boot: Secret,
    pub(crate) ticket: Secret,
    #[serde(skip)]
    #[schemars(skip)]
    pub(crate) cancellation: Cancellation,
}}

#[derive(Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OwnershipReply {
    pub(crate) boot: Secret,
    pub(crate) ownership: Secret,
    pub(crate) last_preparation: u64,
}

guard_parameters! { CancelPreparationParams {
    pub(crate) boot: Secret,
    pub(crate) ownership: Secret,
    pub(crate) preparation: u64,
}}

guard_parameters! { RevokeParams {
    pub(crate) boot: Secret,
    pub(crate) ownership: Secret,
}}

pub(crate) fn valid_operation(operation: u64) -> bool {
    operation > 0 && operation <= MAX_OPERATION
}

macro_rules! redacted_debug {
    ($($type:ty),+ $(,)?) => {$(
        impl std::fmt::Debug for $type {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { redacted(formatter) }
        }
    )+};
}
redacted_debug!(
    PrepareParams,
    InputParams,
    ReleaseParams,
    PreparedReply,
    ClaimParams,
    OwnershipReply,
    CancelPreparationParams,
    RevokeParams
);

pub(crate) fn is_guard_method(method: &crate::api::schema::Method) -> bool {
    use crate::api::schema::Method;
    matches!(
        method,
        Method::GuardClaim(_)
            | Method::GuardPrepare(_)
            | Method::GuardInput(_)
            | Method::GuardRelease(_)
            | Method::GuardCancelPreparation(_)
            | Method::GuardRevoke(_)
    )
}
