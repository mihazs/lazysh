//! Desktop-only terminal sessions. These never own an SSH identity or transport.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use crate::app_lock::AccessState;
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::ssh::SshEvent;
type AccessResult<T> = Result<Guarded<T>, GuardedError<String>>;
use serde::Serialize;
use tauri::{ipc::Channel, State};

#[derive(Serialize)]
pub struct Capability {
    available: bool,
    reason: &'static str,
}
#[tauri::command]
pub fn local_capability() -> Capability {
    let available = cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ));
    Capability {
        available,
        reason: if available {
            "Local shell runs on this desktop device."
        } else {
            "Local terminals require the desktop app."
        },
    }
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
pub async fn local_connect(
    lease: AccessLease,

    state: State<'_, LocalState>,
    launch: State<'_, crate::desktop_launch::LaunchState>,
    launch_receipt: Option<String>,
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
                desktop::connect(&state, lease.clone(), directory, cols, rows, events).await
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
            {
                let _ = (state, launch, launch_receipt, cols, rows, events);
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
        desktop::usage_session(state, id, lease)
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
        access: AccessState,
        creation: AccessLease,
        adopted: AtomicBool,
        adoption: tokio::sync::Notify,
        process: Arc<Mutex<Option<Process>>>,
        stopped: Arc<AtomicBool>,
        #[cfg(unix)]
        wake: UnixStream,
        renderer_gone: watch::Sender<bool>,
    }
    impl Session {
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
    pub async fn connect(
        state: &LocalState,
        creation: AccessLease,
        directory: Option<std::path::PathBuf>,
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
    ) -> Result<Connected, String> {
        let command = shell_command(directory)?;
        start_with_access(state, creation, command, cols, rows, events).await
    }
    pub(super) fn shell_command(
        directory: Option<std::path::PathBuf>,
    ) -> Result<CommandBuilder, String> {
        let mut command = CommandBuilder::new_default_prog();
        command.env("TERM", "xterm-256color");
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
            command.cwd(directory);
        } else if let Some(home) =
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .filter(|path| std::path::Path::new(path).is_dir())
        {
            command.cwd(home);
        }
        Ok(command)
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
        start_with_launcher(state, creation, command, cols, rows, events, launch).await
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
        )
        .await
    }
    async fn start_with_launcher(
        state: &LocalState,
        creation: AccessLease,
        command: CommandBuilder,
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
        launcher: impl FnOnce(CommandBuilder, u32, u32) -> Result<PtyParts, String> + Send + 'static,
    ) -> Result<Connected, String> {
        size(cols, rows)?;
        if state.0.stopped.load(Ordering::SeqCst) {
            return Err("Local terminals are shutting down".into());
        }
        let slot = creation
            .with_current(|| state.0.slots.clone().try_acquire_owned())
            .map_err(String::from)?
            .map_err(|_| "At most 20 local terminals may be open")?;
        let launch_access = creation.clone();
        let owner = state.0.clone();
        let (process, mut reader, mut writer) =
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
            process: process.clone(),
            stopped: stopped.clone(),
            #[cfg(unix)]
            wake,
            renderer_gone: watch::channel(false).0,
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
                                    &mut cancellation, &events, &bytes,
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
                retire_session(&inner, &id, &session);
            }
        });
    }
    pub(super) fn usage_session(
        state: &LocalState,
        id: &str,
        lease: &AccessLease,
    ) -> Result<watch::Receiver<bool>, String> {
        lease
            .with_current(|| {
                let session = state.0.session(id)?;
                if !session.adopted.load(Ordering::SeqCst)
                    || *session.renderer_gone.borrow()
                    || *session.cancel.borrow()
                {
                    return Err("Local terminal is disconnected".into());
                }
                Ok(session.cancel.subscribe())
            })
            .map_err(String::from)?
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
        state
            .0
            .session(id)?
            .input
            .try_send(Input::Resize(cols, rows, lease))
            .map_err(|_| "Local terminal input queue is full or disconnected".into())
    }
    pub fn ack(state: &LocalState, id: &str, bytes: u32) -> Result<(), String> {
        let session = state.0.session(id)?;
        let mut pending = session
            .inflight
            .lock()
            .map_err(|_| "Local output lock failed")?;
        if bytes == 0 || bytes > *pending {
            return Err("Local output acknowledgment exceeds pending data".into());
        }
        *pending -= bytes;
        session.credits.add_permits(bytes as usize);
        Ok(())
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
    fn access_lease() -> crate::app_lock::AccessLease {
        crate::app_lock::AccessState::disabled()
            .lease(None)
            .unwrap()
    }
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;
    fn events() -> (
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
    async fn until(rx: &mut mpsc::UnboundedReceiver<serde_json::Value>, needle: &str) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
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
            assert!(desktop::ack(&state, &connected.session_id, 0).is_err());
            assert!(desktop::ack(&state, &connected.session_id, pending + 1).is_err());
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
        let connected = desktop::connect(&state, access_lease(), None, 80, 24, event)
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
