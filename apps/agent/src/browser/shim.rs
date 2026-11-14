//! `browser-shim install|status|uninstall`: the wrappers and the shell startup blocks that put
//! them first on `PATH`. Everything stays under the user's home; nothing needs root.
use super::{launcher::ORIGINAL_BROWSER, shim_names, socket, ShimCommand};
use crate::{Error, Result};
use lazysh_common::storage_namespace;
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{symlink, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const BEGIN: &str = "# >>> lazysh browser shim >>>";
const END: &str = "# <<< lazysh browser shim <<<";
const LARGEST_STARTUP_FILE: u64 = 1 << 20;

#[derive(Clone, Copy)]
enum Shell {
    Profile,
    Bash,
    Zsh,
    Fish,
}
impl Shell {
    fn name(self) -> &'static str {
        match self {
            Self::Profile => "profile",
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
        }
    }
}
struct Startup {
    path: PathBuf,
    shell: Shell,
    /// Whether install may create the file; the other files are edited only when they exist.
    create: bool,
}
struct Layout {
    home: PathBuf,
    shims: PathBuf,
    target: PathBuf,
    startup: Vec<Startup>,
}

fn absolute_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}
fn layout() -> Result<Layout> {
    let home = dirs::home_dir()
        .filter(|home| home.is_absolute())
        .ok_or(Error::Browser("BrowserNoHome"))?;
    let home = fs::canonicalize(home)?;
    let data = dirs::data_local_dir().ok_or(Error::Browser("BrowserNoHome"))?;
    let companion = storage_namespace::resolve(&data.join("lazysh/companion"))?;
    if !companion.starts_with(&home) {
        return Err(Error::Browser("BrowserOutsideHome"));
    }
    // The managed copy keeps working across companion updates; any other copy is used as it is.
    let managed = companion.join("lazysh-agent");
    let target = if fs::symlink_metadata(&managed).is_ok_and(|m| m.is_file()) {
        managed
    } else {
        fs::canonicalize(std::env::current_exe()?)?
    };
    let config = absolute_env("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
    let mut startup = vec![
        Startup {
            path: home.join(".profile"),
            shell: Shell::Profile,
            create: true,
        },
        Startup {
            path: home.join(".bashrc"),
            shell: Shell::Bash,
            create: false,
        },
        Startup {
            path: home.join(".bash_profile"),
            shell: Shell::Bash,
            create: false,
        },
        Startup {
            path: absolute_env("ZDOTDIR")
                .unwrap_or_else(|| home.clone())
                .join(".zshrc"),
            shell: Shell::Zsh,
            create: false,
        },
    ];
    if config.join("fish").is_dir() {
        startup.push(Startup {
            path: config.join("fish/conf.d/lazysh-browser.fish"),
            shell: Shell::Fish,
            create: true,
        });
    }
    Ok(Layout {
        shims: companion.join("shims"),
        home,
        target,
        startup,
    })
}

/// The text install appends: it begins with a newline so removal restores the file byte for byte.
fn block(shell: Shell, shims: &Path) -> Result<String> {
    let dir = shims
        .to_str()
        .filter(|dir| !dir.chars().any(char::is_control))
        .ok_or(Error::Browser("BrowserUnsafeShimDirectory"))?;
    let body = if matches!(shell, Shell::Fish) {
        let q = dir.replace('\\', "\\\\").replace('\'', "\\'");
        format!(
            "if status is-interactive; and test -d '{q}'\n    test \"$PATH[1]\" = '{q}'; or set -gx PATH '{q}' $PATH\n    if test \"$BROWSER\" != lazysh-open\n        set -gx {ORIGINAL_BROWSER} \"$BROWSER\"\n    end\n    set -gx BROWSER lazysh-open\nend\n"
        )
    } else {
        let q = dir.replace('\'', "'\\''");
        format!(
            "case $- in *i*)\n  d='{q}'\n  if [ -d \"$d\" ]; then\n    case \":$PATH:\" in \":$d:\"*) ;; *) PATH=\"$d:$PATH\"; export PATH ;; esac\n    if [ \"${{BROWSER-}}\" != lazysh-open ]; then {ORIGINAL_BROWSER}=\"${{BROWSER-}}\"; export {ORIGINAL_BROWSER}; fi\n    BROWSER=lazysh-open; export BROWSER\n  fi\n  unset d ;;\nesac\n"
        )
    };
    Ok(format!("\n{BEGIN}\n# Managed by `lazysh-agent browser-shim`; `lazysh-agent browser-shim uninstall` removes it.\n{body}{END}\n"))
}

fn find(haystack: &[u8], needle: &str) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle.as_bytes())
}
/// Byte range of the block with the newline before and after it, `None` when absent.
fn span(content: &[u8]) -> std::result::Result<Option<(usize, usize)>, &'static str> {
    let Some(begin) = find(content, BEGIN) else {
        return Ok(None);
    };
    let end = find(&content[begin..], END).ok_or("unterminatedBlock")? + begin + END.len();
    let end = end + usize::from(content.get(end) == Some(&b'\n'));
    let start = begin - usize::from(begin > 0 && content[begin - 1] == b'\n');
    Ok(Some((start, end)))
}
fn splice(content: &[u8], insert: &[u8]) -> std::result::Result<Vec<u8>, &'static str> {
    Ok(match span(content)? {
        Some((start, end)) => [&content[..start], insert, &content[end..]].concat(),
        None => [content, insert].concat(),
    })
}

fn canonical(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A dangling link is not a missing file: writing there would replace the link.
            if fs::symlink_metadata(path).is_ok() {
                return Err(error);
            }
            let (parent, name) = path.parent().zip(path.file_name()).ok_or(error)?;
            Ok(canonical(parent)?.join(name))
        }
        other => other,
    }
}
/// A startup file may be a link (a dotfiles repository), but never one that leaves the home.
fn contained(path: &Path, home: &Path) -> std::result::Result<PathBuf, &'static str> {
    let real = canonical(path).map_err(|_| "unreadable")?;
    if real.starts_with(home) {
        Ok(real)
    } else {
        Err("outsideHome")
    }
}

fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let name = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let temporary = path.with_file_name(format!(
        ".{}.lazysh-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temporary)
        .and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all()))
        .and_then(|()| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Add (`Some(block)`) or remove (`None`) the block in one startup file: (state, reason).
fn edit(entry: &Startup, home: &Path, block: Option<&str>) -> (&'static str, Option<&'static str>) {
    let real = match contained(&entry.path, home) {
        Ok(real) => real,
        Err(reason) => return ("skipped", Some(reason)),
    };
    let (content, mode) = match fs::metadata(&real) {
        Ok(m) if m.is_file() && m.uid() != socket::euid() => return ("skipped", Some("notOwned")),
        Ok(m) if m.is_file() && m.mode() & 0o200 == 0 => return ("skipped", Some("readOnly")),
        Ok(m) if m.is_file() && m.len() <= LARGEST_STARTUP_FILE => match fs::read(&real) {
            Ok(content) => (Some(content), m.mode() & 0o7777),
            Err(_) => return ("failed", Some("unreadable")),
        },
        Ok(_) => return ("skipped", Some("notAFileOrTooLarge")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (None, 0o644),
        Err(_) => return ("failed", Some("unreadable")),
    };
    let old = content.clone().unwrap_or_default();
    let next = match block {
        Some(_) if content.is_none() && !entry.create => return ("missing", None),
        Some(block) => splice(&old, block.as_bytes()),
        None if content.is_none() => return ("absent", None),
        None => splice(&old, b""),
    };
    let next = match next {
        Ok(next) => next,
        Err(reason) => return ("failed", Some(reason)),
    };
    if content.is_some() && next == old {
        return (
            if block.is_some() {
                "unchanged"
            } else {
                "absent"
            },
            None,
        );
    }
    // A file only install could have created, left empty by removal, goes away with the block.
    let outcome = if block.is_none() && next.is_empty() && entry.create {
        fs::remove_file(&real)
    } else {
        real.parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| write_atomic(&real, &next, mode))
    };
    match outcome {
        Ok(()) => (
            if block.is_some() {
                "installed"
            } else {
                "removed"
            },
            None,
        ),
        Err(_) => ("failed", Some("notWritable")),
    }
}

fn startup_state(entry: &Startup, home: &Path, shims: &Path) -> Result<Value> {
    let expected = block(entry.shell, shims)?;
    let (state, reason) = match contained(&entry.path, home) {
        Err(reason) => ("skipped", Some(reason)),
        Ok(real) => match fs::read(&real) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => ("missing", None),
            Err(_) => ("failed", Some("unreadable")),
            Ok(content) => match span(&content) {
                Ok(None) => ("absent", None),
                Ok(Some((start, end))) if content[start..end] == *expected.as_bytes() => {
                    ("current", None)
                }
                Ok(Some(_)) => ("stale", None),
                Err(reason) => ("failed", Some(reason)),
            },
        },
    };
    Ok(report(entry, state, reason))
}
fn report(entry: &Startup, state: &str, reason: Option<&str>) -> Value {
    json!({"path": entry.path, "shell": entry.shell.name(), "state": state, "reason": reason})
}

fn link_state(path: &Path, target: &Path) -> &'static str {
    match fs::symlink_metadata(path) {
        Err(_) => "missing",
        Ok(m) if m.file_type().is_symlink() && fs::read_link(path).is_ok_and(|to| to == target) => {
            "present"
        }
        Ok(m) if m.file_type().is_symlink() => "stale",
        Ok(_) => "conflict",
    }
}
fn link(shims: &Path, name: &str, target: &Path) -> &'static str {
    let path = shims.join(name);
    match link_state(&path, target) {
        "present" => "unchanged",
        "conflict" => "conflict",
        _ => {
            let staging = shims.join(format!(".{name}.{}", std::process::id()));
            let _ = fs::remove_file(&staging);
            if symlink(target, &staging)
                .and_then(|()| fs::rename(&staging, &path))
                .is_ok()
            {
                "linked"
            } else {
                let _ = fs::remove_file(&staging);
                "failed"
            }
        }
    }
}
fn unlink(shims: &Path, name: &str) -> &'static str {
    let path = shims.join(name);
    match fs::symlink_metadata(&path) {
        Err(_) => "absent",
        // Only links: the directory is ours, but a regular file there is not something install wrote.
        Ok(m) if m.file_type().is_symlink() && fs::remove_file(&path).is_ok() => "removed",
        Ok(_) => "kept",
    }
}

/// Add (`install`) or remove the startup blocks: each file's report row and its state.
fn edit_all(layout: &Layout, install: bool) -> Result<Vec<(Value, &'static str)>> {
    layout
        .startup
        .iter()
        .map(|entry| {
            let text = if install {
                Some(block(entry.shell, &layout.shims)?)
            } else {
                None
            };
            let (state, reason) = edit(entry, &layout.home, text.as_deref());
            Ok((report(entry, state, reason), state))
        })
        .collect()
}
/// The report of a change: every wrapper's and startup file's outcome, and whether all went through.
fn changed(
    layout: &Layout,
    action: &str,
    entries: &[(&str, &'static str)],
    files: Vec<(Value, &str)>,
    complete: bool,
) -> Value {
    let rows: Vec<Value> = entries
        .iter()
        .map(|(name, state)| json!({"name": name, "state": state}))
        .collect();
    json!({
        "schemaVersion": 1, "action": action, "complete": complete,
        "shims": {"directory": layout.shims, "target": layout.target, "entries": rows},
        "startup": files.into_iter().map(|(value, _)| value).collect::<Vec<_>>(),
    })
}

pub(super) fn run(command: ShimCommand) -> Result<Value> {
    let layout = layout()?;
    let Layout { shims, target, .. } = &layout;
    match command {
        ShimCommand::Install => {
            storage_namespace::create(shims).map_err(|error| match error.kind() {
                io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => {
                    Error::Browser("BrowserHomeNotWritable")
                }
                _ => error.into(),
            })?;
            let entries: Vec<_> = shim_names()
                .iter()
                .map(|name| (*name, link(shims, name, target)))
                .collect();
            let files = edit_all(&layout, true)?;
            // Wrappers nobody can reach are not an install: some startup file must carry the block.
            let complete = entries
                .iter()
                .all(|(_, state)| matches!(*state, "linked" | "unchanged"))
                && files.iter().all(|(_, state)| *state != "failed")
                && files
                    .iter()
                    .any(|(_, state)| matches!(*state, "installed" | "unchanged"));
            Ok(changed(&layout, "install", &entries, files, complete))
        }
        ShimCommand::Status => {
            let entries: Vec<Value> = shim_names()
                .iter()
                .map(|name| json!({"name": name, "state": link_state(&shims.join(name), target)}))
                .collect();
            let files = layout
                .startup
                .iter()
                .map(|entry| startup_state(entry, &layout.home, shims))
                .collect::<Result<Vec<_>>>()?;
            let attached = socket::request(&json!({"v": super::PROTOCOL, "op": "probe"}))
                .is_some_and(|reply| reply.watcher);
            let installed = entries.iter().all(|entry| entry["state"] == "present")
                && files.iter().any(|file| file["state"] == "current");
            Ok(json!({
                "schemaVersion": 1, "action": "status", "installed": installed,
                "shims": {"directory": shims, "target": target, "entries": entries},
                "startup": files, "watcher": {"attached": attached},
            }))
        }
        ShimCommand::Uninstall => {
            let entries: Vec<_> = shim_names()
                .iter()
                .map(|name| (*name, unlink(shims, name)))
                .collect();
            // Each removal fails, and so keeps its directory, while anything else lives in it.
            for directory in shims.ancestors().take(3) {
                let _ = fs::remove_dir(directory);
            }
            let files = edit_all(&layout, false)?;
            let complete = files.iter().all(|(_, state)| *state != "failed");
            Ok(changed(&layout, "uninstall", &entries, files, complete))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHIMS: &str = "/home/u/.local/share/lazysh/companion/shims";

    #[test]
    fn removal_restores_every_original_shape_byte_for_byte() {
        let text = block(Shell::Bash, Path::new(SHIMS)).unwrap();
        for original in [
            "",
            "a",
            "a\n",
            "a\n\n",
            "# x\nexport A=1\n\n\nexport B=2",
            "é\r\n",
        ] {
            let once = splice(original.as_bytes(), text.as_bytes()).unwrap();
            assert_eq!(
                splice(&once, text.as_bytes()).unwrap(),
                once,
                "idempotent {original:?}"
            );
            assert_eq!(
                splice(&once, b"").unwrap(),
                original.as_bytes(),
                "{original:?}"
            );
        }
    }

    #[test]
    fn an_unterminated_block_is_never_cut() {
        let content = format!("keep\n{BEGIN}\nhand edited\n");
        assert_eq!(
            splice(content.as_bytes(), b"").unwrap_err(),
            "unterminatedBlock"
        );
    }

    #[test]
    fn the_directory_is_quoted_for_its_shell() {
        let tricky = Path::new("/home/o'brien/$(x)/shims");
        assert!(block(Shell::Zsh, tricky)
            .unwrap()
            .contains(r"d='/home/o'\''brien/$(x)/shims'"));
        assert!(block(Shell::Fish, tricky)
            .unwrap()
            .contains(r"'/home/o\'brien/$(x)/shims'"));
        assert!(block(Shell::Bash, Path::new("/home/u/\n")).is_err());
    }
}
