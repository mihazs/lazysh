//! The launcher: what `xdg-open`, `open`, `sensible-browser`, `x-www-browser`, `lazysh-open`
//! and `lazysh-agent browser-open` do. A web URL goes to the attached device; everything else,
//! and every request nobody answers, goes to the next real opener, so an installed shim never
//! breaks a host used at its own desktop.
use super::{shim_names, socket, url};
use serde_json::json;
use std::{
    ffi::{OsStr, OsString},
    fs,
    os::unix::{fs::PermissionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

/// Counts delegations so wrappers that resolve to each other cannot loop.
const DEPTH: &str = "LAZYSH_BROWSER_DEPTH";
const MAX_DEPTH: u32 = 4;
/// The `BROWSER` the user had before the shell startup block replaced it.
pub(super) const ORIGINAL_BROWSER: &str = "LAZYSH_ORIGINAL_BROWSER";
/// `xdg-open`'s own "a required tool could not be found".
const NO_OPENER: u8 = 3;

pub(super) fn run(launcher: &str, args: &[OsString]) -> ExitCode {
    let url = pick(launcher, args);
    if let Some(url) = url {
        let message = json!({"v": super::PROTOCOL, "op": "open", "url": url, "pid": std::process::id(), "as": launcher});
        if let Some(reply) = socket::request(&message) {
            if reply.ok {
                return ExitCode::SUCCESS;
            }
            // The attached device owns browser requests; never pop the host's own desktop instead.
            eprintln!(
                "lazysh: the device did not take the link ({})",
                reply.reason
            );
            return ExitCode::FAILURE;
        }
    }
    delegate(launcher, args, url)
}

/// The URL a launcher call asks to open, if it is one the device may open. Launchers receive
/// more than a URL (`--new-window URL`), so the last web argument wins; macOS `open` takes
/// files and applications too, so there only a lone URL counts.
fn pick<'a>(launcher: &str, args: &'a [OsString]) -> Option<&'a str> {
    let candidate = if launcher == "open" {
        match args {
            [only] => only.to_str(),
            _ => None,
        }
    } else {
        args.iter()
            .filter_map(|arg| arg.to_str())
            .rfind(|text| url::is_web(text))
    };
    candidate.filter(|text| url::valid(text))
}

/// Next opener, in order: the real tool of the same name with the original arguments, the
/// user's own `BROWSER`, then the platform's usual openers.
fn candidates(
    launcher: &str,
    args: &[OsString],
    url: Option<&str>,
    own: &Path,
) -> Vec<(PathBuf, Vec<OsString>)> {
    let mut found = Vec::new();
    if launcher != "lazysh-open" {
        found.extend(find(OsStr::new(launcher), own).map(|path| (path, args.to_vec())));
    }
    let Some(url) = url else {
        return found;
    };
    let saved = std::env::var(ORIGINAL_BROWSER).unwrap_or_default();
    for entry in saved.split(':') {
        // Same convention as BROWSER: words, with `%s` standing for the URL.
        // shortcut: no shell syntax inside an entry (quotes, `&`), wrap such a command in a script.
        let mut words: Vec<String> = entry.split_whitespace().map(str::to_owned).collect();
        if words.is_empty() {
            continue;
        }
        if entry.contains("%s") {
            words
                .iter_mut()
                .for_each(|word| *word = word.replace("%s", url));
        } else {
            words.push(url.to_owned());
        }
        let program = words.remove(0);
        found.extend(
            find(OsStr::new(&program), own)
                .map(|path| (path, words.into_iter().map(Into::into).collect())),
        );
    }
    let usual: &[&str] = if cfg!(target_os = "macos") {
        &["open"]
    } else {
        &["xdg-open", "sensible-browser", "x-www-browser", "wslview"]
    };
    found.extend(usual.iter().filter_map(|name| {
        find(OsStr::new(name), own).map(|path| (path, vec![OsString::from(url)]))
    }));
    found
}

/// What a real opener should see: no wrapper directory on `PATH`, and the `BROWSER` the user had.
fn environment(own: &Path) -> (OsString, Option<String>) {
    let kept: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|dir| {
            !shim_names()
                .iter()
                .any(|name| fs::canonicalize(dir.join(name)).is_ok_and(|real| real == own))
        })
        .collect();
    let browser = match std::env::var(ORIGINAL_BROWSER) {
        Ok(saved) => Some(saved),
        Err(_) => std::env::var("BROWSER")
            .ok()
            .filter(|browser| browser != "lazysh-open"),
    };
    (
        std::env::join_paths(kept).unwrap_or_default(),
        browser.filter(|browser| !browser.is_empty()),
    )
}

fn delegate(launcher: &str, args: &[OsString], url: Option<&str>) -> ExitCode {
    let depth = std::env::var(DEPTH)
        .ok()
        .and_then(|text| text.parse::<u32>().ok())
        .unwrap_or(0);
    let own = fs::canonicalize(std::env::current_exe().unwrap_or_default()).unwrap_or_default();
    if depth < MAX_DEPTH {
        let (path, browser) = environment(&own);
        for (program, arguments) in candidates(launcher, args, url, &own) {
            let mut command = Command::new(program);
            command
                .args(arguments)
                .env(DEPTH, (depth + 1).to_string())
                .env("PATH", &path);
            match &browser {
                Some(browser) => command.env("BROWSER", browser),
                None => command.env_remove("BROWSER"),
            };
            // exec only returns when the program could not start; try the next one.
            let _ = command.exec();
        }
    }
    match url {
        // Nothing can open it here: leave the URL where the terminal's link detection finds it.
        Some(url) => {
            eprintln!("lazysh: open this on your device: {url}");
            ExitCode::SUCCESS
        }
        None => {
            eprintln!("lazysh: {launcher}: no opener found");
            ExitCode::from(NO_OPENER)
        }
    }
}

/// An executable called `name` on `PATH` that is not one of our own wrappers: wrappers are links
/// to this binary, so the same file, or any file named like it, is skipped.
fn find(name: &OsStr, own: &Path) -> Option<PathBuf> {
    let usable = |path: &Path| {
        fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            && fs::canonicalize(path)
                .is_ok_and(|real| real != own && real.file_name() != own.file_name())
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|path| usable(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn only_a_clean_web_url_is_picked() {
        let url = "https://login.example.com/authorize?x=1";
        for (launcher, given, expected) in [
            ("xdg-open", vec![url], Some(url)),
            ("lazysh-open", vec!["--new-window", url], Some(url)),
            ("xdg-open", vec!["https://a.example/", url], Some(url)),
            ("open", vec![url], Some(url)),
            ("open", vec!["-a", "Safari", url], None),
            ("xdg-open", vec!["--version"], None),
            ("xdg-open", vec!["/etc/hosts"], None),
            ("xdg-open", vec!["mailto:a@example.com"], None),
            ("xdg-open", vec!["https://user:pw@example.com/"], None),
            ("xdg-open", vec!["https://example.com/\u{1b}[31m"], None),
        ] {
            assert_eq!(
                pick(launcher, &args(&given)),
                expected,
                "{launcher} {given:?}"
            );
        }
    }
}
