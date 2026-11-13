use crate::runtime::Error;
use ghostty_vt::{ffi, KeyEncoder, KeyEvent, MouseEncoder, MouseEvent, Terminal};

/// A key or committed text. Text-only commits (IME, soft keyboard) use `GHOSTTY_KEY_UNIDENTIFIED`.
#[derive(Debug, Clone)]
pub struct KeyInput {
    pub key: ffi::GhosttyKey,
    pub mods: u16,
    pub text: Option<String>,
    /// Pre-edit text still being composed: encodes to nothing so it can never be committed twice.
    pub composing: bool,
    pub release: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct MouseInput {
    pub action: ffi::GhosttyMouseAction,
    pub button: Option<ffi::GhosttyMouseButton>,
    pub mods: u16,
    /// Surface pixels, origin top-left.
    pub x: f32,
    pub y: f32,
}

/// The binding marks `KeyEncoder` and `Terminal` `Send` but omits `MouseEncoder`, which would make
/// every runtime `!Send` and block moving sessions to a VT worker. The handle is an
/// allocator-owned struct of options plus the last reported cell, with no thread affinity
/// (libghostty-vt's archive has no thread-local sections), exactly like `KeyEncoder`.
struct MouseHandle(MouseEncoder);

// SAFETY: moved between threads, never shared: `Encoders` is only reachable through `&mut`.
unsafe impl Send for MouseHandle {}

pub(crate) struct Encoders {
    key: KeyEncoder,
    mouse: MouseHandle,
}

impl Encoders {
    pub(crate) fn new() -> Result<Self, Error> {
        Ok(Self {
            key: KeyEncoder::new()?,
            mouse: MouseHandle(MouseEncoder::new()?),
        })
    }

    pub(crate) fn key(&mut self, terminal: &Terminal, input: &KeyInput) -> Result<Vec<u8>, Error> {
        let mut event = KeyEvent::new()?;
        event.set_action(if input.release {
            ffi::GhosttyKeyAction_GHOSTTY_KEY_ACTION_RELEASE
        } else {
            ffi::GhosttyKeyAction_GHOSTTY_KEY_ACTION_PRESS
        });
        event.set_key(input.key);
        event.set_mods(input.mods);
        event.set_composing(input.composing);
        if let Some(text) = &input.text {
            event.set_utf8(text);
        }
        self.key.set_from_terminal(terminal);
        Ok(self.key.encode(&event)?)
    }

    pub(crate) fn mouse(
        &mut self,
        terminal: &Terminal,
        surface: (u32, u32),
        cell: (u32, u32),
        input: MouseInput,
    ) -> Result<Vec<u8>, Error> {
        let mut event = MouseEvent::new()?;
        event.set_action(input.action);
        match input.button {
            Some(button) => event.set_button(button),
            None => event.clear_button(),
        }
        event.set_mods(input.mods);
        event.set_position(input.x, input.y);
        self.mouse.0.set_from_terminal(terminal);
        self.mouse.0.set_size(surface.0, surface.1, cell.0, cell.1);
        Ok(self.mouse.0.encode(&event)?)
    }
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// Bytes to send for pasted text. Bracketed mode strips any embedded end marker (it would let
/// pasted text escape the bracket and run as typed input); otherwise LF becomes CR like xterm.
pub(crate) fn paste(text: &str, bracketed: bool) -> Vec<u8> {
    if !bracketed {
        return text.replace("\r\n", "\r").replace('\n', "\r").into_bytes();
    }
    let mut body = text.as_bytes().to_vec();
    while let Some(at) = body.windows(PASTE_END.len()).position(|w| w == PASTE_END) {
        body.drain(at..at + PASTE_END.len());
    }
    [PASTE_START, &body, PASTE_END].concat()
}
