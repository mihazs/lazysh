//! Closed, failure-only observations of the owned WAL crash fixture, never production stores.
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    ffi::OsStr,
    io::{self, Write},
};

pub const PREFIX: &str = "lazysh-wal-crash-failure ";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    Parent,
    Child,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Spawn,
    Readiness,
    Sidecar,
    Kill,
    Reap,
    Reopen,
    Snapshot,
    Count,
    Schema,
    Integrity,
    StoreOpen,
    Commit,
    CommittedSidecar,
    PendingOpen,
    SpillWrite,
    SpillSize,
    ReadyFlush,
    AwaitKill,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Readiness {
    NotReached,
    Ready,
    Timeout,
    Disconnected,
    NotApplicable,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Scope {
    FailureUnwind,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    schema_version: u8,
    scope: Scope,
    pub origin: Origin,
    stage: Stage,
    readiness: Readiness,
}
impl Record {
    fn valid(&self) -> bool {
        self.schema_version == 1
            && match self.origin {
                Origin::Parent => match self.stage {
                    Stage::Spawn => self.readiness == Readiness::NotReached,
                    Stage::Readiness => self.readiness != Readiness::NotApplicable,
                    Stage::Sidecar
                    | Stage::Kill
                    | Stage::Reap
                    | Stage::Reopen
                    | Stage::Snapshot
                    | Stage::Count
                    | Stage::Schema
                    | Stage::Integrity => self.readiness == Readiness::Ready,
                    _ => false,
                },
                Origin::Child => {
                    matches!(
                        self.stage,
                        Stage::StoreOpen
                            | Stage::Commit
                            | Stage::CommittedSidecar
                            | Stage::PendingOpen
                            | Stage::SpillWrite
                            | Stage::SpillSize
                            | Stage::ReadyFlush
                            | Stage::AwaitKill
                    ) && self.readiness == Readiness::NotApplicable
                }
            }
    }
    pub fn line(&self) -> Option<String> {
        self.valid().then_some(())?;
        let json = serde_json::to_string(self).ok()?;
        Some(format!("{PREFIX}{json}\n"))
    }
    pub fn parse(line: &str) -> Option<Self> {
        if line.len() > 512 || line.chars().any(char::is_control) {
            return None;
        }
        let record: Self = serde_json::from_str(line.strip_prefix(PREFIX)?).ok()?;
        record.valid().then_some(record)
    }
}
pub fn coherent(records: &[Record]) -> bool {
    if records.len() > 2
        || records.iter().any(|record| !record.valid())
        || (records.len() == 2 && records[0].origin == records[1].origin)
    {
        return false;
    }
    let parent = records
        .iter()
        .find(|record| record.origin == Origin::Parent);
    let child = records.iter().find(|record| record.origin == Origin::Child);
    match (parent, child) {
        (None, None) => true,
        (None, Some(_)) => false,
        (Some(parent), Some(child)) => {
            parent.stage == Stage::Spawn
                || (!matches!(
                    child.stage,
                    Stage::StoreOpen
                        | Stage::Commit
                        | Stage::CommittedSidecar
                        | Stage::PendingOpen
                        | Stage::SpillWrite
                        | Stage::SpillSize
                ) || matches!(
                    parent.readiness,
                    Readiness::Timeout | Readiness::Disconnected
                ))
        }
        (Some(_), None) => true,
    }
}

pub struct Observation<W: Write = io::Stderr> {
    record: Cell<Record>,
    enabled: bool,
    output: W,
}
impl Observation {
    pub fn new(origin: Origin) -> Self {
        Self::with_output(
            origin,
            std::env::var_os("LAZYSH_STORAGE_DIAGNOSTICS").as_deref() == Some(OsStr::new("1")),
            io::stderr(),
        )
    }
}
impl<W: Write> Observation<W> {
    fn with_output(origin: Origin, enabled: bool, output: W) -> Self {
        Self {
            record: Cell::new(Record {
                schema_version: 1,
                scope: Scope::FailureUnwind,
                origin,
                stage: if origin == Origin::Parent {
                    Stage::Spawn
                } else {
                    Stage::StoreOpen
                },
                readiness: if origin == Origin::Parent {
                    Readiness::NotReached
                } else {
                    Readiness::NotApplicable
                },
            }),
            enabled,
            output,
        }
    }
    pub fn stage(&self, stage: Stage) {
        self.record.set(Record {
            stage,
            ..self.record.get()
        });
    }
    pub fn readiness(&self, readiness: Readiness) {
        self.record.set(Record {
            readiness,
            ..self.record.get()
        });
    }
}
impl<W: Write> Drop for Observation<W> {
    fn drop(&mut self) {
        if self.enabled && std::thread::panicking() {
            if let Some(line) = self.record.get().line() {
                let _ = self.output.write_all(line.as_bytes());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc, sync::Arc};
    #[derive(Clone)]
    struct Sink(Rc<RefCell<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.borrow_mut().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn panic_observation_preserves_payload_and_runs_after_owned_drop() {
        struct Owned(Sink);
        impl Drop for Owned {
            fn drop(&mut self) {
                self.0.write_all(b"owned-dropped\n").unwrap();
            }
        }
        let bytes = Rc::new(RefCell::new(Vec::new()));
        let sink = Sink(bytes.clone());
        let marker = Arc::new(());
        let original = marker.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let observation = Observation::with_output(Origin::Parent, true, sink.clone());
            let _owned = Owned(sink);
            observation.stage(Stage::Readiness);
            observation.readiness(Readiness::Timeout);
            std::panic::panic_any(original);
        }));
        assert!(Arc::ptr_eq(
            result.unwrap_err().downcast::<Arc<()>>().unwrap().as_ref(),
            &marker
        ));
        let text = String::from_utf8(bytes.borrow().clone()).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("owned-dropped"));
        let record = Record::parse(lines.next().unwrap()).unwrap();
        assert_eq!(record.stage, Stage::Readiness);
        assert_eq!(record.readiness, Readiness::Timeout);
        assert!(lines.next().is_none());
    }
    #[test]
    fn successful_or_disabled_observation_never_writes() {
        drop(Observation::new(Origin::Parent));
        let bytes = Rc::new(RefCell::new(Vec::new()));
        {
            let _observation = Observation::with_output(Origin::Child, true, Sink(bytes.clone()));
        }
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _observation = Observation::with_output(Origin::Child, false, Sink(bytes.clone()));
            panic!("private-payload");
        }));
        assert!(bytes.borrow().is_empty());
    }
    #[test]
    fn failed_observation_write_cannot_replace_the_original_panic() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let panic = std::panic::catch_unwind(|| {
            let _observation = Observation::with_output(Origin::Child, true, Broken);
            std::panic::panic_any(741_u32);
        });
        assert_eq!(*panic.unwrap_err().downcast::<u32>().unwrap(), 741);
    }
    #[test]
    fn closed_record_rejects_private_unknown_control_and_oversized_fields() {
        let observation = Observation::with_output(Origin::Child, false, Vec::new());
        let record = observation.record.get();
        let line = record.line().unwrap();
        assert_eq!(Record::parse(line.trim_end()), Some(record));
        for bad in [
            line.replace("storeOpen", "private-value"),
            line.replace("\"schemaVersion\":1", "\"schemaVersion\":2"),
            line.replace(
                "\"origin\":\"child\"",
                "\"origin\":\"child\",\"secret\":\"/private/path\"",
            ),
            line.replace("\"child\"", "\"parent\""),
            line.replace("{", "{\r"),
            "x".repeat(513),
        ] {
            assert!(Record::parse(bad.trim_end()).is_none());
        }
        let duplicate = line.replace(
            "\"origin\":\"child\"",
            "\"origin\":\"child\",\"origin\":\"parent\"",
        );
        assert!(Record::parse(duplicate.trim_end()).is_none());
    }
    #[test]
    fn child_stage_and_parent_readiness_cannot_describe_contradictory_progress() {
        let parent = Observation::with_output(Origin::Parent, false, Vec::new());
        let child = Observation::with_output(Origin::Child, false, Vec::new());
        assert!(!coherent(&[child.record.get()]));
        // Spawn also covers stdout extraction and reader-thread creation after the child is live.
        // Until the parent reaches its readiness wait, any child progress remains possible.
        for stage in [
            Stage::StoreOpen,
            Stage::Commit,
            Stage::ReadyFlush,
            Stage::AwaitKill,
        ] {
            child.stage(stage);
            assert!(coherent(&[parent.record.get(), child.record.get()]));
        }
        child.stage(Stage::StoreOpen);
        parent.stage(Stage::Readiness);
        parent.readiness(Readiness::Disconnected);
        assert!(coherent(&[parent.record.get(), child.record.get()]));
        parent.readiness(Readiness::Ready);
        assert!(!coherent(&[parent.record.get(), child.record.get()]));
        child.stage(Stage::AwaitKill);
        assert!(coherent(&[parent.record.get(), child.record.get()]));
        parent.stage(Stage::Reopen);
        assert!(coherent(&[parent.record.get()]));
    }
}
