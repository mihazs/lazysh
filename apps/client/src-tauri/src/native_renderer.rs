//! The renderer host of a native terminal session (#2215, epic #1302): it draws what the core's
//! [`Session`] holds on a platform surface with the wgpu renderer. No platform code lives here: a
//! surface arrives as a [`Target`] (raw `raw-window-handle` handles, or an offscreen texture in
//! tests) with the generation its platform host counts, and goes away with [`Host::lost`].
//!
//! Each attached session has one thread that sleeps until something changes:
//!
//! * **Event driven.** The session's `changed` hook rings a [`Wake`]; the loop takes the frame,
//!   draws at most once per display refresh and blocks again. An idle screen costs no frame, a
//!   blinking cursor one row per phase.
//! * **Suspend.** [`Host::set_active`] with `false` stops drawing and tells the core nobody looks;
//!   with `true` the screen is drawn again from a snapshot, so what arrived meanwhile is shown.
//! * **Surface loss.** [`Host::lost`] destroys the renderer before it returns; the session lives on
//!   and [`Host::surface`] with a newer generation draws it again from a snapshot.
//! * **Device loss.** A lost GPU device is rebuilt and the screen redrawn from core state.
//! * **Overlay.** The selection the session holds (`Session::set_selection`, absolute rows, so it
//!   stays on its rows while the reader scrolls), and the text a keyboard is composing, drawn at
//!   the cursor.
//! * **Appearance.** [`Look`] is the user's preferences: the theme (the cursor's colour included),
//!   the font (the machine's fonts for the family list, and the renderer's bundled one, #1325), how
//!   bold text is coloured and the cursor a program that chose none gets, which the core puts in
//!   its frames. The cursor's shape and blink are otherwise the program's, frame by frame (#2218).
//!
//! Nothing in the app attaches a surface yet: the first caller is a platform surface (#1327).
#![cfg_attr(not(test), allow(dead_code))]

use lazysh_terminal_renderer_wgpu::{FontLibrary, Policy, Target, WgpuRenderer};
use lazysh_terminal_runtime::{
    Appearance, BlinkClock, BoldText, Cell, CellMetrics, CellStyle, CellWide, CursorDefault, Frame,
    FramePacer, Overlay, RenderError, Session, SessionError, TerminalRenderer, Theme,
    BLINK_HALF_PERIOD,
};
use std::sync::atomic::{AtomicBool, Ordering::AcqRel};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// How long to wait before trying again to rebuild a device that could not be rebuilt.
const RETRY: Duration = Duration::from_secs(1);
// shortcut: every display is drawn at 60 Hz at most (a window's own vsync paces faster ones);
// take the rate from the platform surface when one reports it.
const REFRESH_HZ: u32 = 60;

/// One clock for every session, so all cursors blink in the same phase.
static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);

fn now() -> Duration {
    EPOCH.elapsed()
}

fn blink() -> BlinkClock {
    BlinkClock::new(BLINK_HALF_PERIOD, Duration::ZERO)
}

/// The variable that lets a debug build on Android draw on a CPU rasterizer. The CI emulator has none other, and
/// the shipping policy refuses one: a device keeps xterm.js unless the native engine beats it, which software cannot.
#[cfg(all(debug_assertions, target_os = "android"))]
pub(crate) const SOFTWARE_GPU: &str = "LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU";

/// The adapter policy of the app's renderers and of its probe: the platform's shipping policy, with CPU rasterizers
/// allowed only in a debug build on Android whose process sets [`SOFTWARE_GPU`] (the instrumentation does, before it
/// drives the page). The variable is not compiled into any other build: `native-android-release-core` checks the
/// release library for its name.
pub(crate) fn policy() -> Policy {
    #[cfg(all(debug_assertions, target_os = "android"))]
    let software = std::env::var_os(SOFTWARE_GPU).is_some();
    #[cfg(not(all(debug_assertions, target_os = "android")))]
    let software = false;
    policy_for(software)
}

fn policy_for(software: bool) -> Policy {
    let policy = Policy::for_platform();
    if software {
        policy.with_software()
    } else {
        policy
    }
}

/// What the user's preferences say a terminal looks like.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Look {
    /// The theme's colours, the selection's and the cursor's included.
    pub theme: Theme,
    /// The preferences' CSS `font-family` list, preferred family first.
    pub font_family: String,
    /// Font size in CSS pixels.
    pub font_px: f32,
    /// Device pixels per CSS pixel.
    pub scale: f32,
    /// Draw glyphs with the machine's fonts for `font_family` and the renderer's bundled font.
    /// Without it glyphs are the reference renderer's dot patterns, which is what the tests that
    /// compare pixels with that renderer draw.
    pub system_fonts: bool,
    /// Bright bold and the bold colour.
    pub bold: BoldText,
    /// The cursor a program that chose none gets; `None` leaves the VT's own.
    pub cursor: Option<CursorDefault>,
    /// The fonts imported in Preferences that `font_family` names (#2223), registered ahead of the machine's.
    pub imported: Vec<crate::native_fonts::ImportedFont>,
}

/// The families of a CSS `font-family` list, preferred first, without their quotes.
pub(crate) fn families(list: &str) -> Vec<String> {
    list.split(',')
        .map(|family| family.trim().trim_matches(['\'', '"']).to_string())
        .filter(|family| !family.is_empty())
        .collect()
}

/// The cell the renderer draws, in device pixels, for a font of `font_px` CSS pixels on a display of `scale` device
/// pixels per CSS pixel: the grid of a pane is as many of these as its surface holds.
// shortcut: a cell is 0.6 x 1.2 of the font size and the renderer fits the font to it (one
// cell is the advance of `0`); take the cell from the font's own metrics when a font
// whose advance is not 0.6 em shows text of the wrong size.
pub(crate) fn cell_metrics(font_px: f32, scale: f32) -> Result<CellMetrics, RenderError> {
    let thirds = (font_px * scale * 3.0).round() as u32;
    CellMetrics::default().scaled(thirds, 40)
}

impl Look {
    pub(crate) fn appearance(&self) -> Result<Appearance, RenderError> {
        Ok(Appearance {
            metrics: cell_metrics(self.font_px, self.scale)?,
            font_families: families(&self.font_family),
            theme: self.theme,
            bold: self.bold,
        })
    }

    /// The fonts of `appearance`'s family list, the imported ones first; none keeps the reference dot patterns.
    fn fonts(&self, appearance: &Appearance) -> FontLibrary {
        let mut library = if self.system_fonts {
            FontLibrary::system(&appearance.font_families)
        } else {
            FontLibrary::new()
        };
        for font in &self.imported {
            // shortcut: bytes the page sent that cannot be read were refused when it sent them; one that fails here
            // (a font collection with no first font) is skipped and the family falls through to the others.
            let _ = font.register(&mut library);
        }
        library
    }
}

enum Message {
    /// The session's screen may have changed.
    Changed,
    /// A call of the [`Host`], run on the loop's thread.
    Run(Box<dyn FnOnce(&mut Loop) + Send>),
    Stop,
}

/// Rings the loop of a session's host. It is made before the session, whose
/// [`Hooks::changed`](lazysh_terminal_runtime::Hooks::changed) is [`Wake::hook`].
#[derive(Clone)]
pub(crate) struct Wake {
    /// A `Changed` is on its way and the loop has not taken the frame yet: a burst rings once.
    pending: Arc<AtomicBool>,
    to: Sender<Message>,
}

/// The receiving end of a [`Wake`], for [`Host::attach`].
pub(crate) struct Inbox(Receiver<Message>, Wake);

#[cfg(test)]
impl Inbox {
    /// Whether the loop was rung within `wait`, as taking the frame would acknowledge it.
    pub(crate) fn rang(&self, wait: Duration) -> bool {
        let rang = matches!(self.0.recv_timeout(wait), Ok(Message::Changed));
        self.1.pending.swap(false, AcqRel);
        rang
    }
}

pub(crate) fn wake() -> (Wake, Inbox) {
    let (to, from) = mpsc::channel();
    let wake = Wake {
        pending: Arc::default(),
        to,
    };
    (wake.clone(), Inbox(from, wake))
}

impl Wake {
    /// Never blocks: it runs on a VT worker.
    pub(crate) fn ring(&self) {
        if !self.pending.swap(true, AcqRel) {
            let _ = self.to.send(Message::Changed);
        }
    }

    pub(crate) fn hook(&self) -> Box<dyn Fn() + Send + Sync> {
        let wake = self.clone();
        Box::new(move || wake.ring())
    }
}

/// Why a frame was not drawn.
enum Trouble {
    /// The session is closed: there is nothing to draw any more.
    Closed,
    Render(RenderError),
}

impl From<SessionError> for Trouble {
    fn from(_: SessionError) -> Self {
        Self::Closed
    }
}

impl From<RenderError> for Trouble {
    fn from(error: RenderError) -> Self {
        Self::Render(error)
    }
}

/// The state of one session's host, owned by its thread.
struct Loop {
    session: Session,
    wake: Wake,
    /// `None` while the session has no surface.
    renderer: Option<WgpuRenderer>,
    generation: u32,
    active: bool,
    /// The renderer holds no usable copy of the screen: the next frame is a snapshot.
    stale: bool,
    /// Nothing is drawn before this instant: the renderer must be resumed first.
    retry: Option<Duration>,
    look: Look,
    composing: Option<String>,
    pacer: FramePacer,
}

impl Loop {
    fn run(mut self, inbox: Receiver<Message>) {
        'run: loop {
            let at = now();
            let message = match self.deadline(at) {
                None => inbox.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(due) => inbox.recv_timeout(due.saturating_sub(at)),
            };
            let mut next = match message {
                Ok(message) => Some(message),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            while let Some(message) = next {
                match message {
                    Message::Changed => {}
                    Message::Run(call) => call(&mut self),
                    Message::Stop => break 'run,
                }
                next = inbox.try_recv().ok();
            }
            self.step(now());
        }
        self.detach();
    }

    /// When the loop has something to do without being told: a frame to draw, a blink phase to
    /// change, a device to rebuild. `None` blocks until a message arrives.
    fn deadline(&self, at: Duration) -> Option<Duration> {
        let renderer = self.renderer.as_ref().filter(|_| self.active)?;
        if self.retry.is_some() {
            return self.retry;
        }
        let frame = self.pacer.next_frame(at, renderer.needs_draw());
        let phase = renderer
            .wants_blink_timer()
            .then(|| blink().next_toggle(at));
        [frame, phase].into_iter().flatten().min()
    }

    fn step(&mut self, at: Duration) {
        if !self.active || self.renderer.is_none() {
            return;
        }
        if let Some(due) = self.retry {
            if due > at || !self.recover(at) {
                return;
            }
        }
        for _ in 0..2 {
            match self.frame(at) {
                Ok(()) => return,
                Err(Trouble::Closed) => return self.suspend(),
                Err(Trouble::Render(RenderError::NeedsFullFrame)) => self.stale = true,
                Err(Trouble::Render(_)) => {
                    if !self.recover(at) {
                        return;
                    }
                }
            }
        }
        // A snapshot on a resumed renderer failed as well: do not spin on it.
        self.retry = Some(at + RETRY);
    }

    /// Bring the renderer back from a suspension or a lost device; the next frame is a snapshot.
    /// False when there is still no device: tried again after [`RETRY`].
    fn recover(&mut self, at: Duration) -> bool {
        self.stale = true;
        let resumed = self.renderer.as_mut().is_some_and(|r| r.resume().is_ok());
        self.retry = (!resumed).then_some(at + RETRY);
        resumed
    }

    /// Take what the core has, and draw when the display is due a frame.
    fn frame(&mut self, at: Duration) -> Result<(), Trouble> {
        let Some(renderer) = self.renderer.as_mut() else {
            return Ok(());
        };
        let changed = self.wake.pending.swap(false, AcqRel);
        // Composing text replaces cells of the cursor's row, so a row the core did not send again
        // could keep stale text: every frame is a snapshot while a keyboard composes.
        let frame = if self.stale || changed && self.composing.is_some() {
            Some(self.session.attach()?)
        } else if changed {
            self.session.take_frame()?
        } else {
            None
        };
        if let Some(mut frame) = frame {
            if let Some(text) = &self.composing {
                compose(&mut frame, text);
            }
            renderer.apply(&frame)?;
            self.stale = false;
        }
        renderer.set_overlay(Overlay {
            cursor_phase_on: blink().phase_on(at),
            selection: self.session.selection_overlay()?,
        })?;
        let due = self.pacer.next_frame(at, renderer.needs_draw());
        if due.is_some_and(|due| due <= at) {
            renderer.draw()?;
            renderer.present()?;
            self.pacer.drew(at);
        }
        Ok(())
    }

    fn suspend(&mut self) {
        if let Some(renderer) = &mut self.renderer {
            renderer.suspend();
        }
        self.session.detach();
        self.active = false;
    }

    fn set_active(&mut self, active: bool) {
        if active {
            self.active = true;
            // Resumed by the next step, which then draws a snapshot.
            self.retry = Some(Duration::ZERO);
        } else {
            self.suspend();
        }
    }

    fn detach(&mut self) {
        if let Some(mut renderer) = self.renderer.take() {
            renderer.destroy();
        }
        self.session.detach();
    }

    fn surface(&mut self, target: Target, generation: u32) -> Result<(), String> {
        if generation <= self.generation {
            return Err(format!(
                "Terminal surface {generation} is not newer than surface {}",
                self.generation
            ));
        }
        self.detach();
        let appearance = self.look.appearance().map_err(|e| e.to_string())?;
        let target = if self.look.system_fonts || !self.look.imported.is_empty() {
            target.with_fonts(self.look.fonts(&appearance))
        } else {
            target
        };
        let mut renderer = WgpuRenderer::create(target, appearance).map_err(|e| e.to_string())?;
        if !self.active {
            renderer.suspend();
        }
        (self.renderer, self.generation) = (Some(renderer), generation);
        (self.stale, self.retry) = (true, None);
        Ok(())
    }

    /// A change to the renderer; made again on a new device when the old one turns out lost, so
    /// the device that replaces it does not come back with the old size or appearance.
    fn change(
        &mut self,
        change: impl Fn(&mut WgpuRenderer) -> Result<(), RenderError>,
    ) -> Result<(), String> {
        let Some(renderer) = &mut self.renderer else {
            return Ok(());
        };
        let done = match change(renderer) {
            Err(RenderError::DeviceLost) => {
                self.stale = true;
                renderer.resume().and_then(|()| change(renderer))
            }
            done => done,
        };
        if !self.active {
            renderer.suspend();
        }
        done.map_err(|e| e.to_string())
    }

    fn set_look(&mut self, look: Look) -> Result<(), String> {
        let appearance = look.appearance().map_err(|e| e.to_string())?;
        // Another family list names other files: read them again.
        let fonts = (look.font_family != self.look.font_family
            || look.system_fonts != self.look.system_fonts
            || look.imported != self.look.imported)
            .then(|| look.fonts(&appearance));
        self.change(|renderer| {
            renderer.set_appearance(appearance.clone())?;
            fonts
                .clone()
                .map_or(Ok(()), |fonts| renderer.set_fonts(fonts))
        })?;
        // The core draws the default cursor into its frames, so a new one needs the screen again from a snapshot.
        if look.cursor != self.look.cursor {
            let _ = self
                .session
                .with(|runtime| runtime.set_cursor_default(look.cursor));
            self.stale = true;
        }
        self.look = look;
        Ok(())
    }
}

/// Draw `text` underlined from the cursor to the end of its row at most, and put the cursor after
/// it: what a keyboard is composing has not been sent, so the core does not hold it.
fn compose(frame: &mut Frame, text: &str) {
    let Some(at) = frame.cursor.viewport.as_mut() else {
        return;
    };
    let Some(row) = frame.dirty.iter_mut().find(|row| row.y == at.y) else {
        return;
    };
    let cell = |text: &str, wide| Cell {
        text: text.into(),
        wide,
        fg: None,
        bg: None,
        style: CellStyle {
            underlined: true,
            underline: 1,
            ..CellStyle::default()
        },
    };
    let cols = row.cells.len();
    let start = usize::from(at.x).saturating_sub(usize::from(at.wide_tail));
    let mut x = start;
    for cluster in text.graphemes(true) {
        let width = cluster.width().min(2);
        if width == 0 {
            continue;
        }
        if x + width > cols {
            break;
        }
        if width == 2 {
            row.cells[x] = cell(cluster, CellWide::Wide);
            row.cells[x + 1] = cell("", CellWide::SpacerTail);
        } else {
            row.cells[x] = cell(cluster, CellWide::Narrow);
        }
        x += width;
    }
    // A wide character the text covered half of is not drawn at all.
    if let Some(cut) = row.cells.get_mut(x).filter(|_| x > start) {
        if cut.wide == CellWide::SpacerTail {
            *cut = Cell {
                style: CellStyle::default(),
                ..cell("", CellWide::Narrow)
            };
        }
    }
    (at.x, at.wide_tail) = (x.min(cols.saturating_sub(1)) as u16, false);
}

/// The renderer of one session, from its first surface until it is dropped.
pub(crate) struct Host {
    wake: Wake,
    thread: Option<JoinHandle<()>>,
}

impl Host {
    /// Draw `session` on `surface`, the `generation`-th surface its platform host gave it (from 1).
    /// The session's `changed` hook must be the [`Wake::hook`] of `inbox`. An error (no usable GPU,
    /// a surface no backend can draw on) leaves nothing running: the caller keeps its fallback.
    pub(crate) fn attach(
        session: Session,
        inbox: Inbox,
        surface: Target,
        generation: u32,
        look: Look,
    ) -> Result<Self, String> {
        let Inbox(from, wake) = inbox;
        // A closed session fails the first surface just below, so there is nothing to tell.
        let _ = session.with(|runtime| runtime.set_cursor_default(look.cursor));
        let state = Loop {
            session,
            wake: wake.clone(),
            renderer: None,
            generation: 0,
            active: true,
            stale: true,
            retry: None,
            look,
            composing: None,
            pacer: FramePacer::new(REFRESH_HZ),
        };
        let thread = std::thread::Builder::new()
            .name("lazysh-terminal-renderer".into())
            .spawn(move || state.run(from))
            .map_err(|error| error.to_string())?;
        let host = Self {
            wake,
            thread: Some(thread),
        };
        host.surface(surface, generation)?;
        Ok(host)
    }

    /// Run `call` on the loop's thread and wait for its answer; the loop then draws what changed.
    fn ask<R: Send + 'static>(
        &self,
        call: impl FnOnce(&mut Loop) -> R + Send + 'static,
    ) -> Result<R, String> {
        let (answer, answered) = mpsc::sync_channel(1);
        let run = Message::Run(Box::new(move |state| {
            let _ = answer.send(call(state));
        }));
        let gone = || "The terminal renderer stopped".to_string();
        self.wake.to.send(run).map_err(|_| gone())?;
        answered.recv().map_err(|_| gone())
    }

    /// The session got a new surface: draw it again from a snapshot. A generation that is not
    /// newer than the current one is refused, so a late callback cannot bring an old surface back.
    pub(crate) fn surface(&self, surface: Target, generation: u32) -> Result<(), String> {
        self.ask(move |state| state.surface(surface, generation))?
    }

    /// The platform takes surface `generation` back. The renderer is destroyed before this returns;
    /// a generation other than the current one changes nothing.
    pub(crate) fn lost(&self, generation: u32) -> Result<(), String> {
        self.ask(move |state| {
            if generation == state.generation {
                state.detach();
            }
        })
    }

    /// The surface's size in device pixels changed; its generation did not.
    pub(crate) fn resize(&self, width: u32, height: u32) -> Result<(), String> {
        self.ask(move |state| state.change(|renderer| renderer.resize(width, height)))?
    }

    /// Whether anyone looks at the surface. While nobody does, nothing is drawn and the core is
    /// told so; the session keeps parsing.
    pub(crate) fn set_active(&self, active: bool) -> Result<(), String> {
        self.ask(move |state| state.set_active(active))
    }

    /// The text a keyboard is composing, drawn underlined at the cursor; `None` when it ends.
    pub(crate) fn set_composing(&self, text: Option<String>) -> Result<(), String> {
        self.ask(move |state| {
            state.composing = text.filter(|text| !text.is_empty());
            state.stale = true;
        })
    }

    /// The preferences changed: theme, font or display scale.
    pub(crate) fn set_look(&self, look: Look) -> Result<(), String> {
        self.ask(move |state| state.set_look(look))?
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.wake.to.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
