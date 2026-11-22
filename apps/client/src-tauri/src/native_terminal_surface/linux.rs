//! The Linux surface a native terminal draws on (#1331): one `wl_subsurface` per session, a child of the
//! toplevel `wl_surface` GDK owns, stacked below the transparent web view at a DOM anchor. Wayland only: on
//! X11 and Xwayland a child window would cover the page, so the host refuses and the probe says why
//! (docs/architecture/linux-surface-composition-poc.md). A surface of a session that has a native core is drawn
//! by the renderer host with a wgpu swapchain on the subsurface (#1331); any other shows the pane background
//! from a `wl_shm` buffer. Everything but [`display`] runs on the GTK main thread.
use super::panes::look;
use super::{Anchor, SurfaceState};
use crate::native_renderer::{Host as Renderer, Look};
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;
use lazysh_terminal_renderer_wgpu::{Policy, Target, Window};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::os::fd::{AsFd, FromRawFd};
use std::ptr::NonNull;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use wayland_backend::client::{Backend, ObjectId};
use wayland_client::globals::registry_queue_init;
use wayland_client::protocol::wl_buffer::WlBuffer;
use wayland_client::protocol::wl_compositor::WlCompositor;
use wayland_client::protocol::wl_shm::{Format, WlShm};
use wayland_client::protocol::wl_shm_pool::WlShmPool;
use wayland_client::protocol::wl_subcompositor::WlSubcompositor;
use wayland_client::protocol::wl_subsurface::WlSubsurface;
use wayland_client::protocol::wl_surface::WlSurface;
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle};

/// More panes than a window shows; a page that asks for more is broken.
const MAX_SESSIONS: usize = 64;

extern "C" {
    // Both are exported by libgdk-3, which GTK already links.
    fn gdk_wayland_window_get_wl_surface(window: *mut gdk::ffi::GdkWindow)
        -> *mut std::ffi::c_void;
    fn gdk_wayland_display_get_wl_display(
        display: *mut gdk::ffi::GdkDisplay,
    ) -> *mut std::ffi::c_void;
}

/// The GDK display type of the app, e.g. `GdkWaylandDisplay`: what the window is really on, whatever the
/// session says (`GDK_BACKEND=x11` in a Wayland session is X11).
static DISPLAY: OnceLock<String> = OnceLock::new();

/// Remembers the display type for the probe, which runs off the main thread. Call it on the main thread.
pub(crate) fn record_display() {
    if let Some(display) = gdk::Display::default() {
        let _ = DISPLAY.set(display.type_().name().to_owned());
    }
}

/// Whether a native surface can compose below the page on the app's display, or why not.
pub(crate) fn display() -> Result<(), String> {
    wayland(DISPLAY.get().map(String::as_str))
}

fn wayland(display: Option<&str>) -> Result<(), String> {
    match display {
        Some("GdkWaylandDisplay") => Ok(()),
        Some(other) => Err(format!(
            "the window is on {other}, and a native surface composes below the page on Wayland only (on X11 and Xwayland it would cover the page's menus)"
        )),
        None => Err("the app window does not exist yet".into()),
    }
}

/// A GPU, or with `LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU` set a CPU rasterizer too: the CI runner has no GPU and
/// the composition harness draws on Mesa's lavapipe. The shipping policy (the probe's) never allows one.
fn policy() -> Policy {
    let policy = Policy::for_platform();
    if std::env::var_os("LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU").is_some() {
        policy.with_software()
    } else {
        policy
    }
}

/// No event of these objects matters to the host: buffers are replaced, never reused.
struct Quiet;

impl<I: Proxy + 'static, U> Dispatch<I, U> for Quiet {
    fn event(_: &mut Self, _: &I, _: I::Event, _: &U, _: &Connection, _: &QueueHandle<Self>) {}
}

struct Pane {
    /// The session the pane shows, whose look the renderer takes.
    session: String,
    surface: WlSurface,
    child: WlSubsurface,
    anchor: Anchor,
    background: u32,
    /// The renderer host that draws the session's screen, once one is attached. While it is, the surface's
    /// buffers are the swapchain's and the host fills none.
    renderer: Option<Renderer>,
    /// The surface's size in device pixels, as of the last `show`.
    size: (i32, i32),
    /// The look the renderer was given.
    looked: Look,
    /// The attached buffer with the width, height and colour it was filled for.
    shown: Option<(WlBuffer, WlShmPool, (i32, i32, u32))>,
}

impl Pane {
    /// The renderer draws with the look the session has now (its preferences, this display's ratio and the pane's
    /// background) if that is not the one it was given.
    fn relook(&mut self) {
        let wanted = look(&self.session, self.anchor.dpr as f32, self.background);
        if let Some(renderer) = self.renderer.as_ref().filter(|_| self.looked != wanted) {
            let _ = renderer.set_look(wanted.clone());
            self.looked = wanted;
        }
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        // The swapchain goes before the surface it presents on.
        drop(self.renderer.take());
        self.child.destroy();
        self.surface.destroy();
        if let Some((buffer, pool, _)) = self.shown.take() {
            buffer.destroy();
            pool.destroy();
        }
    }
}

struct Host {
    connection: Connection,
    queue: EventQueue<Quiet>,
    handle: QueueHandle<Quiet>,
    compositor: WlCompositor,
    subcompositor: WlSubcompositor,
    shm: WlShm,
    parent: WlSurface,
    toplevel: gtk::ApplicationWindow,
    /// The widget the anchor is measured in: the web view, which GTK's own title bar and shadow push away
    /// from the origin of the toplevel's `wl_surface`.
    page: gtk::Widget,
    panes: HashMap<String, Pane>,
}

thread_local! {
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

fn text(error: impl std::fmt::Display) -> String {
    format!("The native terminal surface is unavailable: {error}")
}

impl Host {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| text("the app window is gone"))?;
        let toplevel = window.gtk_window().map_err(text)?;
        let gdk_window = toplevel
            .window()
            .ok_or_else(|| text("the app window is not shown"))?;
        let gdk_display = gdk_window.display();
        wayland(Some(gdk_display.type_().name())).map_err(text)?;
        // SAFETY: both objects are live GDK Wayland objects (checked above) and are only read.
        let (display, parent) = unsafe {
            (
                gdk_wayland_display_get_wl_display(gdk_display.to_glib_none().0),
                gdk_wayland_window_get_wl_surface(gdk_window.to_glib_none().0),
            )
        };
        if display.is_null() || parent.is_null() {
            return Err(text("the app window has no Wayland surface"));
        }
        // SAFETY: `display` is GDK's connection, which lives as long as the process; wayland-client gives the
        // objects made here a queue of their own, so GDK's dispatch never sees them.
        let connection =
            Connection::from_backend(unsafe { Backend::from_foreign_display(display.cast()) });
        // SAFETY: `parent` is the toplevel's `wl_surface` on that connection; the host is dropped when the
        // window is unmapped or destroyed (below), which is when GDK destroys it.
        let parent = unsafe { ObjectId::from_ptr(WlSurface::interface(), parent.cast()) }
            .and_then(|id| WlSurface::from_id(&connection, id))
            .map_err(text)?;
        let (globals, queue) = registry_queue_init::<Quiet>(&connection).map_err(text)?;
        let handle = queue.handle();
        let vbox = window.default_vbox().map_err(text)?;
        let page = vbox
            .children()
            .into_iter()
            .find(|child| child.type_().name() == "WebKitWebView")
            .unwrap_or_else(|| vbox.upcast());
        Ok(Self {
            // `damage_buffer` needs version 4 of the compositor.
            compositor: globals.bind(&handle, 4..=6, ()).map_err(text)?,
            subcompositor: globals.bind(&handle, 1..=1, ()).map_err(text)?,
            shm: globals.bind(&handle, 1..=1, ()).map_err(text)?,
            connection,
            queue,
            handle,
            parent,
            toplevel,
            page,
            panes: HashMap::new(),
        })
    }

    /// Follows what moves a surface without the page seeing it. The handlers reach whatever host there is
    /// at the time, so one set serves the window for the life of the process.
    fn watch(&self) {
        static WATCHED: std::sync::Once = std::sync::Once::new();
        WATCHED.call_once(|| {
            // The web view's offset in the toplevel changes with its allocation (tiling, maximizing, GTK's
            // own title bar), and the buffer with the scale.
            self.page.connect_size_allocate(|_, _| again());
            self.toplevel.connect_scale_factor_notify(|_| again());
            // GDK destroys the toplevel's `wl_surface` when the window is unmapped, and the host with it.
            // shortcut: the page is not told, so a pane would stay empty once the window is shown again;
            // the app never hides its window. Place the panes again on `map` if it ever does.
            self.toplevel.connect_unmap(|_| forget());
            self.toplevel.connect_destroy(|_| forget());
        });
    }

    fn place(
        &mut self,
        session: String,
        anchor: Anchor,
        background: u32,
    ) -> Result<SurfaceState, String> {
        let mut pane = match self.panes.remove(&session) {
            Some(pane) => pane,
            None if self.panes.len() >= MAX_SESSIONS => return Err(text("too many surfaces")),
            None => {
                let surface = self.compositor.create_surface(&self.handle, ());
                let child =
                    self.subcompositor
                        .get_subsurface(&surface, &self.parent, &self.handle, ());
                child.set_desync();
                child.place_below(&self.parent);
                // An empty input region: pointer and touch go to the page, which owns every gesture.
                let nothing = self.compositor.create_region(&self.handle, ());
                surface.set_input_region(Some(&nothing));
                nothing.destroy();
                Pane {
                    session: session.clone(),
                    surface,
                    child,
                    anchor,
                    background,
                    renderer: None,
                    size: (0, 0),
                    looked: look(&session, anchor.dpr as f32, background),
                    shown: None,
                }
            }
        };
        (pane.anchor, pane.background) = (anchor, background);
        let shown = self.show(&mut pane);
        if shown.is_ok() {
            self.draw(&session, &mut pane);
        }
        match shown {
            Ok(_) => drop(self.panes.insert(session, pane)),
            // A pane that cannot be shown is not kept: its surface goes with the parent's next commit.
            Err(_) => {
                drop(pane);
                self.settle();
            }
        }
        shown
    }

    /// Positions the pane at its anchor and fills it, with the scale and the web view's offset of this moment.
    fn show(&mut self, pane: &mut Pane) -> Result<SurfaceState, String> {
        // GTK 3 knows integer scales only; a fractional output scale reaches it rounded up, as for the page.
        let scale = self.toplevel.scale_factor().max(1);
        let (dx, dy) = self
            .page
            .translate_coordinates(&self.toplevel, 0, 0)
            .unwrap_or((0, 0));
        // CSS pixels times the page's ratio are device pixels; a surface is positioned in logical pixels.
        let Anchor {
            x,
            y,
            width,
            height,
            dpr,
        } = pane.anchor;
        let logical = |css: f64| (css * dpr / f64::from(scale)).round() as i32;
        let (left, top) = (logical(x), logical(y));
        // A buffer must be a whole multiple of its scale.
        let (w, h) = (
            (logical(x + width) - left).max(1) * scale,
            (logical(y + height) - top).max(1) * scale,
        );
        pane.size = (w, h);
        pane.surface.set_buffer_scale(scale);
        pane.child.set_position(left + dx, top + dy);
        if let Some(renderer) = &pane.renderer {
            // The swapchain is the size of the surface in device pixels.
            let _ = renderer.resize(w as u32, h as u32);
            pane.relook();
            pane.surface.commit();
            self.settle();
            return Ok(SurfaceState {
                placed: true,
                ready: true,
                generation: 1,
                width: w as u32,
                height: h as u32,
            });
        }
        let wanted = (w, h, pane.background);
        if pane.shown.as_ref().map(|shown| shown.2) != Some(wanted) {
            let (buffer, pool) = self.filled(w, h, pane.background)?;
            pane.surface.attach(Some(&buffer), 0, 0);
            pane.surface.damage_buffer(0, 0, w, h);
            pane.surface.commit();
            // The compositor holds the new buffer from that commit on, so the old one can go.
            if let Some((old, old_pool, _)) = pane.shown.replace((buffer, pool, wanted)) {
                old.destroy();
                old_pool.destroy();
            }
        } else {
            pane.surface.commit();
        }
        self.settle();
        Ok(SurfaceState {
            placed: true,
            ready: true,
            generation: 1,
            width: w as u32,
            height: h as u32,
        })
    }

    /// Hands the pane's surface to the renderer host when its session has a native core: GDK's `wl_display`
    /// and the subsurface's `wl_surface` as raw handles, the surface's size in device pixels. A session
    /// without a core, or a device that cannot draw, keeps the background fill.
    fn draw(&mut self, session: &str, pane: &mut Pane) {
        if pane.renderer.is_some() {
            return;
        }
        let Some((surface, inbox)) = crate::terminal_core::live(session)
            .ok()
            .and_then(|core| core.drawing())
        else {
            return;
        };
        let handles = (
            NonNull::new(self.connection.backend().display_ptr().cast()),
            NonNull::new(pane.surface.id().as_ptr().cast()),
        );
        let (Some(display), Some(wl_surface)) = handles else {
            return;
        };
        // SAFETY: both are live objects of GDK's connection; the renderer is destroyed before the pane's
        // surface (`Pane::drop`), which is destroyed before the window's.
        let window = unsafe { Window::wayland(display, wl_surface) };
        let (w, h) = (pane.size.0 as u32, pane.size.1 as u32);
        let target = Target::on_window(window, w, h).with_policy(policy());
        let look = look(session, pane.anchor.dpr as f32, pane.background);
        match Renderer::attach(surface, inbox, target, 1, look.clone()) {
            Ok(renderer) => {
                pane.renderer = Some(renderer);
                pane.looked = look;
            }
            Err(error) => eprintln!("native terminal renderer: {error}"),
        }
    }

    // shortcut: a full buffer of one colour per size (33 MiB for a 4K pane), rewritten on every resize; the
    // renderer's swapchain replaces it when it attaches to the surface.
    fn filled(&self, w: i32, h: i32, rgb: u32) -> Result<(WlBuffer, WlShmPool), String> {
        // SAFETY: a new anonymous file from a constant name; the descriptor is owned by `file` at once.
        let fd =
            unsafe { libc::memfd_create(c"lazysh-terminal-surface".as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 {
            return Err(text(std::io::Error::last_os_error()));
        }
        // SAFETY: `fd` is a descriptor this function just opened and nothing else holds.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let row = (0xff00_0000 | rgb).to_ne_bytes().repeat(w as usize);
        for _ in 0..h {
            file.write_all(&row).map_err(text)?;
        }
        // The anchor is bounded to 16 384 pixels a side, so the size fits.
        let pool = self
            .shm
            .create_pool(file.as_fd(), w * h * 4, &self.handle, ());
        let buffer = pool.create_buffer(0, w, h, w * 4, Format::Argb8888, &self.handle, ());
        Ok((buffer, pool))
    }

    /// A subsurface's position, order and removal take effect with the parent's next commit, so GTK is asked
    /// to draw the toplevel again; then the requests leave.
    fn settle(&mut self) {
        if let Some(window) = self.toplevel.window() {
            window.invalidate_rect(None, true);
        }
        let _ = self.connection.flush();
        let _ = self.queue.dispatch_pending(&mut Quiet);
    }

    fn state(&self, session: &str) -> Option<SurfaceState> {
        let (w, h) = self.panes.get(session)?.size;
        Some(SurfaceState {
            placed: true,
            ready: true,
            generation: 1,
            width: w as u32,
            height: h as u32,
        })
    }
}

/// Shows every pane again where the web view is now. A signal can arrive while a command holds the host;
/// that command settles the same state itself.
fn again() {
    HOST.with(|host| {
        let Ok(mut slot) = host.try_borrow_mut() else {
            return;
        };
        let Some(host) = slot.as_mut() else { return };
        let mut panes = std::mem::take(&mut host.panes);
        for pane in panes.values_mut() {
            let _ = host.show(pane);
        }
        host.panes = panes;
    });
}

fn forget() {
    HOST.with(|host| {
        if let Ok(mut slot) = host.try_borrow_mut() {
            *slot = None;
        }
    });
}

/// Runs `work` on the GTK main thread and waits for its answer.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (answer, asked) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = answer.send(work(&handle));
    })
    .map_err(text)?;
    asked.await.map_err(text)?
}

pub(super) async fn place(
    app: &AppHandle,
    session: String,
    anchor: Anchor,
    background: u32,
) -> Result<SurfaceState, String> {
    on_main(app, move |app| {
        HOST.with_borrow_mut(|slot| {
            let host = match slot {
                Some(host) => host,
                None => {
                    let host = slot.insert(Host::new(app)?);
                    host.watch();
                    host
                }
            };
            host.place(session, anchor, background)
        })
    })
    .await
}

/// The session's preferences changed: its pane's renderer takes them.
pub(super) async fn relook(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move |_| {
        HOST.with_borrow_mut(|slot| {
            if let Some(pane) = slot.as_mut().and_then(|host| host.panes.get_mut(&session)) {
                pane.relook();
            }
        });
        Ok(())
    })
    .await
}

pub(super) async fn remove(app: &AppHandle, session: String) -> Result<(), String> {
    on_main(app, move |_| {
        HOST.with_borrow_mut(|slot| {
            if let Some(host) = slot {
                if host.panes.remove(&session).is_some() {
                    host.settle();
                }
            }
        });
        Ok(())
    })
    .await
}

pub(super) async fn state(app: &AppHandle, session: String) -> Result<SurfaceState, String> {
    on_main(app, move |_| {
        let placed = HOST.with_borrow(|slot| slot.as_ref().and_then(|host| host.state(&session)));
        Ok(placed.unwrap_or(SurfaceState {
            placed: false,
            ready: false,
            generation: 0,
            width: 0,
            height: 0,
        }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_wayland_display_may_host_a_surface_and_a_refusal_names_the_display() {
        assert_eq!(wayland(Some("GdkWaylandDisplay")), Ok(()));
        let x11 = wayland(Some("GdkX11Display")).unwrap_err();
        assert!(
            x11.contains("GdkX11Display") && x11.contains("Wayland only"),
            "{x11}"
        );
        assert!(wayland(Some("GdkBroadwayDisplay")).is_err());
        // No window, no answer yet: a test process never has one, and the probe must not offer native then.
        assert!(wayland(None).is_err());
        assert!(display().is_err());
    }
}
