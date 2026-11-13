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

mod frame;
mod hub;
mod ingress;
mod input;
pub mod layout;
mod mosh;
mod reference;
mod render;
mod runtime;
mod size;

pub use frame::{Cell, Frame, Row};
pub use hub::{
    Hooks, Hub, HubConfig, HubError, Origin, PtyWriter, Refused, Session, SessionError, Stats,
};
pub use ingress::{Ingress, IngressHandle, Offer};
pub use input::{KeyInput, MouseInput};
pub use mosh::{DisplayFailure, MAX_COLS, MAX_FRAME_CELLS, MAX_ROWS};
pub use reference::{Image, ReferenceRenderer};
pub use render::{
    Appearance, CellMetrics, DrawPlan, Overlay, RenderError, RenderStats, RendererCore, Resume,
    Screen, Selection, SelectionKind, TerminalRenderer, Theme,
};
pub use runtime::{
    Config, Error, Events, Geometry, Modes, TerminalRuntime, Viewport, MAX_READ_ROWS,
};
pub use size::{Size, SizeAuthority, SizeOutcome, MAX_CELLS};

// Re-exported so consumers never depend on the binding crate (or a second VT engine) directly.
pub use ghostty_vt::{
    ffi, ActiveScreen, CellStyle, CellWide, CursorVisualStyle, RenderCursor, RgbColor,
};
