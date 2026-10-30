use crate::{config::AnthropicConfig, error::Result};
use serde::Deserialize;
use std::path::{Path, PathBuf};
/// Claude Desktop's own state file: OAuth token caches plus the account pointer.
const CONFIG_JSON: &str = "config.json";
/// Root of the per-account session-index tree, `<root>/<account>/<org>/`.
const SESSIONS_DIR: &str = "claude-code-sessions";
/// Chromium-style cookie jar — part of the renderer's identity, not just
/// `config.json`'s oauth fields.
const COOKIE_FILES: [&str; 2] = ["Cookies", "Cookies-journal"];
/// LevelDB stores that carry the rest of that identity.
const LEVELDB_DIRS: [&str; 3] = ["Local Storage", "Session Storage", "IndexedDB"];
/// Remote-control / cloud-session bridge. Holds a volatile `cse_…` session id
/// that goes stale fast, so it is deleted on every switch and *never* saved
/// into a profile: restoring a dead id makes `/remote-control` fail to
/// disconnect.
const BRIDGE_FILE: &str = "bridge-state.json";
/// Account-keyed map of browser-extension device registrations. Additive only —
/// see [`merge::merge_device_registry`].
const DEVICE_REGISTRY: &str = "ant-device-registry.json";

/// Profile-store filenames, owned by claude-acc's layout.
const TOKEN_CACHE: &str = "config-tokenCache";
const TOKEN_CACHE_V2: &str = "config-tokenCacheV2";
const DESKTOP_STATE: &str = "desktop-state";
const META_JSON: &str = "meta.json";
/// One credential mutation can include a remote OAuth refresh. Account
/// switching waits on the same lock rather than racing or failing after the
/// old two-second window.
pub const ACCOUNT_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Where the Claude Desktop app and the saved profiles live.
///
/// Constructed with [`Paths::at`] in tests so nothing reads a real `$HOME`.
#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub profiles_dir: PathBuf,
    pub backups_dir: PathBuf,
}

impl Paths {
    fn profiles_directory(anthropic: &AnthropicConfig, home: &Path) -> PathBuf {
        anthropic
            .desktop_profiles_dir
            .clone()
            .unwrap_or_else(|| home.join(".claude-acc").join("profiles"))
    }
    /// Test seam: every root explicit.
    pub fn at(data_dir: PathBuf, profiles_dir: PathBuf, backups_dir: PathBuf) -> Self {
        Self {
            data_dir,
            profiles_dir,
            backups_dir,
        }
    }

    /// Production paths. `desktop_profiles_dir` overrides the claude-acc
    /// default; rollback archives land beside the profile store.
    pub fn resolve(anthropic: &AnthropicConfig) -> Result<Self> {
        let home = crate::cache::home_dir()?;
        let profiles_dir = Self::profiles_directory(anthropic, &home);
        let backups_dir = profiles_dir
            .parent()
            .map_or_else(|| home.join(".claude-acc"), Path::to_path_buf)
            .join("backups");
        Ok(Self {
            data_dir: home.join("Library/Application Support/Claude"),
            profiles_dir,
            backups_dir,
        })
    }

    /// Production paths against an explicit profile directory, for a relocated
    /// Claude Desktop profile (one launched with `--user-data-dir`).
    ///
    /// `profiles_dir` stays shared: it is the label-keyed store of saved
    /// credentials, and the same accounts back every profile.
    ///
    /// `backups_dir` is deliberately NOT shared, and must never be "simplified"
    /// back to one location. [`Self::synced_path`] derives from it, and that
    /// ledger records what each account held *after the last merge*, which
    /// [`merge::deletion_candidates`] diffs live state against. Two profiles
    /// sharing one ledger would each overwrite it with their own narrower view,
    /// so keys merely absent from one profile would later read as intentional
    /// deletions — phantom candidates that an interactive switch can then
    /// answer, and therefore delete for real.
    pub fn for_data_dir(data_dir: PathBuf, anthropic: &AnthropicConfig) -> Result<Self> {
        let home = crate::cache::home_dir()?;
        let profiles_dir = Self::profiles_directory(anthropic, &home);
        // A sibling of the profile, never inside it: nothing Claude Desktop
        // reads should gain directories we own.
        let mut sibling = data_dir.clone().into_os_string();
        sibling.push("-ai-usagebar");
        Ok(Self {
            data_dir,
            profiles_dir,
            backups_dir: PathBuf::from(sibling).join("backups"),
        })
    }

    /// Whether there is a Claude Desktop app installation to act on at all.
    /// False on Linux, and on a Mac where the app has never run.
    pub fn available(&self) -> bool {
        self.data_dir.is_dir()
    }

    pub fn config_json(&self) -> PathBuf {
        self.data_dir.join(CONFIG_JSON)
    }

    pub fn sessions_root(&self) -> PathBuf {
        self.data_dir.join(SESSIONS_DIR)
    }

    pub fn profile_dir(&self, label: &str) -> PathBuf {
        self.profiles_dir.join(label)
    }

    /// Shared by Desktop account switching and inactive-profile OAuth refresh.
    /// Both operations can rotate or install the same saved credential.
    pub fn account_switch_lock(&self) -> PathBuf {
        self.backups_dir.join(".account-switch.lock")
    }

    /// Where [`capture`] parks the live login before clearing it, so a
    /// cancelled capture can put the account back. Sits beside the archives.
    pub fn prelogin_dir(&self) -> PathBuf {
        self.backups_dir.with_file_name("prelogin-backup")
    }

    /// What each account's schedule registry held after the last merge, keyed
    /// by account UUID. Kept beside the profile store rather than inside a
    /// profile so both this tool and claude-acc read and write one record, and
    /// so accounts without a captured profile are still tracked.
    pub fn synced_path(&self) -> PathBuf {
        self.backups_dir.with_file_name("synced.json")
    }
}

/// One saved account in the profile store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileMeta {
    /// The profile directory's name — authoritative, so a hand-edited
    /// `meta.json` can never make a profile answer to the wrong label.
    pub label: String,
    pub email: Option<String>,
    pub account_uuid: String,
    /// Absent until the app has created a session folder for the account;
    /// without it the history merges are skipped but the credential swap
    /// still works.
    pub org_uuid: Option<String>,
    pub has_credentials: bool,
    pub has_desktop_state: bool,
}

#[derive(Debug, Deserialize)]
struct RawMeta {
    email: Option<String>,
    #[serde(rename = "accountUuid")]
    account_uuid: Option<String>,
    #[serde(rename = "orgUuid")]
    org_uuid: Option<String>,
}

/// Every saved profile, sorted by label. Best-effort by design: one unreadable
/// or hand-mangled `meta.json` is skipped rather than failing `account status`
/// for every other account.
pub fn load_profiles(profiles_dir: &Path) -> Vec<ProfileMeta> {
    let Ok(entries) = std::fs::read_dir(profiles_dir) else {
        return Vec::new();
    };
    let mut profiles: Vec<ProfileMeta> = entries
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            let label = dir.file_name()?.to_str()?.to_string();
            let raw: RawMeta =
                serde_json::from_slice(&std::fs::read(dir.join(META_JSON)).ok()?).ok()?;
            let account_uuid = raw.account_uuid.filter(|uuid| !uuid.is_empty())?;
            Some(ProfileMeta {
                label,
                email: raw.email.filter(|email| !email.is_empty()),
                account_uuid,
                org_uuid: raw.org_uuid.filter(|uuid| !uuid.is_empty()),
                has_credentials: dir.join(TOKEN_CACHE).is_file()
                    && dir.join(TOKEN_CACHE_V2).is_file(),
                has_desktop_state: dir.join(DESKTOP_STATE).is_dir(),
            })
        })
        .collect();
    profiles.sort_by(|a, b| a.label.cmp(&b.label));
    profiles
}

pub fn active_account_uuid(config_json: &Path) -> Option<String> {
    let bytes = std::fs::read(config_json).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("lastKnownAccountUuid")?
        .as_str()
        .filter(|uuid| !uuid.is_empty())
        .map(str::to_string)
}
