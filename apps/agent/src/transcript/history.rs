//! The earlier Claude Code and Codex sessions of one folder, newest first, for the Agent view's
//! History list: id, title, time and size. The transcript itself is read later through the usual
//! conversation command, so nothing here exposes message text beyond a bounded title.
use super::{Error, Result, TranscriptAgent};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

/// Claude Code's own per-folder directory: every character outside letters and digits is `-`.
fn project_directory_name(folder: &str) -> String {
    folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

const HEAD: u64 = 256 * 1024;
const TAIL: u64 = 128 * 1024;
/// Codex keeps no per-folder directory, so the newest rollouts are opened and compared by `cwd`.
const CODEX_EXAMINED: usize = 300;
const TITLE_CHARS: usize = 120;

fn owned_file(path: &Path) -> Option<(File, fs::Metadata)> {
    let link = fs::symlink_metadata(path).ok()?;
    if !link.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if link.uid() != unsafe { libc::geteuid() } {
            return None;
        }
    }
    Some((File::open(path).ok()?, link))
}

/// Up to `HEAD` bytes from the start, cut at the last complete line.
fn head(file: &mut File) -> Vec<u8> {
    let mut buffer = Vec::new();
    let _ = file.take(HEAD).read_to_end(&mut buffer);
    if let Some(end) = buffer.iter().rposition(|byte| *byte == b'\n') {
        buffer.truncate(end + 1);
    }
    buffer
}

/// Up to `TAIL` bytes from the end, starting at the first complete line.
fn tail(file: &mut File, size: u64) -> Vec<u8> {
    let start = size.saturating_sub(TAIL);
    let mut buffer = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err()
        || file.take(TAIL).read_to_end(&mut buffer).is_err()
    {
        return Vec::new();
    }
    if start > 0 {
        match buffer.iter().position(|byte| *byte == b'\n') {
            Some(first) => buffer.drain(..=first),
            None => return Vec::new(),
        };
    }
    buffer
}

fn records(bytes: &[u8]) -> impl DoubleEndedIterator<Item = Value> + '_ {
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
}

/// A one-line title: whitespace collapsed, control characters dropped, bounded.
fn title(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean: String = collapsed.chars().filter(|c| !c.is_control()).collect();
    let bounded: String = clean.chars().take(TITLE_CHARS).collect();
    (!bounded.is_empty()).then_some(bounded)
}

fn claude_title(tail: &[u8]) -> Option<String> {
    let all: Vec<Value> = records(tail).collect();
    all.iter()
        .rev()
        .find_map(|record| {
            (record["type"] == "ai-title")
                .then(|| record["aiTitle"].as_str())
                .flatten()
        })
        .or_else(|| {
            all.iter().rev().find_map(|record| {
                (record["type"] == "last-prompt")
                    .then(|| record["lastPrompt"].as_str())
                    .flatten()
            })
        })
        .and_then(title)
}

fn modified_at(modified: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339()
}

fn claude(root: &Path, folder: &str, limit: usize) -> Result<Vec<Value>> {
    let directory = root.join(project_directory_name(folder));
    let Ok(listing) = fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };
    let mut files: Vec<(SystemTime, PathBuf)> = listing
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            (path.extension()? == "jsonl").then_some(())?;
            Some((entry.metadata().ok()?.modified().ok()?, path))
        })
        .collect();
    files.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let mut found = Vec::new();
    for (modified, path) in files {
        if found.len() == limit {
            break;
        }
        let (Some((mut file, metadata)), Some(id), Some(text)) = (
            owned_file(&path),
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned),
            path.to_str()
                .filter(|text| text.len() <= 4096)
                .map(str::to_owned),
        ) else {
            continue;
        };
        // Two folders can share one directory name (`/a/b-c` and `/a/b/c`): the recorded cwd settles it.
        let opening = head(&mut file);
        if let Some(cwd) =
            records(&opening).find_map(|record| record["cwd"].as_str().map(str::to_owned))
        {
            if cwd != folder {
                continue;
            }
        }
        let mut entry = json!({
            "agent":"claude","sessionId":id,"path":text,"modifiedAt":modified_at(modified),"bytes":metadata.len(),
        });
        if let Some(name) = claude_title(&tail(&mut file, metadata.len())) {
            entry["title"] = json!(name);
        }
        found.push(entry);
    }
    Ok(found)
}

fn codex(root: &Path, folder: &str, limit: usize) -> Result<Vec<Value>> {
    let mut files = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0)];
    while let Some((directory, depth)) = pending.pop() {
        let Ok(listing) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in listing.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() && depth < 3 {
                pending.push((entry.path(), depth + 1));
            } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
                if let Some(modified) = entry.metadata().ok().and_then(|meta| meta.modified().ok())
                {
                    files.push((modified, entry.path()));
                }
            }
        }
    }
    files.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let mut found = Vec::new();
    for (modified, path) in files.into_iter().take(CODEX_EXAMINED) {
        if found.len() == limit {
            break;
        }
        let (Some((mut file, metadata)), Some(text)) = (
            owned_file(&path),
            path.to_str()
                .filter(|text| text.len() <= 4096)
                .map(str::to_owned),
        ) else {
            continue;
        };
        let opening = head(&mut file);
        let mut all = records(&opening);
        let Some(meta) = all.find(|record| record["type"] == "session_meta") else {
            continue;
        };
        let (Some(id), true) = (
            meta["payload"]["id"]
                .as_str()
                .filter(|id| id.len() <= 128 && !id.chars().any(char::is_control)),
            meta["payload"]["cwd"] == folder,
        ) else {
            continue;
        };
        let mut entry = json!({
            "agent":"codex","sessionId":id,"path":text,"modifiedAt":modified_at(modified),"bytes":metadata.len(),
        });
        let first_prompt = all.find_map(|record| {
            (record["type"] == "event_msg" && record["payload"]["type"] == "user_message")
                .then(|| record["payload"]["message"].as_str().and_then(title))
                .flatten()
        });
        if let Some(name) = first_prompt {
            entry["title"] = json!(name);
        }
        found.push(entry);
    }
    Ok(found)
}

/// The sessions of `folder` an agent recorded under `root` (its default sessions directory when
/// `None`), newest first, at most `limit`. Only Claude Code and Codex are listed.
pub fn history(
    agent: TranscriptAgent,
    root: Option<&Path>,
    folder: &str,
    limit: u8,
) -> Result<Value> {
    if !matches!(agent, TranscriptAgent::Claude | TranscriptAgent::Codex)
        || !(1..=100).contains(&limit)
        || !Path::new(folder).is_absolute()
        || folder.len() > 4096
        || folder.chars().any(char::is_control)
    {
        return Err(Error::InvalidArgument);
    }
    let root = match root {
        Some(path) => path.to_path_buf(),
        None => super::herdr_session::provider_root(agent)?,
    };
    // A symlinked or missing root lists nothing: the agent's own directory is a real one.
    if fs::symlink_metadata(&root).map_or(true, |meta| !meta.is_dir()) {
        return Ok(json!({"schemaVersion":1,"agent":agent,"sessions":[]}));
    }
    let sessions = match agent {
        TranscriptAgent::Claude => claude(&root, folder, usize::from(limit))?,
        _ => codex(&root, folder, usize::from(limit))?,
    };
    Ok(json!({"schemaVersion":1,"agent":agent,"sessions":sessions}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(path: &Path, lines: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }
    fn age(path: &Path, seconds: u64) {
        let time = SystemTime::now() - std::time::Duration::from_secs(seconds);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }
    /// The folders are written POSIX-style; Windows only accepts a drive-qualified absolute one.
    fn folder(posix: &str) -> String {
        if cfg!(windows) {
            format!("C:{}", posix.replace('/', "\\"))
        } else {
            posix.to_owned()
        }
    }

    #[test]
    fn claude_lists_the_folder_newest_first_with_titles_and_skips_a_folder_with_the_same_directory_name(
    ) {
        let root = tempfile::tempdir().unwrap();
        let app = folder("/home/me/dev/.worktrees/app");
        let directory = root.path().join(if cfg!(windows) {
            "C--home-me-dev--worktrees-app"
        } else {
            "-home-me-dev--worktrees-app"
        });
        let old = directory.join("11111111-1111-4111-8111-111111111111.jsonl");
        let new = directory.join("22222222-2222-4222-8222-222222222222.jsonl");
        let other = directory.join("33333333-3333-4333-8333-333333333333.jsonl");
        write(
            &old,
            &[
                json!({"type":"user","cwd":app}),
                json!({"type":"last-prompt","lastPrompt":"  fix\nthe login\u{1b}[31m  bug "}),
            ],
        );
        write(
            &new,
            &[
                json!({"type":"user","cwd":app}),
                json!({"type":"ai-title","aiTitle":"Old title"}),
                json!({"type":"ai-title","aiTitle":"Add dark mode"}),
            ],
        );
        write(
            &other,
            &[json!({"type":"user","cwd":folder("/home/me/dev/-worktrees/app")})],
        );
        age(&old, 7200);
        age(&new, 60);
        let page = history(TranscriptAgent::Claude, Some(root.path()), &app, 10).unwrap();
        let sessions = page["sessions"].as_array().unwrap();
        assert_eq!(
            sessions
                .iter()
                .map(|s| s["sessionId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "22222222-2222-4222-8222-222222222222",
                "11111111-1111-4111-8111-111111111111"
            ]
        );
        assert_eq!(sessions[0]["title"], "Add dark mode");
        assert_eq!(sessions[1]["title"], "fix the login[31m bug");
        assert_eq!(sessions[0]["path"], new.to_str().unwrap());
        assert!(
            sessions[0]["bytes"].as_u64().unwrap() > 0 && sessions[0]["modifiedAt"].is_string()
        );
        // The limit applies after the newest are chosen.
        let one = history(TranscriptAgent::Claude, Some(root.path()), &app, 1).unwrap();
        assert_eq!(one["sessions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn codex_lists_only_rollouts_whose_session_meta_names_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let mine = root.path().join("2026/11/10/rollout-a.jsonl");
        let theirs = root.path().join("2026/11/10/rollout-b.jsonl");
        let app = folder("/work/app");
        write(
            &mine,
            &[
                json!({"type":"session_meta","payload":{"id":"aaaa","cwd":app}}),
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"not me"}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Plan the release"}}),
            ],
        );
        write(
            &theirs,
            &[json!({"type":"session_meta","payload":{"id":"bbbb","cwd":folder("/work/other")}})],
        );
        let page = history(TranscriptAgent::Codex, Some(root.path()), &app, 10).unwrap();
        assert_eq!(
            page["sessions"],
            json!([{
                "agent":"codex","sessionId":"aaaa","path":mine.to_str().unwrap(),"title":"Plan the release",
                "modifiedAt":page["sessions"][0]["modifiedAt"],"bytes":page["sessions"][0]["bytes"],
            }])
        );
    }

    #[test]
    fn a_missing_root_or_an_unsupported_agent_or_a_bad_folder_is_an_empty_list_or_an_error() {
        let root = tempfile::tempdir().unwrap();
        let work = folder("/work");
        let none = history(
            TranscriptAgent::Claude,
            Some(&root.path().join("absent")),
            &work,
            5,
        )
        .unwrap();
        assert_eq!(none["sessions"], json!([]));
        assert!(history(TranscriptAgent::Pi, Some(root.path()), &work, 5).is_err());
        assert!(history(TranscriptAgent::Claude, Some(root.path()), "relative", 5).is_err());
        assert!(history(
            TranscriptAgent::Claude,
            Some(root.path()),
            &format!("{work}\n"),
            5
        )
        .is_err());
        assert!(history(TranscriptAgent::Claude, Some(root.path()), &work, 0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_transcripts_are_not_listed() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("-work");
        let secret = root.path().join("secret.jsonl");
        write(&secret, &[json!({"type":"ai-title","aiTitle":"private"})]);
        fs::create_dir_all(&directory).unwrap();
        std::os::unix::fs::symlink(
            &secret,
            directory.join("44444444-4444-4444-8444-444444444444.jsonl"),
        )
        .unwrap();
        let page = history(TranscriptAgent::Claude, Some(root.path()), "/work", 5).unwrap();
        assert_eq!(page["sessions"], json!([]));
    }
}
