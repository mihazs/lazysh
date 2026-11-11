//! Host files brought to this device. A download streams the file into a private staging
//! directory (SFTP for SSH hosts, a plain copy for this device) with progress, a size
//! confirmation and cancellation; delivery then saves, opens or shares that copy. Nothing
//! here executes a file, follows a symbolic link unasked or overwrites an existing file.
use crate::{
    app_lock::AccessLease,
    host::{Host, Kind},
    local::LocalState,
    ssh::{AccessResult, AppState, Result, SshError},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
};

/// Copying anything larger needs the user's explicit confirmation first.
pub(crate) const LARGE: u64 = 50 * 1024 * 1024;
const MAX_TRANSFERS: usize = 2;
/// Finished copies kept for other apps (Open with, Share); older ones are deleted when a newer one finishes.
const KEEP_STAGED: usize = 3;
/// A host that sends nothing for this long has stalled the transfer.
const IDLE: Duration = Duration::from_secs(60);
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const PROGRESS_BYTES: u64 = 1024 * 1024;
const CHUNK: usize = 64 * 1024;
/// File types a system "open" could run rather than show; saving them is still allowed.
const RUNNABLE: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "ps1", "psm1", "vbs", "vbe", "js",
    "jse", "wsf", "wsh", "lnk", "url", "reg", "dll", "jar", "app", "command", "terminal", "sh",
    "bash", "zsh", "fish", "run", "bin", "appimage", "desktop", "workflow", "action", "scpt",
    "apk", "deb", "rpm", "dmg", "pkg",
];

/// What this device can do with a staged copy.
#[cfg(desktop)]
const ACTIONS: &[&str] = &["save", "open"];
#[cfg(target_os = "android")]
const ACTIONS: &[&str] = &["save", "open", "share"];
#[cfg(all(mobile, not(target_os = "android")))]
const ACTIONS: &[&str] = &[];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Save,
    Open,
    Share,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    path: String,
    name: String,
    kind: Kind,
    size: u64,
    /// Where a symbolic link points; `kind` and `size` then describe that target.
    link: Option<String>,
    /// The delivery actions this device supports.
    actions: &'static [&'static str],
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Progress {
    bytes: u64,
    total: Option<u64>,
}
#[derive(Debug, Serialize)]
pub struct Staged {
    name: String,
    size: u64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Delivered {
    /// Where a save put the file, when the platform says so.
    location: Option<String>,
}
/// The confirmations the user gave for this file; without them a link or a large file is refused.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub follow_link: bool,
    pub allow_large: bool,
}
pub(crate) struct Request<'a> {
    pub(crate) session_id: &'a str,
    pub(crate) id: &'a str,
    pub(crate) path: String,
    pub(crate) options: Options,
}

fn name_of(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_owned()
}
/// A file name that cannot leave its directory, hide itself or carry control characters.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let mut end = cleaned.len().min(120);
    while !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned[..end].into()
    }
}
fn unavailable() -> SshError {
    SshError::new(
        "transfer_unavailable",
        "This download is no longer available. Start it again.",
    )
}
fn cancelled() -> SshError {
    SshError::new(
        "transfer_cancelled",
        "Download cancelled. No file was kept.",
    )
}
fn io_error(error: io::Error) -> SshError {
    SshError::new("local_io", format!("Could not write the file: {error}"))
}
fn mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / 1_048_576.0)
}

struct Entry {
    session_id: String,
    generation: u64,
    cancel: watch::Sender<bool>,
    /// The finished copy and its completion sequence number.
    staged: Option<(PathBuf, Staged, u64)>,
}
/// Private staging directory plus one entry per download, owned by session and access generation.
pub(crate) struct Transfers {
    finished: std::sync::atomic::AtomicU64,
    root: PathBuf,
    #[cfg_attr(not(desktop), allow(dead_code))]
    downloads: Option<PathBuf>,
    entries: Mutex<HashMap<String, Entry>>,
}
impl Transfers {
    /// `root` holds staged copies and is emptied now: nothing survives a restart.
    pub(crate) fn new(root: PathBuf, downloads: Option<PathBuf>) -> Self {
        let _ = std::fs::remove_dir_all(&root);
        Self {
            finished: Default::default(),
            root,
            downloads,
            entries: Mutex::default(),
        }
    }
    fn dir(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }
    fn begin(&self, id: &str, session_id: &str, lease: &AccessLease) -> Result<Guard<'_>> {
        if !uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id) {
            return Err(unavailable());
        }
        let mut entries = self.entries.lock().map_err(|_| unavailable())?;
        if entries.contains_key(id) {
            return Err(unavailable());
        }
        if entries
            .values()
            .filter(|entry| entry.staged.is_none())
            .count()
            >= MAX_TRANSFERS
        {
            return Err(SshError::new(
                "transfer_busy",
                "Two downloads are already running. Cancel one or wait for it to finish.",
            ));
        }
        let (cancel, stopped) = watch::channel(false);
        entries.insert(
            id.into(),
            Entry {
                session_id: session_id.into(),
                generation: lease.generation(),
                cancel,
                staged: None,
            },
        );
        Ok(Guard {
            transfers: self,
            id: id.into(),
            stopped,
            keep: false,
        })
    }
    fn owned<T>(
        &self,
        id: &str,
        session_id: &str,
        lease: &AccessLease,
        action: impl FnOnce(&mut Entry) -> T,
    ) -> Option<T> {
        let mut entries = self.entries.lock().ok()?;
        entries
            .get_mut(id)
            .filter(|entry| {
                entry.session_id == session_id && entry.generation == lease.generation()
            })
            .map(action)
    }
    /// Stops a running download, or discards a finished one and its staged copy.
    pub(crate) fn cancel(&self, id: &str, session_id: &str, lease: &AccessLease) {
        let running = self.owned(id, session_id, lease, |entry| {
            entry.cancel.send_replace(true);
            entry.staged.is_some()
        });
        if running == Some(true) {
            self.remove(id);
        }
    }
    /// Deletes the oldest finished copies beyond `KEEP_STAGED`.
    fn evict(&self) {
        let old: Vec<String> = match self.entries.lock() {
            Ok(entries) => {
                let mut done: Vec<_> = entries
                    .iter()
                    .filter_map(|(id, entry)| {
                        entry.staged.as_ref().map(|staged| (staged.2, id.clone()))
                    })
                    .collect();
                done.sort();
                let surplus = done.len().saturating_sub(KEEP_STAGED);
                done.into_iter().take(surplus).map(|(_, id)| id).collect()
            }
            Err(_) => return,
        };
        for id in old {
            self.remove(&id);
        }
    }
    fn remove(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(id);
        }
        let _ = std::fs::remove_dir_all(self.dir(id));
    }
}
/// Ends the entry and its staging directory unless the download finished.
struct Guard<'a> {
    transfers: &'a Transfers,
    id: String,
    stopped: watch::Receiver<bool>,
    keep: bool,
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if !self.keep {
            self.transfers.remove(&self.id);
        }
    }
}

/// Streams the host file into `dir/name`, reporting progress, until done, cancelled or stalled.
async fn copy_out(
    mut source: crate::host::Source,
    options: Options,
    destination: &Path,
    mut stopped: watch::Receiver<bool>,
    report: &impl Fn(Progress),
) -> Result<u64> {
    let total = source.size;
    let limit = match total {
        Some(size) if size > LARGE && !options.allow_large => {
            return Err(SshError::new(
                "file_large",
                format!("This file is {}. Confirm the download first.", mib(size)),
            ))
        }
        // An unreported size is read to its end, but only up to the confirmed size.
        Some(size) => size,
        None if options.allow_large => u64::MAX,
        None => LARGE,
    };
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create_new(true);
    // Staged copies are never executable.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    let mut file = tokio::fs::File::from_std(open.open(destination).map_err(io_error)?);
    let (mut buffer, mut bytes, mut last) = (vec![0u8; CHUNK], 0u64, Instant::now());
    let mut reported = 0u64;
    report(Progress { bytes, total });
    while bytes < limit {
        if *stopped.borrow() {
            return Err(cancelled());
        }
        let want = buffer.len().min((limit - bytes).min(CHUNK as u64) as usize);
        let read = tokio::select! { biased;
            _ = stopped.changed() => return Err(cancelled()),
            read = tokio::time::timeout(IDLE, source.reader.read(&mut buffer[..want])) => read
                .map_err(|_| SshError::new("timeout", "The host stopped sending data."))??,
        };
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).await.map_err(io_error)?;
        bytes += read as u64;
        if last.elapsed() >= PROGRESS_EVERY || bytes - reported >= PROGRESS_BYTES {
            report(Progress { bytes, total });
            (reported, last) = (bytes, Instant::now());
        }
    }
    if total.is_some_and(|size| bytes < size) {
        return Err(SshError::new(
            "file_changed",
            "The file got shorter while it was downloading.",
        ));
    }
    if total.is_none() && bytes >= limit && limit != u64::MAX {
        return Err(SshError::new(
            "file_large",
            "The host did not report this file's size and it is larger than 50 MiB. Confirm the download first.",
        ));
    }
    file.flush().await.map_err(io_error)?;
    report(Progress { bytes, total });
    Ok(bytes)
}

/// The native part of a download, independent of the IPC layer so it can be tested directly.
pub(crate) async fn download(
    transfers: &Transfers,
    host: &Host,
    lease: &AccessLease,
    request: Request<'_>,
    report: impl Fn(Progress),
) -> Result<Staged> {
    let Request {
        session_id,
        id,
        path,
        options,
    } = request;
    let mut guard = transfers.begin(id, session_id, lease)?;
    let name = safe_name(&name_of(&path));
    let work = async {
        let source = host.open_file(lease, path, options.follow_link).await?;
        let dir = transfers.dir(id);
        std::fs::create_dir_all(&dir).map_err(io_error)?;
        let size = copy_out(
            source,
            options,
            &dir.join(&name),
            guard.stopped.clone(),
            &report,
        )
        .await?;
        Ok::<_, SshError>(size)
    };
    // Cancel also stops a transfer still opening its SFTP channel.
    let mut stopped = guard.stopped.clone();
    let size = tokio::select! { biased;
        _ = lease.cancelled() => return Err(SshError::new("app_locked", "App access changed")),
        _ = stopped.changed() => return Err(cancelled()),
        result = work => result?,
    };
    let staged = Staged { name, size };
    let file = transfers.dir(id).join(&staged.name);
    let order = transfers
        .finished
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let kept = transfers.owned(id, session_id, lease, |entry| {
        entry.staged = Some((
            file,
            Staged {
                name: staged.name.clone(),
                size,
            },
            order,
        ));
    });
    if kept.is_none() {
        return Err(cancelled());
    }
    guard.keep = true;
    transfers.evict();
    Ok(staged)
}

#[cfg_attr(not(desktop), allow(dead_code))]
/// Copies the staged file into `directory` under a name that does not exist yet: `name (1).ext`, `name (2).ext`...
pub(crate) fn save_to(directory: &Path, staged: &Path, name: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(directory).map_err(io_error)?;
    let (stem, extension) = match name.rfind('.').filter(|dot| *dot > 0) {
        Some(dot) => (&name[..dot], &name[dot..]),
        None => (name, ""),
    };
    for number in 0..1000 {
        let candidate = if number == 0 {
            name.to_owned()
        } else {
            format!("{stem} ({number}){extension}")
        };
        let target = directory.join(candidate);
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create_new(true);
        match open.open(&target) {
            Ok(mut out) => {
                let result = std::fs::File::open(staged)
                    .and_then(|mut source| io::copy(&mut source, &mut out));
                if let Err(error) = result {
                    drop(out);
                    let _ = std::fs::remove_file(&target);
                    return Err(io_error(error));
                }
                return Ok(target);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(error)),
        }
    }
    Err(SshError::new(
        "local_io",
        "Too many files with this name already exist in the folder.",
    ))
}
/// Refuses file types a system "open" could run instead of show.
pub(crate) fn openable(name: &str) -> Result<()> {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    if extension.is_some_and(|extension| RUNNABLE.contains(&extension.as_str())) {
        return Err(SshError::new(
            "open_refused",
            "lazysh does not open programs or scripts. Download the file instead.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn host_file_stat(
    lease: AccessLease,

    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    path: String,
) -> AccessResult<Stat> {
    lease
        .run(async {
            if path.is_empty() || path.len() > 4096 || path.contains('\0') {
                return Err(SshError::new("invalid_path", "Enter a valid remote path"));
            }
            let found = Host::resolve(&state, &local, &session_id, &lease)
                .await?
                .stat_file(&lease, path.clone())
                .await?;
            Ok(Stat {
                name: name_of(&path),
                path,
                kind: found.kind,
                size: found.size,
                link: found.link,
                actions: ACTIONS,
            })
        })
        .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Native-injected lease and state plus the typed IPC fields.
pub async fn host_file_download(
    lease: AccessLease,

    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    transfers: State<'_, Transfers>,
    session_id: String,
    path: String,
    transfer_id: String,
    follow_link: bool,
    allow_large: bool,
    progress: Channel<Progress>,
) -> AccessResult<Staged> {
    lease
        .run(async {
            if path.is_empty() || path.len() > 4096 || path.contains('\0') {
                return Err(SshError::new("invalid_path", "Enter a valid remote path"));
            }
            let host = Host::resolve(&state, &local, &session_id, &lease).await?;
            let request = Request {
                session_id: &session_id,
                id: &transfer_id,
                path,
                options: Options {
                    follow_link,
                    allow_large,
                },
            };
            download(&transfers, &host, &lease, request, |value| {
                let _ = progress.send(value);
            })
            .await
        })
        .await
}
/// Stops a running download or discards a finished one; unknown ids are ignored.
#[tauri::command]
pub async fn host_file_cancel(
    lease: AccessLease,

    transfers: State<'_, Transfers>,
    session_id: String,
    transfer_id: String,
) -> AccessResult<()> {
    lease
        .run(async {
            transfers.cancel(&transfer_id, &session_id, &lease);
            Ok(())
        })
        .await
}
#[tauri::command]
pub async fn host_file_deliver(
    lease: AccessLease,

    app: tauri::AppHandle,
    transfers: State<'_, Transfers>,
    session_id: String,
    transfer_id: String,
    action: Action,
) -> AccessResult<Delivered> {
    lease
        .run(async {
            let (file, name) = transfers
                .owned(&transfer_id, &session_id, &lease, |entry| {
                    entry
                        .staged
                        .as_ref()
                        .map(|(file, staged, _)| (file.clone(), staged.name.clone()))
                })
                .flatten()
                .ok_or_else(unavailable)?;
            if !ACTIONS.contains(&match action {
                Action::Save => "save",
                Action::Open => "open",
                Action::Share => "share",
            }) {
                return Err(SshError::new(
                    "exchange_unsupported",
                    "This device cannot do that with a downloaded file.",
                ));
            }
            if action == Action::Open {
                openable(&name)?;
            }
            deliver(&app, &transfers, &file, &name, action).await
        })
        .await
}
#[cfg(desktop)]
async fn deliver(
    app: &tauri::AppHandle,
    transfers: &Transfers,
    file: &Path,
    name: &str,
    action: Action,
) -> Result<Delivered> {
    use tauri_plugin_opener::OpenerExt;
    match action {
        Action::Save => {
            let directory = transfers
                .downloads
                .clone()
                .ok_or_else(|| SshError::new("local_io", "This device has no Downloads folder."))?;
            let (file, name) = (file.to_owned(), name.to_owned());
            let saved = tokio::task::spawn_blocking(move || save_to(&directory, &file, &name))
                .await
                .map_err(|_| SshError::new("local_io", "Saving stopped"))??;
            Ok(Delivered {
                location: Some(saved.to_string_lossy().into_owned()),
            })
        }
        _ => {
            app.opener()
                .open_path(file.to_string_lossy(), None::<&str>)
                .map_err(|_| {
                    SshError::new(
                        "open_failed",
                        "No app on this device could open the file. Download it instead.",
                    )
                })?;
            Ok(Delivered { location: None })
        }
    }
}
#[cfg(target_os = "android")]
async fn deliver(
    app: &tauri::AppHandle,
    _transfers: &Transfers,
    file: &Path,
    name: &str,
    action: Action,
) -> Result<Delivered> {
    use tauri::Manager;
    let command = match action {
        Action::Save => "save",
        Action::Open => "open",
        Action::Share => "share",
    };
    app.state::<AndroidFiles>()
        .0
        .run_mobile_plugin_async(command, serde_json::json!({"path": file, "name": name}))
        .await
        .map_err(|error| match error {
            tauri::plugin::mobile::PluginInvokeError::InvokeRejected(error) => {
                match error.message.as_deref() {
                    Some("exchange_cancelled") => SshError::new(
                        "exchange_cancelled",
                        "Saving was cancelled. No file was written.",
                    ),
                    message => SshError::new(
                        "exchange_failed",
                        message.unwrap_or("Android could not complete this action."),
                    ),
                }
            }
            _ => SshError::new("exchange_failed", "Android file service is unavailable."),
        })
}
#[cfg(all(mobile, not(target_os = "android")))]
async fn deliver(
    _app: &tauri::AppHandle,
    _transfers: &Transfers,
    _file: &Path,
    _name: &str,
    _action: Action,
) -> Result<Delivered> {
    Err(SshError::new(
        "exchange_unsupported",
        "This device cannot do that with a downloaded file.",
    ))
}

/// Android saves, opens and shares through its own Activity; the renderer cannot call it.
#[cfg(target_os = "android")]
struct AndroidFiles(tauri::plugin::PluginHandle<tauri::Wry>);

/// Registers the Android bridge; desktop has nothing to load.
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lazysh-files")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("unavailable");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(AndroidFiles(api.register_android_plugin(
                    "app.lazysh.client",
                    "FileExchangePlugin",
                )?));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
/// Staged copies live in the app cache and are emptied at every start; saves go to Downloads on desktop.
pub fn install(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::Manager;
    #[cfg(desktop)]
    let downloads = app.path().download_dir().ok();
    #[cfg(mobile)]
    let downloads = None;
    app.manage(Transfers::new(
        app.path().app_cache_dir()?.join("host-files"),
        downloads,
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_names_cannot_leave_their_directory_or_carry_control_characters() {
        assert_eq!(name_of("/home/u/a b/Résumé 世界.txt"), "Résumé 世界.txt");
        assert_eq!(name_of("/home/u/dir/"), "dir");
        assert_eq!(name_of("C:\\Users\\u\\report.pdf"), "report.pdf");
        for (given, expected) in [
            ("report final.pdf", "report final.pdf"),
            ("../../etc/passwd", "_.._etc_passwd"),
            ("..", "file"),
            ("", "file"),
            ("  .hidden  ", "hidden"),
            ("a\nb\u{7}c", "a_b_c"),
            ("what?*.txt", "what__.txt"),
        ] {
            assert_eq!(safe_name(given), expected, "{given:?}");
        }
        assert!(safe_name(&"é".repeat(300)).len() <= 120);
    }
    #[test]
    fn programs_and_scripts_are_never_handed_to_a_system_open() {
        for name in [
            "setup.exe",
            "RUN.BAT",
            "x.sh",
            "tool.AppImage",
            "a.b.ps1",
            "evil.jar",
            "Z.command",
        ] {
            assert_eq!(openable(name).unwrap_err().kind(), "open_refused", "{name}");
        }
        for name in [
            "notes.txt",
            "photo.jpg",
            "report.pdf",
            "archive.tar.gz",
            "noextension",
            "sh",
            ".bashrc.txt",
        ] {
            assert!(openable(name).is_ok(), "{name}");
        }
    }
    #[test]
    fn saving_never_overwrites_an_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let staged = temp.path().join("staged");
        std::fs::write(&staged, "new content").unwrap();
        let downloads = temp.path().join("Downloads");
        std::fs::create_dir(&downloads).unwrap();
        std::fs::write(downloads.join("a.txt"), "mine").unwrap();
        std::fs::write(downloads.join("noext"), "mine").unwrap();
        let first = save_to(&downloads, &staged, "a.txt").unwrap();
        let second = save_to(&downloads, &staged, "a.txt").unwrap();
        let bare = save_to(&downloads, &staged, "noext").unwrap();
        assert_eq!(first.file_name().unwrap(), "a (1).txt");
        assert_eq!(second.file_name().unwrap(), "a (2).txt");
        assert_eq!(bare.file_name().unwrap(), "noext (1)");
        assert_eq!(
            std::fs::read_to_string(downloads.join("a.txt")).unwrap(),
            "mine"
        );
        assert_eq!(
            std::fs::read_to_string(downloads.join("noext")).unwrap(),
            "mine"
        );
        assert_eq!(std::fs::read_to_string(second).unwrap(), "new content");
    }
}
