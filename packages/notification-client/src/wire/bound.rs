use super::{Kind, Receipt};
use serde::{Deserialize, Deserializer, Serialize};
use uuid::Uuid;

// The three dedicated-route messages share one versioned identity contract.
macro_rules! bound_message {
    ($name:ident { $($(#[$attr:meta])* $field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name {
            #[serde(deserialize_with = "schema_one")]
            pub schema_version: u8,
            pub account_id: Uuid,
            pub source_id: Uuid,
            #[serde(deserialize_with = "nonnegative")]
            pub generation: i64,
            $($(#[$attr])* pub $field: $ty),*
        }
        impl $name {
            pub fn valid(&self) -> bool { self.schema_version == 1 && self.generation >= 0 }
        }
    };
}
bound_message!(BoundStatus { enabled: bool });
bound_message!(BoundEvent {
    event_id: Uuid,
    kind: Kind
});
bound_message!(BoundReceipt {
    #[serde(deserialize_with = "closed_receipt")]
    receipt: Receipt
});

pub(crate) fn schema_one<'de, D: Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let value = u8::deserialize(d)?;
    if value == 1 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("unsupported bound schema"))
    }
}
fn nonnegative<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let value = i64::deserialize(d)?;
    if value >= 0 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("invalid bound generation"))
    }
}
fn closed_receipt<'de, D: Deserializer<'de>>(d: D) -> Result<Receipt, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    let object = value
        .as_object()
        .ok_or_else(|| serde::de::Error::custom("invalid bound receipt"))?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "receiptId" | "eventId" | "kind" | "alias" | "state" | "mayHaveReachedDestination"
        )
    }) {
        return Err(serde::de::Error::custom("invalid bound receipt"));
    }
    serde_json::from_value(value).map_err(|_| serde::de::Error::custom("invalid bound receipt"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dedicated_wire_rejects_unknown_fields_versions_and_negative_or_malformed_identity() {
        let status = BoundStatus {
            schema_version: 1,
            account_id: Uuid::new_v4(),
            source_id: Uuid::new_v4(),
            generation: 1,
            enabled: true,
        };
        let valid = serde_json::to_value(status).unwrap();
        for (field, value) in [
            ("schemaVersion", serde_json::json!(2)),
            ("generation", serde_json::json!(-1)),
            ("generation", serde_json::json!("1")),
            ("accountId", serde_json::json!("invalid")),
            ("sourceId", serde_json::json!([])),
            ("prompt", serde_json::json!("must not leave host")),
        ] {
            let mut malformed = valid.clone();
            malformed[field] = value;
            assert!(serde_json::from_value::<BoundStatus>(malformed).is_err());
        }
        let mut receipt = serde_json::json!({"schemaVersion":1,"accountId":valid["accountId"],"sourceId":valid["sourceId"],"generation":1,
            "receipt":{"receiptId":Uuid::new_v4(),"eventId":Uuid::new_v4(),"kind":"done","alias":"public","state":"queued","mayHaveReachedDestination":false}});
        assert!(serde_json::from_value::<BoundReceipt>(receipt.clone()).is_ok());
        receipt["receipt"]["prompt"] = serde_json::json!("never accepted");
        assert!(serde_json::from_value::<BoundReceipt>(receipt).is_err());
    }
}
