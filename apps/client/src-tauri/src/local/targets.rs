//! The places a local terminal can run. Linux and macOS have the login shell only; Windows
//! adds PowerShell, Git Bash and one target per WSL distribution. The renderer picks a target
//! id and never a path: every program is detected here and launched as argv, with no shell string.
use super::{wsl::Wsl, Target, Tools};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

/// `wsl.exe --list --quiet` of a machine with dozens of distributions is far below this.
const LISTING_LIMIT: usize = 64 * 1024;
const LISTING_DEADLINE: Duration = Duration::from_secs(5);
const MAX_DISTROS: usize = 32;
const MAX_DISTRO_NAME: usize = 64;

/// What detection asks the machine; a test answers from a table instead of the real Windows.
pub(super) trait Machine {
    fn var(&self, name: &str) -> Option<OsString>;
    fn is_file(&self, path: &Path) -> bool;
}
struct Real;
impl Machine for Real {
    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }
    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }
}

/// How a detected target starts.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Launch {
    /// A native program with fixed arguments.
    Program(PathBuf, &'static [&'static str]),
    /// One WSL distribution through `wsl.exe`.
    Wsl(PathBuf, String),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Found {
    id: String,
    label: String,
    launch: Launch,
}
impl Found {
    fn native(id: &str, label: &str, program: PathBuf, args: &'static [&'static str]) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            launch: Launch::Program(program, args),
        }
    }
    fn distro(wsl: &Path, name: &str) -> Self {
        Self {
            id: format!("wsl:{name}"),
            label: format!("{name} (WSL)"),
            launch: Launch::Wsl(wsl.to_owned(), name.into()),
        }
    }
    /// The capability entry, with the host `tools` its sessions offer.
    pub(super) fn target(&self, tools: Tools) -> Target {
        Target {
            id: self.id.clone(),
            label: self.label.clone(),
            kind: if self.is_wsl() { "wsl" } else { "windows" },
            tools,
        }
    }
    /// The distribution this target starts, whose host tools run inside it.
    pub(super) fn wsl(&self) -> Option<Wsl> {
        match &self.launch {
            Launch::Wsl(program, distro) => Some(Wsl::new(program.clone(), distro.clone())),
            Launch::Program(..) => None,
        }
    }
    #[cfg(test)]
    pub(super) fn id(&self) -> &str {
        &self.id
    }
    pub(super) fn is_wsl(&self) -> bool {
        matches!(self.launch, Launch::Wsl(..))
    }
    #[cfg(all(test, windows))]
    pub(super) fn is_powershell(&self) -> bool {
        matches!(self.id.as_str(), "pwsh" | "powershell")
    }
    pub(super) fn program(&self) -> &Path {
        match &self.launch {
            Launch::Program(program, _) | Launch::Wsl(program, _) => program,
        }
    }
    /// Every argument is its own argv element. A WSL shell starts in `directory`, else the
    /// distribution user's home (`~`).
    pub(super) fn arguments(&self, directory: Option<&Path>) -> Vec<OsString> {
        match &self.launch {
            Launch::Program(_, args) => args.iter().map(OsString::from).collect(),
            Launch::Wsl(_, distro) => vec![
                "-d".into(),
                distro.into(),
                "--cd".into(),
                directory.map_or("~".into(), |path| path.as_os_str().to_owned()),
            ],
        }
    }
}

/// Decodes `wsl.exe --list --quiet`: UTF-16LE, an optional byte-order mark, one name per line.
/// A name must be a plain distribution name; anything else (the localized "no installed
/// distributions" sentence, a name that could read as an option) is dropped.
pub(super) fn parse_distros(bytes: &[u8]) -> Vec<String> {
    if bytes.len() > LISTING_LIMIT || !bytes.len().is_multiple_of(2) {
        return Vec::new();
    }
    let units = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair));
    let Ok(text) = char::decode_utf16(units).collect::<Result<String, _>>() else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let name = line.trim();
        if valid_distro(name) && !names.iter().any(|known| known == name) {
            names.push(name.into());
            if names.len() == MAX_DISTROS {
                break;
            }
        }
    }
    names
}
/// Letters, digits, `.`, `_` and `-`, starting with a letter or digit: the names the Store
/// and `wsl --install` give. A name with a space is not offered.
fn valid_distro(name: &str) -> bool {
    name.len() <= MAX_DISTRO_NAME
        && name.starts_with(|first: char| first.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn system32(machine: &impl Machine, program: &[&str]) -> Option<PathBuf> {
    let mut path = PathBuf::from(machine.var("SystemRoot")?).join("System32");
    path.extend(program);
    machine.is_file(&path).then_some(path)
}
/// Directories that hold `name` along the process PATH.
fn on_path(machine: &impl Machine, name: &str) -> Vec<PathBuf> {
    machine
        .var("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join(name))
                .filter(|candidate| machine.is_file(candidate))
                .collect()
        })
        .unwrap_or_default()
}
fn pwsh(machine: &impl Machine) -> Option<PathBuf> {
    // The machine-wide install first: a PATH entry is writable by more accounts.
    machine
        .var("ProgramFiles")
        .map(|root| {
            PathBuf::from(root)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe")
        })
        .filter(|path| machine.is_file(path))
        .or_else(|| on_path(machine, "pwsh.exe").into_iter().next())
}
/// Git for Windows' own `bash.exe`. `System32\bash.exe` is the WSL launcher and never counts.
fn git_bash(machine: &impl Machine) -> Option<PathBuf> {
    let installs = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(|name| {
            machine
                .var(name)
                .map(|root| PathBuf::from(root).join("Git"))
        })
        .chain(
            machine
                .var("LOCALAPPDATA")
                .map(|root| PathBuf::from(root).join("Programs").join("Git")),
        )
        // `<install>\cmd\git.exe` on the PATH names an install somewhere else.
        .chain(on_path(machine, "git.exe").into_iter().filter_map(|git| {
            let cmd = git.parent()?;
            cmd.file_name()?
                .eq_ignore_ascii_case("cmd")
                .then(|| cmd.parent().map(Path::to_path_buf))?
        }));
    installs
        .map(|install| install.join("bin").join("bash.exe"))
        .find(|bash| machine.is_file(bash))
}
pub(super) fn native_targets(machine: &impl Machine) -> Vec<Found> {
    let mut found = Vec::new();
    if let Some(program) = pwsh(machine) {
        found.push(Found::native("pwsh", "PowerShell", program, &["-NoLogo"]));
    }
    if let Some(program) = system32(machine, &["WindowsPowerShell", "v1.0", "powershell.exe"]) {
        found.push(Found::native(
            "powershell",
            "Windows PowerShell",
            program,
            &["-NoLogo"],
        ));
    }
    if let Some(program) = git_bash(machine) {
        found.push(Found::native(
            "gitbash",
            "Git Bash",
            program,
            &["--login", "-i"],
        ));
    }
    found
}

/// The distributions `wsl.exe` lists, or none when it is missing, fails or is too slow.
async fn list_distros(wsl: &Path) -> Vec<String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let mut command = tokio::process::Command::new(wsl);
    command
        .args(["--list", "--quiet"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let Ok(mut child) = command.spawn() else {
        return Vec::new();
    };
    let Some(stdout) = child.stdout.take() else {
        return Vec::new();
    };
    let listing = tokio::time::timeout(LISTING_DEADLINE, async {
        let mut bytes = Vec::new();
        stdout
            .take(LISTING_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        // A failure (no distribution installed, WSL absent) can still print a sentence.
        child.wait().await.ok()?.success().then_some(bytes)
    })
    .await;
    listing
        .ok()
        .flatten()
        .map_or_else(Vec::new, |bytes| parse_distros(&bytes))
}

/// Every target this machine offers besides the default shell. Only Windows has any.
pub(super) async fn detect(include_wsl: bool) -> Vec<Found> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut found = native_targets(&Real);
    if include_wsl {
        if let Some(wsl) = system32(&Real, &["wsl.exe"]) {
            found.extend(
                list_distros(&wsl)
                    .await
                    .iter()
                    .map(|name| Found::distro(&wsl, name)),
            );
        }
    }
    found
}
/// The detected target `id` names; an id that was not detected is refused.
pub(super) async fn resolve(id: &str) -> Result<Found, String> {
    detect(id.starts_with("wsl:"))
        .await
        .into_iter()
        .find(|found| found.id == id)
        .ok_or_else(|| "That local terminal target is not available on this device".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// A path built from components, so a test reads the same on any host platform.
    fn p(parts: &[&str]) -> PathBuf {
        parts.iter().collect()
    }
    fn search_path(directories: &[PathBuf]) -> OsString {
        std::env::join_paths(directories).unwrap()
    }
    /// A Windows machine described by its variables and the files it has.
    #[derive(Default)]
    struct Fake {
        vars: HashMap<&'static str, OsString>,
        files: HashSet<PathBuf>,
    }
    impl Fake {
        fn windows() -> Self {
            Self::default().var("SystemRoot", p(&["win"]).into())
        }
        fn with(mut self, path: PathBuf) -> Self {
            self.files.insert(path);
            self
        }
        fn var(mut self, name: &'static str, value: OsString) -> Self {
            self.vars.insert(name, value);
            self
        }
    }
    impl Machine for Fake {
        fn var(&self, name: &str) -> Option<OsString> {
            self.vars.get(name).cloned()
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.contains(path)
        }
    }
    fn ids(found: &[Found]) -> Vec<&str> {
        found.iter().map(|found| found.id.as_str()).collect()
    }
    /// The bytes `wsl.exe` writes: UTF-16LE, `\r\n` after each name.
    fn listing(text: &str, bom: bool) -> Vec<u8> {
        let mut units: Vec<u16> = if bom { vec![0xfeff] } else { Vec::new() };
        units.extend(text.encode_utf16());
        units.into_iter().flat_map(u16::to_le_bytes).collect()
    }

    #[test]
    fn a_wsl_listing_is_decoded_from_utf16le_with_or_without_a_byte_order_mark() {
        for bom in [true, false] {
            assert_eq!(
                parse_distros(&listing("Ubuntu\r\nDebian\r\nUbuntu-22.04\r\n", bom)),
                ["Ubuntu", "Debian", "Ubuntu-22.04"]
            );
        }
        // The exact bytes of "Ubuntu\r\n" as wsl.exe prints it.
        assert_eq!(
            parse_distros(&[
                0xff, 0xfe, b'U', 0, b'b', 0, b'u', 0, b'n', 0, b't', 0, b'u', 0, b'\r', 0, b'\n',
                0
            ]),
            ["Ubuntu"]
        );
    }
    #[test]
    fn a_wsl_listing_keeps_only_plain_unique_names_within_its_bounds() {
        let hostile = "-d\r\n..\r\nfoo bar\r\na/b\r\n\r\nUbuntu\r\nUbuntu\r\nx;y\r\n$(id)\r\n";
        assert_eq!(parse_distros(&listing(hostile, true)), ["Ubuntu"]);
        let sentence = "Windows Subsystem for Linux has no installed distributions.\r\n";
        assert!(parse_distros(&listing(sentence, true)).is_empty());
        let long = format!("{}\r\nok\r\n", "a".repeat(MAX_DISTRO_NAME + 1));
        assert_eq!(parse_distros(&listing(&long, false)), ["ok"]);
        let many: String = (0..MAX_DISTROS + 8).map(|n| format!("d{n}\r\n")).collect();
        assert_eq!(parse_distros(&listing(&many, false)).len(), MAX_DISTROS);
        // Odd length, an unpaired surrogate, UTF-8 text and an oversized capture are not listings.
        assert!(parse_distros(b"Ubuntu\r\n").is_empty());
        assert!(parse_distros(&[0x00, 0xd8, b'a', 0]).is_empty());
        assert!(parse_distros(&vec![b'a'; LISTING_LIMIT + 2]).is_empty());
    }
    #[test]
    fn a_wsl_target_starts_the_distribution_as_separate_arguments() {
        let wsl = Found::distro(&p(&["win", "wsl.exe"]), "Ubuntu-22.04");
        assert_eq!(
            (wsl.id.as_str(), wsl.label.as_str()),
            ("wsl:Ubuntu-22.04", "Ubuntu-22.04 (WSL)")
        );
        assert_eq!(wsl.program(), p(&["win", "wsl.exe"]));
        assert_eq!(wsl.arguments(None), ["-d", "Ubuntu-22.04", "--cd", "~"]);
        let project = p(&["work", "my project"]);
        assert_eq!(
            wsl.arguments(Some(&project)),
            [
                OsString::from("-d"),
                "Ubuntu-22.04".into(),
                "--cd".into(),
                project.into_os_string()
            ]
        );
    }
    #[test]
    fn only_a_wsl_target_runs_its_host_tools_inside_a_distribution() {
        let tools = Tools {
            files: true,
            ..Tools::default()
        };
        let wsl = Found::distro(Path::new("wsl.exe"), "Ubuntu");
        assert_eq!(wsl.target(tools.clone()).kind, "wsl");
        assert!(wsl.target(tools.clone()).tools.files);
        assert!(wsl.wsl().is_some());
        let pwsh = Found::native("pwsh", "PowerShell", "pwsh.exe".into(), &[]);
        assert_eq!(pwsh.target(tools).kind, "windows");
        assert!(pwsh.wsl().is_none());
    }
    #[test]
    fn every_installed_windows_shell_is_detected_with_its_absolute_program() {
        let pwsh = p(&["pf", "PowerShell", "7", "pwsh.exe"]);
        let machine = Fake::windows()
            .var("ProgramFiles", p(&["pf"]).into())
            .with(pwsh.clone())
            .with(p(&[
                "win",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe",
            ]))
            .with(p(&["pf", "Git", "bin", "bash.exe"]));
        let found = native_targets(&machine);
        assert_eq!(ids(&found), ["pwsh", "powershell", "gitbash"]);
        assert_eq!(found[0].program(), pwsh);
        assert_eq!(found[1].label, "Windows PowerShell");
        assert_eq!(found[2].arguments(None), ["--login", "-i"]);
    }
    #[test]
    fn shells_that_are_not_installed_are_not_offered() {
        assert!(native_targets(&Fake::windows()).is_empty());
        assert!(native_targets(&Fake::default()).is_empty());
    }
    #[test]
    fn pwsh_is_found_on_the_path_and_git_bash_next_to_a_git_on_the_path() {
        let machine = Fake::windows()
            .var(
                "PATH",
                search_path(&[p(&["tools"]), p(&["dev", "Git", "cmd"]), p(&["other"])]),
            )
            .with(p(&["tools", "pwsh.exe"]))
            .with(p(&["dev", "Git", "cmd", "git.exe"]))
            .with(p(&["dev", "Git", "bin", "bash.exe"]));
        let found = native_targets(&machine);
        assert_eq!(ids(&found), ["pwsh", "gitbash"]);
        assert_eq!(found[0].program(), p(&["tools", "pwsh.exe"]));
        assert_eq!(found[1].program(), p(&["dev", "Git", "bin", "bash.exe"]));
    }
    #[test]
    fn the_wsl_launcher_named_bash_is_never_git_bash() {
        let machine = Fake::windows()
            .var("PATH", search_path(&[p(&["win", "System32"])]))
            .with(p(&["win", "System32", "bash.exe"]));
        assert!(native_targets(&machine).is_empty());
    }
    #[tokio::test]
    async fn a_target_id_that_was_not_detected_is_refused() {
        let cases = [
            "",
            "default",
            "cmd",
            "pwsh",
            "powershell",
            "gitbash",
            "wsl:",
            "wsl:-d",
            "wsl:a b",
            "wsl:../x",
            "wsl:definitely-not-installed",
        ];
        for id in cases {
            // A Windows runner may really have these shells.
            if cfg!(windows) && matches!(id, "pwsh" | "powershell" | "gitbash") {
                continue;
            }
            assert!(resolve(id).await.is_err(), "{id:?} must not resolve");
        }
    }
}
