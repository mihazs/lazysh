use super::{panes::look, Anchor, SurfaceState};
use crate::native_renderer::{Host, Inbox, Look};
use lazysh_terminal_runtime::Session;
use std::{cell::RefCell, collections::HashMap, sync::OnceLock};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use super::macos as platform;
#[cfg(target_os = "windows")]
use super::windows as platform;

pub(super) use platform::place;

pub(super) fn drawing(session: &str) -> Result<(Session, Inbox), String> {
    crate::terminal_core::live(session)
        .ok()
        .and_then(|core| core.drawing())
        .ok_or_else(|| "The session has no native core to draw".into())
}

thread_local! {
    pub(super) static PANES: RefCell<HashMap<String, Pane>> = RefCell::new(HashMap::new());
}

static DISPLAY: OnceLock<Result<(), String>> = OnceLock::new();

pub(crate) fn install(app: &tauri::App) {
    let _ = DISPLAY.set((|| {
        let window = app
            .get_webview_window("main")
            .ok_or("The app window is gone")?;
        window
            .as_ref()
            .set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)))
            .map_err(|error| error.to_string())?;
        window.on_window_event(|event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                || (cfg!(target_os = "windows")
                    && matches!(event, tauri::WindowEvent::CloseRequested { .. }))
            {
                PANES.with_borrow_mut(HashMap::clear);
            }
        });
        Ok(())
    })());
}

pub(crate) fn display() -> Result<(), String> {
    DISPLAY
        .get()
        .cloned()
        .unwrap_or_else(|| Err(platform::DISPLAY_UNAVAILABLE.into()))
}

pub(super) struct Pane {
    // Field drop order keeps the native surface live until the renderer stops.
    renderer: Host,
    pub(super) surface: platform::Surface,
    state: SurfaceState,
    look: Look,
    scale: f32,
    background: u32,
}

impl Pane {
    pub(super) fn new(
        renderer: Host,
        surface: platform::Surface,
        width: u32,
        height: u32,
        look: Look,
        anchor: Anchor,
        background: u32,
    ) -> Self {
        let state = SurfaceState {
            placed: true,
            ready: true,
            generation: 1,
            width,
            height,
            ..SurfaceState::default()
        };
        Self {
            renderer,
            surface,
            state,
            look,
            scale: anchor.dpr as f32,
            background,
        }
    }

    pub(super) fn state(&self) -> SurfaceState {
        self.state.clone()
    }

    pub(super) fn update(
        &mut self,
        width: u32,
        height: u32,
        wanted: Look,
        anchor: Anchor,
        background: u32,
    ) -> Result<SurfaceState, String> {
        if (self.state.width, self.state.height) != (width, height) {
            self.renderer.resize(width, height)?;
            (self.state.width, self.state.height) = (width, height);
        }
        self.update_look(wanted)?;
        (self.scale, self.background) = (anchor.dpr as f32, background);
        Ok(self.state())
    }

    fn update_look(&mut self, wanted: Look) -> Result<(), String> {
        if self.look != wanted {
            self.renderer.set_look(wanted.clone())?;
            self.look = wanted;
        }
        Ok(())
    }
}

pub(super) async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (answer, asked) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = answer.send(work());
    })
    .map_err(|error| error.to_string())?;
    asked.await.map_err(|error| error.to_string())?
}

pub(super) async fn relook(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move || {
        PANES.with_borrow_mut(|panes| {
            if let Some(pane) = panes.get_mut(&session) {
                pane.update_look(look(&session, pane.scale, pane.background))?;
            }
            Ok(())
        })
    })
    .await
}

pub(super) async fn remove(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move || {
        PANES.with_borrow_mut(|panes| {
            panes.remove(&session);
        });
        Ok(())
    })
    .await
}

pub(super) async fn state(app: &AppHandle, session: String) -> Result<SurfaceState, String> {
    on_main(app, move || {
        Ok(PANES.with_borrow(|panes| panes.get(&session).map(Pane::state).unwrap_or_default()))
    })
    .await
}
