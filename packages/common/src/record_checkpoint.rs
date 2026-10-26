//! Canonical consistency receipts for explicitly checkpointed Grok record reads.
//! These receipts do not authorize file or session access.
use std::fmt;

pub const MAX_SNAPSHOT: u64 = 16 * 1024 * 1024;
pub const MAX_TOKEN: usize = 150;

pub struct RecordCheckpoint {
    pub source: String,
    pub next_offset: u64,
    pub observed_length: u64,
    pub prefix: String,
}

impl RecordCheckpoint {
    pub fn parse(token: &str) -> Option<Self> {
        if token.len() > MAX_TOKEN {
            return None;
        }
        let mut parts = token.split(':');
        if parts.next()? != "g1" {
            return None;
        }
        let source = parts.next()?;
        let next_offset = number(parts.next()?)?;
        let observed_length = number(parts.next()?)?;
        let prefix = parts.next()?;
        if parts.next().is_some()
            || !crate::valid_sha256(source)
            || !crate::valid_sha256(prefix)
            || next_offset > observed_length
        {
            return None;
        }
        Some(Self {
            source: source.into(),
            next_offset,
            observed_length,
            prefix: prefix.into(),
        })
    }
}

fn number(value: &str) -> Option<u64> {
    if value.is_empty()
        || value.len() > 8
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok().filter(|number| *number <= MAX_SNAPSHOT)
}

impl fmt::Display for RecordCheckpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "g1:{}:{}:{}:{}",
            self.source, self.next_offset, self.observed_length, self.prefix
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_receipts_bound_both_offsets_and_reject_alternate_spellings() {
        let hash = "a".repeat(64);
        let token = format!("g1:{hash}:0:16777216:{hash}");
        assert_eq!(RecordCheckpoint::parse(&token).unwrap().to_string(), token);
        let maximum = format!("g1:{hash}:16777216:16777216:{hash}");
        assert_eq!(maximum.len(), MAX_TOKEN);
        assert!(RecordCheckpoint::parse(&maximum).is_some());
        for (cursor, length) in [
            ("01", "2"),
            ("+1", "2"),
            (" 1", "2"),
            ("", "2"),
            ("3", "2"),
            ("0", "16777217"),
            ("0", "000000000"),
        ] {
            assert!(
                RecordCheckpoint::parse(&format!("g1:{hash}:{cursor}:{length}:{hash}")).is_none()
            );
        }
        for invalid in [
            token.replace("g1:", "v1:"),
            token.replace('a', "A"),
            format!("{token}:"),
            token.replace(":0:", ":0\n:"),
            format!("g1:{}:0:0:{hash}", "a".repeat(65)),
        ] {
            assert!(RecordCheckpoint::parse(&invalid).is_none());
        }
    }
}
