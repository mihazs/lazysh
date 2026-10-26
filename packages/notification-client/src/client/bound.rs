//! Captured credentials for the dedicated bound protocol; never downgrade to manual publish.
use super::{base, bounded_body, capture_capability, captured_transport, hex_digest, Capability};
use crate::{BoundEvent, BoundReceipt, BoundStatus, Event, Source};
use lazysh_common::valid_sha256 as valid_hash;
use serde::{Deserialize, Deserializer, Serialize};
use std::path::Path;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherBinding {
    #[serde(deserialize_with = "crate::wire::schema_one")]
    pub schema_version: u8,
    #[serde(deserialize_with = "canonical_origin")]
    pub origin: String,
    pub account_id: Uuid,
    pub source_id: Uuid,
    #[serde(deserialize_with = "hash")]
    pub capability_hash: String,
    #[serde(deserialize_with = "optional_hash")]
    pub ca_hash: Option<String>,
}
impl PublisherBinding {
    pub fn fingerprint(&self) -> String {
        hex_digest(&serde_json::to_vec(self).expect("metadata serialization is infallible"))
    }
}
fn canonical_origin<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if base(&value).is_ok_and(|canonical| canonical == value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("invalid publisher origin"))
    }
}

fn hash<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if valid_hash(&value) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("invalid publisher hash"))
    }
}
fn optional_hash<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(d)?;
    if value.as_deref().is_none_or(valid_hash) {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("invalid publisher trust hash"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundError {
    Binding,
    Unsupported,
    Unauthorized,
    TargetChanged,
    Conflict,
    Disabled,
    Capacity,
    Unavailable,
    InvalidResponse,
}
impl BoundError {
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::Capacity | Self::Unavailable | Self::InvalidResponse
        )
    }
}
impl std::fmt::Display for BoundError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Binding => "RelayBindingMismatch",
            Self::Unsupported => "RelayBoundProtocolUnsupported",
            Self::Unauthorized => "RelayUnauthorized",
            Self::TargetChanged => "RelayTargetChanged",
            Self::Conflict => "RelayIdentityConflict",
            Self::Disabled => "RelayDestinationDisabled",
            Self::Capacity => "RelayCapacity",
            Self::Unavailable => "RelayUnavailable",
            Self::InvalidResponse => "RelayInvalidResponse",
        })
    }
}
impl std::error::Error for BoundError {}

// Deliberately no Debug/Clone: the single captured bearer owns its zeroizing Drop.
pub struct CapturedPublisher {
    client: reqwest::Client,
    capability: Capability,
    binding: PublisherBinding,
}
impl CapturedPublisher {
    pub fn load(capfile: &Path, ca_file: Option<&Path>) -> Result<Self, BoundError> {
        let (capability, capability_hash) =
            capture_capability(capfile).map_err(|_| BoundError::Binding)?;
        Source {
            account_id: capability.account_id.clone(),
            id: capability.source_id,
            alias: capability.alias.clone(),
            token_hash: crate::digest(&capability.secret).to_vec(),
        }
        .validate()
        .map_err(|_| BoundError::Binding)?;
        let (client, ca_hash) = captured_transport(ca_file).map_err(|_| BoundError::Binding)?;
        let binding = PublisherBinding {
            schema_version: 1,
            origin: capability.origin.clone(),
            account_id: Uuid::parse_str(&capability.account_id).map_err(|_| BoundError::Binding)?,
            source_id: capability.source_id,
            capability_hash,
            ca_hash,
        };
        Ok(Self {
            client,
            capability,
            binding,
        })
    }
    pub fn binding(&self) -> &PublisherBinding {
        &self.binding
    }
    pub async fn bound_status(&self) -> Result<BoundStatus, BoundError> {
        let status: BoundStatus = bound_response(
            self.client
                .get(self.endpoint())
                .bearer_auth(&self.capability.secret),
        )
        .await?;
        if status.account_id != self.binding.account_id
            || status.source_id != self.binding.source_id
        {
            return Err(BoundError::TargetChanged);
        }
        Ok(status)
    }
    pub async fn publish_bound(
        &self,
        event: Event,
        expected: &PublisherBinding,
        generation: i64,
    ) -> Result<BoundReceipt, BoundError> {
        if &self.binding != expected || generation < 0 {
            return Err(BoundError::Binding);
        }
        let request = BoundEvent {
            schema_version: 1,
            account_id: self.binding.account_id,
            source_id: self.binding.source_id,
            generation,
            event_id: event.event_id,
            kind: event.kind,
        };
        let result: BoundReceipt = bound_response(
            self.client
                .post(self.endpoint())
                .bearer_auth(&self.capability.secret)
                .json(&request),
        )
        .await?;
        let receipt = &result.receipt;
        if result.account_id != expected.account_id
            || result.source_id != expected.source_id
            || result.generation != generation
            || Uuid::parse_str(&receipt.receipt_id).is_err()
            || Uuid::parse_str(&receipt.event_id).ok() != Some(event.event_id)
            || receipt.kind != event.kind.as_str()
            || receipt.alias != self.capability.alias
            || !matches!(
                receipt.state.as_str(),
                "queued"
                    | "sending"
                    | "accepted"
                    | "cancelled"
                    | "cancelled_unknown"
                    | "expired"
                    | "expired_unknown"
                    | "failed_unknown"
            )
        {
            return Err(BoundError::InvalidResponse);
        }
        Ok(result)
    }
    fn endpoint(&self) -> String {
        format!("{}/v1/bound-events", self.binding.origin)
    }
}

async fn bound_response<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, BoundError> {
    let response = request.send().await.map_err(|_| BoundError::Unavailable)?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(BoundError::Unauthorized),
        404 | 405 | 501 => return Err(BoundError::Unsupported),
        412 => return Err(BoundError::TargetChanged),
        429 => return Err(BoundError::Capacity),
        409 => {
            let bytes = bounded_body(response)
                .await
                .map_err(|_| BoundError::InvalidResponse)?;
            let code: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| BoundError::InvalidResponse)?;
            return Err(if code["error"] == "destination_disabled" {
                BoundError::Disabled
            } else {
                BoundError::Conflict
            });
        }
        500..=599 => return Err(BoundError::Unavailable),
        _ => return Err(BoundError::InvalidResponse),
    }
    let bytes = bounded_body(response)
        .await
        .map_err(|_| BoundError::InvalidResponse)?;
    serde_json::from_slice(&bytes).map_err(|_| BoundError::InvalidResponse)
}
