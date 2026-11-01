//! Read-only installation metadata; never a profile admission or live-reporting proof.
use serde_json::{json, Value};

pub fn run(schema_version: u8) -> Value {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        inspect(schema_version, |name| std::env::var_os(name))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        json!({"schemaVersion":schema_version,"supported":false,"managedSetupSupported":false,"agents":[],"truncated":false})
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn inspect(
    schema_version: u8,
    environment: impl FnMut(&str) -> Option<std::ffi::OsString>,
) -> Value {
    metadata::discover(schema_version, environment)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod metadata {
    use super::*;
    use std::{
        collections::HashSet,
        ffi::OsString,
        fs, io,
        os::unix::fs::PermissionsExt,
        path::{Component, Path, PathBuf},
    };
    const MAX_PATH: usize = 4096;
    const MAX_PATH_BYTES: usize = 32768;
    const MAX_PATH_ENTRIES: usize = 64;
    const MAX_RELEASES: usize = 16;
    const MAX_OUTPUT: usize = 65536;

    struct Scan<F> {
        environment: F,
        truncated: bool,
        schema_version: u8,
    }
    impl<F: FnMut(&str) -> Option<OsString>> Scan<F> {
        fn variable(&mut self, name: &str) -> Option<OsString> {
            (self.environment)(name)
                .filter(|value| value.to_str().is_none_or(|s| !s.trim().is_empty()))
        }
        fn path(&mut self, value: OsString) -> Option<PathBuf> {
            let text = value.to_str()?;
            if text.len() > MAX_PATH {
                self.truncated = true;
                return None;
            }
            let path = Path::new(text);
            (path.is_absolute()
                && !text.chars().any(char::is_control)
                && !text.split('/').any(|part| part == "." || part == "..")
                && !path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir)))
            .then(|| path.components().collect())
        }
        fn profile(&mut self, raw: Option<OsString>, source: &str, suffix: &str) -> Value {
            let path = raw.and_then(|value| self.path(value)).map(|path| {
                if suffix.is_empty() {
                    path
                } else {
                    path.join(suffix)
                }
            });
            if path
                .as_ref()
                .is_some_and(|p| p.as_os_str().len() > MAX_PATH)
            {
                self.truncated = true;
            }
            let Some(path) = path.filter(|p| p.as_os_str().len() <= MAX_PATH) else {
                return json!({"path":null,"source":source,"state":"invalid"});
            };
            let state = match fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() => "directory",
                Ok(_) => "invalid",
                Err(error) if error.kind() == io::ErrorKind::NotFound => "missing",
                Err(_) => "unavailable",
            };
            json!({"path":path,"source":source,"state":state})
        }
        fn home(&mut self, suffix: &str) -> Value {
            let home = self.variable("HOME");
            if home.is_none() {
                return json!({"path":null,"source":"HOME","state":"unavailable"});
            }
            self.profile(home, "HOME", suffix)
        }
        fn selected(&mut self, variable: &str, fallback: &str, suffix: &str) -> Value {
            match self.variable(variable) {
                Some(value) => self.profile(Some(value), variable, suffix),
                None => self.home(fallback),
            }
        }
        fn literal_profile(&mut self, variable: &str, fallback: &str) -> Value {
            // Pinned Kimi and Copilot resolvers preserve nonempty overrides verbatim.
            match (self.environment)(variable) {
                Some(value) if !value.is_empty() => self.profile(Some(value), variable, ""),
                _ => self.home(fallback),
            }
        }
        fn cline_profile(&mut self) -> Value {
            let Some(value) = (self.environment)("CLINE_DIR") else {
                return self.home(".cline");
            };
            // Cline uses ECMAScript String.trim: BOM is whitespace, NEL is not.
            let value = match value.to_str() {
                Some(text) => OsString::from(text.trim_matches(|c| {
                    matches!(c,
                        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
                        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
                        '\u{205f}' | '\u{3000}' | '\u{feff}'
                    )
                })),
                None => value,
            };
            if value.is_empty() {
                self.home(".cline")
            } else {
                self.profile(Some(value), "CLINE_DIR", "")
            }
        }
        fn config(&mut self, suffix: &str) -> Value {
            match self.variable("XDG_CONFIG_HOME") {
                Some(value) => self.profile(Some(value), "XDG_CONFIG_HOME", suffix),
                None => self.home(&format!(".config/{suffix}")),
            }
        }
        fn amp_profile(&mut self) -> Value {
            match (self.environment)("XDG_CONFIG_HOME") {
                Some(value) if !value.is_empty() => {
                    self.profile(Some(value), "XDG_CONFIG_HOME", "amp")
                }
                _ => self.home(".config/amp"),
            }
        }
        fn profiles(&mut self, agent: &str) -> Vec<Value> {
            vec![match agent {
                "claude" => self.selected("CLAUDE_CONFIG_DIR", ".claude", ""),
                "codex" => self.selected("CODEX_HOME", ".codex", ""),
                "cline" => self.cline_profile(),
                "copilot" if matches!(self.schema_version, 2 | 3) => {
                    self.literal_profile("COPILOT_HOME", ".copilot")
                }
                "amp" if self.schema_version == 3 => self.amp_profile(),
                "kimi" => {
                    let mut profiles = vec![
                        self.literal_profile("KIMI_CODE_HOME", ".kimi-code"),
                        self.literal_profile("KIMI_SHARE_DIR", ".kimi"),
                    ];
                    // Missing HOME yields one identical diagnostic for both dialects.
                    profiles.dedup();
                    return profiles;
                }
                "droid" => self.home(".factory"),
                "gemini" => self.selected("GEMINI_CLI_HOME", ".gemini", ".gemini"),
                // CLI-config overrides do not establish relocation of ~/.cursor/hooks.json.
                "cursor" => self.home(".cursor"),
                "opencode" => {
                    if let Some(value) = self.variable("OPENCODE_CONFIG_DIR") {
                        let custom = self.profile(Some(value), "OPENCODE_CONFIG_DIR", "");
                        if custom["state"] == "invalid" {
                            return vec![custom];
                        }
                        let global = self.config("opencode");
                        if custom["path"] != global["path"] {
                            return vec![custom, global];
                        }
                        custom
                    } else {
                        self.config("opencode")
                    }
                }
                _ => return vec![],
            }]
        }
        fn paths(&mut self) -> Vec<PathBuf> {
            let Some(raw) = self.variable("PATH") else {
                return vec![];
            };
            let Some(text) = raw.to_str() else {
                self.truncated = true;
                return vec![];
            };
            let mut result = vec![];
            let mut seen = HashSet::new();
            let mut bytes = 0;
            for (index, entry) in text.split(':').enumerate() {
                bytes += entry.len() + 1;
                if index >= MAX_PATH_ENTRIES || bytes > MAX_PATH_BYTES {
                    self.truncated = true;
                    break;
                }
                if let Some(path) = self.path(entry.into()) {
                    if seen.insert(path.clone()) {
                        result.push(path);
                    }
                }
            }
            result
        }
        fn executable(&mut self, path: &Path) -> bool {
            if path.as_os_str().len() > MAX_PATH {
                self.truncated = true;
                return false;
            }
            match fs::metadata(path) {
                Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
                Err(error) => {
                    if error.kind() != io::ErrorKind::NotFound {
                        self.truncated = true;
                    }
                    false
                }
            }
        }
        fn standalone(&mut self, profiles: &[Value]) -> Option<PathBuf> {
            let profile = profiles.iter().find(|p| p["state"] == "directory")?["path"].as_str()?;
            let releases = Path::new(profile).join("packages/standalone/releases");
            // Only the documented immediate release entries; no recursive home scan.
            if releases.as_os_str().len() > MAX_PATH {
                self.truncated = true;
                return None;
            }
            match fs::symlink_metadata(&releases) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => return None,
                Err(error) => {
                    if error.kind() != io::ErrorKind::NotFound {
                        self.truncated = true;
                    }
                    return None;
                }
            }
            let entries = match fs::read_dir(&releases) {
                Ok(entries) => entries,
                Err(_) => {
                    self.truncated = true;
                    return None;
                }
            };
            let mut paths = vec![];
            for (index, entry) in entries.enumerate() {
                if index >= MAX_RELEASES {
                    self.truncated = true;
                    break;
                }
                match entry {
                    Ok(entry)
                        if entry.file_name().to_str().is_some_and(|s| {
                            s.len() <= 128
                                && s.bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
                        }) =>
                    {
                        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                            paths.push(entry.path().join("bin/codex"));
                        }
                    }
                    _ => self.truncated = true,
                }
            }
            paths.sort();
            paths.into_iter().find(|path| self.executable(path))
        }
    }
    pub(super) fn discover(
        schema_version: u8,
        environment: impl FnMut(&str) -> Option<OsString>,
    ) -> Value {
        let mut scan = Scan {
            environment,
            truncated: false,
            schema_version,
        };
        let paths = scan.paths();
        let mut agents = vec![];
        for (agent, command, setup) in [
            ("claude", "claude", "managed"),
            ("codex", "codex", "managed"),
            ("droid", "droid", "managed"),
            ("gemini", "gemini", "managed"),
            ("cursor", "cursor-agent", "managed"),
            ("opencode", "opencode", "managed"),
            ("cline", "cline", "managed"),
            ("kimi", "kimi", "manual"),
            ("copilot", "copilot", "manual"),
            ("amp", "amp", "manual"),
            ("aider", "aider", "healthOnly"),
        ] {
            let profiles = scan.profiles(agent);
            let setup = if (agent == "copilot" && matches!(schema_version, 2 | 3))
                || (agent == "amp" && schema_version == 3)
            {
                "managed"
            } else {
                setup
            };
            // Search directories first: a legacy alias earlier on PATH wins
            // over a current alias later on PATH. Within a directory prefer agent.
            let aliases: &[&str] = if agent == "cursor" {
                &["agent", "cursor-agent"]
            } else {
                std::slice::from_ref(&command)
            };
            let on_path = paths
                .iter()
                .flat_map(|dir| aliases.iter().map(move |alias| dir.join(alias)))
                .find(|path| scan.executable(path));
            let executable = on_path
                .map(|path| json!({"path":path,"source":"path"}))
                .or_else(|| {
                    (agent == "codex")
                        .then(|| scan.standalone(&profiles))
                        .flatten()
                        .map(|path| json!({"path":path,"source":"codexStandalone"}))
                });
            let diagnostic = profiles.iter().any(|profile| {
                profile["source"] != "HOME"
                    && matches!(profile["state"].as_str(), Some("invalid" | "unavailable"))
            });
            if executable.is_none()
                && !profiles.iter().any(|p| p["state"] == "directory")
                && !diagnostic
            {
                continue;
            }
            let row =
                json!({"agent":agent,"setup":setup,"executable":executable,"profiles":profiles});
            agents.push(row);
            if serde_json::to_vec(&agents)
                .expect("finite discovery JSON")
                .len()
                > MAX_OUTPUT - 256
            {
                agents.pop();
                scan.truncated = true;
            }
        }
        json!({"schemaVersion":schema_version,"supported":true,"managedSetupSupported":cfg!(target_os="linux"),"agents":agents,"truncated":scan.truncated})
    }
}
