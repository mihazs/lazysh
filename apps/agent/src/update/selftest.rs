//! The check a binary passes before it may become the installed companion: it names the expected
//! version, and it round-trips a lifecycle event the way a configured hook would.
//! Only called on bytes whose size and SHA-256 already matched the verified release.
use super::process::{run, version_text};
use std::{path::Path, time::Duration};

const LIMIT: Duration = Duration::from_secs(20);
const SESSION: &str = "lazysh-update-selftest";
const EVENT: &str = r#"{"schemaVersion":1,"sessionId":"lazysh-update-selftest","agent":"Update self-test","project":"/","state":"done","summary":"Update self-test","paneId":null}"#;

/// Identity check plus the hook protocol, in a throwaway state directory.
pub fn passes(path: &Path, version: &str) -> bool {
    let Ok(scratch) = tempfile::tempdir() else {
        return false;
    };
    let dir = scratch.path();
    let state = dir.join("state");
    let env = [
        ("LAZYSH_STATE_DIR", state.as_path()),
        ("PATH", Path::new("/usr/bin:/bin")),
    ];
    version_text(path, dir).as_deref() == Some(version)
        && run(
            path,
            &["ingest", "--agent", "generic"],
            &env,
            dir,
            EVENT.as_bytes(),
            LIMIT,
        )
        .is_some_and(|run| run.success)
        && run(path, &["snapshot", "--limit", "1"], &env, dir, b"", LIMIT)
            .filter(|run| run.success)
            .and_then(|run| serde_json::from_slice::<serde_json::Value>(&run.stdout).ok())
            .is_some_and(|snapshot| snapshot["sessions"][0]["sessionId"] == SESSION)
}
