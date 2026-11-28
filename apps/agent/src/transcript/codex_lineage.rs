//! Read-only bounded rollout prefixes. JSON supplies IDs and cutoffs, never paths.
use super::{conversation, open_transcript, Error, Result, SourceSnapshot, MAX_RECORD};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{BufReader, Cursor, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECORDS: usize = 100_000;
const MAX_SOURCES: usize = 16;
/// Projection tracks turns linearly; cap the opt-in suffix to bound worst-case work.
const MAX_RETAINED_RECORDS: usize = 2_000;

pub(super) fn decode_record(line: &[u8]) -> Result<Value> {
    let value: Value = serde_json::from_slice(line).map_err(|_| Error::InvalidEvent)?;
    if !value.is_object() {
        return Err(Error::InvalidEvent);
    }
    Ok(value)
}

pub(super) fn check_ordinal(
    value: &Value,
    previous: &mut Option<u64>,
    required: bool,
) -> Result<()> {
    if let Some(n) = value["ordinal"].as_u64() {
        if previous.is_some_and(|p| p.checked_add(1) != Some(n)) {
            return Err(Error::InvalidEvent);
        }
        *previous = Some(n);
    } else if required {
        return Err(Error::InvalidEvent);
    }
    Ok(())
}

struct ListEntry {
    name: std::ffi::OsString,
    is_dir: bool,
    is_file: bool,
    is_symlink: bool,
}

enum SourceAccess {
    Path,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    Anchored {
        root: PathBuf,
        directory: crate::managed_directory::Directory,
    },
}
impl SourceAccess {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn parent(&self, path: &Path) -> Result<(crate::managed_directory::Directory, String)> {
        let Self::Anchored { root, directory } = self else {
            return Err(Error::InvalidArgument);
        };
        let relative = path
            .strip_prefix(root)
            .map_err(|_| Error::InvalidArgument)?;
        let leaf = relative
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(Error::InvalidArgument)?
            .to_owned();
        let current = directory.child_or_self(relative.parent().ok_or(Error::InvalidArgument)?)?;
        current.check()?;
        Ok((current, leaf))
    }
    fn file(&self, path: &Path) -> Result<std::fs::File> {
        match self {
            Self::Path => open_transcript(path),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            Self::Anchored { .. } => {
                let (directory, leaf) = self.parent(path)?;
                let file = directory.open_file(&leaf, libc::O_RDONLY)?;
                let metadata = file.metadata()?;
                if !metadata.is_file() {
                    return Err(Error::InvalidArgument);
                }
                super::check_owner(&metadata)?;
                Ok(file)
            }
        }
    }
    fn entries(&self, path: &Path) -> Result<Box<dyn Iterator<Item = std::io::Result<ListEntry>>>> {
        match self {
            Self::Path => Ok(Box::new(fs::read_dir(path)?.map(|entry| {
                let entry = entry?;
                let kind = entry.file_type()?;
                Ok(ListEntry {
                    name: entry.file_name(),
                    is_dir: kind.is_dir(),
                    is_file: kind.is_file(),
                    is_symlink: kind.is_symlink(),
                })
            }))),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            Self::Anchored { .. } => Ok(Box::new(
                super::anchored_listing::Listing::new(&self.directory(path)?)?.map(|entry| {
                    entry.map(|entry| ListEntry {
                        name: entry.name,
                        is_dir: entry.is_dir,
                        is_file: entry.is_file,
                        is_symlink: entry.is_symlink,
                    })
                }),
            )),
        }
    }
    fn directory(&self, path: &Path) -> Result<std::fs::File> {
        match self {
            Self::Path => open_directory(path),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            Self::Anchored { root, directory } => {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| Error::InvalidArgument)?;
                Ok(directory.child_or_self(relative)?.file)
            }
        }
    }
}

pub(super) struct Record {
    pub value: Value,
    pub key: String,
    pub thread: String,
}
pub(super) struct History {
    pub records: Vec<Record>,
    pub thread: String,
    pub mode: String,
    pub offset: u64,
    sources: Vec<Source>,
    directories: Vec<(PathBuf, SourceSnapshot)>,
    scanned: usize,
    access: SourceAccess,
    requires_index: bool,
    selected_start: Option<u64>,
    pub indexed: Option<super::codex_conversation::index::IndexResult>,
}
struct Source {
    path: PathBuf,
    snapshot: SourceSnapshot,
    bytes: Option<Vec<u8>>,
    digest: Option<[u8; 32]>,
    end: u64,
    thread: String,
    start: Option<u64>,
}
impl History {
    /// Re-read one indexed record through the captured source authority. `verify` must
    /// still run after all indexed records have been materialized.
    pub fn read_indexed_record(&self, key: &str, expected: &[u8; 32]) -> Result<Value> {
        let (physical, position) = key.rsplit_once(':').ok_or(Error::InvalidEvent)?;
        let offset: u64 = position.parse().map_err(|_| Error::InvalidEvent)?;
        let mut matches = self.sources.iter().filter(|source| {
            source
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&source.thread)
                == physical
        });
        let source = matches.next().ok_or(Error::InvalidEvent)?;
        if matches.next().is_some() || offset >= source.end {
            return Err(Error::InvalidEvent);
        }
        let mut file = self.access.file(&source.path)?;
        source.snapshot.same_file(&file)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::new(file.take(source.end - offset));
        let line = super::read_record_line_bounded(&mut reader, MAX_RECORD)?;
        if line.last() != Some(&b'\n') {
            return Err(Error::InvalidEvent);
        }
        let actual: [u8; 32] = Sha256::digest(&line).into();
        if &actual != expected {
            return Err(Error::InvalidEvent);
        }
        decode_record(&line)
    }
    /// Validate the logical lineage in projection order, including records omitted from
    /// the retained tail. Captured source verification follows this pass.
    fn validate_full_stream(
        &self,
        images: bool,
    ) -> Result<super::codex_conversation::index::IndexResult> {
        let mut index = super::codex_conversation::index::Index::default();
        for source in self.sources.iter().rev() {
            let file = self.access.file(&source.path)?;
            source.snapshot.same_file(&file)?;
            let mut reader = BufReader::new(file.take(source.snapshot.len()));
            let mut digest = Sha256::new();
            let physical = source
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&source.thread);
            let mut offset = 0u64;
            while offset < source.end {
                let line = super::read_record_line_bounded(
                    &mut reader.by_ref().take(source.end - offset),
                    MAX_RECORD,
                )?;
                if line.is_empty() {
                    return Err(Error::InvalidEvent);
                }
                digest.update(&line);
                let start = offset;
                offset += line.len() as u64;
                if line.last() != Some(&b'\n') {
                    break;
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let value: Value =
                    serde_json::from_slice(&line).map_err(|_| Error::InvalidEvent)?;
                let ordinal = value["ordinal"].as_u64();
                if source
                    .start
                    .is_some_and(|min| ordinal.is_some_and(|n| n < min))
                {
                    continue;
                }
                if self
                    .selected_start
                    .is_some_and(|min| ordinal.is_none_or(|n| n < min))
                {
                    continue;
                }
                let key = format!("{physical}:{start}");
                let record_hash = Sha256::digest(&line).into();
                index.observe(
                    &value,
                    &source.thread,
                    self.mode == "paginated",
                    &key,
                    images,
                    record_hash,
                )?;
            }
            let mut chunk = [0u8; 8192];
            loop {
                let n = reader.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                digest.update(&chunk[..n]);
            }
            let actual: [u8; 32] = digest.finalize().into();
            let expected = match (&source.bytes, source.digest) {
                (Some(bytes), None) => Sha256::digest(bytes).into(),
                (None, Some(digest)) => digest,
                _ => return Err(Error::InvalidEvent),
            };
            if reader.get_ref().limit() != 0 || actual != expected {
                return Err(Error::InvalidEvent);
            }
            source
                .snapshot
                .same_file(&self.access.file(&source.path)?)?;
        }
        Ok(index.finish())
    }
    pub fn verify(&self) -> Result<()> {
        for (path, before) in &self.directories {
            before.same_file(&self.access.directory(path)?)?;
        }
        for source in &self.sources {
            if let Some(bytes) = &source.bytes {
                conversation::verify_captured_with(
                    &|| self.access.file(&source.path),
                    &source.snapshot,
                    bytes,
                )?;
            } else {
                super::codex_large::verify(
                    self.access.file(&source.path)?,
                    &source.snapshot,
                    source.digest.as_ref().ok_or(Error::InvalidEvent)?,
                )?;
                source
                    .snapshot
                    .same_file(&self.access.file(&source.path)?)?;
            }
        }
        Ok(())
    }
}

pub(super) fn read(path: &Path) -> Result<History> {
    read_with(path, SourceAccess::Path, false, false)
}
pub(super) fn read_large(path: &Path, images: bool) -> Result<History> {
    read_with(path, SourceAccess::Path, true, images)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn read_anchored(
    directory: &crate::managed_directory::Directory,
    path: &Path,
    expected: &SourceSnapshot,
    allow_large: bool,
) -> Result<History> {
    let root = directory.path.clone();
    let directory = directory.child_or_self(Path::new(""))?;
    let history = read_with(
        path,
        SourceAccess::Anchored { root, directory },
        allow_large,
        false,
    )?;
    let selected = history
        .sources
        .iter()
        .find(|source| source.path == path)
        .ok_or(Error::InvalidEvent)?;
    expected.same_snapshot(&selected.snapshot)?;
    Ok(history)
}

fn read_with(
    path: &Path,
    access: SourceAccess,
    allow_large: bool,
    images: bool,
) -> Result<History> {
    let mut history = History {
        records: Vec::new(),
        thread: String::new(),
        mode: String::new(),
        offset: 0,
        sources: Vec::new(),
        directories: Vec::new(),
        scanned: 0,
        access,
        requires_index: false,
        selected_start: None,
        indexed: None,
    };
    let mut visited = HashSet::new();
    load(path, None, &mut history, &mut visited, &mut 0, allow_large)?;
    if history.requires_index {
        history.indexed = Some(history.validate_full_stream(images)?);
        history.requires_index = false;
    }
    history.verify()?;
    Ok(history)
}

// The selected file is explicit. Only its recognizable sessions/archive tree can
// supply referenced prefixes; an arbitrary exported JSONL cannot expand its scope.
fn home(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(Error::InvalidArgument);
    }

    let root = path
        .ancestors()
        .skip(1)
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n == "sessions" || n == "archived_sessions")
        })
        .ok_or(Error::InvalidArgument)?;
    if !fs::canonicalize(path)?.starts_with(fs::canonicalize(root)?) {
        return Err(Error::InvalidArgument);
    }
    let home = root.parent().ok_or(Error::InvalidArgument)?;
    for directory in path.parent().ok_or(Error::InvalidArgument)?.ancestors() {
        directory_owned(directory)?;
        if directory == home {
            return Ok(home.to_owned());
        }
    }
    Err(Error::InvalidArgument)
}
fn directory_owned(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::InvalidArgument);
    }
    super::check_owner(&metadata)?;
    Ok(())
}

fn open_directory(path: &Path) -> Result<std::fs::File> {
    directory_owned(path)?;
    let options = lazysh_common::fs::read_options(false);
    #[cfg(windows)]
    let mut options = options;
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_dir() {
        return Err(Error::InvalidEvent);
    }
    Ok(file)
}
fn qualify_tree(path: &Path, history: &mut History) -> Result<()> {
    let home = home(path)?;
    for directory in path.parent().ok_or(Error::InvalidArgument)?.ancestors() {
        if !history
            .directories
            .iter()
            .any(|(path, _)| path == directory)
        {
            if history.directories.len() >= MAX_SOURCES * 5 {
                return Err(Error::InvalidArgument);
            }
            let source = history.access.directory(directory)?;
            history
                .directories
                .push((directory.to_owned(), SourceSnapshot::capture(&source)?));
        }
        if directory == home {
            break;
        }
    }
    Ok(())
}
fn uuid(value: &Value) -> Result<String> {
    let text = value.as_str().ok_or(Error::InvalidEvent)?;
    let id = uuid::Uuid::parse_str(text).map_err(|_| Error::InvalidEvent)?;
    if id.to_string() != text {
        return Err(Error::InvalidEvent);
    }
    Ok(text.to_owned())
}
fn referenced(selected: &Path, id: &str, access: &SourceAccess) -> Result<PathBuf> {
    let home = home(selected)?;
    let mut pending = Vec::new();
    for name in ["sessions", "archived_sessions"] {
        let path = home.join(name);
        if path.try_exists()? {
            directory_owned(&path)?;
            pending.push((path, 0));
        }
    }
    let mut found = None;
    let mut examined = 0;
    while let Some((directory, depth)) = pending.pop() {
        directory_owned(&directory)?;
        for entry in access.entries(&directory)? {
            examined += 1;
            if examined > MAX_RECORDS {
                return Err(Error::InvalidArgument);
            }
            let entry = entry?;
            if entry.is_symlink {
                continue;
            }
            let filename = entry.name;
            let logical_path = directory.join(&filename);
            let name = filename.to_string_lossy();
            if entry.is_dir && depth < 3 && name.bytes().all(|n| n.is_ascii_digit()) {
                directory_owned(&logical_path)?;
                pending.push((logical_path, depth + 1));
            } else if entry.is_file
                && name.starts_with("rollout-")
                && name.ends_with(&format!("-{id}.jsonl"))
                && found.replace(logical_path).is_some()
            {
                return Err(Error::InvalidEvent);
            }
        }
    }
    found.ok_or(Error::InvalidEvent)
}

fn load(
    path: &Path,
    cutoff: Option<(u64, u64, String)>,
    history: &mut History,
    visited: &mut HashSet<PathBuf>,
    charged: &mut usize,
    allow_large: bool,
) -> Result<()> {
    if history.sources.len() >= MAX_SOURCES {
        return Err(Error::InvalidArgument);
    }
    let canonical = fs::canonicalize(path)?;
    if !visited.insert(canonical) {
        return Err(Error::InvalidEvent);
    }
    let mut original = history.access.file(path)?;
    let snapshot = SourceSnapshot::capture(&original)?;
    *charged = charged
        .checked_add(usize::try_from(snapshot.len()).map_err(|_| Error::TooLarge)?)
        .ok_or(Error::InvalidArgument)?;
    if *charged
        > if allow_large {
            1024 * 1024 * 1024
        } else {
            MAX_BYTES
        }
    {
        return Err(Error::TooLarge);
    }
    let length = cutoff
        .as_ref()
        .map_or(snapshot.len(), |(_, bytes, _)| *bytes);
    if length > snapshot.len() || length == 0 {
        return Err(Error::InvalidEvent);
    }
    let large = allow_large && snapshot.len() > MAX_BYTES as u64;
    let mut bytes = None;
    let mut digest = None;
    let mut records = Vec::new();
    let mut offset = 0;
    let mut meta = None;
    let mut previous = None;
    let mut omitted = false;
    if large {
        let captured =
            super::codex_large::capture(&mut original, &snapshot, length, cutoff.is_some())?;
        snapshot.same_file(&history.access.file(path)?)?;
        history.scanned = history
            .scanned
            .checked_add(captured.count)
            .ok_or(Error::TooLarge)?;
        if history.scanned > MAX_RECORDS {
            return Err(Error::TooLarge);
        }
        meta = captured
            .records
            .first()
            .map(|(_, value)| value["payload"].clone());
        previous = captured
            .records
            .last()
            .and_then(|(_, value)| value["ordinal"].as_u64());
        records = captured.records;
        offset = captured.offset;
        omitted = captured.omitted;
        digest = Some(captured.digest);
    } else {
        let captured = conversation::capture_with(|| history.access.file(path))?;
        snapshot.same_file(&history.access.file(path)?)?;
        let mut cursor = Cursor::new(&captured[..length as usize]);
        while offset < length {
            let line = super::read_record_line_bounded(&mut cursor, MAX_RECORD)?;
            if line.last() != Some(&b'\n') {
                if cutoff.is_some() {
                    return Err(Error::InvalidEvent);
                }
                break;
            }
            let start = offset;
            offset += line.len() as u64;
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let value = decode_record(&line)?;
            if meta.is_none() {
                if value["type"] != "session_meta" {
                    return Err(Error::InvalidEvent);
                }
                meta = Some(value["payload"].clone());
            }
            history.scanned += 1;
            if history.scanned > MAX_RECORDS {
                return Err(Error::TooLarge);
            }
            check_ordinal(&value, &mut previous, false)?;
            records.push((start, value));
        }
        bytes = Some(captured);
    }
    let meta = meta.ok_or(Error::InvalidEvent)?;
    let thread = uuid(&meta["id"])?;
    let mode = match meta.get("history_mode") {
        None => "legacy",
        Some(mode) => mode.as_str().ok_or(Error::InvalidEvent)?,
    };
    if cutoff.is_some() && mode != "paginated" {
        return Err(Error::InvalidEvent);
    }
    if meta
        .get("attached_thread")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(Error::InvalidEvent);
    }
    if meta
        .get("subagent_history_start_ordinal")
        .is_some_and(|value| !value.is_null() && value.as_u64().is_none())
    {
        return Err(Error::InvalidEvent);
    }
    if meta["attached_thread"] == true {
        return Err(Error::InvalidEvent);
    }
    if !matches!(mode, "legacy" | "paginated") {
        return Err(Error::InvalidEvent);
    }
    if mode == "paginated" && records.iter().any(|(_, r)| r["ordinal"].as_u64().is_none()) {
        return Err(Error::InvalidEvent);
    }
    if let Some((end, _, id)) = &cutoff {
        if *end == 0 || previous.and_then(|n| n.checked_add(1)) != Some(*end) {
            return Err(Error::InvalidEvent);
        }
        let suffix = format!("-{id}.jsonl");
        if !path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(&suffix))
        {
            return Err(Error::InvalidEvent);
        }
    } else {
        history.thread = thread.clone();
        history.mode = mode.to_owned();
        history.offset = offset;
    }
    if cutoff.is_some() || !meta["history_base"].is_null() {
        qualify_tree(path, history)?;
    }
    let physical = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&thread)
        .to_owned();
    let start = meta["subagent_history_start_ordinal"].as_u64();
    if cutoff.is_none() {
        history.selected_start = start;
    }
    history.sources.push(Source {
        path: path.to_owned(),
        snapshot,
        bytes,
        digest,
        end: length,
        thread: thread.clone(),
        start,
    });
    if !meta["history_base"].is_null() {
        if mode != "paginated" {
            return Err(Error::InvalidEvent);
        }
        let base = &meta["history_base"];
        let id = uuid(&base["thread_id"])?;
        let end = base["end_ordinal_exclusive"]
            .as_u64()
            .ok_or(Error::InvalidEvent)?;
        let length = base["end_byte_offset"]
            .as_u64()
            .ok_or(Error::InvalidEvent)?;
        if records.first().and_then(|(_, r)| r["ordinal"].as_u64()) != Some(end) {
            return Err(Error::InvalidEvent);
        }
        load(
            &referenced(path, &id, &history.access)?,
            Some((end, length, id)),
            history,
            visited,
            charged,
            allow_large,
        )?;
    } else if mode == "paginated"
        && records.first().and_then(|(_, r)| r["ordinal"].as_u64()) != Some(0)
    {
        return Err(Error::InvalidEvent);
    }
    if start.is_some_and(|start| previous.is_none_or(|last| last < start.saturating_sub(1))) {
        return Err(Error::InvalidEvent);
    }
    if omitted {
        history.records.clear();
        history.requires_index = true;
        if records
            .first()
            .is_some_and(|(_, value)| value["type"] == "session_meta")
        {
            records.remove(0);
        }
    }
    for (offset, value) in records {
        if start.is_some_and(|start| value["ordinal"].as_u64().is_some_and(|n| n < start)) {
            continue;
        }
        history.records.push(Record {
            value,
            key: format!("{physical}:{offset}"),
            thread: thread.clone(),
        });
        if history.records.len() > MAX_RECORDS {
            return Err(Error::TooLarge);
        }
    }
    if allow_large && (large || history.requires_index || *charged > MAX_BYTES) {
        let mut size = 0usize;
        let mut keep = history.records.len();
        for (index, record) in history.records.iter().enumerate().rev() {
            if history.records.len() - index > MAX_RETAINED_RECORDS {
                break;
            }
            let record_size = serde_json::to_vec(&record.value)
                .map_err(|_| Error::InvalidEvent)?
                .len();
            if size.saturating_add(record_size) > MAX_BYTES {
                break;
            }
            size += record_size;
            keep = index;
        }
        if keep > 0 {
            history.records.drain(..keep);
            history.requires_index = true;
        }
    }
    if cutoff.is_none() {
        if let Some(start) = start {
            history
                .records
                .retain(|record| record.value["ordinal"].as_u64().is_some_and(|n| n >= start));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn anchored_codex_source_rejects_a_replaced_parent() {
        use super::*;
        let home = tempfile::tempdir().unwrap();
        let base = home.path().canonicalize().unwrap();
        let sessions = base.join("sessions");
        let year = sessions.join("2026");
        let outside = base.join("outside");
        std::fs::create_dir_all(&year).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(year.join("rollout.jsonl"), b"original\n").unwrap();
        std::fs::write(outside.join("rollout.jsonl"), b"outside\n").unwrap();
        let access = SourceAccess::Anchored {
            root: base.clone(),
            directory: crate::managed_directory::Directory::profile(&base).unwrap(),
        };
        std::fs::rename(&year, sessions.join("retired")).unwrap();
        std::os::unix::fs::symlink(&outside, &year).unwrap();
        assert!(access.file(&year.join("rollout.jsonl")).is_err());
    }

    use super::*;
    use std::io::Write;

    #[test]
    fn stream_validation_rejects_different_bytes_even_if_original_is_restored_later() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.jsonl");
        let original = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"22222222-2222-4222-8222-222222222222\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"one\"}}\n";
        fs::write(&path, original).unwrap();
        let history = read(&path).unwrap();
        let offset = original.iter().position(|byte| *byte == b'\n').unwrap() + 1;
        let hash: [u8; 32] = Sha256::digest(&original[offset..]).into();
        let key = format!("selected.jsonl:{offset}");
        assert!(history.read_indexed_record(&key, &hash).is_ok());
        let changed = String::from_utf8(original.to_vec())
            .unwrap()
            .replace("one", "two");
        fs::write(&path, changed).unwrap();
        assert!(history.validate_full_stream(false).is_err());
        assert!(history.read_indexed_record(&key, &hash).is_err());
        fs::write(&path, original).unwrap();
        history.verify().unwrap();
    }

    #[test]
    fn every_retained_source_rejects_replacement_rewrite_and_truncation() {
        for change in ["replace", "rewrite", "truncate", "truncate-regrow"] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("selected.jsonl");
            let original = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"11111111-1111-4111-8111-111111111111\"}}\n";
            fs::write(&path, original).unwrap();
            let history = read(&path).unwrap();
            match change {
                "replace" => {
                    fs::rename(&path, directory.path().join("retired.jsonl")).unwrap();
                    fs::write(&path, original).unwrap();
                }
                "rewrite" => {
                    let mut bytes = original.to_vec();
                    bytes[20] = b'X';
                    fs::write(&path, bytes).unwrap();
                }
                "truncate" => fs::write(&path, b"{}").unwrap(),
                _ => fs::write(&path, vec![b' '; original.len() + 100]).unwrap(),
            }
            assert!(history.verify().is_err(), "accepted {change}");
        }
    }

    #[test]
    fn replacing_a_root_cannot_preserve_authority_with_the_same_file_inode() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("owned-codex");
        let path = home.join("sessions/2026/01/02/selected.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path,b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"33333333-3333-4333-8333-333333333333\"}}\n").unwrap();
        let mut history = read(&path).unwrap();
        qualify_tree(&path, &mut history).unwrap();
        let retired = directory.path().join("retired");
        if let Err(error) = fs::rename(&home, &retired) {
            #[cfg(windows)]
            {
                assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
                assert_eq!(error.raw_os_error(), Some(5));
                assert!(!retired.try_exists().unwrap());
                history.sources[0]
                    .snapshot
                    .same_file(&open_transcript(&path).unwrap())
                    .unwrap();
                history.verify().unwrap();
                return;
            }
            #[cfg(not(windows))]
            panic!("root replacement fixture could not rename its owned root: {error}");
        }
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::hard_link(retired.join("sessions/2026/01/02/selected.jsonl"), &path).unwrap();
        history.sources[0]
            .snapshot
            .same_file(&open_transcript(&path).unwrap())
            .unwrap();
        assert!(history.verify().is_err());
    }

    #[test]
    fn append_keeps_the_qualified_prefix_without_reading_a_new_tail() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.jsonl");
        fs::write(&path, b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"22222222-2222-4222-8222-222222222222\"}}\n").unwrap();
        let history = read(&path).unwrap();
        let retained = history.offset;
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"unparsed tail")
            .unwrap();
        history.verify().unwrap();
        assert_eq!(history.offset, retained);
        assert_eq!(history.records.len(), 1);
    }
}
