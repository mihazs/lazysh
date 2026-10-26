//! Explicit, error-only storage diagnostics. Never format the underlying error.
use super::Error;
use std::io::Write;
#[path = "storage_failure_record.rs"]
mod record;
pub(crate) use record::{Failure, Phase, ResultClass};

pub(crate) fn failure(phase: Phase, error: Error) -> Error {
    if std::env::var_os("LAZYSH_STORAGE_DIAGNOSTICS").is_some_and(|value| value == "1") {
        let diagnostic = describe(phase, &error);
        // Best effort: a broken stderr must not replace the original error or panic.
        let _ = std::io::stderr()
            .lock()
            .write_all(diagnostic.line().as_bytes());
    }
    error
}

fn describe(phase: Phase, error: &Error) -> Failure {
    let result = match error {
        Error::Storage(_) => ResultClass::StorageError,
        Error::Io(_) => ResultClass::IoError,
        Error::InvalidEvent => ResultClass::InvalidEvent,
        Error::InvalidArgument => ResultClass::InvalidArgument,
        Error::UnsupportedStateFilesystem => ResultClass::UnsupportedStateFilesystem,
        // These variants contain extensible static strings. Do not expose them here.
        Error::Relay(_) | Error::Settings(_) | Error::Device(_) => ResultClass::OtherError,
    };
    let sqlite_code = match error {
        Error::Storage(rusqlite::Error::SqliteFailure(code, _)) => Some(code.extended_code),
        _ => None,
    };
    Failure {
        phase,
        result,
        sqlite_code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_causes_never_enter_the_record_and_error_identity_is_preserved() {
        let cause = String::from("private SQL /path payload");
        let pointer = cause.as_ptr();
        let error = Error::Storage(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1811),
            Some(cause),
        ));
        let record = describe(Phase::SessionWrite, &error);
        assert_eq!(record.sqlite_code, Some(1811));
        assert!(!record.line().contains("private"));
        let unchanged = failure(Phase::SessionWrite, error);
        let Error::Storage(rusqlite::Error::SqliteFailure(code, Some(cause))) = unchanged else {
            panic!("error variant changed")
        };
        assert_eq!(code.extended_code, 1811);
        assert_eq!(cause.as_ptr(), pointer);
        for error in [
            Error::Relay("private"),
            Error::Device("private"),
            Error::Settings("private"),
        ] {
            let record = describe(Phase::RelayAdmission, &error);
            assert_eq!(record.result, ResultClass::OtherError);
            assert!(!record.line().contains("private"));
        }
    }
}
