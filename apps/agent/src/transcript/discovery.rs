use super::{Error, Result, TranscriptAgent};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub(super) schema_version: u8,
    pub(super) agent: TranscriptAgent,
    pub(super) sessions: Vec<DiscoveredSession>,
    pub(super) truncated: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscoveredSession {
    pub(super) path: String,
    pub(super) name: String,
    pub(super) modified_at: String,
    pub(super) bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_id: Option<String>,
    #[serde(skip)]
    pub(super) modified: SystemTime,
}

pub fn discover(agent: TranscriptAgent, root: Option<&Path>, limit: u8) -> Result<Discovery> {
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    if matches!(agent, TranscriptAgent::GrokAcp) {
        return Err(Error::InvalidArgument);
    }
    if matches!(agent, TranscriptAgent::Hermes | TranscriptAgent::Opencode) {
        return super::database::discover_database(agent, root, limit);
    }
    let root = match root {
        Some(path) => path.to_path_buf(),
        None if matches!(agent, TranscriptAgent::DevinAtif) => std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| dirs::home_dir().map(|home| home.join(".local/share")))
            .ok_or(Error::InvalidArgument)?
            .join("devin/cli/transcripts"),
        None => {
            let (variable, fallback, child) = match agent {
                TranscriptAgent::Claude => (Some("CLAUDE_CONFIG_DIR"), ".claude", "projects"),
                TranscriptAgent::Codex => (Some("CODEX_HOME"), ".codex", "sessions"),
                TranscriptAgent::Pi => (Some("PI_CODING_AGENT_DIR"), ".pi/agent", "sessions"),
                TranscriptAgent::Omp => (Some("PI_CODING_AGENT_DIR"), ".omp/agent", "sessions"),
                TranscriptAgent::Copilot => (None, ".copilot", "session-state"),
                TranscriptAgent::QoderIde => (None, ".qoder", "projects"),
                TranscriptAgent::Kimi => (Some("KIMI_SHARE_DIR"), ".kimi", "sessions"),
                TranscriptAgent::Jcode => (Some("JCODE_HOME"), ".jcode", "sessions"),
                TranscriptAgent::Droid => (None, ".factory", "sessions"),
                TranscriptAgent::Cursor => (None, ".cursor", "projects"),
                TranscriptAgent::Omo => (
                    [
                        "OMO_CODING_AGENT_DIR",
                        "SENPI_CODING_AGENT_DIR",
                        "PI_CODING_AGENT_DIR",
                    ]
                    .into_iter()
                    .find(|name| std::env::var(name).is_ok_and(|value| !value.trim().is_empty())),
                    ".omo/agent",
                    "sessions",
                ),
                _ => return Err(Error::InvalidArgument),
            };
            variable
                .and_then(std::env::var_os)
                .map(|value| {
                    if matches!(agent, TranscriptAgent::Omo) {
                        PathBuf::from(value.to_string_lossy().trim())
                    } else {
                        PathBuf::from(value)
                    }
                })
                .or_else(|| dirs::home_dir().map(|home| home.join(fallback)))
                .ok_or(Error::InvalidArgument)?
                .join(child)
        }
    };
    let mut discovery = Discovery {
        schema_version: 1,
        agent,
        sessions: Vec::new(),
        truncated: false,
    };
    match fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(discovery),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(Error::InvalidArgument)
        }
        Ok(_) => {}
    }
    let maximum_depth = match agent {
        TranscriptAgent::Claude => 1,
        TranscriptAgent::Codex => 3,
        TranscriptAgent::Pi | TranscriptAgent::Omp | TranscriptAgent::Omo => 1,
        TranscriptAgent::Copilot | TranscriptAgent::Droid => 1,
        TranscriptAgent::QoderIde | TranscriptAgent::Kimi => 2,
        TranscriptAgent::Cursor => 3,
        TranscriptAgent::Jcode | TranscriptAgent::DevinAtif | TranscriptAgent::AmpJson => 0,
        _ => return Err(Error::InvalidArgument),
    };
    let mut pending = vec![(root, 0)];
    let mut examined = 0;
    while let Some((directory, depth)) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            if examined == 10_000 {
                discovery.truncated = true;
                break;
            }
            examined += 1;
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() && depth < maximum_depth {
                pending.push((entry.path(), depth + 1));
                continue;
            }
            let extension = if matches!(
                agent,
                TranscriptAgent::Jcode | TranscriptAgent::DevinAtif | TranscriptAgent::AmpJson
            ) {
                "json"
            } else {
                "jsonl"
            };
            if !kind.is_file()
                || entry
                    .path()
                    .extension()
                    .is_none_or(|value| value != extension)
            {
                continue;
            }
            let path = entry.path();
            let expected = match agent {
                TranscriptAgent::Copilot => {
                    path.file_name().is_some_and(|name| name == "events.jsonl")
                }
                TranscriptAgent::QoderIde => path
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|name| name == "transcript"),
                TranscriptAgent::Kimi => {
                    path.file_name().is_some_and(|name| name == "context.jsonl")
                }
                TranscriptAgent::Droid => super::droid::session_filename(&path),
                TranscriptAgent::Cursor => super::cursor::session_path(&path),
                _ => true,
            };
            if !expected {
                continue;
            }
            let Some(path) = path.to_str() else {
                continue;
            };
            if path.len() > 4096 {
                continue;
            }
            let metadata = entry.metadata()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.uid() != unsafe { libc::geteuid() } {
                    continue;
                }
            }
            let modified = metadata.modified()?;
            let modified_at = chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339();
            discovery.sessions.push(DiscoveredSession {
                path: path.into(),
                name: if matches!(agent, TranscriptAgent::Copilot | TranscriptAgent::Kimi) {
                    entry
                        .path()
                        .parent()
                        .and_then(Path::file_name)
                        .unwrap_or(&entry.file_name())
                        .to_string_lossy()
                        .into_owned()
                } else {
                    entry.file_name().to_string_lossy().into_owned()
                },
                modified_at,
                bytes: metadata.len(),
                modified,
                session_id: None,
            });
            discovery.sessions.sort_unstable_by(|left, right| {
                right
                    .modified
                    .cmp(&left.modified)
                    .then_with(|| left.path.cmp(&right.path))
            });
            if discovery.sessions.len() > usize::from(limit) {
                discovery.sessions.pop();
                discovery.truncated = true;
            }
        }
        if examined == 10_000 {
            discovery.truncated = true;
            break;
        }
    }
    Ok(discovery)
}
