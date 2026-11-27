//! Desktop-only terminal sessions. These never own an SSH identity or transport.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use crate::app_lock::AccessState;
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::SshEvent;
type AccessResult<T> = Result<Guarded<T>, GuardedError<String>>;
use serde::Serialize;
use tauri::{ipc::Channel, State};

#[cfg(desktop)]
mod targets;
#[cfg(desktop)]
mod wsl;
#[cfg(desktop)]
pub(crate) use wsl::{Located, Wsl};

#[derive(Serialize)]
pub struct Capability {
    available: bool,
    reason: &'static str,
    targets: Vec<Target>,
    /// The OS this app runs on (`macos`, `windows`, `linux`, `android`, `ios`); the web view's
    /// user agent is not a contract, so the UI scopes OS-specific controls with this.
    platform: &'static str,
}
/// A local place sessions run in, with the host tools the UI may offer for it.
#[derive(Serialize)]
#[cfg_attr(not(desktop), allow(dead_code))]
pub struct Target {
    id: String,
    label: String,
    kind: &'static str,
    tools: Tools,
}
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(desktop), allow(dead_code))]
pub struct Tools {
    files: bool,
    repository: bool,
    /// A `lazysh-agent` is bundled, managed or on the PATH: the Agents board and approvals work.
    companion: bool,
    attachments: bool,
    previews: bool,
    /// Which of those it is, for the companion panel; `None` exactly when `companion` is false.
    #[cfg(desktop)]
    companion_source: Option<crate::companion::local::Source>,
    /// Multiplexers a local session can attach: on the PATH local commands receive, and never tmux
    /// on a native Windows target, which has no tmux build.
    tmux: bool,
    herdr: bool,
    zellij: bool,
    /// An Android SDK `adb` (or, on macOS, `xcrun`) resolves: the Devices view works.
    devices: bool,
}
/// Whether a local session can attach `tool`: it is on the PATH local commands receive, and the
/// platform has a build of it.
#[cfg(desktop)]
async fn attachable(tool: &str) -> bool {
    !(cfg!(windows) && tool == "tmux") && crate::host::local_program(tool).await
}
/// The login shell (`%ComSpec%` on Windows): what **Open local terminal** starts.
#[cfg(desktop)]
const DEFAULT_TARGET: &str = "default";
#[tauri::command]
pub async fn local_capability() -> Capability {
    #[cfg(desktop)]
    {
        let shell = portable_pty::CommandBuilder::new_default_prog().get_shell();
        let companion_source = crate::companion::local::source().await;
        let tools = Tools {
            files: true,
            repository: crate::host::local_program("git").await,
            companion: companion_source.is_some(),
            companion_source,
            // Uploads write files and previews connect to loopback ports from this device.
            attachments: true,
            previews: true,
            devices: crate::host::local_devices().await,
            tmux: attachable("tmux").await,
            herdr: attachable("herdr").await,
            zellij: attachable("zellij").await,
        };
        let mut targets = vec![Target {
            id: DEFAULT_TARGET.into(),
            label: std::path::Path::new(&shell)
                .file_stem()
                .map_or(shell.clone(), |name| name.to_string_lossy().into_owned()),
            kind: if cfg!(windows) { "windows" } else { "posix" },
            tools: tools.clone(),
        }];
        // A distribution reports the host tools that start inside it; every other shell shares this device's.
        let detected = targets::detect(true).await;
        targets.extend(
            futures_util::future::join_all(detected.iter().map(|found| async {
                let tools = match found.wsl() {
                    Some(wsl) => wsl.tools().await,
                    None => tools.clone(),
                };
                found.target(tools)
            }))
            .await,
        );
        Capability {
            platform: std::env::consts::OS,
            available: true,
            reason: "Local shell runs on this desktop device.",
            targets,
        }
    }
    #[cfg(not(desktop))]
    {
        Capability {
            platform: std::env::consts::OS,
            available: false,
            reason: "Local terminals require the desktop app.",
            targets: Vec::new(),
        }
    }
}
/// The user's home directory, where local sessions and relative host-tool paths start.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(crate) fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_dir())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    session_id: String,
}
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub use desktop::LocalState;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
#[derive(Default)]
pub struct LocalState;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
impl LocalState {
    pub(crate) async fn cancel_for_renderer_rebind(&self) {}
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn local_connect(
    lease: AccessLease,

    state: State<'_, LocalState>,
    launch: State<'_, crate::desktop_launch::LaunchState>,
    launch_receipt: Option<String>,
    attach: Option<crate::multiplexer::Entry>,
    target: Option<String>,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> AccessResult<Connected> {
    lease
        .run(async {
            #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
            {
                let directory = match launch_receipt {
                    Some(receipt) => Some(launch.claim(&receipt, &lease)?),
                    None => None,
                };
                desktop::connect(
                    &state,
                    lease.clone(),
                    directory,
                    attach,
                    target.as_deref(),
                    cols,
                    rows,
                    events,
                )
                .await
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
            {
                let _ = (
                    state,
                    launch,
                    launch_receipt,
                    attach,
                    target,
                    cols,
                    rows,
                    events,
                );
                Err("Local terminals require the desktop app".into())
            }
        })
        .await
}
#[tauri::command]
pub async fn local_write(
    lease: AccessLease,

    state: State<'_, LocalState>,
    session_id: String,
    data: String,
    steps: Option<Vec<String>>,
) -> AccessResult<()> {
    lease
        .run(async {
            #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
            {
                let data = crate::terminal_input::InputSequence::parse(data, steps)?;
                desktop::write_sequence(&state, &session_id, data, lease.clone())
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
            {
                let _ = (state, session_id, data, steps);
                Err("Local terminals require the desktop app".into())
            }
        })
        .await
}
#[tauri::command]
pub async fn local_resize(
    lease: AccessLease,

    state: State<'_, LocalState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AccessResult<()> {
    lease
        .run(async {
            #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
            {
                desktop::resize(&state, &session_id, cols, rows, lease.clone())
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
            {
                let _ = (state, session_id, cols, rows);
                Err("Local terminals require the desktop app".into())
            }
        })
        .await
}
#[tauri::command]
pub fn local_ack(
    state: State<'_, LocalState>,
    session_id: String,
    bytes: u32,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        desktop::ack(&state, &session_id, bytes)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, session_id, bytes);
        Err("Local terminals require the desktop app".into())
    }
}
#[tauri::command]
pub fn local_disconnect(state: State<'_, LocalState>, session_id: String) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        desktop::disconnect(&state, &session_id);
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, session_id);
        Ok(())
    }
}
pub(crate) fn usage_session(
    state: &LocalState,
    id: &str,
    lease: &AccessLease,
) -> Result<tokio::sync::watch::Receiver<bool>, String> {
    #[cfg(desktop)]
    {
        desktop::host_session(state, id, lease).map(|(cancel, _)| cancel)
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, id, lease);
        Err("Local terminals are unavailable".into())
    }
}
/// The close signal of an adopted local terminal and the WSL distribution its host tools run in.
#[cfg(desktop)]
pub(crate) fn host_session(
    state: &LocalState,
    id: &str,
    lease: &AccessLease,
) -> Result<(tokio::sync::watch::Receiver<bool>, Option<Wsl>), String> {
    desktop::host_session(state, id, lease)
}
/// The tmux navigation binding of an adopted local terminal and its close signal.
pub(crate) fn tmux_binding(
    state: &LocalState,
    id: &str,
    lease: &AccessLease,
) -> Result<
    (
        crate::tmux_jump::Binding,
        tokio::sync::watch::Receiver<bool>,
    ),
    String,
> {
    #[cfg(desktop)]
    {
        desktop::tmux_binding(state, id, lease)
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, id, lease);
        Err("Local terminals are unavailable".into())
    }
}
/// The tmux server an adopted local terminal is attached to, when it is attached to one.
#[cfg(desktop)]
pub(crate) fn tmux_server(
    state: &LocalState,
    id: &str,
    lease: &AccessLease,
) -> Result<Option<crate::tmux_server::TmuxServer>, String> {
    desktop::tmux_server(state, id, lease)
}
/// The guarded Herdr binding of an adopted local terminal, if it has one, and its close signal.
pub(crate) fn herdr_binding(
    state: &LocalState,
    id: &str,
    lease: &AccessLease,
) -> Result<
    (
        Option<crate::herdr_guard::Binding>,
        tokio::sync::watch::Receiver<bool>,
    ),
    String,
> {
    #[cfg(desktop)]
    {
        desktop::binding(state, id, lease, |bindings| &bindings.herdr)
    }
    #[cfg(not(desktop))]
    {
        let _ = (state, id, lease);
        Err("Local terminals are unavailable".into())
    }
}
pub(crate) fn adopt(state: &LocalState, id: &str, request: &AccessLease) -> Result<bool, String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        desktop::adopt(state, id, request)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, id, request);
        Ok(false)
    }
}
/// A real, adopted local terminal running the default login shell.
#[cfg(all(
    test,
    any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
pub(crate) async fn adopted_test_session(state: &LocalState, lease: AccessLease) -> String {
    let connected = desktop::connect(
        state,
        lease.clone(),
        None,
        None,
        None,
        80,
        24,
        Channel::new(|_| Ok(())),
    )
    .await
    .unwrap();
    desktop::adopt(state, &connected.session_id, &lease).unwrap();
    connected.session_id
}
pub fn install_cleanup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        use tauri::Manager;
        let sessions = app.state::<LocalState>().clone_inner();
        if let Some(window) = app.get_webview_window("main") {
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    sessions.stop_all();
                }
            });
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let _ = app;
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod desktop {
    use super::*;
    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    #[cfg(unix)]
    use std::os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    };
    use std::{
        collections::HashMap,
        io::{Read, Write},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };
    use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit, Semaphore};
    #[cfg(unix)]
    struct UnixIo {
        pty: OwnedFd,
        wake: UnixStream,
    }
    #[cfg(unix)]
    impl UnixIo {
        fn new(fd: i32) -> Result<(Arc<Self>, UnixStream), String> {
            let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err("Could not duplicate local PTY descriptor".into());
            }
            let pty = unsafe { OwnedFd::from_raw_fd(duplicate) };
            let (wake, signal) = UnixStream::pair().map_err(|error| error.to_string())?;
            signal
                .set_nonblocking(true)
                .map_err(|error| error.to_string())?;
            Ok((Arc::new(Self { pty, wake }), signal))
        }
        fn wait(&self, events: i16) -> std::io::Result<bool> {
            let mut descriptors = [
                libc::pollfd {
                    fd: self.pty.as_raw_fd(),
                    events,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.wake.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            loop {
                let result = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, -1) };
                if result >= 0 {
                    return Ok(descriptors[1].revents == 0);
                }
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
    const WINDOW: usize = 256 * 1024;
    const SESSION_LIMIT: u32 = 20;
    enum Input {
        Data(crate::terminal_input::InputSequence, AccessLease),
        Resize(u32, u32, AccessLease),
        Close,
    }
    struct Session {
        input: mpsc::Sender<Input>,
        cancel: watch::Sender<bool>,
        credits: Semaphore,
        inflight: Mutex<u32>,
        /// Set when the native terminal core consumes this session's output instead of the WebView.
        core: crate::terminal_core::CoreSlot,
        access: AccessState,
        creation: AccessLease,
        adopted: AtomicBool,
        adoption: tokio::sync::Notify,
        process: Arc<Mutex<Option<Process>>>,
        stopped: Arc<AtomicBool>,
        #[cfg(unix)]
        wake: UnixStream,
        renderer_gone: watch::Sender<bool>,
        bindings: crate::bindings::Bindings,
        /// The distribution of a WSL target, set once before the renderer can adopt the session.
        wsl: std::sync::OnceLock<Wsl>,
    }
    impl Session {
        /// Return `bytes` of consumed output credit (a forged or repeated credit is refused).
        fn acknowledge(&self, bytes: u32) -> Result<(), String> {
            let mut pending = self
                .inflight
                .lock()
                .map_err(|_| "Local output lock failed")?;
            if bytes == 0 || bytes > *pending {
                return Err("Local output acknowledgment exceeds pending data".into());
            }
            *pending -= bytes;
            self.credits.add_permits(bytes as usize);
            Ok(())
        }
        /// The native core's replies and encoded input, queued like `local_write`'s.
        fn queue_core_input(&self, bytes: Vec<u8>, lease: &AccessLease) -> Result<(), String> {
            self.input
                .try_send(Input::Data(bytes.into(), lease.clone()))
                .map_err(|error| error.to_string())
        }
        fn stop(&self) {
            self.stopped.store(true, Ordering::SeqCst);
            self.cancel.send_replace(true);
            self.credits.close();
            let _ = self.input.try_send(Input::Close);
            #[cfg(unix)]
            {
                let _ = (&self.wake).write(&[1]);
            }
        }
    }
    pub struct Inner {
        sessions: Mutex<HashMap<String, Arc<Session>>>,
        retiring: Mutex<HashMap<String, Arc<Session>>>,
        slots: Arc<Semaphore>,
        stopped: AtomicBool,
        /// Variables every host-tool command of a test session receives, so a test can
        /// keep real multiplexers away from the user's own state.
        #[cfg(test)]
        test_env: Mutex<Vec<(String, String)>>,
    }
    impl Inner {
        fn with_sessions<T>(
            &self,
            action: impl FnOnce(
                &mut HashMap<String, Arc<Session>>,
                &mut HashMap<String, Arc<Session>>,
            ) -> T,
        ) -> T {
            let mut active = self
                .sessions
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let mut retiring = self
                .retiring
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            action(&mut active, &mut retiring)
        }
        pub fn stop_all(&self) {
            self.stopped.store(true, Ordering::SeqCst);
            let sessions = {
                let active = self
                    .sessions
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let retiring = self
                    .retiring
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                active
                    .values()
                    .chain(retiring.values())
                    .cloned()
                    .collect::<Vec<_>>()
            };
            for session in &sessions {
                session.stop();
            }
            // Window destruction and state drop must not depend on an async
            // supervisor getting another turn before the app runtime exits.
            for session in sessions {
                if let Ok(mut process) = session.process.lock() {
                    drop(process.take());
                }
            }
        }
        fn session(&self, id: &str) -> Result<Arc<Session>, String> {
            self.sessions
                .lock()
                .map_err(|_| "Local terminal lock failed")?
                .get(id)
                .cloned()
                .filter(|session| !session.stopped.load(Ordering::SeqCst))
                .ok_or_else(|| "Local terminal is disconnected".into())
        }
    }
    pub struct LocalState(Arc<Inner>);
    impl Default for LocalState {
        fn default() -> Self {
            Self(Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                retiring: Mutex::new(HashMap::new()),
                slots: Arc::new(Semaphore::new(SESSION_LIMIT as usize)),
                stopped: AtomicBool::new(false),
                #[cfg(test)]
                test_env: Mutex::new(Vec::new()),
            }))
        }
    }
    impl LocalState {
        pub(crate) async fn cancel_for_renderer_rebind(&self) {
            let inner = self.0.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let sessions = inner.with_sessions(crate::ssh::drain_sessions);
                for session in &sessions {
                    session.renderer_gone.send_replace(true);
                    session.stop();
                }
                // The caller runs this hook on a blocking worker. Reap every old PID
                // before releasing its startup slot; do not set permanent shutdown.
                for session in sessions {
                    drop(
                        session
                            .process
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .take(),
                    );
                }
                inner
                    .retiring
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .retain(|_, session| !*session.renderer_gone.borrow());
            })
            .await;
            // Native admission is closed by the caller. Wait asynchronously for
            // every admitted launch/returned Process, including cancelled callers.
            let _all_processes = self.0.slots.clone().acquire_many_owned(SESSION_LIMIT).await;
        }
        #[cfg(test)]
        pub(super) fn available_slots(&self) -> usize {
            self.0.slots.available_permits()
        }
        #[cfg(test)]
        pub(crate) fn set_test_env(&self, env: Vec<(String, String)>) {
            *self.0.test_env.lock().unwrap() = env;
        }
        #[cfg(test)]
        pub(crate) fn test_env(&self) -> Vec<(String, String)> {
            self.0.test_env.lock().unwrap().clone()
        }
        /// Runs the host tools of session `id` in `wsl`, as a connected WSL target does.
        #[cfg(test)]
        pub(crate) fn bind_wsl(&self, id: &str, wsl: Wsl) {
            let _ = self.0.session(id).unwrap().wsl.set(wsl);
        }
        pub(super) fn clone_inner(&self) -> Arc<Inner> {
            self.0.clone()
        }
    }
    impl Drop for LocalState {
        fn drop(&mut self) {
            self.0.stop_all();
        }
    }
    #[cfg(windows)]
    struct ShutdownDrain {
        start: std::sync::mpsc::Sender<()>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    #[cfg(windows)]
    impl ShutdownDrain {
        fn reserve(mut reader: Box<dyn Read + Send>) -> Result<Self, String> {
            let (start, receive) = std::sync::mpsc::channel();
            let worker = std::thread::Builder::new()
                .name("lazysh-conpty-shutdown".into())
                .spawn(move || {
                    if receive.recv().is_ok() {
                        let _ = std::io::copy(&mut reader, &mut std::io::sink());
                    }
                })
                .map_err(|error| format!("Could not reserve ConPTY shutdown drain: {error}"))?;
            Ok(Self {
                start,
                worker: Some(worker),
            })
        }
    }
    struct Process {
        // Fields drop after Process::drop finishes reaping; never release capacity first.
        _slot: Option<OwnedSemaphorePermit>,
        child: Option<Box<dyn Child + Send + Sync>>,
        master: Option<Box<dyn MasterPty + Send>>,
        #[cfg(windows)]
        drain: Option<ShutdownDrain>,
    }
    impl Process {
        /// The tmux client of a `tmux attach-session` started directly in this PTY: no shell
        /// sits between, so the child's PID is the client's and the PTY slave is its terminal.
        fn display_identity(&self) -> Option<crate::tmux_jump::Identity> {
            #[cfg(unix)]
            {
                let pid = self.child.as_ref()?.process_id()?;
                let tty = self.master.as_ref()?.tty_name()?;
                crate::tmux_jump::Identity::from_pty(pid, &tty)
            }
            // tmux has no native Windows build; a WSL target brings its own identity.
            #[cfg(not(unix))]
            {
                None
            }
        }
    }
    impl Drop for Process {
        fn drop(&mut self) {
            #[cfg(windows)]
            if let Some(drain) = &self.drain {
                let _ = drain.start.send(());
            }
            if let Some(child) = self.child.as_mut() {
                if child.try_wait().ok().flatten().is_none() {
                    #[cfg(unix)]
                    if let Some(pid) = child.process_id().filter(|pid| *pid > 1) {
                        if let Some(group) = self
                            .master
                            .as_ref()
                            .and_then(|master| master.process_group_leader())
                            .filter(|group| *group > 1)
                        {
                            // The unreaped child reserves this session ID.
                            unsafe {
                                if libc::getsid(group) == pid as i32 {
                                    libc::kill(-group, libc::SIGKILL);
                                }
                            }
                        }
                    }
                    let _ = child.kill();
                }
            }
            self.master.take();
            if let Some(child) = self.child.as_mut() {
                let _ = child.wait();
            }
            #[cfg(windows)]
            if let Some(mut drain) = self.drain.take() {
                if let Some(worker) = drain.worker.take() {
                    let _ = worker.join();
                }
            }
        }
    }
    fn size(cols: u32, rows: u32) -> Result<PtySize, String> {
        if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
            return Err("Terminal dimensions must be between 1 and 1000".into());
        }
        Ok(PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
    }
    type PtyParts = (Process, Box<dyn Read + Send>, Box<dyn Write + Send>);
    fn deliver(
        output: &mpsc::Sender<Result<Vec<u8>, String>>,
        mut value: Result<Vec<u8>, String>,
        stopped: &AtomicBool,
    ) -> bool {
        loop {
            if stopped.load(Ordering::SeqCst) {
                return false;
            }
            match output.try_send(value) {
                Ok(()) => return true,
                Err(mpsc::error::TrySendError::Closed(_)) => return false,
                Err(mpsc::error::TrySendError::Full(pending)) => {
                    value = pending;
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
    fn launch(command: CommandBuilder, cols: u32, rows: u32) -> Result<PtyParts, String> {
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|e| format!("Could not open local PTY: {e}"))?;
        let mut process = Process {
            _slot: None,
            child: None,
            master: Some(pair.master),
            #[cfg(windows)]
            drain: None,
        };
        #[cfg(windows)]
        {
            process.drain = Some(ShutdownDrain::reserve(
                process
                    .master
                    .as_ref()
                    .unwrap()
                    .try_clone_reader()
                    .map_err(|error| error.to_string())?,
            )?);
        }
        let child = pair.slave.spawn_command(command);
        drop(pair.slave);
        process.child =
            Some(child.map_err(|error| format!("Could not start local shell: {error}"))?);
        let master = process.master.as_ref().unwrap();
        #[cfg(unix)]
        if let Some(fd) = master.as_raw_fd() {
            // All cloned descriptors share nonblocking mode: cancellation can
            // interrupt a foreground program that stops reading terminal input.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err("Could not configure cancellable local PTY".into());
            }
        }
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        Ok((process, reader, writer))
    }
    /// Starts the default shell, or the detected target the renderer chose by id.
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        state: &LocalState,
        creation: AccessLease,
        directory: Option<std::path::PathBuf>,
        attach: Option<crate::multiplexer::Entry>,
        target: Option<&str>,
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
    ) -> Result<Connected, String> {
        let Some(entry) = attach else {
            let found = match target.filter(|id| *id != DEFAULT_TARGET) {
                Some(id) => Some(targets::resolve(id).await?),
                None => None,
            };
            let command = match &found {
                None => shell_command(directory)?,
                Some(found) => target_command(found, directory)?,
            };
            let connected = start_with_access(state, creation, command, cols, rows, events).await?;
            if let Some(wsl) = found.and_then(|found| found.wsl()) {
                // Before the renderer can adopt the session, so its host tools run in the distribution.
                let _ = state.0.session(&connected.session_id)?.wsl.set(wsl);
            }
            return Ok(connected);
        };
        if directory.is_some() {
            return Err("Choose a folder or a multiplexer session, not both".into());
        }
        if target.is_some_and(|id| id != DEFAULT_TARGET) {
            return Err("Multiplexer sessions attach on this device's own shell".into());
        }
        #[cfg_attr(not(test), allow(unused_mut))]
        let mut command = attach_command(&entry).await?;
        // As over SSH, a Herdr that does not positively admit the guard stays an ordinary attach.
        let guard = crate::herdr_guard::Local {
            #[cfg(test)]
            env: state.test_env(),
        };
        let guarded = matches!(entry.kind, crate::multiplexer::MultiplexerKind::Herdr) && {
            let (_open, mut cancel) = watch::channel(false);
            crate::herdr_guard::available_local(guard.clone(), &entry.name, &creation, &mut cancel)
                .await
        };
        creation.check()?;
        if guarded {
            command.arg(crate::herdr_guard::GUARDED_ATTACH);
        }
        #[cfg(test)]
        for (name, value) in state.test_env() {
            command.env(name, value);
        }
        let (ticket, tickets) = oneshot::channel();
        let connected = start_with_launcher(
            state,
            creation.clone(),
            command,
            cols,
            rows,
            events,
            launch,
            guarded.then_some(ticket),
        )
        .await?;
        if guarded {
            // A failed or uncertain private start closes this terminal; it never falls back
            // to an ordinary attach.
            if let Err(error) = bind_herdr(
                state,
                &connected.session_id,
                guard,
                &entry.name,
                tickets,
                &creation,
            )
            .await
            {
                disconnect(state, &connected.session_id);
                return Err(error);
            }
        }
        if matches!(entry.kind, crate::multiplexer::MultiplexerKind::Tmux) {
            // As over SSH, a client that cannot be verified leaves the terminal without
            // navigation; the attach itself stands.
            let server = entry.server().map_err(|error| error.message().to_owned())?;
            let _ = bind_tmux(state, &connected.session_id, &entry.name, server, &creation).await;
        }
        Ok(connected)
    }
    /// The program an attach starts. Unix leaves the name to the PTY, which searches the login
    /// PATH. Native Windows has no tmux; it finds Zellij and Herdr itself, so that a missing one
    /// is named instead of ending in a bare `CreateProcess` failure.
    pub(super) fn attach_program(
        program: &str,
        windows: bool,
        path: &std::ffi::OsStr,
        pathext: Option<&std::ffi::OsStr>,
    ) -> Result<std::ffi::OsString, String> {
        if !windows {
            return Ok(program.into());
        }
        if program == "tmux" {
            return Err("tmux has no native Windows build; use a WSL target for tmux".into());
        }
        crate::native_program::resolve(path, pathext, program)
            .map(std::path::PathBuf::into_os_string)
            .ok_or_else(|| {
                format!("{program} was not found on the PATH; install its Windows build")
            })
    }
    /// The PTY command that attaches `entry` directly: a typed argv, never a shell string.
    async fn attach_command(entry: &crate::multiplexer::Entry) -> Result<CommandBuilder, String> {
        let argv = entry.argv().map_err(|error| error.message().to_owned())?;
        let program = attach_program(
            &argv[0],
            cfg!(windows),
            &std::env::var_os("PATH").unwrap_or_default(),
            std::env::var_os("PATHEXT").as_deref(),
        )?;
        let mut command = CommandBuilder::new(program);
        command.args(&argv[1..]);
        command.env("TERM", "xterm-256color");
        // A lazysh started inside a multiplexer must not hit its nested-session refusal.
        for name in crate::host::INHERITED {
            command.env_remove(name);
        }
        if let Some(path) = crate::host::login_path().await {
            command.env("PATH", path);
        }
        if let Some(home) = crate::local::home_dir() {
            command.cwd(home);
        }
        Ok(command)
    }
    fn target_command(
        found: &targets::Found,
        directory: Option<std::path::PathBuf>,
    ) -> Result<CommandBuilder, String> {
        let start = start_directory(directory.clone())?;
        let mut command = CommandBuilder::new(found.program());
        // Only a WSL target takes the folder as an argument; it starts in `~` without one.
        command.args(found.arguments(directory.and(start.as_deref())));
        command.env("TERM", "xterm-256color");
        if let Some(start) = start {
            command.cwd(start);
        }
        Ok(command)
    }
    pub(super) fn shell_command(
        directory: Option<std::path::PathBuf>,
    ) -> Result<CommandBuilder, String> {
        let mut command = CommandBuilder::new_default_prog();
        command.env("TERM", "xterm-256color");
        if let Some(directory) = start_directory(directory)? {
            command.cwd(directory);
        }
        Ok(command)
    }
    /// Where a local shell starts: the validated `directory`, else the home directory.
    fn start_directory(
        directory: Option<std::path::PathBuf>,
    ) -> Result<Option<std::path::PathBuf>, String> {
        if let Some(directory) = directory {
            #[cfg(windows)]
            let directory = {
                // cmd.exe treats canonical verbatim drive paths as UNC and silently
                // changes cwd. Simplify only names representable without DOS ambiguity.
                let compatible = dunce::simplified(&directory);
                const UNSUPPORTED: &str = "LOCAL_LAUNCH_DIRECTORY_UNSUPPORTED";
                if !compatible.is_absolute()
                    || !matches!(compatible.components().next(),
                    Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
                {
                    return Err(UNSUPPORTED.into());
                }
                if compatible
                    .canonicalize()
                    .map_err(|error| error.to_string())?
                    != directory
                {
                    return Err(UNSUPPORTED.into());
                }
                compatible.to_owned()
            };
            return Ok(Some(directory));
        }
        Ok(super::home_dir())
    }
    #[cfg(test)]
    pub(super) async fn start(
        state: &LocalState,
        command: CommandBuilder,
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
    ) -> Result<Connected, String> {
        start_with_access(
            state,
            AccessState::disabled().lease(None).unwrap(),
            command,
            cols,
            rows,
            events,
        )
        .await
    }
    pub(super) async fn start_with_access(
        state: &LocalState,
        creation: AccessLease,
        command: CommandBuilder,
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
    ) -> Result<Connected, String> {
        start_with_launcher(state, creation, command, cols, rows, events, launch, None).await
    }
    #[cfg(all(test, unix))]
    pub(super) async fn start_with_held_launch(
        state: &LocalState,
        creation: AccessLease,
        command: CommandBuilder,
        events: Channel<SshEvent>,
        held: impl FnOnce(u32) + Send + 'static,
    ) -> Result<Connected, String> {
        start_with_launcher(
            state,
            creation,
            command,
            80,
            24,
            events,
            move |command, cols, rows| {
                let parts = launch(command, cols, rows)?;
                held(parts.0.child.as_ref().unwrap().process_id().unwrap());
                Ok(parts)
            },
            None,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn start_with_launcher(
        state: &LocalState,
        creation: AccessLease,
        command: CommandBuilder,
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
        launcher: impl FnOnce(CommandBuilder, u32, u32) -> Result<PtyParts, String> + Send + 'static,
        // The guarded Herdr's private first frame is taken off the display and sent here.
        startup: Option<oneshot::Sender<crate::herdr_guard::Ticket>>,
    ) -> Result<Connected, String> {
        size(cols, rows)?;
        if state.0.stopped.load(Ordering::SeqCst) {
            return Err("Local terminals are shutting down".into());
        }
        let core = crate::terminal_core::prepare(&events)?;
        let slot = creation
            .with_current(|| state.0.slots.clone().try_acquire_owned())
            .map_err(String::from)?
            .map_err(|_| "At most 20 local terminals may be open")?;
        let launch_access = creation.clone();
        let owner = state.0.clone();
        let (process, reader, mut writer) =
            tauri::async_runtime::spawn_blocking(move || -> Result<PtyParts, String> {
                launch_access.check()?;
                if owner.stopped.load(Ordering::SeqCst) {
                    return Err("Local terminals are shutting down".into());
                }
                let (mut process, reader, writer) = launcher(command, cols, rows)?;
                process._slot = Some(slot);
                // Already-admitted OS work may finish after cancellation. Its own
                // Process must be reaped before the cleanup barrier sees capacity.
                launch_access.check()?;
                if owner.stopped.load(Ordering::SeqCst) {
                    return Err("Local terminals are shutting down".into());
                }
                Ok((process, reader, writer))
            })
            .await
            .map_err(|_| "Local terminal worker failed")??;
        let mut reader: Box<dyn Read + Send> = match startup {
            Some(ticket) => Box::new(crate::herdr_guard::StartupReader::new(reader, ticket)),
            None => reader,
        };
        if state.0.stopped.load(Ordering::SeqCst) {
            tauri::async_runtime::spawn_blocking(move || drop(process));
            return Err("Local terminals are shutting down".into());
        }
        let process = Arc::new(Mutex::new(Some(process)));
        #[cfg(unix)]
        let (unix_io, wake) = {
            let owned = process.lock().map_err(|_| "Local process lock failed")?;
            let fd = owned
                .as_ref()
                .unwrap()
                .master
                .as_ref()
                .unwrap()
                .as_raw_fd()
                .ok_or("Local PTY descriptor unavailable")?;
            UnixIo::new(fd)?
        };
        let stopped = Arc::new(AtomicBool::new(false));
        let (input, mut input_rx) = mpsc::channel(32);
        let (cancel, mut cancellation) = watch::channel(false);
        let session = Arc::new(Session {
            input,
            cancel,
            access: creation.state(),
            creation,
            adopted: AtomicBool::new(false),
            adoption: tokio::sync::Notify::new(),
            credits: Semaphore::new(WINDOW),
            inflight: Mutex::new(0),
            core: Default::default(),
            process: process.clone(),
            stopped: stopped.clone(),
            #[cfg(unix)]
            wake,
            renderer_gone: watch::channel(false).0,
            bindings: crate::bindings::Bindings::default(),
            wsl: std::sync::OnceLock::new(),
        });
        let id = format!("local:{}", uuid::Uuid::new_v4());
        let registration = session
            .creation
            .with_current(|| -> Result<(), String> {
                let mut sessions = state
                    .0
                    .sessions
                    .lock()
                    .map_err(|_| "Local terminal lock failed")?;
                if state.0.stopped.load(Ordering::SeqCst) {
                    Err("Local terminals are shutting down".to_string())
                } else {
                    sessions.insert(id.clone(), session.clone());
                    Ok(())
                }
            })
            .map_err(String::from)
            .and_then(|result| result);
        if let Err(error) = registration {
            drop(reader);
            drop(writer);
            drop(session);
            tauri::async_runtime::spawn_blocking(move || {
                if let Ok(mut process) = process.lock() {
                    drop(process.take());
                }
            });
            return Err(error);
        }
        // Attached only once the session is registered, so a failure above frees the unattached core.
        if let Some(core) = core {
            core.attach(
                &id,
                &session.core,
                crate::terminal_core::credit_to(&session, Session::acknowledge),
                crate::terminal_core::input_to(&session, Session::queue_core_input),
            );
        }
        watch_adoption(state, &id, &session);
        let (output, mut output_rx) = mpsc::channel(1);
        let read_stop = stopped.clone();
        #[cfg(unix)]
        let read_io = unix_io.clone();
        let reader = std::thread::Builder::new()
            .name("lazysh-local-reader".into())
            .spawn(move || {
                let mut buffer = [0; 16384];
                loop {
                    // ClosePseudoConsole on pre-24H2 Windows waits for its output
                    // to drain. Keep this reader alive through HPCON destruction;
                    // cancellation discards bytes and never waits for UI credits.
                    if !cfg!(windows) && read_stop.load(Ordering::SeqCst) {
                        break;
                    }
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(length) => {
                            if !deliver(&output, Ok(buffer[..length].to_vec()), &read_stop)
                                && !cfg!(windows)
                            {
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            #[cfg(unix)]
                            if !read_io.wait(libc::POLLIN).unwrap_or(false) {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = deliver(&output, Err(error.to_string()), &read_stop);
                            break;
                        }
                    }
                }
            })
            .map_err(|error| worker_start_failed(state, &id, &stopped, "output", error))?;
        let write_stop = stopped.clone();
        #[cfg(unix)]
        let write_io = unix_io;
        let write_process = process.clone();
        let (done, mut input_done) = oneshot::channel();
        let writer = std::thread::Builder::new()
            .name("lazysh-local-writer".into())
            .spawn(move || {
                let result: Result<(), String> = (|| {
                    while !write_stop.load(Ordering::SeqCst) {
                        let Some(value) = input_rx.blocking_recv() else {
                            break;
                        };
                        match value {
                            Input::Close => break,
                            Input::Resize(cols, rows, lease) => {
                                if lease.check().is_err() {
                                    continue;
                                }
                                if let Some(process) = write_process
                                    .lock()
                                    .map_err(|_| "Local process lock failed")?
                                    .as_ref()
                                {
                                    process
                                        .master
                                        .as_ref()
                                        .unwrap()
                                        .resize(size(cols, rows)?)
                                        .map_err(|e| e.to_string())?;
                                }
                            }
                            Input::Data(mut data, lease) => {
                                if lease.check().is_err() {
                                    continue;
                                }
                                while !data.is_empty() && !write_stop.load(Ordering::SeqCst) {
                                    if lease.check().is_err() {
                                        break;
                                    }
                                    let delay = data.delay();
                                    if !delay.is_zero() {
                                        std::thread::sleep(delay.min(Duration::from_millis(10)));
                                        continue;
                                    }
                                    match writer.write(data.bytes()) {
                                        Ok(0) => return Err("Local terminal input closed".into()),
                                        Ok(length) => data.advance(length),
                                        Err(error)
                                            if error.kind() == std::io::ErrorKind::Interrupted =>
                                        {
                                            continue
                                        }
                                        Err(error)
                                            if error.kind() == std::io::ErrorKind::WouldBlock =>
                                        {
                                            #[cfg(unix)]
                                            if !write_io
                                                .wait(libc::POLLOUT)
                                                .map_err(|error| error.to_string())?
                                            {
                                                return Ok(());
                                            }
                                        }
                                        Err(error) => return Err(error.to_string()),
                                    }
                                }
                            }
                        }
                    }
                    Ok(())
                })();
                let _ = done.send(result);
            })
            .map_err(|error| worker_start_failed(state, &id, &stopped, "input", error))?;
        let sessions = state.0.clone();
        let task_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let result:Result<(),String>=async {
                loop {
                    if *cancellation.borrow(){return Ok(());}
                    tokio::select! {
                        _=cancellation.changed()=>return Ok(()),
                        result=&mut input_done=>return result.map_err(|_|"Local input worker stopped")?,
                        bytes=output_rx.recv()=>match bytes {
                            Some(Ok(bytes))=>{
                                crate::ssh::deliver_output(&session.access, &session.credits, &session.inflight,
                                    &mut cancellation, &session.core.route(&events), &bytes,
                                    Some((&session.creation, &session.adopted, &session.renderer_gone))).await?;
                            },
                            Some(Err(error))=>return Err(error),None=>return Ok(()),
                        }
                    }
                }
            }.await;
            session.stop();
            drop(output_rx);
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                tauri::async_runtime::spawn_blocking(move || {
                    if let Ok(mut process) = process.lock() {
                        drop(process.take());
                    }
                    let _ = writer.join();
                    let _ = reader.join();
                }),
            )
            .await;
            retire_session(&sessions, &task_id, &session);
            crate::ssh::close_output(
                &session.access,
                Some((&session.creation, &session.adopted, &session.renderer_gone)),
                &events,
                result.err().unwrap_or_else(|| "Local shell exited".into()),
                false,
            )
            .await;
            sessions
                .retiring
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&task_id);
        });
        Ok(Connected { session_id: id })
    }
    fn worker_start_failed(
        state: &LocalState,
        id: &str,
        stopped: &AtomicBool,
        role: &str,
        error: std::io::Error,
    ) -> String {
        stopped.store(true, Ordering::SeqCst);
        disconnect(state, id);
        if let Ok(mut sessions) = state.0.sessions.lock() {
            sessions.remove(id);
        }
        crate::terminal_core::close(id);
        format!("Could not start local {role} worker: {error}")
    }
    fn retire_session(inner: &Inner, id: &str, session: &Arc<Session>) {
        inner.with_sessions(|active, retiring| {
            active.remove(id);
            if !*session.renderer_gone.borrow() {
                retiring.insert(id.to_owned(), session.clone());
            }
        });
    }
    fn watch_adoption(state: &LocalState, id: &str, session: &Arc<Session>) {
        let inner = state.0.clone();
        let id = id.to_owned();
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            let mut cancellation = session.cancel.subscribe();
            if crate::ssh::adoption_revoked(
                &session.adopted,
                &session.adoption,
                &mut cancellation,
                &session.creation,
            )
            .await
            {
                session.stop();
                session.core.discard();
                retire_session(&inner, &id, &session);
            }
        });
    }
    /// Reads an adopted, live session under the current lease.
    fn live_session<T>(
        state: &LocalState,
        id: &str,
        lease: &AccessLease,
        read: impl FnOnce(&Session) -> Result<T, String>,
    ) -> Result<T, String> {
        lease
            .with_current(|| {
                let session = state.0.session(id)?;
                if !session.adopted.load(Ordering::SeqCst)
                    || *session.renderer_gone.borrow()
                    || *session.cancel.borrow()
                {
                    return Err("Local terminal is disconnected".to_string());
                }
                read(&session)
            })
            .map_err(String::from)?
    }
    pub(super) fn host_session(
        state: &LocalState,
        id: &str,
        lease: &AccessLease,
    ) -> Result<(watch::Receiver<bool>, Option<Wsl>), String> {
        live_session(state, id, lease, |session| {
            Ok((session.cancel.subscribe(), session.wsl.get().cloned()))
        })
    }
    #[cfg(all(test, unix))]
    pub(super) fn display_identity(
        state: &LocalState,
        id: &str,
    ) -> Option<crate::tmux_jump::Identity> {
        let session = state.0.session(id).ok()?;
        let process = session.process.lock().ok()?;
        process.as_ref()?.display_identity()
    }
    /// One of an adopted, live terminal's bindings, if it has one, and its close signal.
    pub(super) fn binding<T: Clone>(
        state: &LocalState,
        id: &str,
        lease: &AccessLease,
        slot: impl FnOnce(&crate::bindings::Bindings) -> &Mutex<Option<T>>,
    ) -> Result<(Option<T>, watch::Receiver<bool>), String> {
        live_session(state, id, lease, |session| {
            let bound = slot(&session.bindings)
                .lock()
                .map_err(|_| "Local terminal lock failed")?
                .clone();
            Ok((bound, session.cancel.subscribe()))
        })
    }
    pub(super) fn tmux_binding(
        state: &LocalState,
        id: &str,
        lease: &AccessLease,
    ) -> Result<(crate::tmux_jump::Binding, watch::Receiver<bool>), String> {
        let (binding, cancel) = binding(state, id, lease, |bindings| &bindings.tmux)?;
        Ok((
            binding.ok_or("This terminal has no tmux navigation binding")?,
            cancel,
        ))
    }
    pub(super) fn tmux_server(
        state: &LocalState,
        id: &str,
        lease: &AccessLease,
    ) -> Result<Option<crate::tmux_server::TmuxServer>, String> {
        live_session(state, id, lease, |session| {
            Ok(session
                .bindings
                .tmux_server
                .lock()
                .map_err(|_| "Local terminal lock failed")?
                .clone())
        })
    }
    async fn bind_tmux(
        state: &LocalState,
        id: &str,
        name: &str,
        server: crate::tmux_server::TmuxServer,
        lease: &AccessLease,
    ) -> Result<(), String> {
        let session = state.0.session(id)?;
        *session
            .bindings
            .tmux_server
            .lock()
            .map_err(|_| "Local terminal lock failed")? = Some(server.clone());
        let identity = session
            .process
            .lock()
            .map_err(|_| "Local process lock failed")?
            .as_ref()
            .and_then(Process::display_identity)
            .ok_or("This terminal's tmux client cannot be identified")?;
        #[cfg_attr(not(test), allow(unused_mut))]
        let mut command = crate::tmux_jump::local_control_command(name, &server).await;
        #[cfg(test)]
        command.envs(state.test_env());
        let control = crate::tmux_jump::prepare_local(command, identity, lease)
            .await
            .ok_or("tmux navigation could not be verified for this terminal")?;
        lease.check()?;
        *session
            .bindings
            .tmux
            .lock()
            .map_err(|_| "Local terminal lock failed")? =
            Some(crate::tmux_jump::start(control, session.cancel.subscribe()));
        Ok(())
    }
    /// Claims the guard of the Herdr client that runs in this terminal and keeps it for chat.
    async fn bind_herdr(
        state: &LocalState,
        id: &str,
        guard: crate::herdr_guard::Local,
        name: &str,
        tickets: oneshot::Receiver<crate::herdr_guard::Ticket>,
        lease: &AccessLease,
    ) -> Result<(), String> {
        let session = state.0.session(id)?;
        let startup = crate::herdr_guard::acquire_local(
            guard.clone(),
            lease,
            name,
            tickets,
            &mut session.cancel.subscribe(),
        )
        .await
        .map_err(|error| error.message().to_owned())?;
        lease.check()?;
        *session
            .bindings
            .herdr
            .lock()
            .map_err(|_| "Local terminal lock failed")? = Some(crate::herdr_guard::start(
            startup,
            crate::herdr_guard::Route::Local(guard),
            session.cancel.subscribe(),
        ));
        Ok(())
    }
    pub(super) fn adopt(
        state: &LocalState,
        id: &str,
        request: &AccessLease,
    ) -> Result<bool, String> {
        request.check()?;
        let session = state
            .0
            .sessions
            .lock()
            .map_err(|_| "Local session lock failed")?
            .get(id)
            .cloned();
        let Some(session) = session else {
            return Ok(false);
        };
        if session.stopped.load(Ordering::SeqCst) {
            return Err("Local terminal is disconnected".into());
        }
        session.creation.with_current(|| {
            session.adopted.store(true, Ordering::SeqCst);
            session.adoption.notify_one();
        })?;
        Ok(true)
    }
    #[cfg(test)]
    pub fn write(
        state: &LocalState,
        id: &str,
        data: String,
        lease: AccessLease,
    ) -> Result<(), String> {
        write_sequence(
            state,
            id,
            crate::terminal_input::InputSequence::parse(data, None)?,
            lease,
        )
    }
    pub fn write_sequence(
        state: &LocalState,
        id: &str,
        data: crate::terminal_input::InputSequence,
        lease: AccessLease,
    ) -> Result<(), String> {
        state
            .0
            .session(id)?
            .input
            .try_send(Input::Data(data, lease))
            .map_err(|_| "Local terminal input queue is full or disconnected".into())
    }
    pub fn resize(
        state: &LocalState,
        id: &str,
        cols: u32,
        rows: u32,
        lease: AccessLease,
    ) -> Result<(), String> {
        size(cols, rows)?;
        let session = state.0.session(id)?;
        session
            .input
            .try_send(Input::Resize(cols, rows, lease))
            .map_err(|_| "Local terminal input queue is full or disconnected".to_string())?;
        session.core.resize(cols, rows)
    }
    pub fn ack(state: &LocalState, id: &str, bytes: u32) -> Result<(), String> {
        let session = state.0.session(id)?;
        if session.core.is_attached() {
            return Err("The native terminal core acknowledges this output".into());
        }
        session.acknowledge(bytes)
    }
    /// Outstanding bytes plus the zero-credit and over-credit acknowledgment results.
    #[cfg(test)]
    pub(super) type RejectedOutputAcks = (u32, Result<(), String>, Result<(), String>);
    #[cfg(test)]
    pub(super) fn rejected_output_acks(
        state: &LocalState,
        id: &str,
    ) -> Result<RejectedOutputAcks, String> {
        let session = state.0.session(id)?;
        session
            .creation
            .with_transport_output(&session.adopted, || {
                let pending = *session
                    .inflight
                    .lock()
                    .map_err(|_| "Local output lock failed")?;
                Ok((pending, ack(state, id, 0), ack(state, id, pending + 1)))
            })
            .map_err(|_| "Local output access unavailable".to_string())?
    }
    pub fn disconnect(state: &LocalState, id: &str) {
        if let Ok(sessions) = state.0.sessions.lock() {
            if let Some(session) = sessions.get(id) {
                session.stop();
            }
        }
    }
    #[cfg(all(test, windows))]
    pub(super) fn process_id(state: &LocalState, id: &str) -> u32 {
        state
            .0
            .session(id)
            .unwrap()
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .process_id()
            .unwrap()
    }
}

#[cfg(all(
    test,
    any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
mod tests {
    #[cfg(unix)]
    use crate::ssh::test_support::{ready_lease, replacement_lease, unlocked_access};
    pub(super) fn access_lease() -> crate::app_lock::AccessLease {
        crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap()
    }
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;
    /// The renderer reads these names to decide which views a local session offers.
    #[cfg(desktop)]
    #[tokio::test]
    async fn the_default_target_reports_the_multiplexers_a_local_session_can_attach() {
        let capability = serde_json::to_value(local_capability().await).unwrap();
        let tools = &capability["targets"][0]["tools"];
        for tool in ["tmux", "herdr", "zellij"] {
            assert!(tools[tool].is_boolean(), "{tool} is missing from {tools}");
        }
        // tmux has no native Windows build.
        if cfg!(windows) {
            assert_eq!(tools["tmux"], false);
        }
    }
    pub(super) fn events() -> (
        Channel<SshEvent>,
        mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                    let _ = tx.send(serde_json::from_str(&json).unwrap());
                }
                Ok(())
            }),
            rx,
        )
    }
    pub(super) async fn until(
        rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
        needle: &str,
    ) -> String {
        until_within(rx, needle, Duration::from_secs(5)).await
    }
    pub(super) async fn until_within(
        rx: &mut mpsc::UnboundedReceiver<serde_json::Value>,
        needle: &str,
        deadline: Duration,
    ) -> String {
        tokio::time::timeout(deadline, async {
            let mut bytes = Vec::new();
            loop {
                let event = rx.recv().await.expect("local event stream ended");
                assert_ne!(event["type"], "closed", "{event}");
                if let Some(data) = event["data"].as_array() {
                    bytes.extend(data.iter().map(|v| v.as_u64().unwrap() as u8));
                }
                assert!(bytes.len() < 256 * 1024);
                let text = String::from_utf8_lossy(&bytes);
                if text.contains(needle) {
                    return text.into_owned();
                }
            }
        })
        .await
        .expect("local process output timed out")
    }
    async fn closed(rx: &mut mpsc::UnboundedReceiver<serde_json::Value>) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = rx.recv().await {
                if event["type"] == "closed" {
                    return;
                }
            }
            panic!("missing local Closed");
        })
        .await
        .unwrap();
    }
    #[cfg(unix)]
    async fn owned_pid(rx: &mut mpsc::UnboundedReceiver<serde_json::Value>) -> i32 {
        until(rx, "__\r\n")
            .await
            .split("__PID_")
            .nth(1)
            .unwrap()
            .split("__")
            .next()
            .unwrap()
            .parse()
            .unwrap()
    }
    #[cfg(unix)]
    async fn wait_reaped(pid: i32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("owned local child must be reaped");
    }
    #[cfg(unix)]
    async fn start_owned_child(
        state: &LocalState,
    ) -> (Connected, mpsc::UnboundedReceiver<serde_json::Value>, i32) {
        let (events, mut rx) = events();
        let connected = desktop::start(
            state,
            shell("printf '__PID_%s__\\n' \"$$\"; exec sleep 120"),
            80,
            24,
            events,
        )
        .await
        .unwrap();
        let pid = owned_pid(&mut rx).await;
        (connected, rx, pid)
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn account_usage_gate_requires_adoption_current_access_and_live_local_session() {
        let state = LocalState::default();
        let access = unlocked_access();
        let lease = ready_lease(&access);
        let (event, mut output) = events();
        let connected = desktop::start_with_access(
            &state,
            lease.clone(),
            shell("exec sleep 120"),
            80,
            24,
            event,
        )
        .await
        .unwrap();
        assert!(usage_session(&state, &connected.session_id, &lease).is_err());
        desktop::adopt(&state, &connected.session_id, &lease).unwrap();
        let cancellation = usage_session(&state, &connected.session_id, &lease).unwrap();
        assert!(!*cancellation.borrow());
        access.lock().unwrap();
        assert!(usage_session(&state, &connected.session_id, &lease).is_err());
        access.authorize(access.generation().unwrap()).unwrap();
        access.ready(access.generation().unwrap()).unwrap();
        desktop::disconnect(&state, &connected.session_id);
        assert!(*cancellation.borrow());
        assert!(usage_session(&state, &connected.session_id, &lease).is_err());
        closed(&mut output).await;
    }
    #[tokio::test]
    async fn failed_local_spawn_closes_its_unregistered_pty() {
        let state = LocalState::default();
        let (event, _) = events();
        let directory = tempfile::tempdir().unwrap();
        let command =
            portable_pty::CommandBuilder::new(directory.path().join("missing-lazysh-test-shell"));
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            desktop::start(&state, command, 80, 24, event),
        )
        .await
        .expect("failed spawn trapped PTY shutdown");
        assert!(result.is_err());
    }
    #[cfg(unix)]
    fn shell(program: &str) -> portable_pty::CommandBuilder {
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args(["-c", program]);
        command.env_clear();
        command.env("PATH", "/usr/bin:/bin");
        command.env("TERM", "xterm-256color");
        command
    }
    fn directory_fixture(
        name: &str,
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        portable_pty::CommandBuilder,
    ) {
        let base = tempfile::tempdir().unwrap();
        let directory = base.path().join(name);
        std::fs::create_dir(&directory).unwrap();
        let crate::desktop_launch::LaunchTarget::Directory(selected) =
            crate::desktop_launch::parse(
                [
                    std::ffi::OsString::from("lazysh"),
                    "--dir".into(),
                    directory.to_owned().into_os_string(),
                ],
                || unreachable!(),
            )
            .unwrap()
            .unwrap()
        else {
            panic!("expected directory intent");
        };
        let command = desktop::shell_command(Some(selected.clone())).unwrap();
        assert!(command.is_default_prog());
        (base, selected, command)
    }
    #[cfg(windows)]
    #[test]
    fn windows_directory_command_preserves_canonical_identity_with_ordinary_drive_spelling() {
        let (_base, selected, command) = directory_fixture("workspace 世界 �");
        let cwd = std::path::Path::new(command.get_cwd().unwrap());
        assert!(cwd.is_absolute());
        assert!(
            matches!(cwd.components().next(), Some(std::path::Component::Prefix(prefix))
            if matches!(prefix.kind(),std::path::Prefix::Disk(_)))
        );
        assert_eq!(cwd.canonicalize().unwrap(), selected);
        assert!(command.is_default_prog());
    }
    #[cfg(windows)]
    #[test]
    fn windows_directory_command_refuses_unrepresentable_paths_without_starting_a_shell() {
        for path in [
            r"\\server\share\project",
            r"\\?\UNC\server\share\project",
            r"\\.\C:\project",
            r"\\?\C:\NUL",
            r"\\?\C:\trailing.",
            r"\\?\C:\trailing ",
        ] {
            assert_eq!(
                desktop::shell_command(Some(path.into())).err().as_deref(),
                Some("LOCAL_LAUNCH_DIRECTORY_UNSUPPORTED"),
                "{path}"
            );
        }
        let long = format!("{}{}\\{}", r"\\?\C:\", "x".repeat(150), "y".repeat(150));
        assert!(desktop::shell_command(Some(long.into())).is_err());
        let base = tempfile::tempdir().unwrap();
        let literal = base.path().canonicalize().unwrap().join("trailing.");
        std::fs::create_dir(&literal).unwrap();
        let result = desktop::shell_command(Some(literal.canonicalize().unwrap()));
        std::fs::remove_dir(&literal).unwrap();
        assert!(
            result.is_err(),
            "a literal trailing dot must not silently select another directory"
        );
    }
    #[cfg(unix)]
    fn isolated_login(command: &mut portable_pty::CommandBuilder, home: &std::path::Path) {
        command.env_clear();
        command.env("SHELL", "/bin/sh");
        command.env("HOME", home);
        command.env("PATH", "/usr/bin:/bin");
        command.env("TERM", "xterm-256color");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn directory_launch_uses_the_selected_login_shell_and_literal_initial_pwd() {
        let (base, selected, mut command) =
            directory_fixture("workspace 世界 � $(touch NOT_CREATED)");
        isolated_login(&mut command, base.path());
        let state = LocalState::default();
        let (event, mut rx) = events();
        let connected = desktop::start(&state, command, 80, 24, event)
            .await
            .unwrap();
        desktop::write(
            &state,
            &connected.session_id,
            "stty -echo; printf '__DIRECTORY_RESULT__'; pwd -P; printf '__DIRECTORY_END__\\n'\n"
                .into(),
            access_lease(),
        )
        .unwrap();
        let output = until(&mut rx, "__DIRECTORY_END__\r\n").await;
        desktop::disconnect(&state, &connected.session_id);
        closed(&mut rx).await;
        assert!(
            output.contains(&format!(
                "__DIRECTORY_RESULT__{}\r\n__DIRECTORY_END__",
                selected.display()
            )),
            "{output}"
        );
        assert!(!base.path().join("NOT_CREATED").exists());
    }
    #[tokio::test]
    async fn directory_removed_after_cli_validation_never_falls_back_to_home() {
        let (base, selected, mut command) = directory_fixture("removed-before-spawn");
        command.env(
            if cfg!(windows) { "USERPROFILE" } else { "HOME" },
            base.path(),
        );
        #[cfg(unix)]
        isolated_login(&mut command, base.path());
        std::fs::remove_dir(&selected).unwrap();
        let state = LocalState::default();
        let (event, mut rx) = events();
        let result = desktop::start(&state, command, 80, 24, event).await;
        // Clean a wrongly started fallback child before reporting a failed check.
        if let Ok(connected) = &result {
            desktop::disconnect(&state, &connected.session_id);
            closed(&mut rx).await;
        }
        assert!(
            result.is_err(),
            "a removed explicit directory must not select HOME"
        );
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn directory_launch_conpty_records_its_actual_default_shell_working_directory() {
        let (base, selected, mut command) = directory_fixture("selected-workspace");
        command.env("USERPROFILE", base.path());
        let report = base.path().join("lazysh-working-directory.txt");
        command.env("LAZYSH_CWD_REPORT", &report);
        let shell: String = command.get_shell().chars().take(512).collect();
        let state = LocalState::default();
        let (event, mut rx) = events();
        let connected = desktop::start(&state, command, 240, 24, event)
            .await
            .unwrap();
        let write = desktop::write(
            &state,
            &connected.session_id,
            "cd > \"%LAZYSH_CWD_REPORT%\"\r\n".into(),
            access_lease(),
        );
        let mut output = Vec::new();
        let mut file_state = String::from("not inspected");
        let mut saw_closed = false;
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                // Only this owned fixture's PTY, bounded independently of its deadline.
                for _ in 0..32 {
                    let Ok(event) = rx.try_recv() else {
                        break;
                    };
                    saw_closed |= event["type"] == "closed";
                    if let Some(data) = event["data"].as_array() {
                        output.extend(
                            data.iter()
                                .take((16 * 1024usize).saturating_sub(output.len()))
                                .filter_map(|value| value.as_u64().map(|value| value as u8)),
                        );
                    }
                }
                match tokio::fs::File::open(&report).await {
                    Ok(file) => {
                        use tokio::io::AsyncReadExt;
                        let mut bytes = Vec::new();
                        let result = file.take(8193).read_to_end(&mut bytes).await;
                        file_state = format!("read={result:?}; bytes={}", bytes.len());
                        if result.is_ok() && bytes.len() <= 8192 {
                            if let Ok(text) = String::from_utf8(bytes) {
                                if !text.trim().is_empty() {
                                    break std::path::PathBuf::from(text.trim()).canonicalize();
                                }
                            }
                        }
                    }
                    Err(error) => file_state = format!("open={error}"),
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        desktop::disconnect(&state, &connected.session_id);
        if !saw_closed {
            closed(&mut rx).await;
        }
        // Cleanup must finish even when write, observation or cwd equality fails.
        let diagnostic = format!(
            "shell={shell:?}; configured_cwd={selected:?}; expected_file={file_state}; owned_pty={:?}",
            String::from_utf8_lossy(&output)
        );
        assert!(
            write.is_ok(),
            "owned shell write failed: {write:?}; {diagnostic}"
        );
        assert_eq!(
            observed
                .expect(&format!(
                    "the chosen shell did not report its cwd; {diagnostic}"
                ))
                .expect(&diagnostic),
            selected,
            "{diagnostic}"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_local_sequences_keep_following_input_outside_the_chord() {
        let state = LocalState::default();
        let (event, mut rx) = events();
        let connected=desktop::start(&state,shell("stty -echo; printf READY; while IFS= read -r line; do printf 'INPUT:%s\\n' \"$line\"; done"),80,24,event).await.unwrap();
        until(&mut rx, "READY").await;
        desktop::write_sequence(
            &state,
            &connected.session_id,
            crate::terminal_input::InputSequence::parse(
                String::new(),
                Some(vec!["ab".into(), "世界".into(), "\n".into()]),
            )
            .unwrap(),
            access_lease(),
        )
        .unwrap();
        desktop::write(
            &state,
            &connected.session_id,
            "TAIL\n".into(),
            access_lease(),
        )
        .unwrap();
        let output = until(&mut rx, "INPUT:TAIL").await;
        assert!(output.contains("INPUT:ab世界\r\nINPUT:TAIL"), "{output}");
        desktop::disconnect(&state, &connected.session_id);
        closed(&mut rx).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn dictated_text_stays_a_draft_in_the_owned_pty_until_enter_arrives() {
        // The payloads are what `dictationInput` builds: the dictated line, plus `\r` only with auto-send on.
        let state = LocalState::default();
        let (event, mut rx) = events();
        let connected=desktop::start(&state,shell("stty -echo; printf READY; while IFS= read -r line; do printf 'RAN:%s\\n' \"$line\"; done"),80,24,event).await.unwrap();
        until(&mut rx, "READY").await;
        desktop::write(
            &state,
            &connected.session_id,
            "echo 世界".into(),
            access_lease(),
        )
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(500), until(&mut rx, "RAN:"))
                .await
                .is_err(),
            "dictation without Enter must not reach the shell as a command"
        );
        desktop::write(&state, &connected.session_id, "\r".into(), access_lease()).unwrap();
        until(&mut rx, "RAN:echo 世界\r\n").await;
        desktop::write(
            &state,
            &connected.session_id,
            "pwd\r".into(),
            access_lease(),
        )
        .unwrap();
        until(&mut rx, "RAN:pwd\r\n").await;
        desktop::disconnect(&state, &connected.session_id);
        closed(&mut rx).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_local_utf8_resize_and_isolated_close() {
        let state = LocalState::default();
        let (event, mut rx) = events();
        let first=desktop::start(&state,shell("printf '__LOCAL_世界__\\n'; stty size; while IFS= read -r line; do printf 'INPUT:%s\\n' \"$line\"; stty size; done"),80,24,event).await.unwrap();
        assert!(first.session_id.starts_with("local:"));
        let initial = until(&mut rx, "24 80").await;
        assert!(initial.contains("__LOCAL_世界__"));
        let (event, mut second_rx) = events();
        let second = desktop::start(
            &state,
            shell("while IFS= read -r line; do printf 'SECOND:%s\\n' \"$line\"; done"),
            80,
            24,
            event,
        )
        .await
        .unwrap();
        desktop::resize(&state, &first.session_id, 111, 36, access_lease()).unwrap();
        desktop::write(
            &state,
            &first.session_id,
            "hello世界\n".into(),
            access_lease(),
        )
        .unwrap();
        let output = until(&mut rx, "36 111").await;
        assert!(output.contains("INPUT:hello世界"));
        assert!(
            desktop::write(&state, &first.session_id, "x".repeat(65537), access_lease()).is_err()
        );
        assert!(desktop::resize(&state, &first.session_id, 0, 24, access_lease()).is_err());
        desktop::disconnect(&state, &first.session_id);
        closed(&mut rx).await;
        desktop::write(
            &state,
            &second.session_id,
            "still alive\n".into(),
            access_lease(),
        )
        .unwrap();
        assert!(until(&mut second_rx, "SECOND:still alive")
            .await
            .contains("SECOND:still alive"));
        desktop::disconnect(&state, &second.session_id);
        closed(&mut second_rx).await;
    }
    #[cfg(unix)]
    fn flood() -> portable_pty::CommandBuilder {
        shell("exec yes 1234567890")
    }
    #[cfg(windows)]
    fn flood() -> portable_pty::CommandBuilder {
        let mut command = portable_pty::CommandBuilder::new("cmd.exe");
        command.args([
            "/D",
            "/Q",
            "/C",
            "for /L %i in (1,1,10000000) do @echo 1234567890",
        ]);
        command
    }
    #[tokio::test]
    async fn local_output_credits_reject_forgery_and_cancel_a_stalled_consumer() {
        for stop_all in [false, true] {
            let state = LocalState::default();
            let (event, mut rx) = events();
            let connected = desktop::start(&state, flood(), 80, 24, event)
                .await
                .unwrap();
            let mut pending = 0u32;
            while let Ok(Some(event)) = tokio::time::timeout(
                if pending < 240 * 1024 {
                    Duration::from_secs(5)
                } else {
                    Duration::from_millis(100)
                },
                rx.recv(),
            )
            .await
            {
                assert_eq!(event["type"], "data");
                pending += event["data"].as_array().unwrap().len() as u32;
                assert!(pending <= 256 * 1024);
            }
            assert!(pending > 240 * 1024, "pending={pending}");
            let (outstanding, zero, excessive) =
                desktop::rejected_output_acks(&state, &connected.session_id).unwrap();
            assert!(outstanding >= pending);
            assert!(zero.is_err());
            assert!(excessive.is_err());
            desktop::ack(&state, &connected.session_id, 16384).unwrap();
            let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(event["type"], "data");
            if stop_all {
                state.clone_inner().stop_all();
            } else {
                desktop::disconnect(&state, &connected.session_id);
            }
            closed(&mut rx).await;
            assert!(desktop::write(
                &state,
                &connected.session_id,
                "after close".into(),
                access_lease()
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_pty_output_reaches_an_offered_core_in_order_within_the_window() {
        use crate::terminal_core::{self, fake::ChecksumCore};
        use portable_pty::CommandBuilder;
        let state = LocalState::default();
        let (core, prepared) = ChecksumCore::prepared();
        let (event, mut rx) = events();
        terminal_core::offer(&event, Box::new(move || Ok(prepared)));
        let mut command = CommandBuilder::new("sh");
        command.args([
            "-c",
            // The program writes its own CR LF with output processing off: macOS's tty driver can queue the CR of a
            // newline twice when its output queue overflows, which would put a stray CR into a stream this case compares byte for byte.
            "stty -echo -opost; read x; printf 'BEGIN\\r\\n'; seq 1 60000 | awk '{printf \"%s\\r\\n\", $0}'; printf 'END\\r\\n'",
        ]);
        let connected = desktop::start(&state, command, 80, 24, event)
            .await
            .unwrap();
        let id = connected.session_id;
        desktop::write(&state, &id, "go\n".into(), access_lease()).unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            while !String::from_utf8_lossy(&core.seen.lock().unwrap()).contains("END\r\n") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let text = String::from_utf8_lossy(&core.seen.lock().unwrap()).into_owned();
        let body = text
            .split("BEGIN\r\n")
            .nth(1)
            .unwrap()
            .split("END\r\n")
            .next()
            .unwrap();
        let expected: String = (1..=60000).map(|n| format!("{n}\r\n")).collect();
        assert_eq!(
            body, expected,
            "the PTY stream arrived complete and in order"
        );
        let peak = core.peak_queued.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            peak <= 256 * 1024,
            "{peak} bytes queued over the 256 KiB window"
        );
        assert!(
            desktop::ack(&state, &id, 1).is_err(),
            "a renderer cannot return credit a core owns"
        );
        closed(&mut rx).await;
        while let Ok(event) = rx.try_recv() {
            assert_ne!(
                event["type"], "data",
                "no output over the Channel on the core path"
            );
        }
        terminal_core::close(&id);
        assert!(core.closed.load(std::sync::atomic::Ordering::SeqCst));
    }
    /// What the terminal driver of a local session handed to a core so far.
    #[cfg(unix)]
    async fn seen_by(core: &crate::terminal_core::fake::ChecksumCore, bytes: &[u8]) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !core
                .seen
                .lock()
                .unwrap()
                .windows(bytes.len())
                .any(|window| window == bytes)
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the core never saw {bytes:?}"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn what_a_core_writes_reaches_the_pty_byte_for_byte_until_its_lease_is_gone() {
        use crate::terminal_core::{self, fake::ChecksumCore};
        let state = LocalState::default();
        let access = crate::app_lock::AccessState::disabled();
        let renderer = access.lease(None).unwrap();
        let (core, prepared, link) = ChecksumCore::linked();
        let (event, _rx) = events();
        terminal_core::offer(&event, Box::new(move || Ok(prepared)));
        // Raw and without echo the driver passes every byte; `cat` returns them as output the core sees.
        let program = "stty raw -echo; echo READY; exec cat";
        let connected =
            desktop::start_with_access(&state, renderer.clone(), shell(program), 80, 24, event)
                .await
                .unwrap();
        let id = connected.session_id;
        seen_by(&core, b"READY").await;
        link.use_lease(&renderer);
        // An X10 mouse report (bytes above 0x7f, a NUL), then a terminal reply: neither is text.
        let report = [0x1b, b'[', b'M', 0x20, 0xe8, 0xff, 0x00, b'!'];
        link.write(&report).unwrap();
        link.write(b"\x1b[?62;22c").unwrap();
        seen_by(&core, &report).await;
        seen_by(&core, b"\x1b[?62;22c").await;
        access.replace_renderer().unwrap();
        assert!(
            link.write(b"late").is_err(),
            "no write after the lease is gone"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!String::from_utf8_lossy(&core.seen.lock().unwrap()).contains("late"));
        desktop::disconnect(&state, &id);
        terminal_core::close(&id);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn a_launch_that_fails_frees_the_core_the_renderer_offered() {
        use crate::terminal_core::{self, fake::ChecksumCore};
        let (core, prepared) = ChecksumCore::prepared();
        let (event, _rx) = events();
        terminal_core::offer(&event, Box::new(move || Ok(prepared)));
        let result = desktop::start_with_access(
            &LocalState::default(),
            access_lease(),
            portable_pty::CommandBuilder::new("/nonexistent/lazysh-no-such-shell"),
            80,
            24,
            event,
        )
        .await;
        assert!(result.is_err());
        assert!(core.closed.load(std::sync::atomic::Ordering::SeqCst));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_local_terminals_feed_only_their_own_core() {
        use crate::terminal_core::{self, fake::ChecksumCore};
        let state = LocalState::default();
        let mut running = Vec::new();
        for tag in ["A", "B"] {
            let (events, _rx) = events();
            let (core, prepared) = ChecksumCore::prepared();
            terminal_core::offer(&events, Box::new(move || Ok(prepared)));
            // Output processing is off and the CR LF is written by the program, as in the 60000 line case above.
            let program = format!(
                "stty -opost; seq 1 3000 | awk -v t={tag} '{{printf \"%s:%s\\r\\n\", t, $0}}'; exec sleep 120"
            );
            let connected =
                desktop::start_with_access(&state, access_lease(), shell(&program), 80, 24, events)
                    .await
                    .unwrap();
            running.push((tag, core, connected.session_id));
        }
        for (tag, core, id) in &running {
            let last = format!("{tag}:3000\r\n");
            tokio::time::timeout(Duration::from_secs(10), async {
                while !String::from_utf8_lossy(&core.seen.lock().unwrap()).ends_with(&last) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let seen = String::from_utf8_lossy(&core.seen.lock().unwrap()).into_owned();
            let other = if *tag == "A" { "B:" } else { "A:" };
            assert!(
                !seen.contains(other),
                "{tag} received the other terminal's output"
            );
            let expected: String = (1..=3000).map(|n| format!("{tag}:{n}\r\n")).collect();
            assert_eq!(seen, expected, "{tag} complete and in order");
            desktop::disconnect(&state, id);
            terminal_core::close(id);
            assert!(core.closed.load(std::sync::atomic::Ordering::SeqCst));
        }
    }
    /// A local terminal that only sleeps, started with `creation` and a fake core offered for it.
    #[cfg(unix)]
    async fn start_sleeper_with_core(
        state: &LocalState,
        creation: AccessLease,
    ) -> (
        std::sync::Arc<crate::terminal_core::fake::ChecksumCore>,
        Connected,
    ) {
        let (events, _rx) = events();
        let (core, prepared) = crate::terminal_core::fake::ChecksumCore::prepared();
        crate::terminal_core::offer(&events, Box::new(move || Ok(prepared)));
        let connected =
            desktop::start_with_access(state, creation, shell("exec sleep 120"), 80, 24, events)
                .await
                .unwrap();
        (core, connected)
    }
    /// What a core command answered the current renderer: its value or its error message.
    #[cfg(all(unix, native_terminal_core))]
    fn answered<T>(
        result: Result<crate::app_lock::Guarded<T>, crate::app_lock::GuardedError<String>>,
    ) -> Result<T, String> {
        match result {
            Ok(value) => Ok(value.into_inner().unwrap()),
            Err(error) => Err(error.into_inner().unwrap()),
        }
    }
    /// The real core's screen text, read as the current renderer.
    #[cfg(all(unix, native_terminal_core))]
    async fn real_core_text(id: &str) -> Result<String, String> {
        answered(crate::terminal_core::terminal_core_text(access_lease(), id.to_owned()).await)
    }
    /// The real core's screen text once it contains `marker`.
    #[cfg(all(unix, native_terminal_core))]
    async fn real_core_text_with(id: &str, marker: &str) -> String {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let text = real_core_text(id).await.unwrap();
                if text.contains(marker) {
                    return text;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap()
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn a_resize_sent_to_the_pty_reaches_the_core_and_a_rejected_one_does_not() {
        use crate::terminal_core;
        let state = LocalState::default();
        let (core, connected) = start_sleeper_with_core(&state, access_lease()).await;
        let id = connected.session_id;
        desktop::resize(&state, &id, 120, 40, access_lease()).unwrap();
        assert!(desktop::resize(&state, &id, 0, 40, access_lease()).is_err());
        assert!(desktop::resize(&state, "local:missing", 90, 30, access_lease()).is_err());
        assert_eq!(*core.sizes.lock().unwrap(), [(120, 40)]);
        desktop::disconnect(&state, &id);
        terminal_core::close(&id);
    }
    /// Needs the `native-terminal` feature (Zig); only the `native-terminal-bridge` CI job enables it.
    #[cfg(all(unix, native_terminal_core))]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn local_pty_output_is_parsed_by_the_real_core_and_readable_as_text() {
        use crate::terminal_core;
        let _kept = terminal_core::tests_keeping_cores().read();
        use portable_pty::CommandBuilder;
        let state = LocalState::default();
        let (event, mut rx) = events();
        terminal_core::terminal_core_open(access_lease(), event.clone(), 40, 6, None, None)
            .await
            .unwrap();
        let mut command = CommandBuilder::new("sh");
        command.args(["-c", "stty -echo; read x; printf '\\033[31mred\\033[0m hello \\346\\227\\245\\r\\n'; seq 1 3000 | tail -n 2; echo done"]);
        let connected = desktop::start(&state, command, 40, 6, event).await.unwrap();
        let id = connected.session_id;
        desktop::write(&state, &id, "go\n".into(), access_lease()).unwrap();
        let text = real_core_text_with(&id, "done").await;
        let rows: Vec<_> = text.lines().map(str::trim_end).collect();
        // A shell that has not yet run `stty -echo` echoes the typed "go", so compare the last four rows.
        assert_eq!(
            &rows[rows.len() - 4..],
            ["red hello \u{65e5}", "2999", "3000", "done"],
            "{rows:?}"
        );
        closed(&mut rx).await;
        assert_eq!(
            real_core_text(&id).await.unwrap(),
            text,
            "the screen outlives the session"
        );
        terminal_core::terminal_core_close(id.clone()).unwrap();
        assert!(real_core_text(&id).await.is_err());
    }
    /// Needs the `native-terminal` feature (Zig).
    #[cfg(all(unix, native_terminal_core))]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn the_real_core_follows_the_size_the_renderer_resized_to() {
        use crate::terminal_core;
        let _kept = terminal_core::tests_keeping_cores().read();
        let state = LocalState::default();
        let (event, _rx) = events();
        terminal_core::terminal_core_open(access_lease(), event.clone(), 40, 10, None, None)
            .await
            .unwrap();
        // Column 40 is clamped to the last column of the grid, so where the Y lands shows the width.
        let program = r"stty -echo; read x; printf '\033[2J\033[1;40HY\r\n'; echo done";
        let connected =
            desktop::start_with_access(&state, access_lease(), shell(program), 40, 10, event)
                .await
                .unwrap();
        let id = connected.session_id;
        desktop::resize(&state, &id, 25, 10, access_lease()).unwrap();
        desktop::write(&state, &id, "go\n".into(), access_lease()).unwrap();
        let text = real_core_text_with(&id, "done").await;
        let row = text.lines().find(|row| row.ends_with('Y')).expect(&text);
        assert_eq!(row.chars().count(), 25, "{text:?}");
        terminal_core::close(&id);
    }
    /// Needs the `native-terminal` feature (Zig). The History lines setting changed while the session is open (#2505):
    /// the real core drops the oldest rows at once, and refuses a number outside the setting's range.
    #[cfg(all(unix, native_terminal_core))]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn the_real_core_keeps_the_history_lines_the_setting_changed_to() {
        use crate::terminal_core::{self, terminal_core_scrollback, terminal_core_snapshot};
        let _kept = terminal_core::tests_keeping_cores().read();
        let state = LocalState::default();
        let (event, _rx) = events();
        terminal_core::terminal_core_open(access_lease(), event.clone(), 40, 6, Some(20_000), None)
            .await
            .unwrap();
        let program = r"stty -echo; read x; seq 1 30000; echo done; sleep 20";
        let connected =
            desktop::start_with_access(&state, access_lease(), shell(program), 40, 6, event)
                .await
                .unwrap();
        let id = connected.session_id;
        desktop::write(&state, &id, "go\n".into(), access_lease()).unwrap();
        real_core_text_with(&id, "done").await;
        let length = || async {
            let answer = terminal_core_snapshot(access_lease(), id.clone(), Some(1)).await;
            answered(answer).unwrap()["state"]["viewport"]["length"]
                .as_u64()
                .unwrap()
        };
        let before = length().await;
        assert!(
            before > 25_000,
            "20,000 lines keep what the program printed: {before}"
        );
        let set = |lines| {
            let id = id.clone();
            async move { answered(terminal_core_scrollback(access_lease(), id, lines).await) }
        };
        set(100).await.unwrap();
        let after = length().await;
        assert!(
            (100 + 6..before / 2).contains(&after),
            "cut to 100 lines, dropped at once: {before} -> {after}"
        );
        for lines in [0, 99, 20_001] {
            assert!(set(lines).await.is_err(), "{lines}");
        }
        assert_eq!(length().await, after, "a refused number changes nothing");
        terminal_core::close(&id);
    }
    /// A local state and a core opened for a terminal of this size, with the Channel the session starts with.
    #[cfg(all(unix, native_terminal_core))]
    async fn open_core(
        cols: u32,
        rows: u32,
    ) -> (
        LocalState,
        Channel<SshEvent>,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (event, rx) = events();
        crate::terminal_core::terminal_core_open(
            access_lease(),
            event.clone(),
            cols,
            rows,
            None,
            None,
        )
        .await
        .unwrap();
        (LocalState::default(), event, rx)
    }
    /// The events the core's Channel has delivered so far. The core's output never travels on it.
    #[cfg(all(unix, native_terminal_core))]
    fn queued(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) -> Vec<serde_json::Value> {
        let events: Vec<_> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(
            events.iter().all(|event| event["type"] != "data"),
            "{events:?}"
        );
        events
    }
    /// The events up to and including the next `changed`. A chunk is announced just after it is parsed, so the
    /// screen can show it a moment before its ring has gone out.
    #[cfg(all(unix, native_terminal_core))]
    async fn until_ring(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) -> Vec<serde_json::Value> {
        let mut events = queued(rx);
        while !events.iter().any(|event| event["type"] == "changed") {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .expect("a ring");
            events.push(event.unwrap());
        }
        events
    }
    #[cfg(all(unix, native_terminal_core))]
    fn kinds(events: &[serde_json::Value]) -> Vec<&str> {
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect()
    }
    /// Needs the `native-terminal` feature (Zig). The control plane over a real PTY: a program the shell runs
    /// prints, the reader asks for the state, scrolls, resizes and stops looking, and the core's event stream on the
    /// session's Channel says what the program reported and rings once per read, however much output arrives.
    #[cfg(all(unix, native_terminal_core))]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn the_control_commands_answer_for_a_real_pty_core_and_its_events_follow_the_reader() {
        use crate::terminal_core::{self, fake::assert_no_cells};
        use serde_json::json;
        let _kept = terminal_core::tests_keeping_cores().read();
        let (state, event, mut rx) = open_core(40, 6).await;
        let program = concat!(
            r"stty -echo; read a; printf '\a\033]0;build\a\033]7;file://host/tmp/a%%20b\a\033]52;c;aGVsbG8=\a'; seq 1 3000; echo first; ",
            r"read b; seq 1 3000; echo second; read c; seq 1 5000; echo third; sleep 5",
        );
        let connected =
            desktop::start_with_access(&state, access_lease(), shell(program), 40, 6, event)
                .await
                .unwrap();
        let id = connected.session_id;
        let id = id.as_str();
        let go = || desktop::write(&state, id, "go\n".into(), access_lease()).unwrap();
        let snapshot = |window| async move {
            answered(
                terminal_core::terminal_core_snapshot(access_lease(), id.to_owned(), window).await,
            )
        };
        let scroll = |action| async move {
            answered(
                terminal_core::terminal_core_scroll(access_lease(), id.to_owned(), action, Some(8))
                    .await,
            )
        };
        let size = |cols, rows| async move {
            answered(
                terminal_core::terminal_core_resize(
                    access_lease(),
                    id.to_owned(),
                    cols,
                    rows,
                    Some(8),
                )
                .await,
            )
        };
        let active = |active| async move {
            answered(
                terminal_core::terminal_core_set_active(access_lease(), id.to_owned(), active)
                    .await,
            )
        };

        go();
        let first = real_core_text_with(id, "first").await;
        assert!(first.contains("3000"), "{first:?}");
        // 3,000 lines arrived in many chunks and the reader has not read: one ring.
        let mut events = until_ring(&mut rx).await;
        assert_eq!(
            kinds(&events)
                .iter()
                .filter(|kind| **kind == "changed")
                .count(),
            1,
            "{events:?}"
        );
        // The reader reads: the state, the last rows, nothing that is a cell.
        let live = snapshot(Some(8)).await.unwrap();
        assert_no_cells(&live);
        assert_eq!(live["state"]["columns"], 40);
        assert_eq!(live["state"]["rows"], 6);
        assert_eq!(live["state"]["viewport"]["following"], true);
        let rows = live["window"]["rows"].as_array().unwrap();
        assert!(rows.len() <= 8);
        assert_eq!(
            &rows[rows.len() - 4..],
            [json!("2999"), json!("3000"), json!("first"), json!("")]
        );
        // What the program reported came out once, decoded, ahead of the ring or with the read.
        events.extend(queued(&mut rx));
        let of = |kind: &str| {
            events
                .iter()
                .filter(|event| event["type"] == kind)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            (
                of("title").len(),
                of("bell").len(),
                of("cwd").len(),
                of("clipboard").len()
            ),
            (1, 1, 1, 1),
            "{events:?}"
        );
        assert_eq!(of("title")[0]["title"], "build");
        assert_eq!(of("cwd")[0]["path"], "/tmp/a b");
        assert_eq!(of("clipboard")[0]["text"], "hello");

        // Scrolling and sizing answer with the new state.
        let top = scroll(json!({"kind": "toTop"})).await.unwrap();
        assert_no_cells(&top);
        assert_eq!(top["state"]["viewport"]["top"], 0);
        assert_eq!(top["state"]["viewport"]["following"], false);
        assert_eq!(top["window"]["first"], 0);
        let bottom = scroll(json!({"kind": "toBottom"})).await.unwrap();
        assert_eq!(bottom["state"]["viewport"]["following"], true);
        let resized = size(30, 8).await.unwrap();
        assert_no_cells(&resized);
        assert_eq!(
            (
                resized["state"]["columns"].as_u64(),
                resized["state"]["rows"].as_u64()
            ),
            (Some(30), Some(8))
        );
        assert!(size(0, 8).await.unwrap_err().contains("between 1 and 1000"));

        // A reader that stopped looking is told nothing while the program keeps printing, and is caught up once.
        queued(&mut rx);
        active(false).await.unwrap();
        go();
        real_core_text_with(id, "second").await;
        assert_eq!(
            kinds(&queued(&mut rx)),
            Vec::<&str>::new(),
            "an inactive session wakes nobody"
        );
        active(true).await.unwrap();
        assert_eq!(
            kinds(&queued(&mut rx)),
            ["changed"],
            "and rings once when looked at again"
        );
        // Reading rearms it: the next burst of 5,000 lines rings once more.
        let seen = snapshot(None).await.unwrap();
        assert!(seen["window"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row == "second"));
        go();
        real_core_text_with(id, "third").await;
        assert_eq!(
            kinds(&until_ring(&mut rx).await),
            ["changed"],
            "5,000 lines, one ring"
        );
        terminal_core::close(id);
    }
    /// Needs the `native-terminal` feature (Zig). `cat -v` makes the bytes the program receives visible.
    #[cfg(all(unix, native_terminal_core))]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn the_real_core_answers_queries_and_encodes_paste_and_mouse_into_the_pty() {
        use crate::terminal_core::{self, CoreInput, MouseAction, MouseButton};
        let _kept = terminal_core::tests_keeping_cores().read();
        let state = LocalState::default();
        let (event, _rx) = events();
        terminal_core::terminal_core_open(access_lease(), event.clone(), 120, 24, None, None)
            .await
            .unwrap();
        // Bracketed paste and mouse tracking on, then a device attributes query: the core answers it
        // into the PTY before `cat` starts reading, and the tty buffers the answer.
        let program = r"stty raw -echo; printf '[?2004h[?1000h[c'; exec cat -v";
        let connected =
            desktop::start_with_access(&state, access_lease(), shell(program), 120, 24, event)
                .await
                .unwrap();
        let id = connected.session_id;
        real_core_text_with(&id, "^[[?").await;
        let send = |input| async {
            terminal_core::terminal_core_input(access_lease(), id.clone(), input)
                .await
                .unwrap()
                .into_inner()
                .unwrap()
        };
        let paste = CoreInput::Paste {
            text: "a\nb".into(),
        };
        assert_eq!(send(paste).await, "\x1b[200~a\rb\x1b[201~".len());
        // Column 111 in X10 encoding is the byte 0x8f, which is not UTF-8 and reaches the program as is.
        let press = CoreInput::Mouse {
            action: MouseAction::Press,
            button: Some(MouseButton::Left),
            mods: Default::default(),
            x: 110.5,
            y: 1.5,
        };
        assert_eq!(send(press).await, 6);
        let text = real_core_text_with(&id, "M-^O").await;
        for shown in ["^[[200~a^Mb^[[201~", "^[[M M-^O\""] {
            assert!(text.contains(shown), "{shown:?} in {text:?}");
        }
        terminal_core::close(&id);
    }
    /// Needs the `native-terminal` feature (Zig). It reads the process-wide hub, so it takes the cores
    /// exclusively: no other test's core is alive while it counts.
    #[cfg(all(unix, native_terminal_core))]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' cores away
    async fn history_lines_set_the_scrollback_the_real_core_reserves_for_a_session() {
        use crate::terminal_core;
        use lazysh_terminal_runtime::scrollback_bytes_for_lines;
        let _exclusive = terminal_core::tests_keeping_cores().write();
        let state = LocalState::default();
        let (event, _rx) = events();
        terminal_core::terminal_core_open(
            access_lease(),
            event.clone(),
            120,
            24,
            Some(5_000),
            None,
        )
        .await
        .unwrap();
        let connected =
            desktop::start_with_access(&state, access_lease(), shell("echo done"), 120, 24, event)
                .await
                .unwrap();
        let id = connected.session_id;
        real_core_text_with(&id, "done").await;
        assert_eq!(
            terminal_core::hub_usage(),
            (1, scrollback_bytes_for_lines(5_000, 120))
        );
        terminal_core::close(&id);
        assert_eq!(terminal_core::hub_usage(), (0, 0));
    }
    /// Needs the `native-terminal` feature (Zig) and a Linux `/proc`; run alone (`--test-threads=1`)
    /// with `--nocapture` to see the measured resident set.
    #[cfg(all(target_os = "linux", native_terminal_core))]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard keeps other tests' cores out of the global budget
    async fn a_hundred_terminals_open_and_close_without_growing_the_process_or_the_budget() {
        use crate::terminal_core;
        let _exclusive = terminal_core::tests_keeping_cores().write().unwrap();
        fn resident_kib() -> usize {
            let statm = std::fs::read_to_string("/proc/self/statm").unwrap();
            statm
                .split_whitespace()
                .nth(1)
                .unwrap()
                .parse::<usize>()
                .unwrap()
                * 4
        }
        let state = LocalState::default();
        let mut baseline = 0;
        for round in 0..110 {
            if round == 10 {
                baseline = resident_kib(); // after warm-up: allocator pools and thread stacks exist
            }
            let (event, mut rx) = events();
            terminal_core::terminal_core_open(
                access_lease(),
                event.clone(),
                80,
                24,
                Some(1_000),
                None,
            )
            .await
            .unwrap();
            let connected = desktop::start_with_access(
                &state,
                access_lease(),
                shell("seq 1 30000"),
                80,
                24,
                event,
            )
            .await
            .unwrap();
            let id = connected.session_id;
            closed(&mut rx).await;
            // The session ends when the PTY does; the core's worker may still be parsing what it was fed.
            real_core_text_with(&id, "30000").await;
            terminal_core::terminal_core_close(id).unwrap();
        }
        let grown = resident_kib().saturating_sub(baseline);
        eprintln!("resident set: {baseline} KiB after 10 rounds, {grown} KiB more after 100 more");
        assert_eq!(
            terminal_core::hub_usage(),
            (0, 0),
            "every session and its scrollback budget was returned"
        );
        assert!(
            grown < 32 * 1024,
            "{grown} KiB growth over 100 sessions of 1000 lines of scrollback"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn local_disconnect_reaps_its_owned_running_process() {
        let state = LocalState::default();
        let (connected, mut rx, pid) = start_owned_child(&state).await;
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        desktop::disconnect(&state, &connected.session_id);
        closed(&mut rx).await;
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "owned local process still exists"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn state_drop_reaps_local_child_without_waiting_for_async_supervisor() {
        let state = LocalState::default();
        let (_, mut rx, pid) = start_owned_child(&state).await;
        drop(state);
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "state drop returned before owned child was reaped"
        );
        closed(&mut rx).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stopped_window_rejects_additional_local_terminal_startup() {
        let state = LocalState::default();
        state.clone_inner().stop_all();
        let (event, _) = events();
        assert!(desktop::start(&state, shell("exit 99"), 80, 24, event)
            .await
            .is_err());
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_conpty_executes_utf8_resizes_and_closes() {
        let state = LocalState::default();
        let (event, mut rx) = events();
        let connected = desktop::connect(&state, access_lease(), None, None, None, 80, 24, event)
            .await
            .expect("ConPTY startup failed on this Windows runner");
        let pid = desktop::process_id(&state, &connected.session_id);
        desktop::resize(&state, &connected.session_id, 111, 36, access_lease()).unwrap();
        desktop::write(
            &state,
            &connected.session_id,
            "chcp 65001 >nul\r\necho __LOCAL_世界__\r\n".into(),
            access_lease(),
        )
        .unwrap();
        assert!(until(&mut rx, "__LOCAL_世界__")
            .await
            .contains("__LOCAL_世界__"));
        desktop::disconnect(&state, &connected.session_id);
        closed(&mut rx).await;
        let processes = std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("Could not query owned ConPTY child after cleanup");
        assert!(
            processes.status.success(),
            "tasklist failed: {}",
            String::from_utf8_lossy(&processes.stderr)
        );
        assert!(
            !String::from_utf8_lossy(&processes.stdout).contains(&format!(",\"{pid}\",")),
            "owned ConPTY shell survived disconnect"
        );
    }
    /// Opens `target` as a real local terminal, runs `input` and waits for `needle`.
    async fn run_in_target(target: &str, input: &str, needle: &str) -> String {
        let state = LocalState::default();
        let (event, mut rx) = events();
        let connected = desktop::connect(
            &state,
            access_lease(),
            None,
            None,
            Some(target),
            100,
            30,
            event,
        )
        .await
        .unwrap_or_else(|error| panic!("target {target} did not start: {error}"));
        desktop::write(&state, &connected.session_id, input.into(), access_lease()).unwrap();
        // Shell startup, profiles included, is slower than the 5 seconds a bare shell needs.
        let output = until_within(&mut rx, needle, Duration::from_secs(60)).await;
        desktop::disconnect(&state, &connected.session_id);
        closed(&mut rx).await;
        output
    }
    #[tokio::test]
    async fn a_target_that_was_not_detected_is_refused_before_any_process_starts() {
        let state = LocalState::default();
        let slots = state.available_slots();
        for target in [
            "wsl:definitely-not-installed",
            "../x",
            "C:\\Windows\\System32\\cmd.exe",
            "",
        ] {
            let (event, _rx) = events();
            let error = desktop::connect(
                &state,
                access_lease(),
                None,
                None,
                Some(target),
                80,
                24,
                event,
            )
            .await
            .err()
            .expect("an undetected target must be refused");
            assert!(error.contains("not available"), "{target:?}: {error}");
        }
        assert_eq!(state.available_slots(), slots);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn linux_offers_the_login_shell_as_its_only_target_and_opens_it_by_id() {
        let capability = local_capability().await;
        let ids: Vec<_> = capability
            .targets
            .iter()
            .map(|target| target.id.as_str())
            .collect();
        assert_eq!(ids, ["default"]);
        assert_eq!(capability.targets[0].kind, "posix");
        let output =
            run_in_target("default", "printf '__TARGET_%s__\\n' ok\n", "__TARGET_ok__").await;
        assert!(output.contains("__TARGET_ok__"));
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_lists_cmd_first_then_every_installed_powershell() {
        let capability = local_capability().await;
        let targets: Vec<_> = capability
            .targets
            .iter()
            .map(|target| (target.id.as_str(), target.label.as_str()))
            .collect();
        assert_eq!(targets[0].0, "default");
        assert!(targets[0].1.eq_ignore_ascii_case("cmd"), "{targets:?}");
        // Windows PowerShell ships with Windows; PowerShell 7 is listed when its pwsh.exe is installed.
        assert!(
            targets.contains(&("powershell", "Windows PowerShell")),
            "{targets:?}"
        );
        let pwsh_installed = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .any(|directory| directory.join("pwsh.exe").is_file());
        assert_eq!(
            targets.iter().any(|(id, _)| *id == "pwsh"),
            pwsh_installed,
            "{targets:?}"
        );
        assert!(capability
            .targets
            .iter()
            .all(|target| target.kind == "windows"));
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn every_detected_powershell_prints_its_version_in_conpty() {
        for target in targets::detect(false)
            .await
            .iter()
            .filter(|found| found.is_powershell())
        {
            let output = run_in_target(target.id(), "$PSVersionTable.PSVersion\r\n", "Major").await;
            assert!(output.contains("Major"), "{}: {output}", target.id());
        }
    }
    /// Needs a WSL distribution, which hosted Windows runners lack: run it where one is installed.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "needs a WSL distribution"]
    async fn real_wsl_target_runs_a_linux_shell_in_the_chosen_distribution() {
        let distro = targets::detect(true)
            .await
            .into_iter()
            .find(|found| found.is_wsl())
            .expect("no WSL distribution is installed");
        let output =
            run_in_target(distro.id(), "echo __WSL_$(uname -s)__\n", "__WSL_Linux__").await;
        assert!(output.contains("__WSL_Linux__"));
    }
    /// Starts a real WSL target and runs its host tools: makes a repository in the distribution,
    /// reads a file through `\\wsl.localhost\<distro>\` and shows a diff. Needs a distribution
    /// with `git`, which hosted Windows runners lack; it compiles everywhere and runs only there.
    #[tokio::test]
    #[ignore = "needs a WSL distribution with git"]
    async fn real_wsl_target_reads_a_file_and_shows_a_diff_through_the_host_context() {
        use crate::host::{Cmd, Host};
        async fn run(
            host: &Host,
            lease: &AccessLease,
            argv: &[&str],
        ) -> crate::ssh::Result<String> {
            host.run(lease, &Cmd::new(&[], argv)).await
        }
        let distro = targets::detect(true)
            .await
            .into_iter()
            .find(|found| found.is_wsl())
            .expect("no WSL distribution is installed");
        let state = LocalState::default();
        let lease = access_lease();
        let (event, _rx) = events();
        let connected = desktop::connect(
            &state,
            lease.clone(),
            None,
            None,
            Some(distro.id()),
            100,
            30,
            event,
        )
        .await
        .unwrap();
        desktop::adopt(&state, &connected.session_id, &lease).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let app = crate::ssh::AppState::new(temp.path().join("state")).unwrap();
        let host = Host::resolve(&app, &state, &connected.session_id, &lease)
            .await
            .unwrap();
        let home = host.home(&lease).await.unwrap();
        assert!(home.starts_with('/'), "{home}");
        let work = format!("{home}/lazysh-wsl-{}", uuid::Uuid::new_v4());
        run(&host, &lease, &["mkdir", &work]).await.unwrap();
        let write = |text: &str| format!("printf '{text}\\n' > '{work}/a.txt'");
        run(&host, &lease, &["sh", "-c", &write("before")])
            .await
            .unwrap();
        run(&host, &lease, &["git", "-C", &work, "init", "-q"])
            .await
            .unwrap();
        run(&host, &lease, &["git", "-C", &work, "add", "--", "a.txt"])
            .await
            .unwrap();
        run(
            &host,
            &lease,
            &[
                "git",
                "-C",
                &work,
                "-c",
                "user.name=Lazysh Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "first",
            ],
        )
        .await
        .unwrap();
        run(&host, &lease, &["sh", "-c", &write("after")])
            .await
            .unwrap();
        let read = host.read_text(&lease, format!("{work}/a.txt")).await;
        let diff = run(
            &host,
            &lease,
            &["git", "-C", &work, "diff", "--no-ext-diff"],
        )
        .await;
        let _ = run(&host, &lease, &["rm", "-rf", &work]).await;
        desktop::disconnect(&state, &connected.session_id);
        assert_eq!(read.unwrap(), "after\n");
        assert!(diff.unwrap().contains("+after"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn unadopted_local_pid_is_reaped_after_serialization_while_adopted_process_survives_lock()
    {
        use tauri::ipc::IpcResponse;
        for retained in [false, true] {
            let state = LocalState::default();
            let access = unlocked_access();
            let nonce = access.status().unwrap().nonce.unwrap();
            let creation = access.lease(Some(&nonce)).unwrap();
            let (events, mut rx) = events();
            let connected = desktop::start_with_access(
                &state,
                creation.clone(),
                shell("printf '__PID_%s__\\n' \"$$\"; exec sleep 120"),
                80,
                24,
                events,
            )
            .await
            .unwrap();
            let id = connected.session_id.clone();
            let pid = owned_pid(&mut rx).await;
            assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
            if retained {
                assert!(desktop::adopt(&state, &id, &creation).unwrap());
            }
            creation.guard(connected).unwrap().body().unwrap();
            access.lock().unwrap();
            assert!(desktop::adopt(&state, &id, &creation).is_err());
            if !retained {
                wait_reaped(pid).await;
            }
            access.authorize(access.generation().unwrap()).unwrap();
            access.ready(access.generation().unwrap()).unwrap();
            if retained {
                assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
                desktop::disconnect(&state, &id);
            }
            closed(&mut rx).await;
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // the guard only keeps other tests' renderer replacements away
    async fn an_unadopted_local_terminal_frees_its_core_but_an_adopted_one_keeps_it_through_a_lock()
    {
        use crate::terminal_core;
        for adopted in [false, true] {
            let _kept = terminal_core::tests_keeping_cores().read();
            let state = LocalState::default();
            let access = unlocked_access();
            let nonce = access.status().unwrap().nonce.unwrap();
            let creation = access.lease(Some(&nonce)).unwrap();
            let (core, connected) = start_sleeper_with_core(&state, creation.clone()).await;
            let id = connected.session_id.clone();
            if adopted {
                assert!(desktop::adopt(&state, &id, &creation).unwrap());
            }
            use tauri::ipc::IpcResponse;
            creation.guard(connected).unwrap().body().unwrap();
            access.lock().unwrap();
            let freed = tokio::time::timeout(Duration::from_secs(2), async {
                while !core.closed.load(std::sync::atomic::Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .is_ok();
            assert_eq!(freed, !adopted, "adopted: {adopted}");
            assert_eq!(terminal_core::live(&id).is_ok(), adopted);
            access.authorize(access.generation().unwrap()).unwrap();
            access.ready(access.generation().unwrap()).unwrap();
            if adopted {
                desktop::disconnect(&state, &id);
                terminal_core::close(&id);
                assert!(core.closed.load(std::sync::atomic::Ordering::SeqCst));
            }
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn renderer_rebind_reaps_old_local_pids_without_permanently_stopping_new_terminals() {
        use std::sync::Arc;
        use tauri::ipc::IpcResponse;
        let state = Arc::new(LocalState::default());
        let access = AccessState::disabled();
        let creation = access.lease(None).unwrap();
        let mut pids = Vec::new();
        let mut old_events = Vec::new();
        assert_eq!(state.available_slots(), 20);
        for adopted in [false, true] {
            let (events, mut rx) = events();
            let connected = desktop::start_with_access(
                &state,
                creation.clone(),
                shell("printf '__PID_%s__\\n' \"$$\"; exec sleep 120"),
                80,
                24,
                events,
            )
            .await
            .unwrap();
            let pid = owned_pid(&mut rx).await;
            if adopted {
                assert!(desktop::adopt(&state, &connected.session_id, &creation).unwrap());
            }
            creation.guard(connected).unwrap().body().unwrap();
            pids.push(pid);
            old_events.push(rx);
        }
        assert_eq!(state.available_slots(), 18);
        access.replace_renderer().unwrap();
        assert!(creation.check().is_err());
        state.cancel_for_renderer_rebind().await;
        for pid in pids {
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "old local child must be reaped before replacement ACK"
            );
        }
        assert_eq!(state.available_slots(), 20);
        state.cancel_for_renderer_rebind().await; // Idempotent cleanup cannot stop a future renderer.
        let fresh = replacement_lease(&access);
        let (events, mut rx) = events();
        let connected = desktop::start_with_access(
            &state,
            fresh.clone(),
            shell("printf 'FRESH_RENDERER_READY\\n'; exec sleep 120"),
            80,
            24,
            events,
        )
        .await
        .unwrap();
        assert!(desktop::adopt(&state, &connected.session_id, &fresh).unwrap());
        until(&mut rx, "FRESH_RENDERER_READY").await;
        for events in &mut old_events {
            assert!(
                events.try_recv().is_err(),
                "old callback namespace received replacement output"
            );
        }
        desktop::disconnect(&state, &connected.session_id);
        closed(&mut rx).await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rebind_waits_for_an_admitted_launch_after_its_caller_is_cancelled() {
        use std::sync::Arc;
        for directory_launch in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let pending = crate::desktop_launch::LaunchState::new(directory_launch.then(|| {
                crate::desktop_launch::LaunchTarget::Directory(directory.path().to_owned())
            }));
            let state = Arc::new(LocalState::default());
            let access = if directory_launch {
                unlocked_access()
            } else {
                AccessState::disabled()
            };
            let creation = ready_lease(&access);
            let receipt = pending.read(&creation).unwrap().directory_receipt;
            let mut command = shell("exec sleep 120");
            if let Some(receipt) = &receipt {
                let path = pending.claim(receipt, &creation).unwrap();
                command.cwd(path);
            }
            let (began, started) = tokio::sync::oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            let caller_state = state.clone();
            let caller_creation = creation.clone();
            let caller = tokio::spawn(async move {
                let (events, _rx) = events();
                caller_creation
                    .run(desktop::start_with_held_launch(
                        &caller_state,
                        caller_creation.clone(),
                        command,
                        events,
                        move |pid| {
                            let _ = began.send(pid);
                            let _ = held.recv();
                        },
                    ))
                    .await
            });
            let pid = started.await.unwrap() as i32;
            assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
            if directory_launch {
                access.lock().unwrap();
            }
            access.replace_renderer().unwrap();
            assert!(caller.await.unwrap().is_err());
            let available_while_held = state.available_slots();
            let cleanup_state = state.clone();
            let mut cleanup = tokio::spawn(async move {
                cleanup_state.cancel_for_renderer_rebind().await;
            });
            // The held native worker cannot finish until this test explicitly releases it.
            let ended_early = tokio::time::timeout(Duration::from_millis(50), &mut cleanup)
                .await
                .is_ok();
            let alive_when_cleanup_returned = ended_early && unsafe { libc::kill(pid, 0) } == 0;
            let _ = release.send(());
            if !ended_early {
                tokio::time::timeout(Duration::from_secs(5), cleanup)
                    .await
                    .unwrap()
                    .unwrap();
            }
            // Always clean the real child before asserting the red/green boundary.
            wait_reaped(pid).await;
            assert!(!alive_when_cleanup_returned,
            "cleanup returned while its held old child was still alive; available slots={available_while_held}");
            assert_eq!(
                available_while_held, 19,
                "launch permit must belong to the real native worker, not its cancelled caller"
            );
            assert!(
                !ended_early,
                "cleanup acknowledged while an admitted launch was held"
            );
            assert_eq!(state.available_slots(), 20);
            assert!(access.finish_renderer_replacement().unwrap());
            access.foreground().unwrap();
            if directory_launch {
                access.authorize(access.generation().unwrap()).unwrap();
            }
            let fresh = ready_lease(&access);
            assert!(pending.queued_receipt().is_none());
            if let Some(receipt) = &receipt {
                assert!(
                    pending.claim(receipt, &fresh).is_err(),
                    "a cancelled launch receipt must not replay after unlock"
                );
            }
            let (events, mut rx) = events();
            let connected = desktop::start_with_access(
                &state,
                fresh.clone(),
                shell("printf 'AFTER_HELD_LAUNCH\\n'; exec sleep 120"),
                80,
                24,
                events,
            )
            .await
            .unwrap();
            assert!(desktop::adopt(&state, &connected.session_id, &fresh).unwrap());
            until(&mut rx, "AFTER_HELD_LAUNCH").await;
            desktop::disconnect(&state, &connected.session_id);
            closed(&mut rx).await;
        }
    }
}
#[cfg(all(
    test,
    any(target_os = "linux", target_os = "macos", target_os = "windows")
))]
#[path = "local_attach_tests.rs"]
mod attach_tests;
