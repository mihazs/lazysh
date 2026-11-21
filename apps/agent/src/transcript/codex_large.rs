//! Bounded projection of a fully validated large Codex rollout.
use super::{Error, Result, SourceSnapshot};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::File,
    io::{BufReader, Read},
};

const MAX_SOURCE: u64 = 1024 * 1024 * 1024;
const MAX_RECORD: u64 = 16 * 1024 * 1024;
const MAX_RETAINED: usize = 8 * 1024 * 1024;
const MAX_RECORDS: usize = 100_000;

pub(super) struct Capture {
    pub records: Vec<(u64, Value)>,
    pub digest: [u8; 32],
    pub offset: u64,
    pub count: usize,
    pub omitted: bool,
}

/// Scan the captured prefix, validating every complete JSON record and ordinal while keeping
/// only a bounded suffix. No record from an unverified source may be projected.
pub(super) fn capture(
    file: &mut File,
    before: &SourceSnapshot,
    end: u64,
    require_complete: bool,
) -> Result<Capture> {
    if before.len() > MAX_SOURCE {
        return Err(Error::TooLarge);
    }
    if end == 0 || end > before.len() {
        return Err(Error::InvalidEvent);
    }
    let mut reader = BufReader::new(file.take(before.len()));
    let mut hash = Sha256::new();
    let mut offset = 0;
    let mut complete = 0;
    let mut count = 0;
    let mut previous = None;
    let mut header = None;
    let mut retained = VecDeque::new();
    let mut retained_bytes = 0usize;
    let mut omitted = false;
    let mut paginated = false;
    while offset < end {
        let line =
            super::read_record_line_bounded(&mut reader.by_ref().take(end - offset), MAX_RECORD)
                .map_err(|error| {
                    if matches!(error, Error::InvalidEvent) {
                        Error::TooLarge
                    } else {
                        error
                    }
                })?;
        if line.is_empty() {
            return Err(Error::InvalidEvent);
        }
        hash.update(&line);
        let start = offset;
        offset += line.len() as u64;
        if line.last() != Some(&b'\n') {
            break;
        }
        complete = offset;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value = super::codex_lineage::decode_record(&line)?;
        if header.is_none() {
            if value["type"] != "session_meta" {
                return Err(Error::InvalidEvent);
            }
            paginated = value["payload"]["history_mode"] == "paginated";
            header = Some((start, value.clone()));
        }
        count += 1;
        if count > MAX_RECORDS {
            return Err(Error::TooLarge);
        }
        super::codex_lineage::check_ordinal(&value, &mut previous, paginated)?;
        if count == 1 {
            continue;
        }
        if line.len() > MAX_RETAINED {
            retained.clear();
            retained_bytes = line.len();
            retained.push_back((start, value, line.len()));
            omitted = true;
            continue;
        }
        retained_bytes += line.len();
        retained.push_back((start, value, line.len()));
        while retained_bytes > MAX_RETAINED {
            let (_, _, size) = retained.pop_front().ok_or(Error::InvalidEvent)?;
            retained_bytes -= size;
            omitted = true;
        }
    }
    if offset != end || (require_complete && complete != end) {
        return Err(Error::InvalidEvent);
    }
    let mut rest = [0u8; 8192];
    loop {
        let n = reader.read(&mut rest)?;
        if n == 0 {
            break;
        }
        hash.update(&rest[..n]);
    }
    if reader.get_ref().limit() != 0 {
        return Err(Error::InvalidEvent);
    }
    let mut records = vec![header.ok_or(Error::InvalidEvent)?];
    records.extend(
        retained
            .into_iter()
            .map(|(offset, value, _)| (offset, value)),
    );
    Ok(Capture {
        records,
        digest: hash.finalize().into(),
        offset: complete,
        count,
        omitted,
    })
}

/// The selected name must still be the same file and the entire captured prefix unchanged;
/// appends beyond that prefix are permitted.
pub(super) fn verify(mut file: File, before: &SourceSnapshot, expected: &[u8; 32]) -> Result<()> {
    before.same_file(&file)?;
    if file.metadata()?.len() < before.len() {
        return Err(Error::InvalidEvent);
    }
    let mut hash = Sha256::new();
    let mut reader = (&mut file).take(before.len());
    let mut bytes = [0u8; 8192];
    loop {
        let n = reader.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    let actual: [u8; 32] = hash.finalize().into();
    if reader.limit() != 0 || &actual != expected {
        return Err(Error::InvalidEvent);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn verification_accepts_append_but_rejects_rewrite_and_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("owned.jsonl");
        std::fs::write(&path, b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"11111111-1111-4111-8111-111111111111\"}}\n").unwrap();
        let mut file = File::open(&path).unwrap();
        let snapshot = SourceSnapshot::capture(&file).unwrap();
        let captured = capture(&mut file, &snapshot, snapshot.len(), false).unwrap();
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap(),
            "{{}}"
        )
        .unwrap();
        verify(File::open(&path).unwrap(), &snapshot, &captured.digest).unwrap();
        std::fs::write(&path, vec![b'x'; snapshot.len() as usize]).unwrap();
        assert!(verify(File::open(&path).unwrap(), &snapshot, &captured.digest).is_err());
        std::fs::rename(&path, dir.path().join("old.jsonl")).unwrap();
        std::fs::write(&path, vec![b'x'; snapshot.len() as usize]).unwrap();
        assert!(verify(File::open(&path).unwrap(), &snapshot, &captured.digest).is_err());
    }
}
