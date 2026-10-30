use super::*;
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
pub(super) async fn detect(session: &Session, lease: &AccessLease) -> Result<Option<Unix>> {
    match ssh::exec_bounded(
        session,
        format!("sh -c {}", ssh::quote(PROBE)),
        lease,
        Duration::from_secs(5),
        8192,
        None,
    )
    .await
    {
        Ok(text) => Ok(parse(&text)),
        Err(error)
            if matches!(
                error.kind(),
                "remote_command_failed" | "invalid_output" | "output_too_large" | "timeout"
            ) =>
        {
            lease.check()?;
            if *session.cancel.borrow() {
                return Err(super::error("disconnected", "Session closed"));
            }
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
impl Unix {
    pub fn target(&self) -> String {
        format!("{}-agent-{}", self.os, self.arch)
    }
    pub fn managed(&self) -> String {
        format!(
            "{}/lazysh/companion/lazysh-agent",
            self.data.trim_end_matches('/')
        )
    }
    fn stat(&self) -> &'static str {
        if self.os == "linux" {
            "stat -c '%u %a %h'"
        } else {
            "stat -f '%u %Lp %l'"
        }
    }
    pub(super) fn command(&self, original: &str) -> Result<String> {
        let suffix = original
            .strip_prefix("lazysh-agent ")
            .ok_or_else(|| error("companion_command", "Invalid companion command"))?;
        // Positive Unix proof is required before this fixed read-only POSIX helper.
        // No SFTP requirement is introduced for existing exec-only hosts.
        let script = format!(
            r#"
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
    exec {original}
fi
"#,
            path = ssh::quote(&self.managed()),
            stat = self.stat(),
            uid = self.uid
        );
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
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let bin = base.join("bin");
        fs::create_dir(&bin).unwrap();
        let legacy = bin.join("lazysh-agent");
        fs::write(&legacy, b"#!/bin/sh\nprintf legacy-owned\n").unwrap();
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
        let execute = || {
            Command::new("/bin/sh")
                .args(["-c", &host.command("lazysh-agent --version").unwrap()])
                .env_clear()
                .env("HOME", root.path())
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .output()
                .unwrap()
        };
        let missing = execute();
        assert!(missing.status.success());
        assert_eq!(missing.stdout, b"legacy-owned");
        fs::create_dir(&data).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(
            !execute().status.success(),
            "a mutable existing namespace is not an absent managed executable"
        );
        assert_eq!(
            fs::read(&legacy).unwrap(),
            b"#!/bin/sh\nprintf legacy-owned\n"
        );
    }
}
