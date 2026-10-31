//! Read-only crash-state classification; it never resumes or rolls back a write.
use super::{
    json,
    record::{hash, Agent, FileState, Record},
};

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Observation {
    Prepared,
    Configured,
    Removed,
    Conflict,
}
pub(super) fn classify(
    record: &Record,
    current: &FileState,
    contents: Option<&str>,
) -> Result<Observation, &'static str> {
    record.validate()?;
    let current_hash = match (current, contents) {
        (FileState::Missing, None) => None,
        (FileState::Present { identity, sha256 }, Some(contents))
            if identity.bytes == contents.len() as u64 && sha256 == &hash(contents.as_bytes()) =>
        {
            Some(sha256.as_str())
        }
        _ => return Err("HooksChangedFile"),
    };
    if record.previous.is_none() && record.next.is_none() {
        return Ok(if current_hash == record.provider_after_sha256.as_deref() {
            Observation::Removed
        } else {
            Observation::Conflict
        });
    }
    if record.agent == Agent::Opencode {
        let old = record
            .previous
            .as_ref()
            .and_then(|owned| owned.plugin_sha256.as_deref());
        let new = record
            .next
            .as_ref()
            .and_then(|owned| owned.plugin_sha256.as_deref());
        return Ok(if current_hash == new {
            if new.is_some() {
                Observation::Configured
            } else {
                Observation::Removed
            }
        } else if current_hash == old && (old.is_some() || *current == record.provider_before) {
            Observation::Prepared
        } else {
            Observation::Conflict
        });
    }
    let previous = record
        .previous
        .as_ref()
        .map(|owned| owned.entries.as_slice())
        .unwrap_or_default();
    let next = record
        .next
        .as_ref()
        .map(|owned| owned.entries.as_slice())
        .unwrap_or_default();
    let text = contents.unwrap_or("{}\n");
    if *current == record.provider_before {
        let planned = json::rewrite(text, previous, next).map_err(|_| "HooksInvalidRecord")?;
        if record.provider_after_sha256.as_deref() != Some(hash(planned.as_bytes()).as_str()) {
            return Err("HooksInvalidRecord");
        }
        return Ok(if planned == text && record.next.is_some() {
            Observation::Configured
        } else {
            Observation::Prepared
        });
    }
    let next_counts = json::counts(text, next).map_err(|_| "HooksInvalidConfiguration")?;
    let obsolete = previous
        .iter()
        .filter(|entry| !next.contains(entry))
        .cloned()
        .collect::<Vec<_>>();
    let old_counts = json::counts(text, &obsolete).map_err(|_| "HooksInvalidConfiguration")?;
    if old_counts.iter().any(|count| *count > 0) {
        return Ok(Observation::Conflict);
    }
    if record.next.is_some() && next_counts.iter().all(|count| *count == 1) {
        return Ok(Observation::Configured);
    }
    // After removal, changed foreign contents cannot prove which transition happened.
    if record.next.is_none() && current_hash == record.provider_after_sha256.as_deref() {
        return Ok(Observation::Removed);
    }
    Ok(Observation::Conflict)
}
