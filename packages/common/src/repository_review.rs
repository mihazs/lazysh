//! The read-only Git readers behind repository review. The app runs them on a connected host or on
//! this desktop, and `lazysh-agent review` runs them on the host it is installed on. Both build the
//! same commands and read the same output, so the two report the same changes and the same diffs.
use serde::Serialize;

pub const ENTRY_LIMIT: usize = 10_000;
pub const DIFF_LINE_LIMIT: usize = 10_000;
/// Fixed environment of every review command: no index refresh and no replacement objects.
pub const GIT_ENV: &[(&str, &str)] =
    &[("GIT_OPTIONAL_LOCKS", "0"), ("GIT_NO_REPLACE_OBJECTS", "1")];
/// `git <TOPLEVEL_ARGS>` prints the repository root of the directory.
pub const TOPLEVEL_ARGS: [&str; 2] = ["rev-parse", "--show-toplevel"];
/// `git <STATUS_ARGS>` prints the changed files in the format `status` parses.
pub const STATUS_ARGS: [&str; 5] = [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=all",
];
/// Options of the two reads `diff` combines: whether the file is binary, and its patch.
pub const NUMSTAT_OPTIONS: [&str; 2] = ["--numstat", "-z"];
pub const PATCH_OPTIONS: [&str; 2] = ["--no-color", "--no-renames"];

/// Why review refused a directory, a path or what Git printed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Invalid {
    Directory,
    FilePath,
    StatusOutput,
    UnknownStatus,
    IncompleteRename,
    TooManyChanges,
    DiffTooLarge,
}
impl Invalid {
    pub fn message(self) -> &'static str {
        match self {
            Self::Directory => "Invalid repository directory",
            Self::FilePath => "Select a repository-relative file path",
            Self::StatusOutput => "Invalid Git status output",
            Self::UnknownStatus => "Unknown Git status",
            Self::IncompleteRename => "Incomplete Git rename record",
            Self::TooManyChanges => "Repository has more than 10,000 changed files",
            Self::DiffTooLarge => {
                "Diff preview exceeds 10,000 lines; review a smaller change in the terminal"
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub original_path: Option<String>,
    pub index: String,
    pub worktree: String,
}
#[derive(Debug, Serialize)]
pub struct Status {
    pub path: String,
    pub changes: Vec<Change>,
}
#[derive(Debug, Serialize)]
pub struct Diff {
    pub patch: String,
    pub binary: bool,
}

/// The command line of `git args` run in `directory`, from the program name on. The directory is one
/// argument and every path is a literal pathspec, so nothing is ever parsed by a shell or by Git.
pub fn git<'a>(directory: &'a str, args: &[&'a str]) -> Result<Vec<&'a str>, Invalid> {
    if directory.is_empty() || directory.len() > 4096 || directory.contains('\0') {
        return Err(Invalid::Directory);
    }
    let mut argv = vec![
        "git",
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotePath=false",
        "-C",
        directory,
    ];
    argv.extend_from_slice(args);
    Ok(argv)
}

/// A path inside a repository: relative, without `..`, and short enough for Git.
pub fn check_file_path(value: &str) -> Result<(), Invalid> {
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || value.starts_with('/')
        || value.split('/').any(|part| part == "..")
    {
        return Err(Invalid::FilePath);
    }
    Ok(())
}

/// The command line that reads `file` of the repository at `directory`, staged or not, with `options`.
pub fn diff_command<'a>(
    directory: &'a str,
    options: &[&'a str],
    staged: bool,
    file: &'a str,
) -> Result<Vec<&'a str>, Invalid> {
    check_file_path(file)?;
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
    args.extend_from_slice(options);
    if staged {
        args.push("--cached");
    }
    args.extend_from_slice(&["--", file]);
    git(directory, &args)
}

/// The repository root out of what `TOPLEVEL_ARGS` printed.
pub fn toplevel(output: &str) -> &str {
    output.strip_suffix('\n').unwrap_or(output)
}

/// The repository root and the changes `STATUS_ARGS` printed in it.
pub fn status(toplevel: &str, porcelain: &str) -> Result<Status, Invalid> {
    let mut parts = porcelain.split_terminator('\0');
    let mut changes = Vec::new();
    while let Some(record) = parts.next() {
        if record.len() < 4 || record.as_bytes()[2] != b' ' || !record.is_char_boundary(3) {
            return Err(Invalid::StatusOutput);
        }
        let state = &record.as_bytes()[..2];
        if !state.iter().all(|b| b" MADRCU?!T".contains(b)) {
            return Err(Invalid::UnknownStatus);
        }
        let original_path = if state.contains(&b'R') || state.contains(&b'C') {
            Some(parts.next().ok_or(Invalid::IncompleteRename)?.to_owned())
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
            return Err(Invalid::TooManyChanges);
        }
    }
    Ok(Status {
        path: toplevel.to_owned(),
        changes,
    })
}

/// The patch Git printed for a file and what `--numstat -z` printed for it.
pub fn diff(numstat: &str, patch: String) -> Result<Diff, Invalid> {
    if patch.lines().count() > DIFF_LINE_LIMIT {
        return Err(Invalid::DiffTooLarge);
    }
    Ok(Diff {
        binary: numstat
            .split_terminator('\0')
            .any(|row| row.starts_with("-\t-\t")),
        patch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_relative_escape_and_an_unusable_directory() {
        for file in ["", "../outside", "/etc/passwd", "x/../../outside", "x\0y"] {
            assert_eq!(
                diff_command("/repo", &[], false, file).unwrap_err(),
                Invalid::FilePath
            );
        }
        for directory in ["", "x\0y", &"d".repeat(4097)] {
            assert_eq!(git(directory, &[]).unwrap_err(), Invalid::Directory);
        }
    }

    #[test]
    fn a_hostile_looking_file_name_stays_one_literal_pathspec_after_the_separator() {
        let argv = diff_command(
            "/repo dir",
            &["--numstat"],
            true,
            "--help;$(touch harmless)",
        )
        .unwrap();
        assert_eq!(
            argv,
            [
                "git",
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.quotePath=false",
                "-C",
                "/repo dir",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--numstat",
                "--cached",
                "--",
                "--help;$(touch harmless)",
            ]
        );
    }

    #[test]
    fn reads_every_kind_of_change_and_the_original_path_of_a_rename() {
        let status = status(
            toplevel("/repo\n"),
            "R  new.txt\0old.txt\0 M edited.txt\0?? untracked.txt\0A  staged.txt\0",
        )
        .unwrap();
        assert_eq!(status.path, "/repo");
        let seen: Vec<_> = status
            .changes
            .iter()
            .map(|change| {
                (
                    change.path.as_str(),
                    change.original_path.as_deref(),
                    change.index.as_str(),
                    change.worktree.as_str(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                ("new.txt", Some("old.txt"), "R", " "),
                ("edited.txt", None, " ", "M"),
                ("untracked.txt", None, "?", "?"),
                ("staged.txt", None, "A", " "),
            ]
        );
    }

    #[test]
    fn refuses_what_git_does_not_print_and_more_changes_than_the_limit() {
        assert_eq!(
            status("/r", "R  broken\0").unwrap_err(),
            Invalid::IncompleteRename
        );
        assert_eq!(status("/r", "x\0").unwrap_err(), Invalid::StatusOutput);
        assert_eq!(
            status("/r", "Z  file\0").unwrap_err(),
            Invalid::UnknownStatus
        );
        let many = "?? f\0".repeat(ENTRY_LIMIT);
        assert_eq!(status("/r", &many).unwrap().changes.len(), ENTRY_LIMIT);
        assert_eq!(
            status("/r", &format!("{many}?? f\0")).unwrap_err(),
            Invalid::TooManyChanges
        );
    }

    #[test]
    fn a_diff_is_binary_when_git_counts_no_lines_and_refused_past_the_line_limit() {
        assert!(diff("-\t-\tbinary.dat\0", String::new()).unwrap().binary);
        assert!(!diff("1\t1\ttext.txt\0", "x\n".into()).unwrap().binary);
        let lines = "+x\n".repeat(DIFF_LINE_LIMIT);
        assert!(diff("", lines.clone()).is_ok());
        assert_eq!(
            diff("", format!("{lines}+x\n")).unwrap_err(),
            Invalid::DiffTooLarge
        );
    }
}
