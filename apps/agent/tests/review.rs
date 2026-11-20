//! `lazysh-agent review` against real temporary Git repositories: the exit codes, both output modes,
//! the app's size bounds, hostile names, the language of the help, and that no byte of the repository
//! changes.
#![cfg(unix)]
#[path = "support/binary.rs"]
mod binary;

use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{Duration, SystemTime},
};

/// Git without the developer's own configuration, so the cases do not depend on it.
fn git_command(directory: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(directory)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            // `git commit` otherwise detaches a background maintenance run whose lock file
            // (`.git/objects/maintenance.lock`) comes and goes while the cases snapshot the repository.
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
        ]);
    command
}
fn git(directory: &Path, args: &[&str]) {
    let output = git_command(directory).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
}
fn repository(parent: &Path, name: &str) -> PathBuf {
    let directory = parent.join(name);
    fs::create_dir(&directory).unwrap();
    git(&directory, &["init", "-q"]);
    directory
}
fn commit_all(directory: &Path) {
    git(directory, &["add", "--", "."]);
    git(directory, &["commit", "-qm", "initial"]);
}

/// `a.txt` gets "two" staged and "three" on top of it, unstaged.
fn stage_then_edit(repo: &Path) {
    fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    git(repo, &["add", "a.txt"]);
    fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
}

fn review(args: &[&str]) -> Output {
    review_in("C", args, &[])
}
fn review_in(locale: &str, args: &[&str], environment: &[(&str, &str)]) -> Output {
    let mut all = vec!["review"];
    all.extend_from_slice(args);
    run_in(locale, &all, environment)
}
/// Runs the binary with this language and nothing else of the user's locale or Git environment.
fn run_in(locale: &str, args: &[&str], environment: &[(&str, &str)]) -> Output {
    let mut command = Command::new(binary::path());
    command
        .args(args)
        .env_clear()
        .envs(std::env::vars().filter(|(name, _)| name == "PATH" || name == "HOME"))
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .envs(environment.iter().copied());
    if !locale.is_empty() {
        command.env("LC_ALL", locale);
    }
    command.output().unwrap()
}
fn stdout(output: &Output) -> String {
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout.clone()).unwrap()
}
fn failure(output: &Output) -> String {
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    String::from_utf8(output.stderr.clone()).unwrap()
}
fn json_of(output: &Output) -> Value {
    let text = stdout(output);
    assert_eq!(text.matches('\n').count(), 1, "one line: {text}");
    serde_json::from_str(&text).unwrap()
}
fn path_of(directory: &Path) -> &str {
    directory.to_str().unwrap()
}

/// Every file of the tree, `.git` included, with its bytes.
fn snapshot(directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, files);
            } else {
                files.insert(
                    path.strip_prefix(root).unwrap().into(),
                    fs::read(&path).unwrap(),
                );
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(directory, directory, &mut files);
    files
}

#[test]
fn status_reports_every_kind_of_change_in_both_modes_and_changes_nothing() {
    let parent = tempfile::tempdir().unwrap();
    let repo = repository(parent.path(), "repo");
    fs::create_dir(repo.join("nested")).unwrap();
    fs::write(repo.join("a.txt"), "one\n").unwrap();
    fs::write(repo.join("old.txt"), "moved\n").unwrap();
    fs::write(repo.join("touched.txt"), "same\n").unwrap();
    fs::write(repo.join("nested/file.txt"), "deep\n").unwrap();
    commit_all(&repo);
    stage_then_edit(&repo);
    git(&repo, &["mv", "old.txt", "new.txt"]);
    fs::write(repo.join("untracked.txt"), "new\n").unwrap();
    // Same bytes, another modification time: a plain `git status` refreshes the index for it.
    let touched = fs::File::options()
        .write(true)
        .open(repo.join("touched.txt"))
        .unwrap();
    touched
        .set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    let before = snapshot(&repo);

    // A subdirectory resolves to the repository root, as in the app.
    let nested = repo.join("nested");
    let text = stdout(&review(&["status", path_of(&nested)]));
    let root = fs::canonicalize(&repo).unwrap();
    assert_eq!(
        text,
        format!(
            "{}\nMM a.txt\nR  old.txt -> new.txt\n?? untracked.txt\n",
            root.display()
        )
    );
    let value = json_of(&review(&["status", "--json", path_of(&nested)]));
    assert_eq!(
        value,
        json!({
            "schemaVersion": 1,
            "path": root.to_str().unwrap(),
            "changes": [
                {"path": "a.txt", "originalPath": null, "index": "M", "worktree": "M"},
                {"path": "new.txt", "originalPath": "old.txt", "index": "R", "worktree": " "},
                {"path": "untracked.txt", "originalPath": null, "index": "?", "worktree": "?"},
            ],
        })
    );
    assert_eq!(
        value,
        json_of(&review(&["--json", "status", path_of(&repo)]))
    );
    assert_eq!(
        snapshot(&repo),
        before,
        "review must not write to the repository"
    );

    // A clean repository prints its root and no changes.
    let clean = repository(parent.path(), "clean");
    fs::write(clean.join("f"), "x").unwrap();
    commit_all(&clean);
    let root = fs::canonicalize(&clean).unwrap();
    assert_eq!(
        stdout(&review(&["status", path_of(&clean)])),
        format!("{}\n", root.display())
    );
    assert_eq!(
        json_of(&review(&["status", "--json", path_of(&clean)]))["changes"],
        json!([])
    );
}

#[test]
fn diff_prints_the_unstaged_or_staged_patch_and_marks_a_binary_file() {
    let parent = tempfile::tempdir().unwrap();
    let repo = repository(parent.path(), "repo");
    fs::write(repo.join("a.txt"), "one\n").unwrap();
    fs::write(repo.join("binary.dat"), [0, 255, 34, 10]).unwrap();
    commit_all(&repo);
    stage_then_edit(&repo);
    fs::write(repo.join("binary.dat"), [0, 244]).unwrap();
    let before = snapshot(&repo);
    let directory = path_of(&repo);

    let unstaged = stdout(&review(&["diff", directory, "a.txt"]));
    assert!(
        unstaged.starts_with("diff --git a/a.txt b/a.txt\n"),
        "{unstaged}"
    );
    assert!(unstaged.ends_with(" one\n two\n+three\n"), "{unstaged}");
    let staged = stdout(&review(&["diff", "--staged", directory, "a.txt"]));
    assert!(staged.ends_with(" one\n+two\n"), "{staged}");
    assert!(!staged.contains("three"), "{staged}");
    for (flags, patch) in [(&[][..], unstaged), (&["--staged"][..], staged)] {
        let mut args = vec!["diff", "--json"];
        args.extend_from_slice(flags);
        args.extend([directory, "a.txt"]);
        assert_eq!(
            json_of(&review(&args)),
            json!({"schemaVersion": 1, "patch": patch, "binary": false})
        );
    }

    let binary = json_of(&review(&["diff", "--json", directory, "binary.dat"]));
    assert_eq!(binary["binary"], true);
    assert!(binary["patch"].as_str().unwrap().contains("Binary files"));
    // Nothing changed in the file: an empty patch, not an error.
    assert_eq!(
        stdout(&review(&["diff", directory, "binary.dat", "--staged"])),
        ""
    );
    assert_eq!(
        snapshot(&repo),
        before,
        "review must not write to the repository"
    );
}

#[test]
fn hostile_names_stay_literal_and_cannot_drive_the_terminal() {
    let parent = tempfile::tempdir().unwrap();
    let repo = repository(parent.path(), "repo';$() name");
    let hostile = "--strange\tname\nfile.txt";
    fs::write(repo.join(hostile), "before\n").unwrap();
    fs::write(repo.join("=config.txt"), "before\n").unwrap();
    fs::write(repo.join("escape.txt"), "before\n").unwrap();
    commit_all(&repo);
    fs::write(repo.join(hostile), "after\n").unwrap();
    fs::write(repo.join("=config.txt"), "after\n").unwrap();
    fs::write(repo.join("escape.txt"), "after \u{1b}[31mred\n").unwrap();
    let directory = path_of(&repo);

    let text = stdout(&review(&["status", directory]));
    assert!(
        text.contains("\n M --strange\\tname\\nfile.txt\n"),
        "{text}"
    );
    assert!(!text.contains('\t'), "{text}");
    let value = json_of(&review(&["status", "--json", directory]));
    assert!(value["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|change| change["path"] == hostile));

    // The name of a file after the directory is a literal pathspec, never an option or a glob.
    for file in [hostile, "=config.txt"] {
        let patch = stdout(&review(&["diff", directory, "--", file]));
        assert!(patch.contains("-before\n+after\n"), "{file}: {patch}");
    }
    let patch = stdout(&review(&["diff", directory, "escape.txt"]));
    assert!(patch.contains("+after \\u{1b}[31mred\n"), "{patch}");
    assert!(!patch.contains('\u{1b}'), "{patch:?}");
    let raw = json_of(&review(&["diff", "--json", directory, "escape.txt"]));
    assert!(raw["patch"]
        .as_str()
        .unwrap()
        .contains("+after \u{1b}[31mred\n"));
    assert_eq!(
        stdout(&review(&["diff", directory, "*.txt"])),
        "",
        "a glob matches nothing"
    );
}

#[test]
fn an_inherited_git_directory_does_not_replace_the_named_repository() {
    let parent = tempfile::tempdir().unwrap();
    let named = repository(parent.path(), "named");
    let other = repository(parent.path(), "other");
    fs::write(named.join("named.txt"), "x").unwrap();
    fs::write(other.join("other.txt"), "x").unwrap();
    commit_all(&other);
    let other_git = other.join(".git");
    let output = review_in(
        "C",
        &["status", "--json", path_of(&named)],
        &[("GIT_DIR", path_of(&other_git))],
    );
    let paths: Vec<_> = json_of(&output)["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|change| change["path"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(paths, ["named.txt"]);
}

#[test]
fn what_the_app_refuses_is_refused_with_a_failure_and_no_output() {
    let parent = tempfile::tempdir().unwrap();
    let plain = parent.path().join("not-a-repository");
    fs::create_dir(&plain).unwrap();
    assert!(failure(&review(&["status", path_of(&plain)])).contains("ReviewNotARepository"));
    assert!(failure(&review(&["diff", path_of(&plain), "f"])).contains("ReviewNotARepository"));
    assert!(failure(&review(&["status", ""])).contains("ReviewInvalidDirectory"));

    let repo = repository(parent.path(), "repo");
    fs::write(repo.join("a.txt"), "x\n").unwrap();
    commit_all(&repo);
    let directory = path_of(&repo);
    for file in ["../outside", "/etc/passwd", "x/../../outside", ""] {
        assert!(
            failure(&review(&["diff", directory, file])).contains("ReviewInvalidFilePath"),
            "{file}"
        );
    }
    // Usage errors are the parser's: exit status 2.
    assert_eq!(review(&["diff", directory]).status.code(), Some(2));
    assert_eq!(review(&["blame", directory]).status.code(), Some(2));

    // More than 10,000 changed files, as in the app; exactly 10,000 is shown.
    let many = repo.join("many");
    fs::create_dir(&many).unwrap();
    for number in 0..10_000 {
        fs::write(many.join(format!("{number}")), "").unwrap();
    }
    let value = json_of(&review(&["status", "--json", directory]));
    assert_eq!(value["changes"].as_array().unwrap().len(), 10_000);
    fs::write(repo.join("one-more"), "").unwrap();
    assert!(failure(&review(&["status", directory])).contains("ReviewTooManyChanges"));

    // More than 10,000 diff lines, and more than 1 MiB of Git output in few lines.
    fs::remove_dir_all(&many).unwrap();
    fs::remove_file(repo.join("one-more")).unwrap();
    fs::write(repo.join("a.txt"), "x\n".repeat(10_000)).unwrap();
    assert!(failure(&review(&["diff", directory, "a.txt"])).contains("ReviewDiffTooLarge"));
    fs::write(repo.join("a.txt"), "y".repeat(1024 * 1024 + 1)).unwrap();
    assert!(failure(&review(&["diff", directory, "a.txt"])).contains("ReviewOutputTooLarge"));
    fs::write(repo.join("a.txt"), "y".repeat(1024 * 1024 - 1024)).unwrap();
    assert!(stdout(&review(&["diff", directory, "a.txt"])).len() > 1024 * 1000);
}

#[test]
fn help_is_written_in_the_language_of_the_environment() {
    let help = |locale: &str, environment: &[(&str, &str)], args: &[&str]| {
        let mut all = args.to_vec();
        all.push("--help");
        stdout(&review_in(locale, &all, environment))
    };
    let english = ("Usage:", "Print the patch of one changed file", "Options");
    let portuguese = ("Uso:", "Imprime o patch de um arquivo alterado", "Opções");
    let spanish = (
        "Uso:",
        "Imprime el parche de un archivo modificado",
        "Opciones",
    );
    for (text, (usage, about, options)) in [
        (help("en_US.UTF-8", &[], &["diff"]), english),
        (help("pt_BR.UTF-8", &[], &["diff"]), portuguese),
        (help("es_ES", &[], &["diff"]), spanish),
        // LC_ALL wins over LC_MESSAGES, which wins over LANG.
        (help("es_ES", &[("LANG", "pt_BR")], &["diff"]), spanish),
        (help("", &[("LANG", "pt_BR.UTF-8")], &["diff"]), portuguese),
        (
            help("", &[("LC_MESSAGES", "es"), ("LANG", "pt_BR")], &["diff"]),
            spanish,
        ),
        // An unsupported or missing language is English.
        (help("fr_FR.UTF-8", &[], &["diff"]), english),
        (help("", &[], &["diff"]), english),
    ] {
        assert!(text.contains(usage) && text.contains(about), "{text}");
        assert!(text.contains(&format!("{options}:")), "{text}");
    }
    let status = help("pt_BR.UTF-8", &[], &["status"]);
    assert!(
        status.contains("Lista os arquivos alterados") && status.contains("<DIRETÓRIO>"),
        "{status}"
    );
    let listing = help("es_ES.UTF-8", &[], &[]);
    assert!(
        listing.contains("Revisa un repositorio") && listing.contains("Comandos:"),
        "{listing}"
    );
    // The help of the whole program lists the command with its localized summary.
    let top = stdout(&run_in("pt_BR.UTF-8", &["--help"], &[]));
    assert!(top.contains("Revisa um repositório"), "{top}");
}
