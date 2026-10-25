//! Desktop-only terminal sessions. These never own an SSH identity or transport.
use crate::ssh::SshEvent;
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

#[tauri::command]
pub async fn local_connect(
    state: State<'_, LocalState>,
    cols: u32,
    rows: u32,
    events: Channel<SshEvent>,
) -> Result<Connected, String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        desktop::connect(&state, cols, rows, events).await
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, cols, rows, events);
        Err("Local terminals require the desktop app".into())
    }
}
#[tauri::command]
pub async fn local_write(
    state: State<'_, LocalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        desktop::write(&state, &session_id, data)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, session_id, data);
        Err("Local terminals require the desktop app".into())
    }
}
#[tauri::command]
pub async fn local_resize(
    state: State<'_, LocalState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        desktop::resize(&state, &session_id, cols, rows)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (state, session_id, cols, rows);
        Err("Local terminals require the desktop app".into())
    }
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
    enum Input {
        Data(String),
        Resize(u32, u32),
        Close,
    }
    struct Session {
        input: mpsc::Sender<Input>,
        cancel: watch::Sender<bool>,
        credits: Semaphore,
        inflight: Mutex<u32>,
        process: Arc<Mutex<Option<Process>>>,
        stopped: Arc<AtomicBool>,
        #[cfg(unix)]
        wake: UnixStream,
        _slot: OwnedSemaphorePermit,
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
        slots: Arc<Semaphore>,
        stopped: AtomicBool,
    }
    impl Inner {
        pub fn stop_all(&self) {
            self.stopped.store(true, Ordering::SeqCst);
            let sessions = self
                .sessions
                .lock()
                .map(|sessions| sessions.values().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
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
                slots: Arc::new(Semaphore::new(20)),
                stopped: AtomicBool::new(false),
            }))
        }
    }
    impl LocalState {
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
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
    ) -> Result<Connected, String> {
        let mut command = CommandBuilder::new_default_prog();
        command.env("TERM", "xterm-256color");
        if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .filter(|path| std::path::Path::new(path).is_dir())
        {
            command.cwd(home);
        }
        start(state, command, cols, rows, events).await
    }
    pub(super) async fn start(
        state: &LocalState,
        command: CommandBuilder,
        cols: u32,
        rows: u32,
        events: Channel<SshEvent>,
    ) -> Result<Connected, String> {
        size(cols, rows)?;
        if state.0.stopped.load(Ordering::SeqCst) {
            return Err("Local terminals are shutting down".into());
        }
        let slot = state
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "At most 20 local terminals may be open")?;
        let (process, mut reader, mut writer) =
            tauri::async_runtime::spawn_blocking(move || launch(command, cols, rows))
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
            credits: Semaphore::new(WINDOW),
            inflight: Mutex::new(0),
            process: process.clone(),
            stopped: stopped.clone(),
            #[cfg(unix)]
            wake,
            _slot: slot,
        });
        let id = format!("local:{}", uuid::Uuid::new_v4());
        let registration = {
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
        };
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
            .map_err(|error| {
                stopped.store(true, Ordering::SeqCst);
                disconnect(state, &id);
                if let Ok(mut sessions) = state.0.sessions.lock() {
                    sessions.remove(&id);
                }
                format!("Could not start local output worker: {error}")
            })?;
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
                            Input::Resize(cols, rows) => {
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
                            Input::Data(data) => {
                                let mut bytes = data.as_bytes();
                                while !bytes.is_empty() && !write_stop.load(Ordering::SeqCst) {
                                    match writer.write(bytes) {
                                        Ok(0) => return Err("Local terminal input closed".into()),
                                        Ok(length) => bytes = &bytes[length..],
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
            .map_err(|error| {
                stopped.store(true, Ordering::SeqCst);
                disconnect(state, &id);
                if let Ok(mut sessions) = state.0.sessions.lock() {
                    sessions.remove(&id);
                }
                format!("Could not start local input worker: {error}")
            })?;
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
                                let permit=tokio::select! {_=cancellation.changed()=>return Ok(()), result=tokio::time::timeout(Duration::from_secs(15),session.credits.acquire_many(bytes.len() as u32))=>result.map_err(|_|"Local terminal stopped consuming output")?.map_err(|_|"Local terminal closed")?};
                                permit.forget();
                                *session.inflight.lock().map_err(|_|"Local output lock failed")?+=bytes.len() as u32;
                                events.send(SshEvent::Data{data:bytes}).map_err(|_|"Local terminal output closed")?;
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
            if let Ok(mut active) = sessions.sessions.lock() {
                active.remove(&task_id);
            }
            let _ = events.send(SshEvent::Closed {
                message: result.err().unwrap_or_else(|| "Local shell exited".into()),
            });
        });
        Ok(Connected { session_id: id })
    }
    pub fn write(state: &LocalState, id: &str, data: String) -> Result<(), String> {
        if data.len() > 65536 {
            return Err("Paste at most 64 KiB at once".into());
        }
        state
            .0
            .session(id)?
            .input
            .try_send(Input::Data(data))
            .map_err(|_| "Local terminal input queue is full or disconnected".into())
    }
    pub fn resize(state: &LocalState, id: &str, cols: u32, rows: u32) -> Result<(), String> {
        size(cols, rows)?;
        state
            .0
            .session(id)?
            .input
            .try_send(Input::Resize(cols, rows))
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
        desktop::resize(&state, &first.session_id, 111, 36).unwrap();
        desktop::write(&state, &first.session_id, "hello世界\n".into()).unwrap();
        let output = until(&mut rx, "36 111").await;
        assert!(output.contains("INPUT:hello世界"));
        assert!(desktop::write(&state, &first.session_id, "x".repeat(65537)).is_err());
        assert!(desktop::resize(&state, &first.session_id, 0, 24).is_err());
        desktop::disconnect(&state, &first.session_id);
        closed(&mut rx).await;
        desktop::write(&state, &second.session_id, "still alive\n".into()).unwrap();
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
            assert!(desktop::write(&state, &connected.session_id, "after close".into()).is_err());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_disconnect_reaps_its_owned_running_process() {
        let state = LocalState::default();
        let (event, mut rx) = events();
        let connected = desktop::start(
            &state,
            shell("printf '__PID_%s__\\n' \"$$\"; exec sleep 120"),
            80,
            24,
            event,
        )
        .await
        .unwrap();
        let output = until(&mut rx, "__\r\n").await;
        let pid = output
            .split("__PID_")
            .nth(1)
            .unwrap()
            .split("__")
            .next()
            .unwrap()
            .parse::<i32>()
            .unwrap();
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
        let (event, mut rx) = events();
        desktop::start(
            &state,
            shell("printf '__PID_%s__\\n' \"$$\"; exec sleep 120"),
            80,
            24,
            event,
        )
        .await
        .unwrap();
        let output = until(&mut rx, "__\r\n").await;
        let pid = output
            .split("__PID_")
            .nth(1)
            .unwrap()
            .split("__")
            .next()
            .unwrap()
            .parse::<i32>()
            .unwrap();
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
        let connected = desktop::connect(&state, 80, 24, event)
            .await
            .expect("ConPTY startup failed on this Windows runner");
        let pid = desktop::process_id(&state, &connected.session_id);
        desktop::resize(&state, &connected.session_id, 111, 36).unwrap();
        desktop::write(
            &state,
            &connected.session_id,
            "chcp 65001 >nul\r\necho __LOCAL_世界__\r\n".into(),
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
}
