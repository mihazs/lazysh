//! Private first-admission snapshots; legacy wire data remains unchanged.
use crate::{
    push::{EncryptedPush, EventFormat, PushConfig, Subscription},
    ApiError, Receipt,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    schema_version: u8,
    subscription: Subscription,
    device_id: Uuid,
    generation: i64,
    issued_at: i64,
    expires_at: i64,
}

pub(crate) fn capture(
    config: &PushConfig,
    active: String,
    generation: i64,
    at: i64,
    event_expires: i64,
) -> Result<String, ApiError> {
    if config.event_format() == EventFormat::Legacy {
        return Ok(active);
    }
    let snapshot = Snapshot {
        schema_version: 2,
        subscription: serde_json::from_str(&active).map_err(|_| ApiError::storage())?,
        device_id: config.slot_id(),
        generation,
        issued_at: at,
        expires_at: at
            .checked_add(300)
            .ok_or_else(ApiError::storage)?
            .min(event_expires),
    };
    validate(config, &snapshot)?;
    serde_json::to_string(&snapshot).map_err(|_| ApiError::storage())
}

fn validate(config: &PushConfig, snapshot: &Snapshot) -> Result<(), ApiError> {
    if snapshot.schema_version != 2
        || snapshot.device_id != config.slot_id()
        || snapshot.generation < 0
        || snapshot.issued_at < 0
        || snapshot.expires_at <= snapshot.issued_at
        || snapshot
            .expires_at
            .checked_sub(snapshot.issued_at)
            .is_none_or(|span| span > 300)
    {
        return Err(ApiError::storage());
    }
    Ok(())
}

pub(crate) fn encrypted(
    config: &PushConfig,
    snapshot: &str,
    receipt: &Receipt,
    at: i64,
) -> Result<Option<EncryptedPush>, ApiError> {
    let (subscription, body, ttl) = match config.event_format() {
        EventFormat::Legacy => (
            serde_json::from_str(snapshot).map_err(|_| ApiError::storage())?,
            serde_json::json!({"schemaVersion":1,"receiptId":receipt.receipt_id,"eventId":receipt.event_id,"kind":receipt.kind,"alias":receipt.alias}),
            300,
        ),
        EventFormat::BoundV2 => {
            let snapshot: Snapshot =
                serde_json::from_str(snapshot).map_err(|_| ApiError::storage())?;
            validate(config, &snapshot)?;
            if at < snapshot.issued_at {
                return Err(ApiError::storage());
            }
            if at >= snapshot.expires_at {
                return Ok(None);
            }
            let ttl = u32::try_from(snapshot.expires_at - at).map_err(|_| ApiError::storage())?;
            let body = serde_json::json!({"schemaVersion":2,"deviceId":snapshot.device_id,"generation":snapshot.generation,
                "receiptId":receipt.receipt_id,"eventId":receipt.event_id,"kind":receipt.kind,"alias":receipt.alias,
                "issuedAt":snapshot.issued_at,"expiresAt":snapshot.expires_at});
            (snapshot.subscription, body, ttl)
        }
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&body).map_err(|_| ApiError::storage())?);
    config
        .encrypt(&subscription, &bytes, ttl)
        .map(Some)
        .map_err(|_| ApiError::storage())
}
