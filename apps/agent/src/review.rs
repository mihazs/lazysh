//! `lazysh-agent review`: the repository review of the app's Diff view, for a terminal on the host.
//! It runs the app's read-only Git commands (`lazysh_common::repository_review`) under the app's
//! bounds (1 MiB of Git output, 10,000 changed files, 10,000 diff lines) and changes nothing in the
//! repository: Git neither refreshes the index nor runs an external diff or text conversion.
mod help;

use crate::{devices, Error, Result};
use clap::{Args, Subcommand};
use lazysh_common::repository_review::{self as review, Invalid, Status};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Write,
    process::Command as Process,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

pub use help::{locale_from_environment, localize};

/// The app's bound on the output of one Git command, and its deadline.
const OUTPUT_LIMIT: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
/// What would make Git read another repository than the one named on the command line.
const REPOSITORY_ENV: [&str; 4] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
];

#[derive(Args, Debug)]
pub struct Arguments {
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    Status {
        directory: String,
    },
    Diff {
        directory: String,
        file: String,
        #[arg(long)]
        staged: bool,
    },
}

impl From<Invalid> for Error {
    fn from(invalid: Invalid) -> Self {
        Self::Review(match invalid {
            Invalid::Directory => "ReviewInvalidDirectory",
            Invalid::FilePath => "ReviewInvalidFilePath",
            Invalid::StatusOutput | Invalid::UnknownStatus | Invalid::IncompleteRename => {
                "ReviewInvalidOutput"
            }
            Invalid::TooManyChanges => "ReviewTooManyChanges",
            Invalid::DiffTooLarge => "ReviewDiffTooLarge",
        })
    }
}

pub fn run(arguments: Arguments, out: &mut impl Write) -> Result<()> {
    let cancelled = devices::cancellation_signal()?;
    let git = |directory: &str, args: &[&str]| read(&review::git(directory, args)?, &cancelled);
    let root = |directory: &str| {
        git(directory, &review::TOPLEVEL_ARGS).map_err(|error| match error {
            Error::Review("ReviewGitFailed") => Error::Review("ReviewNotARepository"),
            other => other,
        })
    };
    match arguments.command {
        Command::Status { directory } => {
            let root = root(&directory)?;
            let root = review::toplevel(&root);
            let status = review::status(root, &git(root, &review::STATUS_ARGS)?)?;
            if arguments.json {
                write_json(out, &status)
            } else {
                write_status(out, &status)
            }
        }
        Command::Diff {
            directory,
            file,
            staged,
        } => {
            let root = root(&directory)?;
            let root = review::toplevel(&root);
            let read = |options: &[&str]| {
                read(
                    &review::diff_command(root, options, staged, &file)?,
                    &cancelled,
                )
            };
            let stats = read(&review::NUMSTAT_OPTIONS)?;
            let diff = review::diff(&stats, read(&review::PATCH_OPTIONS)?)?;
            if arguments.json {
                write_json(out, &diff)
            } else {
                write!(out, "{}", printable(&diff.patch, &['\n', '\t']))?;
                Ok(())
            }
        }
    }
}

/// What a Git command printed; a failure of any kind is one `Review` class.
fn read(argv: &[&str], cancelled: &Arc<AtomicBool>) -> Result<String> {
    let mut command = Process::new(argv[0]);
    command
        .args(&argv[1..])
        .envs(review::GIT_ENV.iter().copied());
    for name in REPOSITORY_ENV {
        command.env_remove(name);
    }
    let bytes = devices::bounded_command(command, OUTPUT_LIMIT, cancelled.clone(), DEADLINE)
        .map_err(|error| match error {
            Error::Device("SdkUnavailable") => Error::Review("ReviewGitUnavailable"),
            Error::Device("SdkCommandFailed") => Error::Review("ReviewGitFailed"),
            Error::Device("DeviceTimeout") => Error::Review("ReviewTimeout"),
            Error::Device("DeviceOutputTooLarge") => Error::Review("ReviewOutputTooLarge"),
            Error::Device("DeviceCancelled") => Error::Review("ReviewCancelled"),
            other => other,
        })?;
    String::from_utf8(bytes).map_err(|_| Error::Review("ReviewInvalidOutput"))
}

fn write_json(out: &mut impl Write, value: &impl Serialize) -> Result<()> {
    let mut value = serde_json::to_value(value).map_err(|_| Error::InvalidEvent)?;
    value["schemaVersion"] = Value::from(1);
    serde_json::to_writer(&mut *out, &value).map_err(|_| Error::InvalidEvent)?;
    writeln!(out)?;
    Ok(())
}

/// The repository root, then one line per change in the format of `git status --short`.
fn write_status(out: &mut impl Write, status: &Status) -> Result<()> {
    writeln!(out, "{}", printable(&status.path, &[]))?;
    for change in &status.changes {
        let path = printable(&change.path, &[]);
        let path = match &change.original_path {
            Some(original) => format!("{} -> {path}", printable(original, &[])),
            None => path,
        };
        writeln!(out, "{}{} {path}", change.index, change.worktree)?;
    }
    Ok(())
}

/// File names and file contents are the repository's, not ours: a control character such as ESC would
/// drive the reader's terminal, so it is written as an escape (`\u{1b}`), except those in `keep`.
fn printable(text: &str, keep: &[char]) -> String {
    let mut shown = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_control() && !keep.contains(&character) {
            shown.extend(character.escape_default());
        } else {
            shown.push(character);
        }
    }
    shown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_characters_cannot_reach_the_terminal() {
        assert_eq!(
            printable("a\u{1b}[31mb\nc\td\r", &[]),
            "a\\u{1b}[31mb\\nc\\td\\r"
        );
        assert_eq!(printable("x\ny\tz\u{7}", &['\n', '\t']), "x\ny\tz\\u{7}");
    }

    #[test]
    fn status_text_is_the_root_then_the_short_format_with_renames_shown_as_an_arrow() {
        let status = review::status(
            "/repo",
            "R  new.txt\0old.txt\0 M edited.txt\0?? un\ntracked.txt\0",
        )
        .unwrap();
        let mut out = Vec::new();
        write_status(&mut out, &status).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "/repo\nR  old.txt -> new.txt\n M edited.txt\n?? un\\ntracked.txt\n"
        );
    }
}
