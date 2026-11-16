use super::{powershell::Windows, *};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Unix {
    pub os: &'static str,
    pub arch: &'static str,
    pub uid: u32,
    pub home: String,
    pub data: String,
}
pub(super) fn path(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= 4096
        && !value.chars().any(char::is_control)
        && !value.split('/').any(|p| matches!(p, "." | ".."))
}
const PROBE: &str = "printf 'lazysh-posix-v1\\n'; uname -s; uname -m; id -u; h=$(cd -P \"$HOME\" && pwd -P); printf '%s\\n' \"$h\"; case $(uname -s) in Linux) case ${XDG_DATA_HOME-} in /*) printf '%s\\n' \"$XDG_DATA_HOME\";; *) printf '%s/.local/share\\n' \"$HOME\";; esac;; Darwin) printf '%s/Library/Application Support\\n' \"$h\";; esac";
fn parse(text: &str) -> Option<Unix> {
    let rows = text.trim_end_matches('\n').split('\n').collect::<Vec<_>>();
    if rows.len() != 6 || rows[0] != "lazysh-posix-v1" {
        return None;
    }
    let os = match rows[1] {
        "Linux" => "linux",
        "Darwin" => "macos",
        _ => return None,
    };
    let arch = match rows[2] {
        "x86_64" => "x64",
        "aarch64" | "arm64" => "arm64",
        _ => return None,
    };
    if !path(rows[4])
        || !path(rows[5])
        || rows[3].is_empty()
        || !rows[3].bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some(Unix {
        os,
        arch,
        uid: rows[3].parse().ok()?,
        home: rows[4].into(),
        data: rows[5].into(),
    })
}
/// A host the app positively identified: a Unix shell, or a Windows OpenSSH host that answered the PowerShell probe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Host {
    Unix(Unix),
    Windows(Windows),
}
impl Host {
    /// The Unix host, for what only a Unix shell can do (installation, the Herdr lookup).
    pub(super) fn unix(self) -> Option<Unix> {
        match self {
            Self::Unix(unix) => Some(unix),
            Self::Windows(_) => None,
        }
    }
    pub(super) fn command(&self, original: &str) -> Result<String> {
        match self {
            Self::Unix(unix) => unix.command(original),
            Self::Windows(windows) => windows.command(original),
        }
    }
    /// `original`, answering `marker` instead of failing when the companion is missing or too old to know the command.
    /// With `diagnostics` the companion's stderr is kept, for a caller that reads it.
    pub(super) fn required(
        &self,
        original: &str,
        marker: &str,
        diagnostics: bool,
    ) -> Result<String> {
        match self {
            Self::Unix(unix) => unix.required(original, marker, diagnostics),
            Self::Windows(windows) => windows.required(original, marker, diagnostics),
        }
    }
}
/// What one probe exec learned. `Unknown` means it could not run to an answer (timeout, odd output) and must be asked again.
pub(super) enum Probed {
    Known(Option<Host>),
    Unknown,
}
/// The host's answer, asked once per SSH connection: it cannot change while the connection stands, and every companion
/// command needs it. A probe that did not answer is not remembered.
pub(super) async fn detect(session: &Session, lease: &AccessLease) -> Result<Option<Host>> {
    session
        .handle
        .host_probe
        .resolve(|| probe(session, lease))
        .await
}
/// How one probe exec ended: with text, with a non-zero exit (the shell could not run it) or without an answer.
enum Asked {
    Text(String),
    Failed,
    Unanswered,
}
async fn ask(
    session: &Session,
    lease: &AccessLease,
    command: String,
    wait: Duration,
) -> Result<Asked> {
    let asked = match ssh::exec_bounded(session, command, lease, wait, 8192, None).await {
        Ok(text) => return Ok(Asked::Text(text)),
        Err(error) if error.kind() == "remote_command_failed" => Asked::Failed,
        Err(error)
            if matches!(
                error.kind(),
                "invalid_output" | "output_too_large" | "timeout"
            ) =>
        {
            Asked::Unanswered
        }
        Err(error) => return Err(error),
    };
    lease.check()?;
    if *session.cancel.borrow() {
        return Err(super::error("disconnected", "Session closed"));
    }
    Ok(asked)
}
/// The POSIX probe first. Only when it exits non-zero (no `sh`: the localized shell message cannot be matched) is the
/// Windows probe tried, so a host that answers the first never sees the second. A host that answers neither is asked
/// again next time, as before.
async fn probe(session: &Session, lease: &AccessLease) -> Result<Probed> {
    let posix = format!("sh -c {}", ssh::quote(PROBE));
    Ok(
        match ask(session, lease, posix, Duration::from_secs(5)).await? {
            Asked::Text(text) => Probed::Known(parse(&text).map(Host::Unix)),
            Asked::Unanswered => Probed::Unknown,
            Asked::Failed => {
                match ask(
                    session,
                    lease,
                    Windows::probe_command(),
                    Duration::from_secs(10),
                )
                .await?
                {
                    Asked::Text(text) => Probed::Known(match Windows::parse(&text) {
                        Some(windows) => {
                            Some(Host::Windows(managed(session, lease, windows).await?))
                        }
                        None => None,
                    }),
                    _ => Probed::Unknown,
                }
            }
        },
    )
}
/// The identified Windows host once its managed namespace has been read (one exec) and decided, for the whole
/// connection. A read that fails or does not answer keeps the `PATH` lookup, as does a namespace that is absent or refused.
async fn managed(session: &Session, lease: &AccessLease, windows: Windows) -> Result<Windows> {
    let Ok(command) = windows.namespace_command() else {
        return Ok(windows);
    };
    Ok(
        match ask(session, lease, command, Duration::from_secs(10)).await? {
            Asked::Text(text) => windows.admit(&text),
            _ => windows,
        },
    )
}
impl Unix {
    pub fn target(&self) -> String {
        format!("{}-agent-{}", self.os, self.arch)
    }
    pub fn managed_dir(&self) -> String {
        format!("{}/lazysh/companion", self.data.trim_end_matches('/'))
    }
    pub fn managed(&self) -> String {
        format!("{}/lazysh-agent", self.managed_dir())
    }
    /// The closed choice of managed Herdr artifact for this host: one of the four `<os>-herdr-<arch>` targets.
    pub fn herdr_target(&self) -> String {
        format!("{}-herdr-{}", self.os, self.arch)
    }
    /// The fixed directory, beside the companion's and never inside Herdr's own `lazysh-herdr` application namespace.
    pub fn herdr_dir(&self) -> String {
        format!("{}/lazysh/herdr", self.data.trim_end_matches('/'))
    }
    pub fn herdr(&self) -> String {
        format!("{}/lazysh-herdr", self.herdr_dir())
    }
    fn stat(&self) -> &'static str {
        if self.os == "linux" {
            "stat -c '%u %a %h'"
        } else {
            "stat -f '%u %Lp %l'"
        }
    }
    pub(super) fn command(&self, original: &str) -> Result<String> {
        self.command_inner(original, false)
    }
    /// Confirm the private managed executable itself, without falling back to PATH.
    pub(super) fn managed_command(&self, original: &str) -> Result<String> {
        self.command_inner(original, true)
    }
    fn command_inner(&self, original: &str, managed_only: bool) -> Result<String> {
        let suffix = original
            .strip_prefix("lazysh-agent ")
            .ok_or_else(|| error("companion_command", "Invalid companion command"))?;
        // Positive Unix proof is required before this fixed read-only POSIX helper.
        // No SFTP requirement is introduced for existing exec-only hosts.
        // The app's own version, for a companion that can update itself to it; older ones ignore it.
        let script = format!(
            r#"
LAZYSH_APP_VERSION={app}; export LAZYSH_APP_VERSION
invalid() {{ printf 'Invalid managed companion namespace or executable\n' >&2; exit 73; }}
set -f
p={path}
r="$p"
while [ "$r" != / ] && [ -n "$r" ]; do
    [ ! -L "$r" ] || invalid
    if [ "$r" != "$p" ] && [ -e "$r" ]; then
        [ -d "$r" ] && [ -x "$r" ] || invalid
        info=$({stat} "$r") || invalid
        set -- $info
        [ "$#" -eq 3 ] || invalid
        case "$1" in ''|*[!0-9]*) invalid;; esac
        case "$2" in ''|*[!0-7]*) invalid;; esac
        [ "$1" = 0 ] || [ "$1" = {uid} ] || invalid
        if [ "$((0$2 & 022))" -ne 0 ]; then
            [ "$1" = 0 ] && [ "$((0$2 & 01000))" -ne 0 ] || invalid
        fi
    fi
    r=${{r%/*}}
done
if [ -e "$p" ] || [ -L "$p" ]; then
    [ -f "$p" ] && [ -x "$p" ] && [ "$({stat} "$p")" = '{uid} 700 1' ] || invalid
    exec "$p" {suffix}
else
    {fallback}
fi
"#,
            app = ssh::quote(env!("CARGO_PKG_VERSION")),
            path = ssh::quote(&self.managed()),
            stat = self.stat(),
            uid = self.uid,
            fallback = if managed_only {
                "exit 127".to_owned()
            } else {
                format!("exec {original}")
            }
        );
        Ok(format!("sh -c {}", ssh::quote(&script)))
    }
    pub(super) fn required(
        &self,
        original: &str,
        marker: &str,
        diagnostics: bool,
    ) -> Result<String> {
        let resolved = self.command(original)?;
        let redirect = if diagnostics { "" } else { "2>/dev/null" };
        let script=format!("{resolved} {redirect}; code=$?; case $code in 2|126|127) printf '%s\\n' {};; *) exit \"$code\";; esac",ssh::quote(marker));
        Ok(format!("sh -c {}", ssh::quote(&script)))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_positive_bounded_unix_shapes_enable_the_helper() {
        let linux = "lazysh-posix-v1\nLinux\nx86_64\n1000\n/home/owned\n/home/owned/.local/share\n";
        let host = parse(linux).unwrap();
        assert_eq!(host.target(), "linux-agent-x64");
        let command = host.command("lazysh-agent snapshot --limit 50").unwrap();
        assert!(command.contains("Invalid managed companion"));
        assert!(command.contains("exec lazysh-agent snapshot --limit 50"));
        for text in [
            "Windows_NT",
            "'sh' is not recognized",
            "{\"schemaVersion\":1}",
            &linux.replace("Linux", "MINGW64_NT"),
            // Only the architectures with a published companion are accepted.
            &linux.replace("x86_64", "riscv64"),
            &linux.replace("x86_64", "armv7l"),
            &linux.replace("x86_64", "i686"),
            &linux.replace("/home/owned", "/home/../owned"),
            &format!("banner\n{linux}"),
        ] {
            assert!(parse(text).is_none(), "{text}");
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn real_read_only_helper_preserves_legacy_and_refuses_mutable_managed_namespace() {
        use std::{
            fs,
            os::unix::fs::{MetadataExt, PermissionsExt},
            process::Command,
        };
        const LEGACY: &[u8] = b"#!/bin/sh\nprintf 'legacy-owned %s' \"$LAZYSH_APP_VERSION\"\n";
        let version = env!("CARGO_PKG_VERSION");
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let bin = base.join("bin");
        fs::create_dir(&bin).unwrap();
        let legacy = bin.join("lazysh-agent");
        fs::write(&legacy, LEGACY).unwrap();
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o700)).unwrap();
        let data = base.join("data's folder");
        let host = Unix {
            os: if cfg!(target_os = "macos") {
                "macos"
            } else {
                "linux"
            },
            arch: "x64",
            uid: fs::metadata(root.path()).unwrap().uid(),
            home: base.to_string_lossy().into(),
            data: data.to_string_lossy().into(),
        };
        let execute = |managed: bool| {
            let script = if managed {
                host.managed_command("lazysh-agent --version")
            } else {
                host.command("lazysh-agent --version")
            }
            .unwrap();
            Command::new("/bin/sh")
                .args(["-c", &script])
                .env_clear()
                .env("HOME", root.path())
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .output()
                .unwrap()
        };
        let missing = execute(false);
        assert!(missing.status.success());
        // Every command the app runs tells the companion which app asks, whichever copy answers.
        assert_eq!(missing.stdout, format!("legacy-owned {version}").as_bytes());
        assert!(
            !execute(true).status.success(),
            "PATH is not evidence of a managed executable"
        );
        fs::create_dir(&data).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(
            !execute(false).status.success(),
            "a mutable existing namespace is not an absent managed executable"
        );
        assert_eq!(fs::read(&legacy).unwrap(), LEGACY);
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
        let managed = data.join("lazysh/companion/lazysh-agent");
        fs::create_dir_all(managed.parent().unwrap()).unwrap();
        for directory in [data.join("lazysh"), data.join("lazysh/companion")] {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(
            &managed,
            b"#!/bin/sh\nprintf 'managed-owned %s' \"$LAZYSH_APP_VERSION\"\n",
        )
        .unwrap();
        fs::set_permissions(&managed, fs::Permissions::from_mode(0o700)).unwrap();
        for managed in [false, true] {
            assert_eq!(
                execute(managed).stdout,
                format!("managed-owned {version}").as_bytes()
            );
        }
    }
}
