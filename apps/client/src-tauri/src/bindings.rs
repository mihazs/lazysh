//! Per-session multiplexer and host state, shared by SSH and local sessions: the bindings a
//! terminal acquires when it attaches tmux or Herdr, and the slots one host command at a time uses.
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

pub(crate) struct Bindings {
    /// The control client that owns navigation and guarded Chat input for the displayed tmux.
    pub(crate) tmux: Mutex<Option<crate::tmux_jump::Binding>>,
    pub(crate) herdr: Mutex<Option<crate::herdr_guard::Binding>>,
    /// The tmux server the displayed terminal is attached to.
    pub(crate) tmux_server: Mutex<Option<crate::tmux_server::TmuxServer>>,
    pub(crate) clipboard: crate::host_clipboard::UploadSlot,
    pub(crate) companion_install: Arc<Semaphore>,
}
impl Default for Bindings {
    fn default() -> Self {
        Self {
            tmux: Mutex::new(None),
            herdr: Mutex::new(None),
            tmux_server: Mutex::new(None),
            clipboard: crate::host_clipboard::UploadSlot::default(),
            companion_install: Arc::new(Semaphore::new(1)),
        }
    }
}
