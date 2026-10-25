use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::{exec, quote, sftp, AppState, Result, SshError};
use serde::Serialize;
use tauri::State;
use tokio::{
    io::AsyncReadExt,
    time::{timeout, Duration},
};

const ENTRY_LIMIT: usize = 10_000;
const BLOB_LIMIT: u64 = 200 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    original_path: Option<String>,
    index: String,
    worktree: String,
}
#[derive(Debug, Serialize)]
pub struct Status {
    path: String,
    changes: Vec<Change>,
}
#[derive(Debug, Serialize)]
pub struct Commit {
    oid: String,
    subject: String,
}
#[derive(Debug, Serialize)]
pub struct TreeEntry {
    path: String,
    oid: String,
    kind: String,
    size: Option<u64>,
}
#[derive(Debug, Serialize)]
pub struct Blob {
    text: Option<String>,
    binary: bool,
    bytes: u64,
}
#[derive(Debug, Serialize)]
pub struct Diff {
    patch: String,
    binary: bool,
}
#[derive(Debug, Serialize)]
pub struct Image {
    mime: &'static str,
    data: Vec<u8>,
}

fn image(data: Vec<u8>) -> Result<Image> {
    let mime = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err(invalid("Image preview supports PNG, JPEG, GIF and WebP; active formats such as SVG and HTML are not rendered"));
    };
    Ok(Image { mime, data })
}

#[tauri::command]
pub async fn repository_image(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    file_path: String,
    object_id: Option<String>,
    access: AccessLease,
) -> std::result::Result<Guarded<Image>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            if let Some(object_id) = object_id {
                oid(&object_id)?;
                let prefix = git(&path)?;
                let size = exec(&session, format!("{prefix} cat-file -s {object_id}"))
                    .await?
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| invalid("Invalid image size"))?;
                if size > BLOB_LIMIT {
                    return Err(invalid(
                        "Historical image exceeds the 200 KiB preview limit",
                    ));
                }
                let encoded = exec(
                    &session,
                    format!("{prefix} cat-file blob {object_id} | od -An -v -tu1"),
                )
                .await?;
                let bytes = encoded
                    .split_whitespace()
                    .map(|s| {
                        s.parse::<u8>()
                            .map_err(|_| invalid("Invalid image encoding"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                if bytes.len() as u64 != size {
                    return Err(invalid("Image changed while reading"));
                }
                return image(bytes);
            }
            check_file_path(&file_path)?;
            git(&path)?;
            timeout(Duration::from_secs(30), async {
                let sftp = sftp(&session).await?;
                let target = format!("{}/{}", path.trim_end_matches('/'), file_path);
                let metadata = sftp.symlink_metadata(&target).await?;
                if metadata.is_symlink() || !metadata.is_regular() {
                    return Err(invalid("Image preview requires a regular file"));
                }
                let file = sftp.open(target).await?;
                let mut bytes = Vec::new();
                file.take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                if bytes.len() > 2 * 1024 * 1024 {
                    return Err(invalid("Image preview is limited to 2 MiB"));
                }
                image(bytes)
            })
            .await
            .map_err(|_| SshError::new("timeout", "Reading image timed out"))?
        })
        .await
}

fn invalid(message: &str) -> SshError {
    SshError::new("invalid_repository", message)
}
fn git(path: &str) -> Result<String> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(invalid("Invalid repository directory"));
    }
    Ok(format!("GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 git --no-pager --literal-pathspecs -c core.fsmonitor=false -c core.quotePath=false -C {}", quote(path)))
}
fn oid(value: &str) -> Result<()> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid(
            "Select a full commit or object identifier from repository history",
        ));
    }
    Ok(())
}
fn check_file_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || value.starts_with('/')
        || value.split('/').any(|part| part == "..")
    {
        return Err(invalid("Select a repository-relative file path"));
    }
    Ok(())
}
fn parse_status(text: &str) -> Result<Vec<Change>> {
    let mut parts = text.split_terminator('\0');
    let mut changes = Vec::new();
    while let Some(record) = parts.next() {
        if record.len() < 4 || record.as_bytes()[2] != b' ' || !record.is_char_boundary(3) {
            return Err(invalid("Invalid Git status output"));
        }
        let state = &record.as_bytes()[..2];
        if !state.iter().all(|b| b" MADRCU?!T".contains(b)) {
            return Err(invalid("Unknown Git status"));
        }
        let original_path = if state.contains(&b'R') || state.contains(&b'C') {
            Some(
                parts
                    .next()
                    .ok_or_else(|| invalid("Incomplete Git rename record"))?
                    .to_owned(),
            )
        } else {
            None
        };
        changes.push(Change {
            path: record[3..].to_owned(),
            original_path,
            index: (state[0] as char).to_string(),
            worktree: (state[1] as char).to_string(),
        });
        if changes.len() > ENTRY_LIMIT {
            return Err(invalid("Repository has more than 10,000 changed files"));
        }
    }
    Ok(changes)
}
fn parse_history(text: &str) -> Result<Vec<Commit>> {
    let mut fields = text.split_terminator('\0');
    let mut commits = Vec::new();
    while let Some(hash) = fields.next() {
        oid(hash)?;
        let subject = fields
            .next()
            .ok_or_else(|| invalid("Invalid history output"))?;
        commits.push(Commit {
            oid: hash.to_owned(),
            subject: subject.to_owned(),
        });
        if commits.len() > 50 {
            return Err(invalid("History exceeds 50 commits"));
        }
    }
    Ok(commits)
}
fn parse_tree(text: &str) -> Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    for record in text.split_terminator('\0') {
        let (metadata, path) = record
            .split_once('\t')
            .ok_or_else(|| invalid("Invalid Git tree output"))?;
        let fields = metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 4 {
            return Err(invalid("Invalid Git tree entry"));
        }
        oid(fields[2])?;
        let size = if fields[3] == "-" {
            None
        } else {
            Some(
                fields[3]
                    .parse()
                    .map_err(|_| invalid("Invalid Git blob size"))?,
            )
        };
        entries.push(TreeEntry {
            path: path.to_owned(),
            oid: fields[2].to_owned(),
            kind: if fields[0] == "120000" {
                "symlink"
            } else {
                fields[1]
            }
            .to_owned(),
            size,
        });
        if entries.len() > ENTRY_LIMIT {
            return Err(invalid("Repository tree exceeds 10,000 entries"));
        }
    }
    Ok(entries)
}

#[tauri::command]
pub async fn repository_status(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Status>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let root = exec(
                &session,
                format!("{} rev-parse --show-toplevel", git(&path)?),
            )
            .await?;
            let root = root.strip_suffix('\n').unwrap_or(&root).to_owned();
            let changes = parse_status(
                &exec(
                    &session,
                    format!(
                        "{} status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all",
                        git(&root)?
                    ),
                )
                .await?,
            )?;
            Ok(Status {
                path: root,
                changes,
            })
        })
        .await
}
#[tauri::command]
pub async fn repository_history(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    offset: Option<u32>,
    revision: Option<String>,
    access: AccessLease,
) -> std::result::Result<Guarded<Vec<Commit>>, GuardedError<crate::ssh::SshError>> {
    access.run(async {
    let offset = offset.unwrap_or(0);
    if offset > 100_000 {
        return Err(invalid("History cursor exceeds 100,000 commits"));
    }
    let revision = revision.unwrap_or_default();
    if !revision.is_empty() {
        oid(&revision)?;
    }
    let session = state.session(&session_id).await?;
    parse_history(
        &exec(
            &session,
            format!(
                "{} log -z --skip={offset} --max-count=50 --format='%H%x00%s' --no-show-signature {revision}",
                git(&path)?
            ),
        )
        .await?,
    )
 }).await
}
#[tauri::command]
pub async fn repository_tree(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    revision: String,
    directory: Option<String>,
    access: AccessLease,
) -> std::result::Result<Guarded<Vec<TreeEntry>>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            oid(&revision)?;
            let directory = directory.unwrap_or_default();
            if !directory.is_empty() {
                check_file_path(&directory)?;
            }
            let tree = if directory.is_empty() {
                revision
            } else {
                format!("{revision}:{directory}")
            };
            let session = state.session(&session_id).await?;
            let mut entries = parse_tree(
                &exec(
                    &session,
                    format!("{} ls-tree -l -z --full-tree {}", git(&path)?, quote(&tree)),
                )
                .await?,
            )?;
            if !directory.is_empty() {
                for entry in &mut entries {
                    entry.path = format!("{directory}/{}", entry.path);
                }
            }
            Ok(entries)
        })
        .await
}
fn decode_blob(text: &str, size: u64) -> Result<Blob> {
    let bytes = text
        .split_whitespace()
        .map(|s| {
            s.parse::<u8>()
                .map_err(|_| invalid("Invalid blob encoding"))
        })
        .collect::<Result<Vec<_>>>()?;
    if bytes.len() as u64 != size {
        return Err(invalid("Repository blob changed while reading"));
    }
    let text = if bytes.contains(&0) {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    Ok(Blob {
        binary: text.is_none(),
        text,
        bytes: size,
    })
}
#[tauri::command]
pub async fn repository_blob(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    object_id: String,
    access: AccessLease,
) -> std::result::Result<Guarded<Blob>, GuardedError<crate::ssh::SshError>> {
    access
        .run(async {
            oid(&object_id)?;
            let prefix = git(&path)?;
            let session = state.session(&session_id).await?;
            let size = exec(&session, format!("{prefix} cat-file -s {object_id}"))
                .await?
                .trim()
                .parse::<u64>()
                .map_err(|_| invalid("Invalid object size"))?;
            if size > BLOB_LIMIT {
                return Err(invalid("Historical file exceeds the 200 KiB preview limit"));
            }
            let encoded = exec(
                &session,
                format!("{prefix} cat-file blob {object_id} | od -An -v -tu1"),
            )
            .await?;
            decode_blob(&encoded, size)
        })
        .await
}
#[tauri::command]
pub async fn repository_diff(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    file_path: String,
    staged: bool,
    access: AccessLease,
) -> std::result::Result<Guarded<Diff>, GuardedError<crate::ssh::SshError>> {
    access.run(async {
    check_file_path(&file_path)?;
    let session = state.session(&session_id).await?;
    let prefix = git(&path)?;
    let cached = if staged { "--cached" } else { "" };
    let pathspec = quote(&file_path);
    let stats = exec(
        &session,
        format!("{prefix} diff --no-ext-diff --no-textconv --numstat -z {cached} -- {pathspec}"),
    )
    .await?;
    let binary = stats
        .split_terminator('\0')
        .any(|row| row.starts_with("-\t-\t"));
    let patch = exec(&session, format!("{prefix} diff --no-ext-diff --no-textconv --no-color --no-renames {cached} -- {pathspec}")).await?;
    if patch.lines().count() > 10_000 {
        return Err(invalid(
            "Diff preview exceeds 10,000 lines; review a smaller change in the terminal",
        ));
    }
    Ok(Diff { patch, binary })
 }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::{fs, process::Command};

    #[cfg(unix)]
    fn run(command: String) -> String {
        let output = Command::new("sh").args(["-c", &command]).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    #[test]
    fn rejects_untrusted_revisions_and_relative_escape() {
        for revision in [
            "HEAD",
            "--help",
            "$(touch /tmp/nope)",
            "abc",
            &"g".repeat(40),
        ] {
            assert!(oid(revision).is_err());
        }
        assert!(oid(&"a".repeat(40)).is_ok());
        for path in ["../outside", "/etc/passwd", "x/../../outside", "x\0y"] {
            assert!(check_file_path(path).is_err());
        }
        assert!(check_file_path("--help;$(touch harmless)").is_ok());
        assert!(parse_status("R  broken\0").is_err());
        assert!(image(b"<svg onload='run()'>".to_vec()).is_err());
        assert!(image(b"<html>secret</html>".to_vec()).is_err());
        assert_eq!(
            image(b"\x89PNG\r\n\x1a\n".to_vec()).unwrap().mime,
            "image/png"
        );
    }
    #[cfg(unix)]
    #[test]
    fn real_git_history_status_and_binary_objects_preserve_hostile_names() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("repo';$() name");
        fs::create_dir(&dir).unwrap();
        let prefix = git(dir.to_str().unwrap()).unwrap();
        run(format!("{prefix} init -q"));
        let hostile = "--strange\tname\nfile.txt";
        fs::write(dir.join(hostile), "before\n").unwrap();
        fs::write(dir.join("binary.dat"), [0, 255, 34, 10]).unwrap();
        fs::create_dir(dir.join("nested")).unwrap();
        fs::write(dir.join("nested/file.txt"), "nested text").unwrap();
        run(format!("{prefix} add -- ."));
        run(format!(
            "{prefix} -c user.name=Test -c user.email=test@example.invalid commit -qm initial"
        ));
        let history = parse_history(&run(format!(
            "{prefix} log -z --max-count=50 --format='%H%x00%s' --no-show-signature"
        )))
        .unwrap();
        assert_eq!(history[0].subject, "initial");
        let tree = parse_tree(&run(format!(
            "{prefix} ls-tree -r -l -z --full-tree {}",
            history[0].oid
        )))
        .unwrap();
        assert!(tree.iter().any(|entry| entry.path == hostile));
        let root_tree = parse_tree(&run(format!(
            "{prefix} ls-tree -l -z --full-tree {}",
            history[0].oid
        )))
        .unwrap();
        assert!(root_tree
            .iter()
            .any(|entry| entry.path == "nested" && entry.kind == "tree"));
        let nested = quote(&format!("{}:nested", history[0].oid));
        let subtree =
            parse_tree(&run(format!("{prefix} ls-tree -l -z --full-tree {nested}"))).unwrap();
        assert_eq!(subtree[0].path, "file.txt");
        let binary = tree
            .iter()
            .find(|entry| entry.path == "binary.dat")
            .unwrap();
        let encoded = run(format!(
            "{prefix} cat-file blob {} | od -An -v -tu1",
            binary.oid
        ));
        assert!(decode_blob(&encoded, 4).unwrap().binary);
        fs::rename(dir.join(hostile), dir.join("renamed.txt")).unwrap();
        run(format!("{prefix} add -- ."));
        fs::write(dir.join("untracked.txt"), "new").unwrap();
        let changes = parse_status(&run(format!(
            "{prefix} status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all"
        )))
        .unwrap();
        assert!(changes.iter().any(|change| change.path == "renamed.txt"
            && change.original_path.as_deref() == Some(hostile)));
        assert!(changes
            .iter()
            .any(|change| change.path == "untracked.txt" && change.index == "?"));
        fs::write(dir.join("binary.dat"), [0, 244]).unwrap();
        let stats = run(format!(
            "{prefix} diff --no-ext-diff --no-textconv --numstat -z -- binary.dat"
        ));
        assert!(stats.starts_with("-\t-\t"));
    }
}
