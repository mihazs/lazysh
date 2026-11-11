//! `transcript-watch`: one long-lived stream of upserts for a Claude Code or Codex conversation.
//!
//! The watcher never tails the file itself. A change of the file's identity, length or
//! modification time re-projects the conversation with the same bounded readers the paged
//! `transcript` and `herdr-conversation` commands use, then sends only what differs from the last
//! window. An unchanged file costs one `open` and `fstat` per interval. Frames are one JSON object
//! per line; the contract is in `docs/companion.md`.
use super::{herdr_session, Error, Result, TranscriptAgent, TranscriptPage};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    path::PathBuf,
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::{Duration, Instant, SystemTime},
};

/// Frame vocabulary version. Later versions only add frame types and fields; a client ignores
/// frame types it does not know.
pub const PROTOCOL: u8 = 1;
const HEARTBEAT: Duration = Duration::from_secs(5);
/// A page is at most 512 KiB, so a snapshot frame always fits.
const MAX_FRAME: usize = 1024 * 1024;
/// Consecutive failed checks (about 5 s at the default interval) before the stream ends.
const MAX_FAILURES: u32 = 20;

pub enum Source {
    /// A transcript file chosen by the caller, as `transcript --view conversation` reads it.
    Path(PathBuf),
    /// A provider session id resolved inside the agent's own data root, as `herdr-conversation`.
    Session(String),
}

pub struct Options {
    pub agent: TranscriptAgent,
    pub path: Option<PathBuf>,
    pub session_id: Option<String>,
    pub limit: u8,
    pub interval: Duration,
}

struct Entry {
    id: String,
    rev: u64,
    message: Value,
}

#[derive(Clone, Copy, PartialEq)]
struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
    identity: Option<(u64, u64)>,
}

impl Fingerprint {
    fn of(file: &File) -> Result<Self> {
        let metadata = file.metadata()?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            Some((metadata.dev(), metadata.ino()))
        };
        #[cfg(not(unix))]
        let identity = None;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            identity,
        })
    }
}

pub struct Watcher {
    agent: TranscriptAgent,
    source: Source,
    limit: u8,
    generation: u64,
    sequence: u64,
    entries: Vec<Entry>,
    activity: Option<&'static str>,
    seen: Option<Fingerprint>,
    located: Option<PathBuf>,
    /// Duration of the last projection; the next check waits at least three times as long.
    cost: Duration,
}

fn upsert(entry: &Entry) -> Value {
    json!({"id":entry.id,"rev":entry.rev,"message":entry.message})
}

/// How many entries left the head of the window when `incoming` is the old window shifted by that
/// many plus new entries at the tail. `None` when the order changed in any other way.
fn evicted(old: &[Entry], incoming: &[(String, Value)]) -> Option<usize> {
    (0..=old.len()).find(|&dropped| {
        let kept = &old[dropped..];
        (!kept.is_empty() || old.is_empty())
            && incoming.len() >= kept.len()
            && kept
                .iter()
                .zip(incoming)
                .all(|(old, (id, _))| old.id == *id)
            && incoming[kept.len()..]
                .iter()
                .all(|(id, _)| old.iter().all(|old| old.id != *id))
    })
}

impl Watcher {
    pub fn new(agent: TranscriptAgent, source: Source, limit: u8) -> Result<Self> {
        if !matches!(agent, TranscriptAgent::Claude | TranscriptAgent::Codex)
            || !(1..=100).contains(&limit)
        {
            return Err(Error::InvalidArgument);
        }
        Ok(Self {
            agent,
            source,
            limit,
            generation: 0,
            sequence: 0,
            entries: Vec::new(),
            activity: None,
            seen: None,
            located: None,
            cost: Duration::ZERO,
        })
    }

    fn fingerprint(&mut self) -> Result<Fingerprint> {
        let path = match (&self.source, &self.located) {
            (Source::Path(path), _) | (Source::Session(_), Some(path)) => path.clone(),
            (Source::Session(id), None) => {
                let path = herdr_session::locate(self.agent, id)?;
                self.located = Some(path.clone());
                path
            }
        };
        let result = super::open_transcript(&path).and_then(|file| Fingerprint::of(&file));
        if result.is_err() {
            // The session file may have been replaced: resolve it again on the next check.
            self.located = None;
        }
        result
    }

    fn project(&self) -> Result<TranscriptPage> {
        match &self.source {
            Source::Path(path) => super::conversation(path, self.agent, self.limit),
            Source::Session(id) => {
                herdr_session::read_herdr_conversation(self.agent, id, self.limit)
            }
        }
    }

    /// Frames for what changed since the last call; empty when nothing did.
    pub fn poll(&mut self) -> Result<Vec<Value>> {
        let seen = self.fingerprint()?;
        if self.seen == Some(seen) {
            return Ok(Vec::new());
        }
        let started = Instant::now();
        let page = self.project()?;
        self.cost = started.elapsed();
        // A replaced or shrunk file is a rewrite, never an append.
        let rewritten = self
            .seen
            .is_some_and(|old| old.identity != seen.identity || seen.len < old.len);
        self.seen = Some(seen);
        Ok(self.diff(page, rewritten))
    }

    fn diff(&mut self, page: TranscriptPage, rewritten: bool) -> Vec<Value> {
        // The last message with an id wins, in the position of the first, as the polling reader does.
        let mut incoming: Vec<(String, Value)> = Vec::new();
        let mut at: HashMap<String, usize> = HashMap::new();
        for message in page.messages {
            let id = message["id"].as_str().unwrap_or_default().to_owned();
            match at.get(&id) {
                Some(&index) => incoming[index].1 = message,
                None => {
                    at.insert(id.clone(), incoming.len());
                    incoming.push((id, message));
                }
            }
        }
        let activity_changed = self.activity != page.activity;
        self.activity = page.activity;
        let dropped = if rewritten || self.generation == 0 {
            None
        } else {
            evicted(&self.entries, &incoming)
        };
        let old = std::mem::take(&mut self.entries);
        let mut upserts = Vec::new();
        let mut entries = Vec::with_capacity(incoming.len());
        let previous: HashMap<&str, &Entry> =
            old.iter().map(|entry| (entry.id.as_str(), entry)).collect();
        for (id, message) in incoming {
            let rev = match previous.get(id.as_str()) {
                Some(entry) if entry.message == message => {
                    entries.push(Entry {
                        id,
                        rev: entry.rev,
                        message,
                    });
                    continue;
                }
                Some(entry) => entry.rev + 1,
                None => 1,
            };
            entries.push(Entry { id, rev, message });
            upserts.push(entries.len() - 1);
        }
        let drops: Vec<&str> = dropped.map_or_else(Vec::new, |count| {
            old[..count].iter().map(|entry| entry.id.as_str()).collect()
        });
        let frame = if dropped.is_none() {
            self.generation += 1;
            self.sequence += 1;
            Some(json!({
                "type":"snapshot","gen":self.generation,"seq":self.sequence,
                "entries":entries.iter().map(upsert).collect::<Vec<_>>(),
                "activity":self.activity,"branchId":page.branch_id,"truncated":page.truncated,
            }))
        } else if !upserts.is_empty() || !drops.is_empty() || activity_changed {
            self.sequence += 1;
            let mut frame = json!({
                "type":"delta","gen":self.generation,"seq":self.sequence,
                "upserts":upserts.iter().map(|index| upsert(&entries[*index])).collect::<Vec<_>>(),
                "drops":drops,
            });
            if activity_changed {
                frame["activity"] = json!(self.activity);
            }
            Some(frame)
        } else {
            None
        };
        self.entries = entries;
        frame.into_iter().collect()
    }
}

fn write_frame(out: &mut impl Write, frame: &Value) -> Result<()> {
    let mut line = serde_json::to_vec(frame).map_err(|_| Error::InvalidEvent)?;
    if line.len() > MAX_FRAME {
        return Err(Error::InvalidEvent);
    }
    line.push(b'\n');
    out.write_all(&line)?;
    out.flush()?;
    Ok(())
}

/// Emit frames until `closed` fires or disconnects, the output breaks, or the source fails for
/// good: at once when nothing has been read yet, after `MAX_FAILURES` checks otherwise.
pub fn run(
    mut watcher: Watcher,
    interval: Duration,
    out: &mut impl Write,
    closed: &Receiver<()>,
) -> Result<()> {
    write_frame(
        out,
        &json!({"type":"hello","protocol":PROTOCOL,"agent":watcher.agent,"intervalMs":interval.as_millis() as u64,
            "limit":watcher.limit,"companion":env!("CARGO_PKG_VERSION")}),
    )?;
    let (mut failures, mut quiet) = (0, Instant::now());
    loop {
        match watcher.poll() {
            Ok(frames) => {
                failures = 0;
                for frame in &frames {
                    write_frame(out, frame)?;
                    quiet = Instant::now();
                }
            }
            Err(error) => {
                failures += 1;
                if watcher.sequence == 0 || failures >= MAX_FAILURES {
                    write_frame(out, &json!({"type":"end","reason":error.class()}))?;
                    return Err(error);
                }
            }
        }
        if quiet.elapsed() >= HEARTBEAT {
            write_frame(out, &json!({"type":"heartbeat"}))?;
            quiet = Instant::now();
        }
        if !matches!(
            closed.recv_timeout(interval.max(watcher.cost * 3)),
            Err(RecvTimeoutError::Timeout)
        ) {
            return Ok(());
        }
    }
}

/// The command entry point: stdout carries the frames and a closed stdin (the SSH channel going
/// away) ends the watch.
pub fn run_stdio(options: Options) -> Result<()> {
    let source = match (options.path, options.session_id) {
        (Some(path), None) => Source::Path(path),
        (None, Some(id)) => Source::Session(id),
        _ => return Err(Error::InvalidArgument),
    };
    let watcher = Watcher::new(options.agent, source, options.limit)?;
    let (closed_tx, closed) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0; 64];
        let mut stdin = std::io::stdin();
        while matches!(stdin.read(&mut buffer), Ok(count) if count > 0) {}
        drop(closed_tx);
    });
    run(
        watcher,
        options.interval,
        &mut std::io::stdout().lock(),
        &closed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    fn record(id: &str, parent: Option<&str>, role: &str, text: &str) -> String {
        format!(
            "{}\n",
            json!({"type":role,"uuid":id,"parentUuid":parent,"message":{"content":text}})
        )
    }
    /// `count` alternating user and assistant records chained in order.
    fn chain(count: usize) -> String {
        (0..count)
            .map(|index| {
                record(
                    &format!("m{index}"),
                    index.checked_sub(1).map(|p| format!("m{p}")).as_deref(),
                    if index % 2 == 0 { "user" } else { "assistant" },
                    &format!("text {index}"),
                )
            })
            .collect()
    }
    fn watcher(path: &Path, limit: u8) -> Watcher {
        Watcher::new(TranscriptAgent::Claude, Source::Path(path.into()), limit).unwrap()
    }
    fn ids(frame: &Value, key: &str) -> Vec<String> {
        frame[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                entry
                    .as_str()
                    .map_or_else(|| entry["id"].as_str().unwrap().into(), String::from)
            })
            .collect()
    }
    fn fixture(content: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        fs::write(&path, content).unwrap();
        (directory, path)
    }
    fn append(path: &Path, text: &str) {
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn append_sends_only_the_new_entry_and_an_unchanged_file_sends_nothing() {
        let (_directory, path) = fixture(&chain(2));
        let mut watch = watcher(&path, 50);
        let first = watch.poll().unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["type"], "snapshot");
        assert_eq!(
            (first[0]["gen"].as_u64(), first[0]["seq"].as_u64()),
            (Some(1), Some(1))
        );
        assert_eq!(ids(&first[0], "entries"), ["m0", "m1"]);
        assert!(watch.poll().unwrap().is_empty());
        append(&path, &record("m2", Some("m1"), "user", "next"));
        let next = watch.poll().unwrap();
        assert_eq!(next[0]["type"], "delta");
        assert_eq!(
            (next[0]["gen"].as_u64(), next[0]["seq"].as_u64()),
            (Some(1), Some(2))
        );
        assert_eq!(ids(&next[0], "upserts"), ["m2"]);
        assert_eq!(next[0]["upserts"][0]["rev"], 1);
        assert!(next[0]["drops"].as_array().unwrap().is_empty());
        assert!(watch.poll().unwrap().is_empty());
    }

    #[test]
    fn a_rewritten_record_keeps_its_id_and_raises_its_rev_in_place() {
        let (_directory, path) = fixture(&chain(3));
        let mut watch = watcher(&path, 50);
        watch.poll().unwrap();
        // Claude Code can record the same uuid again with newer content; the order is unchanged.
        append(&path, &record("m1", Some("m0"), "assistant", "revised"));
        let frame = &watch.poll().unwrap()[0];
        assert_eq!(
            (frame["type"].as_str(), frame["gen"].as_u64()),
            (Some("delta"), Some(1))
        );
        assert_eq!(ids(frame, "upserts"), ["m1"]);
        assert_eq!(frame["upserts"][0]["rev"], 2);
        assert_eq!(
            frame["upserts"][0]["message"]["blocks"][0]["text"],
            "revised"
        );
    }

    #[test]
    fn window_is_bounded_and_the_head_is_dropped_explicitly() {
        let (_directory, path) = fixture(&chain(3));
        let mut watch = watcher(&path, 3);
        watch.poll().unwrap();
        append(&path, &record("m3", Some("m2"), "assistant", "four"));
        let frame = &watch.poll().unwrap()[0];
        assert_eq!(frame["type"], "delta");
        assert_eq!(ids(frame, "drops"), ["m0"]);
        assert_eq!(ids(frame, "upserts"), ["m3"]);
        let (_directory, path) = fixture(&chain(300));
        let mut watch = watcher(&path, 5);
        assert_eq!(
            watch.poll().unwrap()[0]["entries"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(watch.entries.len(), 5);
    }

    #[test]
    fn truncation_and_rotation_rebuild_with_a_new_generation() {
        let (directory, path) = fixture(&chain(4));
        let mut watch = watcher(&path, 50);
        watch.poll().unwrap();
        fs::write(&path, chain(2)).unwrap();
        let shrunk = watch.poll().unwrap();
        assert_eq!(
            (shrunk[0]["type"].as_str(), shrunk[0]["gen"].as_u64()),
            (Some("snapshot"), Some(2))
        );
        assert_eq!(ids(&shrunk[0], "entries"), ["m0", "m1"]);
        // A different file of the same size and a newer message at the same path.
        fs::rename(&path, directory.path().join("old.jsonl")).unwrap();
        fs::write(&path, chain(2).replace("text 1", "text X")).unwrap();
        let rotated = watch.poll().unwrap();
        assert_eq!(
            (rotated[0]["type"].as_str(), rotated[0]["gen"].as_u64()),
            (Some("snapshot"), Some(3))
        );
        assert_eq!(
            rotated[0]["entries"][1]["message"]["blocks"][0]["text"],
            "text X"
        );
        assert_eq!(rotated[0]["seq"], 3);
    }

    #[test]
    fn a_partial_last_line_waits_for_its_newline() {
        let (_directory, path) = fixture(&chain(1));
        let mut watch = watcher(&path, 50);
        watch.poll().unwrap();
        let full = record("m1", Some("m0"), "assistant", "complete");
        let (head, tail) = full.split_at(full.len() / 2);
        append(&path, head);
        assert!(watch.poll().unwrap().is_empty());
        append(&path, tail);
        let frame = &watch.poll().unwrap()[0];
        assert_eq!(ids(frame, "upserts"), ["m1"]);
        assert_eq!(
            frame["upserts"][0]["message"]["blocks"][0]["text"],
            "complete"
        );
    }

    #[test]
    fn activity_change_alone_is_sent_and_a_large_file_is_one_bounded_snapshot() {
        let (_directory, path) = fixture(&chain(2));
        let mut watch = watcher(&path, 50);
        assert_eq!(watch.poll().unwrap()[0]["activity"], Value::Null);
        append(
            &path,
            &(record("m2", Some("m1"), "user", "go")
                + &json!({"type":"system","subtype":"turn_duration","uuid":"s1","parentUuid":"m2"})
                    .to_string() + "\n"),
        );
        let frame = &watch.poll().unwrap()[0];
        assert_eq!(frame["activity"], "idle");
        let big = "x".repeat(2000);
        let content: String = (0..1500usize)
            .map(|index| {
                record(
                    &format!("b{index}"),
                    index.checked_sub(1).map(|p| format!("b{p}")).as_deref(),
                    "user",
                    &big,
                )
            })
            .collect();
        let (_directory, path) = fixture(&content);
        assert!(fs::metadata(&path).unwrap().len() > 3_000_000);
        let frames = watcher(&path, 100).poll().unwrap();
        assert!(serde_json::to_vec(&frames[0]).unwrap().len() < MAX_FRAME);
        assert!(frames[0]["entries"].as_array().unwrap().len() <= 100);
    }

    #[test]
    fn an_unreadable_source_ends_at_once_and_a_stuck_one_after_the_retry_budget() {
        let directory = tempfile::tempdir().unwrap();
        let (_tx, closed) = mpsc::channel();
        let mut out = Vec::new();
        let missing = watcher(&directory.path().join("gone.jsonl"), 50);
        assert!(run(missing, Duration::from_millis(1), &mut out, &closed).is_err());
        let lines = String::from_utf8(out).unwrap();
        assert_eq!(lines.lines().count(), 2);
        assert!(lines.lines().next().unwrap().contains("\"hello\""));
        assert!(lines.lines().last().unwrap().contains("\"end\""));
        // The file turns unreadable right after the first frames went out.
        struct Corrupting(Vec<u8>, PathBuf);
        impl Write for Corrupting {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.0.contains(&b'\n') {
                    fs::write(&self.1, "{ not json\n")?;
                }
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (_directory, path) = fixture(&chain(2));
        let mut out = Corrupting(Vec::new(), path.clone());
        assert!(run(
            watcher(&path, 50),
            Duration::from_millis(1),
            &mut out,
            &closed
        )
        .is_err());
        let lines: Vec<Value> = String::from_utf8(out.0)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["type"], "hello");
        assert_eq!(lines[1]["type"], "snapshot");
        assert_eq!(
            lines.last().unwrap(),
            &json!({"type":"end","reason":"InvalidEvent"})
        );
    }

    #[test]
    fn only_claude_and_codex_sources_with_a_valid_limit_are_watched() {
        let path = || Source::Path("x".into());
        assert!(Watcher::new(TranscriptAgent::Pi, path(), 50).is_err());
        assert!(Watcher::new(TranscriptAgent::Claude, path(), 0).is_err());
        assert!(Watcher::new(TranscriptAgent::Codex, path(), 100).is_ok());
    }
}
