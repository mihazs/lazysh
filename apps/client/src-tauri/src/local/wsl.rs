//! Host tools inside a WSL distribution. Commands run as `wsl.exe -d <distro> --cd ~ -e <argv>`
//! (argv, never a shell string) and files are read through `\\wsl.localhost\<distro>\` with
//! `std::fs`. A WSL session names every path as a Linux path; a `\\wsl.localhost\<distro>\` path
//! of this distribution and a Windows drive path (translated with `wslpath`) are accepted too,
//! and every other UNC or device path is refused.
use super::Tools;
use crate::ssh::{Result, SshError};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const UNC_HOST: &str = "wsl.localhost";
const PATH_LIMIT: usize = 4096;
/// A distribution that has not started yet needs a moment; `git --version` needs no more.
const PROBE_DEADLINE: Duration = Duration::from_secs(10);

/// One distribution: the `wsl.exe` that starts it and the UNC root its files are read through.
#[derive(Clone, Debug)]
pub(crate) struct Wsl {
    program: PathBuf,
    distro: String,
    root: PathBuf,
}
/// Where a renderer path points, with every component checked.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Located {
    /// An absolute Linux path in this distribution, such as `/home/me/project`.
    Linux(String),
    /// A Windows drive path such as `C:\Users\me`, which `wslpath -u` turns into a Linux path.
    Drive(String),
}

impl Wsl {
    pub(super) fn new(program: PathBuf, distro: String) -> Self {
        let root = PathBuf::from(format!(r"\\{UNC_HOST}\{distro}"));
        Self {
            program,
            distro,
            root,
        }
    }
    /// A distribution whose files live under `root`, for tests on a host without WSL.
    #[cfg(test)]
    pub(crate) fn with_root(program: PathBuf, distro: &str, root: PathBuf) -> Self {
        Self {
            root,
            ..Self::new(program, distro.into())
        }
    }
    /// What running `argv` with `env` in this distribution starts: the `wsl.exe` argument list,
    /// from the user's home directory. A command's constant environment goes through `env`,
    /// which `wsl.exe` does not forward by itself.
    pub(crate) fn argv(&self, env: &[(&str, &str)], argv: &[String]) -> Vec<String> {
        let mut command = vec![
            self.program.to_string_lossy().into_owned(),
            "-d".into(),
            self.distro.clone(),
            "--cd".into(),
            "~".into(),
            "-e".into(),
        ];
        if !env.is_empty() {
            command.push("env".into());
            command.extend(env.iter().map(|(name, value)| format!("{name}={value}")));
        }
        command.extend_from_slice(argv);
        command
    }

    /// Classifies a path the renderer sent. Refused: a relative path, another UNC host or
    /// distribution, a device path (`\\?\`, `\\.\`), and any `.` or `..` component.
    pub(crate) fn locate(&self, path: &str) -> Result<Located> {
        let refuse = |message: &str| Err(SshError::new("invalid_path", message));
        if path.is_empty() || path.len() > PATH_LIMIT || path.chars().any(char::is_control) {
            return refuse("Invalid path");
        }
        if path.starts_with('/') {
            // A backslash would be a separator once the path is read through the UNC share.
            return components(path.split('/'), |part| !part.contains('\\')).map(Located::Linux);
        }
        if let Some(unc) = path.strip_prefix(r"\\") {
            let mut parts = unc.split('\\');
            return match (parts.next(), parts.next()) {
                (Some(host), Some(share))
                    if host.eq_ignore_ascii_case(UNC_HOST)
                        && share.eq_ignore_ascii_case(&self.distro) =>
                {
                    components(parts.flat_map(|part| part.split('/')), |_| true).map(Located::Linux)
                }
                _ => refuse(&format!(
                    r"Only \\{UNC_HOST}\{}\ paths are available for this WSL target",
                    self.distro
                )),
            };
        }
        let mut bytes = path.bytes();
        if bytes
            .next()
            .is_some_and(|drive| drive.is_ascii_alphabetic())
            && bytes.next() == Some(b':')
            && matches!(bytes.next(), Some(b'\\' | b'/'))
        {
            components(path[3..].split(['\\', '/']), |_| true)?;
            return Ok(Located::Drive(path.to_owned()));
        }
        refuse("Enter an absolute path such as /home/user")
    }
    /// The Linux path `wslpath -u -a <drive path>` printed: a clean absolute path or nothing.
    pub(crate) fn translated(&self, output: &[u8]) -> Result<String> {
        match std::str::from_utf8(output).map(|text| self.locate(text.trim_end_matches('\n'))) {
            Ok(Ok(Located::Linux(path))) => Ok(path),
            _ => Err(SshError::new(
                "invalid_output",
                "wslpath did not return a Linux path",
            )),
        }
    }
    /// The path `std::fs` opens for a Linux path of this distribution. Built by appending,
    /// never `join`: a component such as `C:` would otherwise replace the whole root.
    pub(crate) fn fs_path(&self, linux: &str) -> PathBuf {
        let mut path = self.root.clone().into_os_string();
        for part in linux.split('/').filter(|part| !part.is_empty()) {
            path.push(std::path::MAIN_SEPARATOR_STR);
            path.push(part);
        }
        PathBuf::from(path)
    }
    /// The Linux path of something `std::fs` resolved inside this distribution, such as where a
    /// symbolic link points; `None` when it leaves the distribution.
    pub(crate) fn linux_path(&self, resolved: &Path) -> Option<String> {
        let text = resolved.to_string_lossy();
        let text = match text.strip_prefix(r"\\?\UNC\") {
            Some(unc) => format!(r"\\{unc}"),
            None => text.into_owned(),
        };
        let inside = Path::new(&text).strip_prefix(&self.root).ok()?;
        let parts = inside
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>();
        Some(format!("/{}", parts.join("/")))
    }

    /// Host tools this distribution can offer: `git` starts inside it. The check starts the
    /// distribution if it is stopped, which WSL stops again when it has been idle.
    pub(crate) async fn tools(&self) -> Tools {
        let git = self.runs(&["git".into(), "--version".into()]).await;
        // Attachments and previews act on this Windows device, so they stay off (`Host::refuse_in_wsl`).
        Tools {
            files: git,
            repository: git,
            ..Tools::default()
        }
    }
    async fn runs(&self, argv: &[String]) -> bool {
        use std::process::Stdio;
        let argv = self.argv(&[], argv);
        let mut command = tokio::process::Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let Ok((mut child, _tree)) = lazysh_account_usage::spawn_owned(&mut command) else {
            return false;
        };
        matches!(
            tokio::time::timeout(PROBE_DEADLINE, child.wait()).await,
            Ok(Ok(status)) if status.success()
        )
    }
}

/// `/a/b` for the components of a path, each one checked; the root is `/`.
fn components<'a>(
    parts: impl Iterator<Item = &'a str>,
    allowed: impl Fn(&str) -> bool,
) -> Result<String> {
    let mut path = String::new();
    for part in parts.filter(|part| !part.is_empty()) {
        if matches!(part, "." | "..") || !allowed(part) {
            return Err(SshError::new("invalid_path", "Invalid path"));
        }
        path.push('/');
        path.push_str(part);
    }
    Ok(if path.is_empty() { "/".into() } else { path })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ubuntu() -> Wsl {
        Wsl::new(
            PathBuf::from(r"C:\Windows\System32\wsl.exe"),
            "Ubuntu".into(),
        )
    }
    fn locate(path: &str) -> std::result::Result<Located, &'static str> {
        ubuntu().locate(path).map_err(|error| error.kind())
    }
    fn linux(path: &str) -> Located {
        Located::Linux(path.into())
    }

    #[test]
    fn a_command_runs_as_argv_from_the_home_directory_with_its_environment_through_env() {
        let argv = ["git".to_owned(), "-C".into(), "/home/me/a b; $(x)".into()];
        assert_eq!(
            ubuntu().argv(&[], &argv),
            [
                r"C:\Windows\System32\wsl.exe",
                "-d",
                "Ubuntu",
                "--cd",
                "~",
                "-e",
                "git",
                "-C",
                "/home/me/a b; $(x)"
            ]
        );
        assert_eq!(
            ubuntu().argv(&[("GIT_OPTIONAL_LOCKS", "0")], &argv)[6..9],
            ["env", "GIT_OPTIONAL_LOCKS=0", "git"]
        );
    }

    #[test]
    fn linux_paths_unc_paths_of_this_distribution_and_drive_paths_are_accepted() {
        assert_eq!(locate("/"), Ok(linux("/")));
        assert_eq!(locate("/home//me/"), Ok(linux("/home/me")));
        assert_eq!(locate("/mnt/c/Users/Me Q"), Ok(linux("/mnt/c/Users/Me Q")));
        assert_eq!(locate(r"\\wsl.localhost\Ubuntu"), Ok(linux("/")));
        assert_eq!(
            locate(r"\\WSL.LOCALHOST\ubuntu\home\me\a.txt"),
            Ok(linux("/home/me/a.txt"))
        );
        assert_eq!(
            locate(r"\\wsl.localhost\Ubuntu\home/me"),
            Ok(linux("/home/me"))
        );
        assert_eq!(
            locate(r"C:\Users\me\a b"),
            Ok(Located::Drive(r"C:\Users\me\a b".into()))
        );
        assert_eq!(locate("d:/x"), Ok(Located::Drive("d:/x".into())));
    }

    #[test]
    fn other_hosts_distributions_device_paths_escapes_and_relative_paths_are_refused() {
        for refused in [
            r"\\wsl.localhost\Debian\home\me",
            r"\\wsl.localhost",
            r"\\wsl$\Ubuntu\home\me",
            r"\\server\share\file",
            r"\\?\C:\Windows",
            r"\\?\UNC\wsl.localhost\Ubuntu\home",
            r"\\.\pipe\x",
            r"\\wsl.localhost\Ubuntu\home\..\..\Debian\x",
            r"\\wsl.localhost\Ubuntu\..",
            "/home/me/../../etc",
            "/home/./me",
            "/home\\..\\Debian",
            r"C:\Users\..\Windows",
            "C:",
            "C:foo",
            "relative/path",
            "~",
            "",
            "/home/me\0",
            "/home/me\n",
        ] {
            assert_eq!(locate(refused), Err("invalid_path"), "{refused:?}");
        }
        assert_eq!(
            locate(&format!("/{}", "a".repeat(PATH_LIMIT))),
            Err("invalid_path")
        );
    }

    #[test]
    fn a_linux_path_maps_under_the_distribution_root_and_cannot_replace_it() {
        let root = r"\\wsl.localhost\Ubuntu";
        let sep = std::path::MAIN_SEPARATOR;
        let expected = |tail: &str| format!("{root}{}", tail.replace('/', &sep.to_string()));
        assert_eq!(
            ubuntu().fs_path("/home/me/a.txt"),
            PathBuf::from(expected("/home/me/a.txt"))
        );
        assert_eq!(ubuntu().fs_path("/"), PathBuf::from(root));
        // A component that is a drive prefix is appended, not treated as an absolute path.
        assert_eq!(ubuntu().fs_path("/x/C:"), PathBuf::from(expected("/x/C:")));
    }

    #[test]
    fn what_wslpath_prints_must_be_a_clean_linux_path() {
        let wsl = ubuntu();
        assert_eq!(
            wsl.translated(b"/mnt/c/Users/me\n").unwrap(),
            "/mnt/c/Users/me"
        );
        for output in [
            &b""[..],
            b"C:\\Users\\me\n",
            b"relative\n",
            b"/mnt/../etc\n",
            b"\xff\xfe",
            b"wslpath: C:foo: No such file or directory\n",
        ] {
            assert_eq!(wsl.translated(output).unwrap_err().kind(), "invalid_output");
        }
    }

    #[test]
    fn a_resolved_path_maps_back_only_while_it_stays_in_the_distribution() {
        let rooted = Wsl::with_root(
            PathBuf::from("wsl.exe"),
            "Ubuntu",
            PathBuf::from("/srv/ubuntu"),
        );
        assert_eq!(
            rooted
                .linux_path(Path::new("/srv/ubuntu/home/me"))
                .as_deref(),
            Some("/home/me")
        );
        assert_eq!(
            rooted.linux_path(Path::new("/srv/ubuntu")).as_deref(),
            Some("/")
        );
        assert_eq!(rooted.linux_path(Path::new("/srv/other/home")), None);
        assert_eq!(rooted.linux_path(Path::new("/etc/passwd")), None);
    }

    /// `fs::canonicalize` answers with the verbatim spelling of a share.
    #[cfg(windows)]
    #[test]
    fn windows_spells_a_resolved_share_path_two_ways() {
        for inside in [
            r"\\wsl.localhost\Ubuntu\home\me\target",
            r"\\?\UNC\wsl.localhost\Ubuntu\home\me\target",
        ] {
            assert_eq!(
                ubuntu().linux_path(Path::new(inside)).as_deref(),
                Some("/home/me/target")
            );
        }
        assert_eq!(ubuntu().linux_path(Path::new(r"C:\Users\me")), None);
        assert_eq!(
            ubuntu().linux_path(Path::new(r"\\wsl.localhost\Debian\home")),
            None
        );
    }
}
