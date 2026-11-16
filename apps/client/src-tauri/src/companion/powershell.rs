//! Windows OpenSSH hosts. The server runs a command through its default shell: `cmd.exe`, Windows PowerShell or
//! something else, and each unquotes differently. Both the probe and every companion command therefore travel as
//! `powershell.exe ... -EncodedCommand <base64 of the UTF-16LE script>`, a line made only of fixed words and base64,
//! which none of those shells (nor a POSIX one) changes. Windows PowerShell 5.1 is assumed, as in ADR 0003.
use super::{error, words, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use lazysh_common::windows_acl::{admit_facts, descriptor_from_binary, Fact, Unsafe};

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
/// Output as UTF-8: the console's code page would garble a transcript.
const UTF8: &str = "try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{}";
/// The first `lazysh-agent` program on the `PATH`: PowerShell never runs one from the current directory, which
/// `cmd.exe` would.
const SEARCH: &str =
    "Get-Command lazysh-agent -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1";
/// What the namespace reader prints first.
const NAMESPACE_MARKER: &str = "lazysh-windows-managed-v1";
/// The managed namespace below `%LOCALAPPDATA%` and the executable in it, as `lazysh-agent` places them.
const MANAGED: [&str; 2] = ["lazysh", "companion"];
const EXECUTABLE: &str = "lazysh-agent.exe";
/// One line for each component from `%LOCALAPPDATA%` down to the executable, up to the first one that is absent, a
/// link or not a directory (nothing under it is read, and a junction is never followed): `-` absent, `l` a reparse
/// point, `?` that it cannot be read, or `d` or `f` (a directory, or a file) and the base64 of its self-relative
/// security descriptor, which Rust reads and decides. `GetAttributes` looks at a link itself, not at what it points to.
const NAMESPACE: &str = "$p={root}
{marker}
foreach($n in $null,{names}){
if($n){$p+='\\'+$n}
try{$a=[int][IO.File]::GetAttributes($p)}catch [IO.FileNotFoundException],[IO.DirectoryNotFoundException]{'-';break}catch{'?';break}
if($a -band 0x400){'l';break}
try{$o=if($a -band 0x10){[IO.DirectoryInfo]::new($p)}else{[IO.FileInfo]::new($p)};$d=[Convert]::ToBase64String($o.GetAccessControl().GetSecurityDescriptorBinaryForm())}catch{'?';break}
if($a -band 0x10){'d '+$d}else{'f '+$d;break}}";
/// `cmd.exe` takes 8,191 characters per line, the shell's own prefix included (`"C:\Windows\System32\cmd.exe" /c ` is 33).
const LIMIT: usize = 8191 - 100;

/// A Windows host the probe identified. Installation stays unsupported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Windows {
    /// Read by the tests only: nothing picks a download for a Windows host yet.
    #[cfg_attr(not(test), allow(dead_code))]
    pub arch: &'static str,
    pub sid: String,
    /// `%LOCALAPPDATA%`, where the managed companion belongs.
    pub data: String,
    /// The managed `lazysh-agent.exe`, when its namespace was read and admitted: it runs before the `PATH`'s.
    pub managed: Option<String>,
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

/// The facts a namespace exec printed: its marker, then a row for each component down to the first one that is not a
/// directory. `None` when it is anything else, a row after the last one the walk reaches included. A descriptor that
/// cannot be read faithfully is `Unreadable`, which refuses.
fn namespace(answer: &str) -> Option<Vec<Fact>> {
    let mut rows = answer.lines();
    (rows.next()? == NAMESPACE_MARKER).then_some(())?;
    let mut facts = Vec::new();
    for row in rows {
        if facts.len() == MANAGED.len() + 2
            || !matches!(facts.last(), None | Some(Fact::Directory(_)))
        {
            return None;
        }
        facts.push(match row.split_once(' ') {
            None => match row {
                "-" => Fact::Absent,
                "l" => Fact::Link,
                "?" => Fact::Unreadable,
                _ => return None,
            },
            Some((kind, bytes)) => {
                let read = STANDARD
                    .decode(bytes)
                    .ok()
                    .and_then(|bytes| descriptor_from_binary(&bytes));
                match (kind, read) {
                    ("d", Some(descriptor)) => Fact::Directory(descriptor),
                    ("f", Some(descriptor)) => Fact::File(descriptor),
                    ("d" | "f", None) => Fact::Unreadable,
                    _ => return None,
                }
            }
        });
    }
    // The walk stops at the first component that is not a directory; a directory last means rows are missing.
    let complete = facts.len() == MANAGED.len() + 2 || !matches!(facts.last()?, Fact::Directory(_));
    complete.then(|| {
        facts.resize(MANAGED.len() + 2, Fact::Absent);
        facts
    })
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
            managed: None,
        })
    }
    /// Reads the facts of the managed namespace in one exec: see `NAMESPACE`.
    pub(super) fn namespace_command(&self) -> Result<String> {
        let names = MANAGED.iter().chain([&EXECUTABLE]);
        checked(
            &NAMESPACE
                .replace("{root}", &literal(&self.data))
                .replace("{marker}", &literal(NAMESPACE_MARKER))
                .replace(
                    "{names}",
                    &names
                        .map(|name| literal(name))
                        .collect::<Vec<_>>()
                        .join(","),
                ),
        )
    }
    /// The host once `answer`, what `namespace_command` printed, has been decided by the `lazysh_common::windows_acl`
    /// rules for the user the probe named. An absent namespace, an answer that cannot be understood and a refused
    /// namespace (reported, never used) all keep the `PATH` lookup.
    pub(super) fn admit(self, answer: &str) -> Windows {
        let admitted = namespace(answer).map(|facts| admit_facts(&self.sid, &facts));
        match admitted {
            Some(Ok(true)) => Windows {
                managed: Some(format!(
                    "{}\\{}\\{EXECUTABLE}",
                    self.data,
                    MANAGED.join("\\")
                )),
                ..self
            },
            Some(Err(refused)) => {
                eprintln!(
                    "The managed companion on the Windows host was not used: {}. Falling back to the PATH.",
                    match refused {
                        Unsafe::Directory => "a directory of its namespace is a link or can be changed by another account",
                        Unsafe::Executable => "its executable is a link, no regular file, or open to another account",
                    }
                );
                self
            }
            _ => self,
        }
    }
    /// The script that sets `$e` to the program to run: the admitted managed executable while it is still a file, else
    /// the first one on the `PATH`. Between the decision and the run another account cannot change the namespace, but
    /// the user and the administrators can, and PowerShell cannot evaluate the rules again here.
    fn find(&self) -> String {
        match &self.managed {
            None => format!("{UTF8}\n$e={SEARCH}"),
            Some(path) => format!(
                "{UTF8}\n$e=@{{Source={}}}\nif(-not(Test-Path -LiteralPath $e.Source -PathType Leaf)){{$e={SEARCH}}}",
                literal(path)
            ),
        }
    }
    pub(super) fn command(&self, original: &str) -> Result<String> {
        let (arguments, find) = (arguments(original)?, self.find());
        checked(&format!(
            "{find}
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
        let (arguments, marker, find) = (arguments(original)?, literal(marker), self.find());
        let redirect = if diagnostics { "" } else { " 2>$null" };
        checked(&format!(
            "{find}
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
                data: profile.into(),
                managed: None
            }
        );
        assert_eq!(host().arch, "x64");
        assert_eq!(
            Windows::parse(&answer("AMD64", SID, profile).replace("\r\n", "\n")),
            Some(Windows {
                arch: "x64",
                sid: SID.into(),
                data: profile.into(),
                managed: None
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

    use lazysh_common::windows_acl::{
        binary_fixture::encode, Ace, Descriptor, ADMINISTRATORS, SYSTEM,
    };

    const MANAGED_PATH: &str = "C:\\Users\\o\\AppData\\Local\\lazysh\\companion\\lazysh-agent.exe";
    const OTHER: &str = "S-1-5-21-1004336348-1177238915-682003330-1002";
    fn grant(sid: &str, mask: u32) -> Ace {
        Ace {
            sid: sid.into(),
            mask,
            allow: true,
            inherit_only: false,
        }
    }
    /// What a user profile gives: the system, the administrators and the user hold everything.
    fn profile() -> Vec<Ace> {
        [SYSTEM, ADMINISTRATORS, SID]
            .map(|sid| grant(sid, 0x1f_01ff))
            .to_vec()
    }
    /// A row of the namespace reader for an object of `kind` (`d` or `f`) owned by the user.
    fn row(kind: &str, aces: Vec<Ace>) -> String {
        let descriptor = Descriptor {
            owner: SID.into(),
            dacl: Some(aces),
        };
        format!("{kind} {}", STANDARD.encode(encode(&descriptor)))
    }
    fn rows(rows: &[String]) -> String {
        format!("{NAMESPACE_MARKER}\r\n{}\r\n", rows.join("\r\n"))
    }
    /// The four rows of a namespace in place, with `executable` as the last.
    fn namespace_in_place(executable: String) -> Vec<String> {
        let mut rows = vec![row("d", profile()); 3];
        rows.push(executable);
        rows
    }
    fn admitted() -> Windows {
        host().admit(&rows(&namespace_in_place(row("f", profile()))))
    }

    #[test]
    fn the_namespace_reader_is_one_line_of_fixed_words_and_base64_with_the_profile_path_as_a_literal(
    ) {
        let profile = "D:\\Usuários\\O'Neil\\AppData\\Local";
        let host = Windows::parse(&answer("AMD64", SID, profile)).unwrap();
        let command = host.namespace_command().unwrap();
        assert!(
            command
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || " -.+/=".contains(c)),
            "{command}"
        );
        let text = script(&command);
        assert!(text.starts_with(
            "$p='D:\\Usuários\\O''Neil\\AppData\\Local'\n'lazysh-windows-managed-v1'\n"
        ));
        assert!(text.contains("foreach($n in $null,'lazysh','companion','lazysh-agent.exe'){"));
        assert!(command.len() < 4_000);
    }

    #[test]
    fn the_managed_namespace_is_read_from_the_top_down_and_decided_by_the_windows_acl_rules() {
        let admitted = admitted();
        assert_eq!(admitted.managed.as_deref(), Some(MANAGED_PATH));
        // Others may read and run the executable's directory but not change it; an administrator may own the files.
        let mut listing = profile();
        listing.push(grant("S-1-5-32-545", 0x12_00a9));
        let mut rows = namespace_in_place(row("f", profile()));
        rows[2] = row("d", listing);
        assert_eq!(host().admit(&self::rows(&rows)), admitted);
        // Nothing yet, or only part of the namespace: the PATH lookup stays, nothing is refused.
        for answer in [
            rows_of(&["-"]),
            rows_of(&["d", "-"]),
            rows_of(&["d", "d", "-"]),
            rows_of(&["d", "d", "d", "-"]),
        ] {
            assert_eq!(host().admit(&answer), host(), "{answer}");
        }
    }

    /// An answer of rows with a real descriptor wherever the kind is `d` or `f`.
    fn rows_of(kinds: &[&str]) -> String {
        let all = kinds.iter().map(|kind| match *kind {
            "d" | "f" => row(kind, profile()),
            other => other.into(),
        });
        rows(&all.collect::<Vec<_>>())
    }

    #[test]
    fn a_namespace_another_account_can_change_or_a_link_in_its_place_is_never_used() {
        let writable = |grant_to: &str, mask| {
            let mut aces = profile();
            aces.push(grant(grant_to, mask));
            aces
        };
        let foreign = Descriptor {
            owner: OTHER.into(),
            dacl: Some(profile()),
        };
        let with_executable = |executable: String| rows(&namespace_in_place(executable));
        for (name, answer) in [
            ("a directory another account may change", {
                let mut rows = namespace_in_place(row("f", profile()));
                rows[1] = row("d", writable("S-1-1-0", 0x13_01bf));
                self::rows(&rows)
            }),
            ("a directory it owns", {
                let mut rows = namespace_in_place(row("f", profile()));
                rows[2] = format!("d {}", STANDARD.encode(encode(&foreign)));
                self::rows(&rows)
            }),
            (
                "an executable another account may read",
                with_executable(row("f", writable("S-1-1-0", 1))),
            ),
            (
                "an executable it owns",
                with_executable(format!("f {}", STANDARD.encode(encode(&foreign)))),
            ),
            ("a link in place of a directory", rows_of(&["d", "l"])),
            (
                "a link in place of the executable",
                rows_of(&["d", "d", "d", "l"]),
            ),
            ("a file in place of a directory", rows_of(&["d", "d", "f"])),
            (
                "a directory in place of the executable",
                rows_of(&["d", "d", "d", "d"]),
            ),
            ("a component it could not read", rows_of(&["d", "d", "?"])),
            ("a descriptor of an unknown form", rows(&["d AAAA".into()])),
        ] {
            assert_eq!(host().admit(&answer), host(), "{name}");
        }
    }

    #[test]
    fn what_the_reader_did_not_print_faithfully_decides_nothing() {
        let good = rows(&namespace_in_place(row("f", profile())));
        assert_eq!(host().admit(&good).managed.as_deref(), Some(MANAGED_PATH));
        let dir = row("d", profile());
        for (name, answer) in [
            ("nothing", String::new()),
            (
                "another marker",
                good.replace(NAMESPACE_MARKER, "lazysh-windows-v1"),
            ),
            ("a banner", format!("banner\r\n{good}")),
            ("a row past the executable", good.clone() + "d\r\n"),
            ("a row after a link", rows_of(&["d", "l", "-"])),
            (
                "a directory last and rows missing",
                rows(&[dir.clone(), dir.clone()]),
            ),
            ("only the marker", format!("{NAMESPACE_MARKER}\r\n")),
            ("an unknown row", rows_of(&["d", "x"])),
            ("a kind without a descriptor", rows(&["d".into()])),
            (
                "a descriptor that is not base64",
                rows(&["d not base64!".into()]),
            ),
            ("an unknown kind", rows(&[dir.replacen('d', "x", 1)])),
        ] {
            assert_eq!(host().admit(&answer), host(), "{name}");
        }
    }

    #[test]
    fn an_admitted_executable_runs_before_the_path_and_falls_back_to_it_when_it_is_gone() {
        let (plain, managed) = (host(), admitted());
        let search = "Get-Command lazysh-agent -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1";
        let lines = |host: &Windows| {
            let text = script(&host.command("lazysh-agent snapshot --limit 5").unwrap());
            text.lines().map(str::to_owned).collect::<Vec<_>>()
        };
        assert_eq!(lines(&plain)[1], format!("$e={search}"));
        let managed = lines(&managed);
        assert_eq!(managed[1], format!("$e=@{{Source='{MANAGED_PATH}'}}"));
        assert_eq!(
            managed[2],
            format!("if(-not(Test-Path -LiteralPath $e.Source -PathType Leaf)){{$e={search}}}")
        );
        // The call, the missing-companion answer and the exit status are the ones of the PATH lookup.
        assert_eq!(managed[3..], lines(&plain)[2..]);
        let marker = "lazysh-account-usage-companion-required-v1";
        let required = script(
            &admitted()
                .required("lazysh-agent account-usage", marker, false)
                .unwrap(),
        );
        assert!(required.contains(&format!("$e=@{{Source='{MANAGED_PATH}'}}")));
        assert!(required.contains(&format!("if(-not $e){{'{marker}';exit 0}}")));
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

    /// The facts the reader would print for `data`, read on this machine the way the native admission reads them.
    fn native_facts(data: &Path) -> Vec<Fact> {
        use lazysh_common::windows_acl::describe;
        let mut path = data.to_owned();
        let mut facts = Vec::new();
        for name in [
            None,
            Some("lazysh"),
            Some("companion"),
            Some("lazysh-agent.exe"),
        ] {
            path.extend(name);
            let fact = match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Fact::Absent,
                Err(_) => Fact::Unreadable,
                Ok(metadata) if lazysh_common::storage_namespace::is_link(&metadata) => Fact::Link,
                Ok(metadata) => match describe(&path) {
                    Ok(descriptor) if metadata.is_dir() => Fact::Directory(descriptor),
                    Ok(descriptor) => Fact::File(descriptor),
                    Err(_) => Fact::Unreadable,
                },
            };
            let more = matches!(fact, Fact::Directory(_));
            facts.push(fact);
            if !more {
                break;
            }
        }
        facts.resize(4, Fact::Absent);
        facts
    }

    #[test]
    #[ignore = "requires Windows PowerShell and the companion this build produced in LAZYSH_TEST_AGENT_BIN"]
    fn real_windows_shells_read_the_managed_namespace_and_run_what_it_admits_before_the_path() {
        use lazysh_common::windows_acl::{
            admit_namespace, admit_path,
            fixtures::{icacls, restrict},
            local_kind,
        };
        let root = tempfile::tempdir().unwrap();
        let (bin, state, data) = (
            root.path().join("bin"),
            root.path().join("state"),
            root.path().join("data"),
        );
        let companion = data.join("lazysh").join("companion");
        let managed = companion.join("lazysh-agent.exe");
        for dir in [&bin, &state, &data] {
            fs::create_dir_all(dir).unwrap();
        }
        // The user and the system hold the stand-in profile; a temporary folder would inherit whatever its volume grants.
        restrict(&data);
        let agent = std::env::var_os("LAZYSH_TEST_AGENT_BIN")
            .expect("build lazysh-agent from this checkout and pass it as LAZYSH_TEST_AGENT_BIN");
        // A different program under the same name first on the PATH: whichever runs shows in the output.
        let shadow = Path::new(&std::env::var("SystemRoot").unwrap()).join(r"System32\whoami.exe");
        fs::copy(shadow, bin.join("lazysh-agent.exe")).unwrap();
        let version = format!("lazysh-agent {}", env!("CARGO_PKG_VERSION"));
        let place = || {
            fs::create_dir_all(&companion).unwrap();
            fs::copy(&agent, &managed).unwrap();
        };
        let everyone = "*S-1-1-0";
        let hosts = SHELLS.map(|shell| (shell, identified(shell, &state)));
        // Reads and decides the namespace through each shell, then runs a command on the host it yields, and
        // checks them against the native admission of the same files.
        let check = |case: &str, expected: std::result::Result<bool, Unsafe>| {
            let native = admit_namespace(
                &data,
                &["lazysh", "companion"],
                "lazysh-agent.exe",
                admit_path,
                local_kind,
            );
            assert_eq!(native, expected, "{case}: the native admission");
            for (shell, identity) in &hosts {
                let host = Windows {
                    data: data.display().to_string(),
                    ..identity.clone()
                };
                let command = host.namespace_command().unwrap();
                let out = run(*shell, &command, &search(None), &state);
                let answer = String::from_utf8_lossy(&out.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&out.stderr);
                assert!(out.status.success(), "{case} {shell:?}: {answer} {stderr}");
                assert_eq!(
                    namespace(&answer),
                    Some(native_facts(&data)),
                    "{case} {shell:?}: {answer}"
                );
                let host = host.admit(&answer);
                assert_eq!(
                    host.managed.is_some(),
                    expected == Ok(true),
                    "{case} {shell:?}"
                );
                let command = host.command("lazysh-agent --version").unwrap();
                let out = run(*shell, &command, &search(Some(&bin)), &state);
                let ran_managed = text(&out.stdout) == version;
                assert_eq!(ran_managed, expected == Ok(true), "{case} {shell:?}");
            }
        };
        place();
        check("a namespace the user alone controls", Ok(true));
        // Others may read and run the directory and cannot read the executable.
        icacls(&companion, &["/grant", &format!("{everyone}:(RX)")]);
        check("a directory others may only list", Ok(true));
        icacls(&companion, &["/grant", &format!("{everyone}:(M)")]);
        check("a directory others may change", Err(Unsafe::Directory));
        icacls(&companion, &["/remove", everyone]);
        icacls(&managed, &["/grant", &format!("{everyone}:(R)")]);
        check("an executable others may read", Err(Unsafe::Executable));
        icacls(&managed, &["/remove", everyone]);
        check("the grants taken back", Ok(true));
        fs::remove_file(&managed).unwrap();
        check("no executable yet", Ok(false));
        place();
        icacls(&managed, &["/setowner", "*S-1-5-32-545"]);
        check(
            "an executable another account owns",
            Err(Unsafe::Executable),
        );
        fs::remove_file(&managed).unwrap();
        fs::create_dir(&managed).unwrap();
        check(
            "a directory where the executable belongs",
            Err(Unsafe::Executable),
        );
        fs::remove_dir(&managed).unwrap();
        place();
        let elsewhere = root.path().join("elsewhere");
        fs::rename(&companion, &elsewhere).unwrap();
        let junction = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&companion)
            .arg(&elsewhere)
            .output()
            .unwrap();
        assert!(junction.status.success(), "{junction:?}");
        check(
            "a junction in the place of a directory",
            Err(Unsafe::Directory),
        );
        fs::remove_dir(&companion).unwrap();
        fs::remove_dir_all(&elsewhere).unwrap();
        fs::write(&companion, b"not a directory").unwrap();
        check("a file where a directory belongs", Err(Unsafe::Directory));
        fs::remove_file(&companion).unwrap();
        check("no companion directory yet", Ok(false));
        fs::remove_dir_all(data.join("lazysh")).unwrap();
        check("no lazysh directory yet", Ok(false));
    }
}
