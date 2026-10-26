//! Finite wire record also consumed by the owned CLI trace fixture.
use serde::{Deserialize, Serialize};
pub(crate) const PREFIX: &str = "lazysh-storage-diagnostic ";
pub(crate) const LINE_LIMIT: usize = 256;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    BootstrapPreparation,
    BootstrapLock,
    SqliteOpen,
    SqliteConfiguration,
    Synchronous,
    JournalMode,
    JournalSize,
    SessionsSchema,
    RelaySchema,
    IngestValidation,
    IngestBegin,
    PriorState,
    SessionWrite,
    RelayAdmission,
    RetentionAge,
    RetentionCount,
    Commit,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ResultClass {
    StorageError,
    IoError,
    InvalidEvent,
    InvalidArgument,
    UnsupportedStateFilesystem,
    OtherError,
}
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Failure {
    pub phase: Phase,
    pub result: ResultClass,
    pub sqlite_code: Option<i32>,
}
impl Failure {
    pub fn line(&self) -> String {
        // All strings are enum variants; the only variable data is an i32 or null.
        let line = format!(
            "{PREFIX}{}\n",
            serde_json::to_string(self).expect("finite diagnostic")
        );
        debug_assert!(line.len() <= LINE_LIMIT);
        line
    }
    #[cfg(test)]
    pub fn parse(line: &str) -> Option<Self> {
        if line.len() > LINE_LIMIT {
            return None;
        }
        serde_json::from_str(line.strip_prefix(PREFIX)?).ok()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_are_bounded_and_reject_unknown_or_extra_data() {
        let record = Failure {
            phase: Phase::BootstrapLock,
            result: ResultClass::StorageError,
            sqlite_code: Some(i32::MIN),
        };
        let line = record.line();
        assert!(line.len() <= LINE_LIMIT);
        assert_eq!(Failure::parse(&line), Some(record));
        for invalid in [
            "{\"phase\":\"private_path\",\"result\":\"StorageError\",\"sqliteCode\":5}",
            "{\"phase\":\"commit\",\"result\":\"private_secret\",\"sqliteCode\":5}",
            "{\"phase\":\"commit\",\"result\":\"IoError\",\"sqliteCode\":null,\"path\":\"secret\"}",
        ] {
            assert!(Failure::parse(&format!("{PREFIX}{invalid}")).is_none());
        }
        assert!(Failure::parse(&"x".repeat(LINE_LIMIT + 1)).is_none());
    }
}
