//! Shared terminal runtime (#1313): one authoritative VT state per session, independent of any
//! renderer, UI toolkit or transport. Not wired into the app yet.
//!
//! Data flow: transport bytes -> [`Ingress`] (bounded, ordered, credits) -> libghostty-vt ->
//! [`Frame`] (dirty rows) for a renderer, and [`TerminalRuntime::take_replies`] back to the
//! transport. UI size requests and transport-authoritative sizes are separate inputs
//! ([`SizeAuthority`]); the runtime never invents one from the other.
//!
//! Rendering is behind [`TerminalRenderer`] (#1322): [`Frame`]s in, pixels on an opaque surface out,
//! with a deterministic CPU [`ReferenceRenderer`] for golden-image tests.

mod blink;
mod clipboard;
mod colors;
mod cursor;
mod doorbell;
mod frame;
mod hub;
mod ingress;
mod input;
mod keymap;
pub mod layout;
mod links;
mod mosh;
mod reference;
mod render;
mod runtime;
mod selection;
mod size;
mod titles;

pub use blink::{BlinkClock, FramePacer, BLINK_HALF_PERIOD};
pub use clipboard::{clipboard_consent_text, MAX_CLIPBOARD_TEXT_BYTES};
pub use doorbell::Doorbell;
pub use frame::{Cell, CursorDefault, Frame, Row};
pub use hub::{
    Hooks, Hub, HubConfig, HubError, Origin, PtyWriter, Refused, Session, SessionError, Stats,
};
pub use ingress::{Ingress, IngressHandle, Offer};
pub use input::{KeyInput, MouseInput};
pub use keymap::{dom_mods, DomKey};
pub use links::{LinkHit, PathLink, UrlLink};
pub use mosh::{DisplayFailure, MAX_COLS, MAX_FRAME_CELLS, MAX_ROWS};
pub use reference::{Image, ReferenceRenderer};
pub use render::{
    Appearance, BoldText, CellMetrics, DrawPlan, Overlay, RenderError, RenderStats, RendererCore,
    Resume, Screen, Selection, SelectionKind, TerminalRenderer, Theme,
};
pub use runtime::{
    control_window, scrollback_bytes_for_lines, Config, ControlAnswer, ControlCursor, ControlEvent,
    ControlModes, ControlQuery, ControlSnapshot, ControlState, Error, Events, Geometry, Modes,
    MouseTracking, RowWindow, ScrollAction, TerminalRuntime, Viewport, CONTROL_WINDOW_DEFAULT,
    CONTROL_WINDOW_MAX, MAX_READ_ROWS,
};
pub use selection::{CellPos, CellRange, Direction, SearchHit, MAX_QUERY_BYTES};
pub use size::{Size, SizeAuthority, SizeOutcome, MAX_CELLS};

// Re-exported so consumers never depend on the binding crate (or a second VT engine) directly.
pub use ghostty_vt::{
    default_palette, ffi, ActiveScreen, CellColor, CellStyle, CellWide, CursorVisualStyle,
    RenderCursor, RgbColor,
};
