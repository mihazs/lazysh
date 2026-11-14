//! Exact Herdr-selected provider sessions; no path supplied by the caller.
use super::window::Window;
use super::{Error, Result, TranscriptAgent, TranscriptPage};
use std::path::{Path, PathBuf};

/// The directory the agent keeps its own sessions in: its configured home, else the default one.
pub(super) fn provider_root(agent: TranscriptAgent) -> Result<PathBuf> {
    let (variable, fallback, child) = match agent {
        TranscriptAgent::Claude => ("CLAUDE_CONFIG_DIR", ".claude", "projects"),
        TranscriptAgent::Codex => ("CODEX_HOME", ".codex", "sessions"),
        _ => return Err(Error::InvalidArgument),
    };
    let home = std::env::var_os(variable)
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|path| path.join(fallback)))
        .ok_or(Error::InvalidArgument)?;
    Ok(home.join(child))
}

fn session_root(agent: TranscriptAgent, id: &str) -> Result<PathBuf> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| Error::InvalidArgument)?;
    if parsed.to_string() != id {
        return Err(Error::InvalidArgument);
    }
    provider_root(agent)
}

pub fn read_herdr_conversation(
    agent: TranscriptAgent,
    id: &str,
    limit: u8,
) -> Result<TranscriptPage> {
    read_herdr_conversation_window(agent, id, limit, &Window::Tail)
}

pub fn read_herdr_conversation_window(
    agent: TranscriptAgent,
    id: &str,
    limit: u8,
    window: &Window,
) -> Result<TranscriptPage> {
    let root = session_root(agent, id)?;
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidArgument);
    }
    read_in(&root, agent, id, limit, window)
}

/// The file `read_herdr_conversation` would read, for cheap change checks only.
/// Content always comes from `read_herdr_conversation`, which re-validates the file.
pub(super) fn locate(agent: TranscriptAgent, id: &str) -> Result<PathBuf> {
    locate_in(&session_root(agent, id)?, agent, id)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_in(_: &Path, _: TranscriptAgent, _: &str, _: u8, _: &Window) -> Result<TranscriptPage> {
    Err(Error::InvalidArgument)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn locate_in(_: &Path, _: TranscriptAgent, _: &str) -> Result<PathBuf> {
    Err(Error::InvalidArgument)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn locate_in(root: &Path, agent: TranscriptAgent, id: &str) -> Result<PathBuf> {
    find(&open_roots(root, agent)?.1, agent, id)
}

/// The provider home (Codex only) and the anchored directory holding the sessions.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_roots(
    root: &Path,
    agent: TranscriptAgent,
) -> Result<(
    Option<crate::managed_directory::Directory>,
    crate::managed_directory::Directory,
)> {
    use crate::managed_directory::Directory;
    let home = if matches!(agent, TranscriptAgent::Codex) {
        if root.file_name().is_none_or(|name| name != "sessions") {
            return Err(Error::InvalidArgument);
        }
        Some(Directory::profile(
            root.parent().ok_or(Error::InvalidArgument)?,
        )?)
    } else {
        None
    };
    let root = if let Some(home) = &home {
        home.child("sessions", false)?
    } else {
        Directory::profile(root)?
    };
    Ok((home, root))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn read_in(
    root: &Path,
    agent: TranscriptAgent,
    id: &str,
    limit: u8,
    window: &Window,
) -> Result<TranscriptPage> {
    let (home, root) = open_roots(root, agent)?;
    let path = find(&root, agent, id)?;
    let relative = path
        .strip_prefix(&root.path)
        .map_err(|_| Error::InvalidArgument)?;
    let parent = root.child_or_self(relative.parent().ok_or(Error::InvalidArgument)?)?;
    let leaf = relative
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(Error::InvalidArgument)?;
    let original = parent.open_file(leaf, libc::O_RDONLY)?;
    let metadata = original.metadata()?;
    if !metadata.is_file() {
        return Err(Error::InvalidArgument);
    }
    super::check_owner(&metadata)?;
    let source = super::SourceSnapshot::capture(&original)?;
    let page = match agent {
        TranscriptAgent::Claude => {
            let bytes = super::anchored_capture(&parent, leaf)?;
            super::conversation::project_claude_bounded(
                bytes,
                limit,
                false,
                4 * 1024 * 1024,
                20_000,
                Some(id),
                window,
            )?
        }
        TranscriptAgent::Codex => {
            let page = super::anchored_codex(
                home.as_ref().ok_or(Error::InvalidArgument)?,
                &path,
                limit,
                &source,
                window,
            )?;
            if page.branch_id.as_deref() != Some(id) {
                return Err(Error::InvalidEvent);
            }
            page
        }
        _ => return Err(Error::InvalidArgument),
    };
    let verify = || -> Result<()> {
        source.same_file(&parent.open_file(leaf, libc::O_RDONLY)?)?;
        parent.check()?;
        root.check()?;
        if let Some(home) = &home {
            home.check()?;
        }
        Ok(())
    };
    verify()?;
    if find(&root, agent, id)? != path {
        return Err(Error::InvalidEvent);
    }
    verify()?;
    Ok(page)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn find(
    root: &crate::managed_directory::Directory,
    agent: TranscriptAgent,
    id: &str,
) -> Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let max_depth = if matches!(agent, TranscriptAgent::Claude) {
        1
    } else {
        3
    };
    let mut pending = vec![(PathBuf::new(), 0)];
    let mut examined = 0usize;
    let mut found = None;
    while let Some((relative, depth)) = pending.pop() {
        let directory = root.child_or_self(&relative)?;
        let before = directory.file.metadata()?;
        for entry in super::anchored_listing::Listing::new(&directory.file)? {
            examined += 1;
            if examined > 10_000 {
                return Err(Error::InvalidArgument);
            }
            let entry = entry?;
            let Some(name) = entry.name.to_str() else {
                continue;
            };
            let matches = if matches!(agent, TranscriptAgent::Claude) {
                name == format!("{id}.jsonl")
            } else {
                name.starts_with("rollout-") && name.ends_with(&format!("-{id}.jsonl"))
            };
            if matches {
                if !entry.is_file || found.replace(directory.path.join(name)).is_some() {
                    return Err(Error::InvalidEvent);
                }
            } else if entry.is_dir && depth < max_depth {
                pending.push((relative.join(name), depth + 1));
            }
        }
        directory.check()?;
        let after = directory.file.metadata()?;
        if (
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec(),
        ) != (
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec(),
        ) {
            return Err(Error::InvalidEvent);
        }
    }
    found.ok_or(Error::InvalidArgument)
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    const ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER: &str = "22222222-2222-4222-8222-222222222222";

    fn claude_fixture(id: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("projects");
        let project = root.join("one");
        fs::create_dir_all(&project).unwrap();
        let file = project.join(format!("{id}.jsonl"));
        (temp, root, file)
    }

    fn codex_roots() -> (PathBuf, PathBuf, PathBuf, tempfile::TempDir, &'static Path) {
        let temp = tempfile::tempdir().unwrap();
        (
            temp.path().canonicalize().unwrap().join("codex"),
            temp.path().canonicalize().unwrap().join("alternate"),
            temp.path().canonicalize().unwrap().join("retired"),
            temp,
            Path::new("sessions/2026/11/10"),
        )
    }

    fn read_during_swap(
        home: &Path,
        alternate: &Path,
        retired: &Path,
        authority: &crate::managed_directory::Directory,
        selected: &Path,
        expected: &super::super::SourceSnapshot,
    ) -> Result<TranscriptPage> {
        fs::rename(home, retired).unwrap();
        fs::rename(alternate, home).unwrap();
        let result = super::super::anchored_codex(authority, selected, 50, expected, &Window::Tail);
        fs::rename(home, alternate).unwrap();
        fs::rename(retired, home).unwrap();
        result
    }

    #[test]
    fn claude_requires_unique_exact_metadata_and_preserves_partial_tail() {
        let (_temp, root, file) = claude_fixture(ID);
        let record =
            json!({"type":"user","uuid":"first","sessionId":ID,"message":{"content":"hello"}});
        fs::write(&file, format!("{record}\n{{")).unwrap();
        let page = read_in(&root, TranscriptAgent::Claude, ID, 50, &Window::Tail).unwrap();
        assert_eq!(page.view, "active_branch");
        assert_eq!(page.messages[0]["blocks"][0]["text"], "hello");
        assert!(read_in(&root, TranscriptAgent::Claude, OTHER, 50, &Window::Tail).is_err());
        let mut conflicting = record.clone();
        conflicting["sessionId"] = json!(OTHER);
        fs::write(&file, format!("{conflicting}\n")).unwrap();
        assert!(read_in(&root, TranscriptAgent::Claude, ID, 50, &Window::Tail).is_err());
        fs::write(&file, format!("{record}\n")).unwrap();
        let duplicate = root.join("two");
        fs::create_dir(&duplicate).unwrap();
        fs::write(duplicate.join(format!("{ID}.jsonl")), format!("{record}\n")).unwrap();
        assert!(read_in(&root, TranscriptAgent::Claude, ID, 50, &Window::Tail).is_err());
    }

    #[test]
    fn codex_checks_session_metadata_and_refuses_symlink_candidates() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap().join("codex");
        let root = home.join("sessions");
        let date = root.join("2026/11/10");
        fs::create_dir_all(&date).unwrap();
        let file = date.join(format!("rollout-2026-11-10T00-00-00-{ID}.jsonl"));
        let meta = |id| json!({"type":"session_meta","payload":{"id":id,"history_mode":"legacy"}});
        let event = json!({"type":"event_msg","payload":{"type":"user_message","message":"hello"}});
        fs::write(&file, format!("{}\n{event}\n", meta(ID))).unwrap();
        let page = read_in(&root, TranscriptAgent::Codex, ID, 50, &Window::Tail).unwrap();
        assert_eq!(page.branch_id.as_deref(), Some(ID));
        fs::write(&file, format!("{}\n{event}\n", meta(OTHER))).unwrap();
        assert!(read_in(&root, TranscriptAgent::Codex, ID, 50, &Window::Tail).is_err());
        fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(temp.path().canonicalize().unwrap().join("outside"), &file)
            .unwrap();
        assert!(read_in(&root, TranscriptAgent::Codex, ID, 50, &Window::Tail).is_err());
    }

    #[test]
    fn selected_sessions_handle_large_unrelated_records_without_changing_default_limits() {
        let temp = tempfile::tempdir().unwrap();
        let claude = temp.path().canonicalize().unwrap().join("projects");
        let project = claude.join("one");
        fs::create_dir_all(&project).unwrap();
        let path = project.join(format!("{ID}.jsonl"));
        let large =
            json!({"type":"api-request-shape","payload":"x".repeat(300_000),"sessionId":ID});
        let mut input = format!("{large}\n");
        for index in 0..10_001 {
            input.push_str(&format!(
                "{{\"type\":\"system\",\"uuid\":\"{index}\",\"sessionId\":\"{ID}\"}}\n"
            ));
        }
        input.push_str(&format!(
            "{}\n",
            json!({"type":"user","uuid":"last","sessionId":ID,"message":{"content":"hello"}})
        ));
        fs::write(&path, input).unwrap();
        assert!(super::super::conversation(&path, TranscriptAgent::Claude, 50).is_err());
        assert_eq!(
            read_in(&claude, TranscriptAgent::Claude, ID, 50, &Window::Tail)
                .unwrap()
                .messages[0]["blocks"][0]["text"],
            "hello"
        );
        let oversized =
            json!({"type":"api-request-shape","payload":"x".repeat(4*1024*1024),"sessionId":ID});
        fs::write(&path, format!("{oversized}\n")).unwrap();
        assert!(read_in(&claude, TranscriptAgent::Claude, ID, 50, &Window::Tail).is_err());
        assert!(super::super::snapshot::read_bytes_bounded(
            &mut std::io::empty(),
            64 * 1024 * 1024 + 1,
            64 * 1024 * 1024
        )
        .is_err());
        let codex = temp.path().canonicalize().unwrap().join("codex/sessions");
        let date = codex.join("2026/11/10");
        fs::create_dir_all(&date).unwrap();
        let rollout = date.join(format!("rollout-2026-11-10T00-00-00-{ID}.jsonl"));
        let meta = json!({"type":"session_meta","payload":{"id":ID,"history_mode":"legacy"}});
        let ignored = json!({"type":"response_item","payload":{"type":"message","content":"x".repeat(300_000)}});
        let event = json!({"type":"event_msg","payload":{"type":"user_message","message":"hello"}});
        fs::write(&rollout, format!("{meta}\n{ignored}\n{event}\n")).unwrap();
        // Codex writes whole commands and compactions as one line, so its reader takes a record of any length (the Claude reader above still bounds it).
        assert_eq!(
            super::super::conversation(&rollout, TranscriptAgent::Codex, 50)
                .unwrap()
                .messages[0]["blocks"][0]["text"],
            "hello"
        );
        assert_eq!(
            read_in(&codex, TranscriptAgent::Codex, ID, 50, &Window::Tail)
                .unwrap()
                .messages[0]["blocks"][0]["text"],
            "hello"
        );
    }

    #[test]
    fn compacted_structural_records_keep_recorded_branch_identical() {
        let id = "5f0c1d2e-0000-4000-8000-000000000001";
        let (_temp, root, file) = claude_fixture(id);
        let fixture = include_str!("../../tests/fixtures/interaction-cards/claude.jsonl");
        let mut prefix = String::new();
        for line in fixture.lines() {
            prefix.push_str(line);
            prefix.push('\n');
            fs::write(&file, &prefix).unwrap();
            let ordinary = super::super::conversation(&file, TranscriptAgent::Claude, 50).unwrap();
            let selected = read_in(&root, TranscriptAgent::Claude, id, 50, &Window::Tail).unwrap();
            assert_eq!(
                serde_json::to_value(ordinary).unwrap(),
                serde_json::to_value(selected).unwrap()
            );
        }
    }

    #[test]
    fn codex_rejects_transient_provider_home_replacement() {
        use crate::managed_directory::Directory;
        let (home, alternate, retired, _temp, relative) = codex_roots();
        let leaf = format!("rollout-2026-11-10T00-00-00-{ID}.jsonl");
        let meta = json!({"type":"session_meta","payload":{"id":ID,"history_mode":"legacy"}});
        for (base, message) in [(&home, "original"), (&alternate, "replacement")] {
            let date = base.join(relative);
            fs::create_dir_all(&date).unwrap();
            let event =
                json!({"type":"event_msg","payload":{"type":"user_message","message":message}});
            fs::write(date.join(&leaf), format!("{meta}\n{event}\n")).unwrap();
        }
        let home_authority = Directory::profile(&home).unwrap();
        let root = home_authority.child("sessions", false).unwrap();
        let parent = root.child_or_self(Path::new("2026/11/10")).unwrap();
        let original = parent.open_file(&leaf, libc::O_RDONLY).unwrap();
        let expected = super::super::SourceSnapshot::capture(&original).unwrap();
        let selected = home.join(relative).join(&leaf);
        let result = read_during_swap(
            &home,
            &alternate,
            &retired,
            &home_authority,
            &selected,
            &expected,
        );
        expected
            .same_file(&parent.open_file(&leaf, libc::O_RDONLY).unwrap())
            .unwrap();
        root.check().unwrap();
        if let Ok(page) = result {
            assert_eq!(page.messages[0]["blocks"][0]["text"], "original");
        }
    }

    #[test]
    fn codex_hard_linked_child_cannot_switch_fork_ancestor() {
        use crate::managed_directory::Directory;
        let (home, alternate, retired, _temp, relative) = codex_roots();
        let parent_leaf = format!("rollout-parent-{ID}.jsonl");
        let child_leaf = format!("rollout-child-{OTHER}.jsonl");
        let mut length = 0;
        for (base, text) in [(&home, "original"), (&alternate, "replaced")] {
            let date = base.join(relative);
            fs::create_dir_all(&date).unwrap();
            let meta = json!({"ordinal":0,"type":"session_meta","payload":{"id":ID,"history_mode":"paginated"}});
            let turn = json!({"ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"parent"}});
            let event = json!({"ordinal":2,"type":"event_msg","payload":{"type":"item_completed","thread_id":ID,"turn_id":"parent","item":{"type":"UserMessage","id":"item","content":[{"type":"text","text":text}]},"completed_at_ms":1}});
            let bytes = format!("{meta}\n{turn}\n{event}\n");
            if length == 0 {
                length = bytes.len();
            } else {
                assert_eq!(length, bytes.len());
            }
            fs::write(date.join(&parent_leaf), bytes).unwrap();
        }
        let child = json!({"ordinal":3,"type":"session_meta","payload":{"id":OTHER,"history_mode":"paginated","history_base":{"thread_id":ID,"end_ordinal_exclusive":3,"end_byte_offset":length}}});
        let selected = home.join(relative).join(&child_leaf);
        fs::write(&selected, format!("{child}\n")).unwrap();
        fs::hard_link(&selected, alternate.join(relative).join(&child_leaf)).unwrap();
        let home_authority = Directory::profile(&home).unwrap();
        let root = home_authority.child("sessions", false).unwrap();
        let parent = root.child_or_self(Path::new("2026/11/10")).unwrap();
        let expected = super::super::SourceSnapshot::capture(
            &parent.open_file(&child_leaf, libc::O_RDONLY).unwrap(),
        )
        .unwrap();
        let before =
            super::super::anchored_codex(&home_authority, &selected, 50, &expected, &Window::Tail)
                .unwrap();
        assert_eq!(before.messages[0]["blocks"][0]["text"], "original");
        let result = read_during_swap(
            &home,
            &alternate,
            &retired,
            &home_authority,
            &selected,
            &expected,
        );
        if let Ok(page) = result {
            assert_eq!(page.messages[0]["blocks"][0]["text"], "original");
        }
    }

    #[test]
    fn incomplete_discovery_never_selects_a_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("projects");
        fs::create_dir(&root).unwrap();
        let record =
            json!({"type":"user","uuid":"first","sessionId":ID,"message":{"content":"hello"}});
        fs::write(root.join(format!("{ID}.jsonl")), format!("{record}\n")).unwrap();
        for index in 0..10_000 {
            fs::write(root.join(format!("unrelated-{index}")), b"").unwrap();
        }
        assert!(read_in(&root, TranscriptAgent::Claude, ID, 50, &Window::Tail).is_err());
    }
}
