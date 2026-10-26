use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Working,
    NeedsAttention,
    Done,
}
impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::NeedsAttention => "needs_attention",
            Self::Done => "done",
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub event_id: Uuid,
    pub kind: Kind,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub account_id: String,
    pub id: Uuid,
    pub alias: String,
    pub token_hash: Vec<u8>,
}
impl Source {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.token_hash.len() != 32
            || self.alias.is_empty()
            || self.alias.len() > 64
            || !self
                .alias
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b" _-.".contains(&b))
        {
            return Err("invalid_source");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub account_id: String,
    pub enabled: bool,
    pub generation: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub receipt_id: String,
    pub event_id: String,
    pub kind: String,
    pub alias: String,
    pub state: String,
    pub may_have_reached_destination: bool,
}

mod bound;
pub(crate) use bound::schema_one;
pub use bound::{BoundEvent, BoundReceipt, BoundStatus};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn event_wire_remains_closed_and_source_validation_keeps_its_code() {
        let event = Event {
            event_id: Uuid::nil(),
            kind: Kind::NeedsAttention,
        };
        let mut value = serde_json::to_value(event).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"eventId":"00000000-0000-0000-0000-000000000000","kind":"needs_attention"})
        );
        value["summary"] = serde_json::json!("must not leave host");
        assert!(serde_json::from_value::<Event>(value).is_err());
        let mut source = Source {
            account_id: Uuid::nil().to_string(),
            id: Uuid::nil(),
            alias: "public-worker".into(),
            token_hash: vec![0; 32],
        };
        assert_eq!(source.validate(), Ok(()));
        source.token_hash.pop();
        assert_eq!(source.validate(), Err("invalid_source"));
        source.token_hash.push(0);
        source.alias = "private\ncontrol".into();
        assert_eq!(source.validate(), Err("invalid_source"));
    }
}
