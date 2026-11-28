//! Finding a native program the way Windows starts one: through the PATH directories in order,
//! each tried with the program name plus every `PATHEXT` extension a process can be started from.
//! Discovery, one-shot actions and attach all go through here, so they agree on what is installed.
use std::{
    ffi::{OsStr, OsString},
    path::PathBuf,
};

/// The `PATHEXT` entries a PTY can start without a shell. `.bat` and `.cmd` are `PATHEXT` entries
/// too, but a batch file needs `cmd.exe` and its unsafe argument escaping, so they never resolve.
const STARTABLE: [&str; 2] = ["com", "exe"];

/// The first `PATH` match for `program` (a bare name), keeping the `PATHEXT` order. A missing or
/// empty `PATHEXT`, or one with no startable entry, means `.exe` alone.
pub(crate) fn resolve(path: &OsStr, pathext: Option<&OsStr>, program: &str) -> Option<PathBuf> {
    let mut extensions: Vec<String> = pathext
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default()
        .split(';')
        .filter_map(|entry| entry.trim().strip_prefix('.'))
        .map(str::to_ascii_lowercase)
        .filter(|entry| STARTABLE.contains(&entry.as_str()))
        .collect();
    if extensions.is_empty() {
        extensions.push("exe".into());
    }
    std::env::split_paths(path).find_map(|directory| {
        extensions
            .iter()
            .filter_map(|extension| {
                std::path::absolute(directory.join(format!("{program}.{extension}"))).ok()
            })
            .find(|candidate| candidate.is_file())
    })
}

/// Whether `program` resolves on `path`: on Windows as `resolve` finds it, elsewhere a file of
/// that name in a `PATH` directory.
pub(crate) fn on_path(windows: bool, path: &OsStr, pathext: Option<&OsStr>, program: &str) -> bool {
    if windows {
        resolve(path, pathext, program).is_some()
    } else {
        std::env::split_paths(path).any(|directory| directory.join(program).is_file())
    }
}

/// What a local one-shot command starts. Windows starts the file `resolve` finds, so a `.com`
/// program that `CreateProcess` would not search for still runs; a program that is not found keeps
/// its name and fails to start with the usual error. Elsewhere the name is left to the `PATH`
/// search of the spawn.
pub(crate) fn start(
    windows: bool,
    path: &OsStr,
    pathext: Option<&OsStr>,
    program: &str,
) -> OsString {
    if windows {
        if let Some(found) = resolve(path, pathext, program) {
            return found.into_os_string();
        }
    }
    program.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn directory_with(files: &[&str]) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        for file in files {
            std::fs::write(directory.path().join(file), b"").unwrap();
        }
        directory
    }
    fn path_of(directories: &[&tempfile::TempDir]) -> OsString {
        std::env::join_paths(directories.iter().map(|directory| directory.path())).unwrap()
    }
    fn found(path: &OsStr, pathext: Option<&str>, program: &str) -> Option<String> {
        resolve(path, pathext.map(OsStr::new), program)
            .map(|found| found.file_name().unwrap().to_string_lossy().into_owned())
    }

    #[test]
    fn the_first_path_directory_wins_over_a_better_extension_further_on() {
        let (first, second) = (
            directory_with(&["zellij.com"]),
            directory_with(&["zellij.exe"]),
        );
        let path = path_of(&[&first, &second]);
        assert_eq!(
            found(&path, Some(".EXE;.COM"), "zellij").as_deref(),
            Some("zellij.com")
        );
    }

    #[test]
    fn extensions_follow_pathext_order_ignoring_case() {
        let directory = directory_with(&["herdr.com", "herdr.exe"]);
        let path = path_of(&[&directory]);
        assert_eq!(
            found(&path, Some(".EXE;.COM"), "herdr").as_deref(),
            Some("herdr.exe")
        );
        assert_eq!(
            found(&path, Some(".com;.exe"), "herdr").as_deref(),
            Some("herdr.com")
        );
    }

    #[test]
    fn exe_is_used_without_a_usable_pathext() {
        let directory = directory_with(&["zellij.exe"]);
        let path = path_of(&[&directory]);
        for pathext in [None, Some(""), Some(".BAT;.CMD"), Some("EXE")] {
            assert_eq!(
                found(&path, pathext, "zellij").as_deref(),
                Some("zellij.exe"),
                "{pathext:?}"
            );
        }
    }

    #[test]
    fn batch_files_and_bare_names_are_not_programs() {
        let directory = directory_with(&["zellij.cmd", "zellij.bat", "zellij", "herdr.exe.txt"]);
        let path = path_of(&[&directory]);
        assert_eq!(found(&path, Some(".COM;.EXE;.BAT;.CMD"), "zellij"), None);
        assert_eq!(found(&path, None, "herdr"), None);
    }

    #[test]
    fn a_relative_path_entry_resolves_to_an_absolute_executable() {
        let dir = tempfile::tempdir_in(".").unwrap();
        std::fs::write(dir.path().join("zellij.exe"), b"").unwrap();
        let relative = dir.path().file_name().unwrap();
        let candidate = resolve(relative, None, "zellij").unwrap();
        assert!(candidate.is_absolute(), "resolved path was {candidate:?}");
        assert_eq!(
            candidate,
            std::path::absolute(dir.path().join("zellij.exe")).unwrap()
        );
    }

    #[test]
    fn a_directory_named_like_a_program_is_not_one() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("zellij.exe")).unwrap();
        assert_eq!(found(directory.path().as_os_str(), None, "zellij"), None);
    }
}
