use super::{panes::look, Anchor, SurfaceState};
use crate::native_renderer::{policy, Host, Look};
use lazysh_terminal_renderer_wgpu::{Target, Window};
use objc2::{rc::Retained, MainThreadOnly};
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use objc2_quartz_core::CAMetalLayer;
use std::{cell::RefCell, collections::HashMap, ptr::NonNull, sync::OnceLock};
use tauri::{AppHandle, Manager};

thread_local! {
    static PANES: RefCell<HashMap<String, Pane>> = RefCell::new(HashMap::new());
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
            if matches!(event, tauri::WindowEvent::Destroyed) {
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
        .unwrap_or_else(|| Err("The native terminal web view is unavailable".into()))
}

struct Pane {
    renderer: Option<Host>,
    view: Retained<NSView>,
    layer: Retained<CAMetalLayer>,
    state: SurfaceState,
    look: Look,
    scale: f32,
    background: u32,
}

impl Drop for Pane {
    fn drop(&mut self) {
        // The worker finishes using the layer before AppKit can release it.
        drop(self.renderer.take());
        self.view.removeFromSuperview();
    }
}

fn webview_rect(anchor: Anchor, bounds: NSRect, flipped: bool, scale: f64) -> NSRect {
    let points = anchor.dpr / scale;
    let y = if flipped {
        bounds.origin.y + anchor.y * points
    } else {
        bounds.origin.y + bounds.size.height - (anchor.y + anchor.height) * points
    };
    NSRect::new(
        NSPoint::new(bounds.origin.x + anchor.x * points, y),
        NSSize::new(anchor.width * points, anchor.height * points),
    )
}

fn place_in_webview(
    web: &NSView,
    session: String,
    anchor: Anchor,
    background: u32,
) -> Result<SurfaceState, String> {
    display()?;
    let mtm = MainThreadMarker::new().ok_or("AppKit requires the main thread")?;
    // SAFETY: The main-thread WebView callback keeps its view hierarchy alive.
    let parent = unsafe { web.superview() }.ok_or("The web view has no parent")?;
    let scale = parent
        .window()
        .ok_or("The web view has no window")?
        .backingScaleFactor();
    // WKWebView lays out the CSS viewport below the title bar of this window.
    let frame = web.convertRect_toView(
        webview_rect(anchor, web.safeAreaRect(), web.isFlipped(), scale),
        Some(&parent),
    );
    let width = (anchor.width * anchor.dpr).round().max(1.0) as u32;
    let height = (anchor.height * anchor.dpr).round().max(1.0) as u32;
    let wanted = look(&session, anchor.dpr as f32, background);
    PANES.with_borrow_mut(|panes| {
        if let Some(pane) = panes.get_mut(&session) {
            pane.view.setFrame(frame);
            pane.layer.setContentsScale(scale);
            if (pane.state.width, pane.state.height) != (width, height) {
                pane.renderer.as_ref().unwrap().resize(width, height)?;
                (pane.state.width, pane.state.height) = (width, height);
            }
            if pane.look != wanted {
                pane.renderer.as_ref().unwrap().set_look(wanted.clone())?;
                pane.look = wanted;
            }
            (pane.scale, pane.background) = (anchor.dpr as f32, background);
            return Ok(pane.state.clone());
        }

        let (core, inbox) = crate::terminal_core::live(&session)
            .ok()
            .and_then(|core| core.drawing())
            .ok_or("The session has no native core to draw")?;
        let view = NSView::initWithFrame(NSView::alloc(mtm), frame);
        let layer = CAMetalLayer::new();
        layer.setOpaque(true);
        layer.setContentsScale(scale);
        view.setLayer(Some(&layer));
        view.setWantsLayer(true);
        parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, Some(web));
        let state = SurfaceState {
            placed: true,
            ready: true,
            generation: 1,
            width,
            height,
            ..SurfaceState::default()
        };
        let mut pane = Pane {
            renderer: None,
            view,
            layer,
            state,
            look: wanted,
            scale: anchor.dpr as f32,
            background,
        };
        let pointer = NonNull::from(&*pane.layer).cast();
        // SAFETY: Pane keeps the layer alive until its renderer worker is joined.
        let window = unsafe { Window::metal_layer(pointer) };
        let target = Target::on_window(window, width, height).with_policy(policy());
        pane.renderer = Some(Host::attach(core, inbox, target, 1, pane.look.clone())?);
        let state = pane.state.clone();
        panes.insert(session, pane);
        Ok(state)
    })
}

pub(super) async fn place(
    app: &AppHandle,
    session: String,
    anchor: Anchor,
    background: u32,
) -> Result<SurfaceState, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("The app window is gone")?;
    let (answer, asked) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |web| {
            // SAFETY: Tauri calls on the UI thread with a live WKWebView, an NSView subclass.
            let view = unsafe { web.inner().cast::<NSView>().as_ref() };
            let result = view
                .ok_or_else(|| "The native web view is gone".to_string())
                .and_then(|view| place_in_webview(view, session, anchor, background));
            let _ = answer.send(result);
        })
        .map_err(|error| error.to_string())?;
    asked.await.map_err(|error| error.to_string())?
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&mut HashMap<String, Pane>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (answer, asked) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = answer.send(PANES.with_borrow_mut(work));
    })
    .map_err(|error| error.to_string())?;
    asked.await.map_err(|error| error.to_string())?
}

pub(super) async fn relook(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move |panes| {
        if let Some(pane) = panes.get_mut(&session) {
            let wanted = look(&session, pane.scale, pane.background);
            if wanted != pane.look {
                pane.renderer.as_ref().unwrap().set_look(wanted.clone())?;
                pane.look = wanted;
            }
        }
        Ok(())
    })
    .await
}

pub(super) async fn remove(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move |panes| {
        panes.remove(&session);
        Ok(())
    })
    .await
}

pub(super) async fn state(app: &AppHandle, session: String) -> Result<SurfaceState, String> {
    on_main(app, move |panes| {
        Ok(panes
            .get(&session)
            .map(|pane| pane.state.clone())
            .unwrap_or_default())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_anchor_respects_backing_scale_zoom_and_flipped_coordinates() {
        let bounds = NSRect::new(NSPoint::new(10.0, 20.0), NSSize::new(400.0, 300.0));
        let anchor = Anchor {
            x: 20.0,
            y: 30.0,
            width: 100.0,
            height: 80.0,
            dpr: 2.0,
        };
        let flipped = webview_rect(anchor, bounds, true, 2.0);
        assert_eq!(
            flipped,
            NSRect::new(NSPoint::new(30.0, 50.0), NSSize::new(100.0, 80.0))
        );
        let unflipped = webview_rect(Anchor { dpr: 1.5, ..anchor }, bounds, false, 1.0);
        assert_eq!(
            unflipped,
            NSRect::new(NSPoint::new(40.0, 155.0), NSSize::new(150.0, 120.0))
        );
    }
}
