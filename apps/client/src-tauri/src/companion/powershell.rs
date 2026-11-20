//! Windows OpenSSH hosts. The server runs a command through its default shell: `cmd.exe`, Windows PowerShell or
//! something else, and each unquotes differently. Both the probe and every companion command therefore travel as
//! `powershell.exe ... -EncodedCommand <base64 of the UTF-16LE script>`, a line made only of fixed words and base64,
//! which none of those shells (nor a POSIX one) changes. Windows PowerShell 5.1 is assumed, as in ADR 0003.
use super::{error, words, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};

/// What the probe prints first: the answer of a host that ran it, never of one that merely echoes a command.
const MARKER: &str = "lazysh-windows-v1";
/// The marker, the architecture (`PROCESSOR_ARCHITEW6432` names the real one under emulation), the user's SID and
/// the local application data directory as base64 of UTF-8, so a non-ASCII profile path survives the console code page.
const PROBE: &str = "$a=$env:PROCESSOR_ARCHITEW6432
if(-not $a){$a=$env:PROCESSOR_ARCHITECTURE}
'lazysh-windows-v1'
$a
[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('LocalApplicationData')))";
/// Output as UTF-8 (the console's code page would garble a transcript), and the first `lazysh-agent` program on the
/// `PATH`: PowerShell never runs one from the current directory, which `cmd.exe` would.
const FIND: &str = "try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{}
$e=Get-Command lazysh-agent -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1";
/// `cmd.exe` takes 8,191 characters per line, the shell's own prefix included (`"C:\Windows\System32\cmd.exe" /c ` is 33).
const LIMIT: usize = 8191 - 100;

/// A Windows host the probe identified. Installation stays unsupported; the managed executable is not resolved yet.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(super) struct Windows {
    pub arch: &'static str,
    pub sid: String,
    /// `%LOCALAPPDATA%`, where the managed companion belongs.
    pub data: String,
}

fn sid(value: &str) -> bool {
    let parts = value.strip_prefix("S-1-").map(|rest| rest.split('-'));
    parts.is_some_and(|parts| {
        let parts = parts.collect::<Vec<_>>();
        (2..=16).contains(&parts.len())
            && parts.iter().all(|part| {
                (1..=10).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit())
            })
    })
}
/// An absolute path on a drive: no relative components, no characters Windows forbids, no UNC share.
fn path(value: &str) -> bool {
    let rest = value.get(3..).filter(|_| {
        let head = value.as_bytes();
        head[0].is_ascii_alphabetic() && &head[1..3] == b":\\"
    });
    rest.is_some_and(|rest| {
        value.len() <= 1024
            && !value
                .chars()
                .any(|c| c.is_control() || "\"<>|*?/".contains(c))
            && rest
                .split('\\')
                .all(|part| !matches!(part, "" | "." | ".."))
    })
}
/// PowerShell reads all five of these as a single quote, so each is doubled inside a single-quoted string.
fn literal(value: &str) -> String {
    let mut text = String::from("'");
    for c in value.chars() {
        text.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            text.push(c);
        }
    }
    text.push('\'');
    text
}
fn encode(script: &str) -> String {
    let utf16 = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    format!(
        "powershell.exe -NoProfile -NonInteractive -InputFormat None -EncodedCommand {}",
        STANDARD.encode(utf16)
    )
}
fn checked(script: &str) -> Result<String> {
    let command = encode(script);
    if command.len() > LIMIT {
        return Err(error(
            "companion_command",
            "Companion command is too long for a Windows host",
        ));
    }
    Ok(command)
}
/// The arguments of a companion command line, each as a PowerShell literal after a space. Windows PowerShell 5.1
/// builds a native command's line itself and drops an empty argument, mangles a double quote, and ends a quoted
/// argument that finishes with a backslash in an escaped quote; an argument it cannot pass as written is refused,
/// not changed.
fn arguments(original: &str) -> Result<String> {
    let refused = || {
        error(
            "companion_command",
            "Companion argument cannot be passed to a Windows host",
        )
    };
    if !original.starts_with("lazysh-agent ") {
        return Err(error("companion_command", "Invalid companion command"));
    }
    words(original)?
        .into_iter()
        .skip(1)
        .map(|word| {
            let quotes = word
                .chars()
                .any(|c| matches!(c, '"' | '\u{201C}'..='\u{201F}'));
            let open = word.ends_with('\\') && word.contains(char::is_whitespace);
            if word.is_empty() || quotes || open || word.chars().any(char::is_control) {
                return Err(refused());
            }
            Ok(format!(" {}", literal(&word)))
        })
        .collect()
}

impl Windows {
    pub(super) fn probe_command() -> String {
        encode(PROBE)
    }
    /// A probe answer is exactly the marker, a known architecture, a SID and a base64 path, one per line (the
    /// console ends them with CR LF). Anything else, a banner included, is not a Windows host to rely on.
    pub(super) fn parse(text: &str) -> Option<Windows> {
        let rows = text.lines().collect::<Vec<_>>();
        let [MARKER, arch, sid_row, data] = rows[..] else {
            return None;
        };
        let arch = match arch {
            "AMD64" => "x64",
            "ARM64" => "arm64",
            _ => return None,
        };
        let data = String::from_utf8(STANDARD.decode(data).ok()?).ok()?;
        (sid(sid_row) && path(&data)).then(|| Windows {
            arch,
            sid: sid_row.into(),
            data,
        })
    }
    pub(super) fn command(&self, original: &str) -> Result<String> {
        let arguments = arguments(original)?;
        checked(&format!(
            "{FIND}
if(-not $e){{[Console]::Error.WriteLine('lazysh-agent: command not found');exit 127}}
$LASTEXITCODE=1
& $e.Source{arguments}
exit $LASTEXITCODE"
        ))
    }
    /// Prints `marker` and exits 0 where a POSIX shell would exit 2, 126 or 127: no companion, or one too old to
    /// know the command. What the companion writes to stderr is dropped, as the POSIX form drops it, unless `diagnostics`.
    pub(super) fn required(
        &self,
        original: &str,
        marker: &str,
        diagnostics: bool,
    ) -> Result<String> {
        let (arguments, marker) = (arguments(original)?, literal(marker));
        let redirect = if diagnostics { "" } else { " 2>$null" };
        checked(&format!(
            "{FIND}
if(-not $e){{{marker};exit 0}}
$LASTEXITCODE=1
& $e.Source{arguments}{redirect}
$c=$LASTEXITCODE
if($c -eq 2 -or $c -eq 126 -or $c -eq 127){{{marker};exit 0}}
exit $c"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";
    fn answer(arch: &str, sid: &str, data: &str) -> String {
        format!(
            "{MARKER}\r\n{arch}\r\n{sid}\r\n{}\r\n",
            STANDARD.encode(data)
        )
    }
    /// The script a command line carries.
    fn script(command: &str) -> String {
        let (intro, encoded) = command.rsplit_once(' ').unwrap();
        assert_eq!(
            intro,
            "powershell.exe -NoProfile -NonInteractive -InputFormat None -EncodedCommand"
        );
        let bytes = STANDARD.decode(encoded).unwrap();
        let units = bytes
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
        char::decode_utf16(units).map(|c| c.unwrap()).collect()
    }
    fn host() -> Windows {
        Windows::parse(&answer("AMD64", SID, "C:\\Users\\o\\AppData\\Local")).unwrap()
    }

    #[test]
    fn only_the_fixed_marker_a_known_architecture_a_sid_and_an_absolute_profile_path_identify_a_windows_host(
    ) {
        let profile = "D:\\Usuários\\José Ñandú\\AppData\\Local";
        assert_eq!(
            Windows::parse(&answer("ARM64", SID, profile)).unwrap(),
            Windows {
                arch: "arm64",
                sid: SID.into(),
                data: profile.into()
            }
        );
        assert_eq!(host().arch, "x64");
        assert_eq!(
            Windows::parse(&answer("AMD64", SID, profile).replace("\r\n", "\n")),
            Some(Windows {
                arch: "x64",
                sid: SID.into(),
                data: profile.into()
            })
        );
        let good = answer("AMD64", SID, "C:\\Users\\o\\AppData\\Local");
        for text in [
            "Windows_NT",
            "'sh' is not recognized as an internal or external command",
            "{\"schemaVersion\":1}",
            &format!("banner\r\n{good}"),
            &format!("{good}extra\r\n"),
            &good.replace(MARKER, "lazysh-posix-v1"),
            &answer("x86", SID, "C:\\Users\\o"),
            &answer("AMD64", "S-1-5", "C:\\Users\\o"),
            &answer("AMD64", "S-1-5-21-x", "C:\\Users\\o"),
            &answer("AMD64", "1004336348", "C:\\Users\\o"),
            &answer("AMD64", SID, "Users\\o"),
            &answer("AMD64", SID, "C:\\Users\\..\\o"),
            &answer("AMD64", SID, "C:\\Users\\\\o"),
            &answer("AMD64", SID, "C:\\"),
            &answer("AMD64", SID, "\\\\server\\share\\o"),
            &answer("AMD64", SID, "C:/Users/o"),
            &answer("AMD64", SID, "C:\\Users\\o\u{7}"),
            &good.replace(
                &STANDARD.encode("C:\\Users\\o\\AppData\\Local"),
                "not base64!",
            ),
        ] {
            assert!(Windows::parse(text).is_none(), "{text:?}");
        }
    }

    #[test]
    fn the_probe_is_one_line_of_fixed_words_and_base64_that_no_shell_changes() {
        let command = Windows::probe_command();
        assert_eq!(script(&command), PROBE);
        assert!(PROBE.contains(MARKER));
        assert!(command.len() < 2_000);
        assert!(
            command
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " -.+/=".contains(c)),
            "{command}"
        );
    }

    #[test]
    fn a_companion_command_becomes_the_same_encoded_line_whatever_its_arguments_hold() {
        let hostile = "C:\\Users\\o wner\\it's $(id); `x` | y & z > w < v # %PATH% ^ \u{2019}q\u{2019} 世界.jsonl";
        let line = format!(
            "lazysh-agent transcript --path {} --limit 50 --id={}",
            crate::ssh::quote(hostile),
            crate::ssh::quote("a b")
        );
        let command = host().command(&line).unwrap();
        assert!(command.starts_with(
            "powershell.exe -NoProfile -NonInteractive -InputFormat None -EncodedCommand "
        ));
        assert!(
            command
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " -.+/=".contains(c)),
            "{command}"
        );
        let text = script(&command);
        let call = text.lines().find(|line| line.starts_with("& ")).unwrap();
        assert_eq!(
            call,
            format!(
                "& $e.Source 'transcript' '--path' '{}' '--limit' '50' '--id=a b'",
                hostile
                    .replace('\'', "''")
                    .replace('\u{2019}', "\u{2019}\u{2019}")
            )
        );
        assert!(text.ends_with("exit $LASTEXITCODE"));
    }

    #[test]
    fn a_missing_or_old_companion_is_answered_with_the_marker_where_a_required_command_asks_for_it()
    {
        let marker = "lazysh-account-usage-companion-required-v1";
        let script = script(
            &host()
                .required("lazysh-agent account-usage --watch-channel", marker, false)
                .unwrap(),
        );
        assert_eq!(script.matches(&format!("'{marker}';exit 0")).count(), 2);
        assert!(script.contains("& $e.Source 'account-usage' '--watch-channel' 2>$null"));
        assert!(script.contains("-eq 2 -or $c -eq 126 -or $c -eq 127"));
        assert!(script.ends_with("exit $c"));
    }

    #[test]
    fn what_a_windows_host_cannot_receive_faithfully_is_refused_not_guessed() {
        for line in [
            "lazysh-agent snapshot ''",
            "lazysh-agent x --name='say \"hi\"'",
            "lazysh-agent x --name='say \u{201C}hi\u{201D}'",
            "lazysh-agent x --path 'C:\\Program Files\\dir\\'",
            "lazysh-agent x 'a\nb'",
            "lazysh-agent x 'a\tb'",
            "lazysh-agent x 'a\u{0}b'",
            "lazysh-agent snapshot $(id)",
            "lazysh-agent snapshot | id",
            "lazysh-agent snapshot 'unterminated",
            "lazysh-agent",
            "other-agent snapshot",
            "powershell snapshot",
        ] {
            for result in [host().command(line), host().required(line, "marker", false)] {
                let kind = result.map_err(|error| error.kind().to_owned());
                assert_eq!(kind, Err("companion_command".into()), "{line:?}");
            }
        }
        // A trailing backslash is fine when nothing makes PowerShell wrap the argument in quotes.
        assert!(host().command("lazysh-agent x --path 'C:\\dir\\'").is_ok());
        assert!(host()
            .command("lazysh-agent x --path 'C:\\dir with space\\file'")
            .is_ok());
    }

    #[test]
    fn a_command_is_kept_within_the_cmd_exe_line_and_longer_ones_are_refused() {
        let line = |length: usize| {
            format!(
                "lazysh-agent x --path {}",
                crate::ssh::quote(&"a".repeat(length))
            )
        };
        let longest = (0..3_000)
            .rev()
            .find(|n| host().command(&line(*n)).is_ok())
            .unwrap();
        let command = host().command(&line(longest)).unwrap();
        assert!(command.len() <= 8191 - 33, "{}", command.len());
        assert_eq!(
            host().command(&line(longest + 1)).unwrap_err().kind(),
            "companion_command"
        );
        assert!(
            longest > 2_000,
            "a path of a few hundred characters must fit: {longest}"
        );
    }
}

/// Real `cmd.exe` and Windows PowerShell, started the way an OpenSSH server for Windows starts a command it
/// receives. The hosted Windows job runs them (`--ignored`); they need Windows and cannot run elsewhere.
#[cfg(all(test, windows))]
mod native_tests {
    use super::*;
    use std::{
        fs,
        os::windows::process::CommandExt,
        path::Path,
        process::{Command, Output, Stdio},
        sync::mpsc,
        time::Duration,
    };

    /// The program and arguments an OpenSSH server for Windows puts before the command, by default shell.
    const SHELLS: [(&str, &[&str]); 2] = [
        ("cmd.exe", &["/c"]),
        (
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command"],
        ),
    ];

    /// A `PATH` of only the system directories, plus `first`: a `lazysh-agent` the runner has installed is never found.
    fn search(first: Option<&Path>) -> String {
        let root = std::env::var("SystemRoot").unwrap();
        let mut dirs = vec![
            format!(r"{root}\System32"),
            format!(r"{root}\System32\WindowsPowerShell\v1.0"),
        ];
        if let Some(dir) = first {
            dirs.insert(0, dir.display().to_string());
        }
        dirs.join(";")
    }
    /// Runs `command` as `shell` would for an exec request: appended as it is, with an open stdin that nobody writes to
    /// or closes, so a command that waits for input hangs here as it would over SSH.
    fn run(shell: (&str, &[&str]), command: &str, path: &str, state: &Path) -> Output {
        let (program, flags) = shell;
        let mut start = Command::new(program);
        start
            .args(flags)
            .raw_arg(command)
            .env("PATH", path)
            .env("LAZYSH_STATE_DIR", state)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut child = start.spawn().unwrap();
            let _open = child.stdin.take();
            let _ = sender.send(child.wait_with_output().unwrap());
        });
        receiver
            .recv_timeout(Duration::from_secs(120))
            .unwrap_or_else(|_| panic!("{program} did not finish {command}"))
    }
    fn text(bytes: &[u8]) -> &str {
        std::str::from_utf8(bytes).unwrap().trim()
    }
    /// The status `shell` reports for a command that exits with `status`: `cmd.exe` passes it on, while
    /// `powershell.exe -Command` turns every non-zero status of its last native command into 1.
    fn reported(shell: (&str, &[&str]), status: i32) -> Option<i32> {
        Some(if shell.0 == "cmd.exe" {
            status
        } else {
            status.min(1)
        })
    }
    fn identified(shell: (&str, &[&str]), state: &Path) -> Windows {
        let out = run(shell, &Windows::probe_command(), &search(None), state);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(out.status.success(), "{shell:?}: {stdout} {stderr}");
        Windows::parse(&stdout)
            .unwrap_or_else(|| panic!("{shell:?} answered {stdout:?} {stderr:?}"))
    }

    #[test]
    #[ignore = "requires Windows with cmd.exe and Windows PowerShell"]
    fn real_windows_shells_identify_the_host_through_the_encoded_probe() {
        let state = tempfile::tempdir().unwrap();
        for shell in SHELLS {
            let host = identified(shell, state.path());
            assert_eq!(
                host.sid,
                lazysh_common::windows_acl::current_user().unwrap(),
                "{shell:?}"
            );
            assert!(
                host.data
                    .eq_ignore_ascii_case(&std::env::var("LOCALAPPDATA").unwrap()),
                "{shell:?}: {}",
                host.data
            );
        }
    }

    #[test]
    #[ignore = "requires the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
    fn real_windows_shells_run_the_companion_with_every_argument_and_its_exit_status() {
        let root = tempfile::tempdir().unwrap();
        let (bin, state) = (root.path().join("bin"), root.path().join("state"));
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&state).unwrap();
        fs::copy(
            std::env::var_os("LAZYSH_TEST_AGENT_BIN").expect(
                "build lazysh-agent from this checkout and pass it as LAZYSH_TEST_AGENT_BIN",
            ),
            bin.join("lazysh-agent.exe"),
        )
        .unwrap();
        let (with, without) = (search(Some(&bin)), search(None));
        let version = format!("lazysh-agent {}", env!("CARGO_PKG_VERSION"));
        let hostile =
            "C:\\Users\\own er\\it's %PATH% $x & ^ | < > ; ( ) {} \u{2019}q\u{2019} 世界.json";
        let marker = "owned-companion-required";
        for shell in SHELLS {
            let host = identified(shell, &state);
            let go = |command: String, path: &str| run(shell, &command, path, &state);
            let out = go(host.command("lazysh-agent --version").unwrap(), &with);
            assert_eq!(
                (out.status.code(), text(&out.stdout)),
                (Some(0), &*version),
                "{shell:?}"
            );
            // Spaces, quotes, shell syntax and non-ASCII text arrive as written: the companion echoes the id.
            let echo = format!(
                "lazysh-agent reported-history --session-id={}",
                crate::ssh::quote(hostile)
            );
            let out = go(host.command(&echo).unwrap(), &with);
            assert!(
                out.status.success(),
                "{shell:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(json["sessionId"], hostile, "{shell:?}");
            // The companion's own exit status (2 for a command it does not know) is the command's.
            let unknown = go(host.command("lazysh-agent no-such-command").unwrap(), &with);
            assert_eq!(unknown.status.code(), reported(shell, 2), "{shell:?}");
            // A required command answers the marker for what is missing or too old, and runs what is there.
            let required =
                |line: &str, path: &str| go(host.required(line, marker, false).unwrap(), path);
            let old = required("lazysh-agent no-such-command", &with);
            assert_eq!(
                (old.status.code(), text(&old.stdout)),
                (Some(0), marker),
                "{shell:?}"
            );
            let current = required("lazysh-agent --version", &with);
            assert_eq!(
                (current.status.code(), text(&current.stdout)),
                (Some(0), &*version),
                "{shell:?}"
            );
            let absent = required("lazysh-agent --version", &without);
            assert_eq!(
                (absent.status.code(), text(&absent.stdout)),
                (Some(0), marker),
                "{shell:?}"
            );
            // With no companion at all an ordinary command fails as `sh` does: status 127 and a message.
            let missing = go(host.command("lazysh-agent --version").unwrap(), &without);
            assert_eq!(missing.status.code(), reported(shell, 127), "{shell:?}");
            assert!(
                String::from_utf8_lossy(&missing.stderr).contains("command not found"),
                "{shell:?}"
            );
        }
    }
}
