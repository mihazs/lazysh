use crate::runtime::Error;
use ghostty_vt::{
    ffi, KeyEncoder, KeyEvent, MouseEncoder, MouseEvent, Terminal, MOD_ALT, MOD_CTRL, MOD_SHIFT,
    MOD_SUPER,
};

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
        if input.key == ffi::GhosttyKey_GHOSTTY_KEY_UNIDENTIFIED {
            // Committed text (IME, soft keyboard) names no key, so no protocol can describe it: the
            // encoder turned a keyboard "\r" into CSI 13u under Kitty flags, which a menu expecting
            // Enter's CR (#1043) did not take. A pre-edit or a release sends nothing.
            let text = input
                .text
                .as_deref()
                .filter(|_| !input.composing && !input.release);
            return Ok(text.map_or_else(Vec::new, |text| text.as_bytes().to_vec()));
        }
        // Kitty keyboard flags or modifyOtherKeys: the program asked for the protocol forms.
        let protocol =
            terminal.kitty_keyboard_flags()? != 0 || terminal.modify_other_keys_enabled()?;
        if !protocol {
            if let Some(bytes) = legacy_bytes(input) {
                return Ok(bytes.to_vec());
            }
        }
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
            // Without the key's unshifted character the encoder cannot name the key in the Kitty
            // protocol (Ctrl+C came out as plain "c"), and it must know Shift made the text.
            if let Some(unshifted) = unshifted_codepoint(input) {
                event.set_unshifted_codepoint(unshifted);
            }
            event.set_consumed_mods(input.mods & MOD_SHIFT);
        }
        self.key.set_from_terminal(terminal);
        let bytes = self.key.encode(&event)?;
        // A program that never asked for a protocol cannot read its escape codes: a shell would print
        // them as junk, and xterm.js sends nothing for these chords either.
        Ok(if !protocol && is_protocol_form(&bytes) {
            Vec::new()
        } else {
            bytes
        })
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

/// libghostty-vt encodes some chords in a keyboard-protocol form (`CSI 27;<mods>;<code>~` for modified
/// Enter, Tab and Escape, `CSI <code>;<mods>u` for Ctrl+[ or Ctrl+-) even when the program never asked
/// for one. While neither Kitty keyboard flags nor modifyOtherKeys is enabled the caller sends what
/// xterm.js sends for the keys below, with one deliberate exception, Shift+Enter: xterm.js sends CR, so
/// an agent TUI would submit instead of inserting a newline (#805), and lazysh has always sent
/// `CSI 13;2u` for it (Codex, OpenCode and Claude Code read that form). Printable keys with the Super key send nothing and other chords the
/// encoder answers with a protocol form are dropped by [`is_protocol_form`]. `None` leaves the key to the encoder.
fn legacy_bytes(input: &KeyInput) -> Option<&'static [u8]> {
    if input.release || input.composing {
        return None;
    }
    let modifiers = input.mods & (MOD_SHIFT | MOD_CTRL | MOD_ALT | MOD_SUPER);
    Some(match (input.key, modifiers) {
        (ffi::GhosttyKey_GHOSTTY_KEY_ENTER, MOD_SHIFT) => b"\x1b[13;2u",
        (ffi::GhosttyKey_GHOSTTY_KEY_ENTER, m) if m != 0 && m & MOD_ALT == 0 => b"\r",
        (ffi::GhosttyKey_GHOSTTY_KEY_TAB, MOD_CTRL) => b"\t",
        (ffi::GhosttyKey_GHOSTTY_KEY_TAB, m) if m & MOD_SHIFT != 0 && m & MOD_SUPER == 0 => {
            b"\x1b[Z"
        }
        (ffi::GhosttyKey_GHOSTTY_KEY_ESCAPE, m) if m != 0 && m & MOD_ALT == 0 => b"\x1b",
        (ffi::GhosttyKey_GHOSTTY_KEY_BRACKET_LEFT, MOD_CTRL) => b"\x1b",
        // Cmd or the Meta key is the host's shortcut modifier; typing the text would insert "c" for Cmd+C.
        (_, m) if m & MOD_SUPER != 0 && input.text.is_some() => b"",
        _ => return None,
    })
}

/// `CSI <numbers> u` (Kitty) and `CSI 27;<mods>;<code>~` (modifyOtherKeys): no legacy key sends these.
fn is_protocol_form(bytes: &[u8]) -> bool {
    let params = |end: u8| {
        bytes
            .strip_prefix(b"\x1b[")
            .and_then(|rest| rest.strip_suffix(&[end]))
    };
    let numbers = |rest: &[u8]| rest.iter().all(|b| b.is_ascii_digit() || b";:".contains(b));
    params(b'u').is_some_and(numbers)
        || params(b'~').is_some_and(|rest| rest.starts_with(b"27;") && numbers(rest))
}

/// The character the physical key produces without Shift on a US layout, from the key itself; other
/// keys report the single character of their text lowercased.
// The binding's key constants are not upper case, which a constant pattern trips over.
#[allow(non_upper_case_globals)]
fn unshifted_codepoint(input: &KeyInput) -> Option<u32> {
    use ffi::*;
    let key = input.key;
    let from_key = match key {
        GhosttyKey_GHOSTTY_KEY_A..=GhosttyKey_GHOSTTY_KEY_Z => {
            Some(u32::from(b'a') + (key - GhosttyKey_GHOSTTY_KEY_A) as u32)
        }
        GhosttyKey_GHOSTTY_KEY_DIGIT_0..=GhosttyKey_GHOSTTY_KEY_DIGIT_9 => {
            Some(u32::from(b'0') + (key - GhosttyKey_GHOSTTY_KEY_DIGIT_0) as u32)
        }
        GhosttyKey_GHOSTTY_KEY_BACKQUOTE => Some(u32::from(b'`')),
        GhosttyKey_GHOSTTY_KEY_BACKSLASH => Some(u32::from(b'\\')),
        GhosttyKey_GHOSTTY_KEY_BRACKET_LEFT => Some(u32::from(b'[')),
        GhosttyKey_GHOSTTY_KEY_BRACKET_RIGHT => Some(u32::from(b']')),
        GhosttyKey_GHOSTTY_KEY_COMMA => Some(u32::from(b',')),
        GhosttyKey_GHOSTTY_KEY_EQUAL => Some(u32::from(b'=')),
        GhosttyKey_GHOSTTY_KEY_MINUS => Some(u32::from(b'-')),
        GhosttyKey_GHOSTTY_KEY_PERIOD => Some(u32::from(b'.')),
        GhosttyKey_GHOSTTY_KEY_QUOTE => Some(u32::from(b'\'')),
        GhosttyKey_GHOSTTY_KEY_SEMICOLON => Some(u32::from(b';')),
        GhosttyKey_GHOSTTY_KEY_SLASH => Some(u32::from(b'/')),
        GhosttyKey_GHOSTTY_KEY_SPACE => Some(u32::from(b' ')),
        _ => None,
    };
    from_key.or_else(|| {
        let mut chars = input.text.as_deref()?.chars();
        let only = chars.next().filter(|_| chars.next().is_none())?;
        Some(only.to_lowercase().next().map_or(only, |c| c) as u32)
    })
}

const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";

/// Bytes to send for pasted text. Line breaks become CR like xterm.js, bracketed or not. Bracketed mode
/// also strips any embedded end marker (it would let pasted text escape the bracket and run as typed input).
pub(crate) fn paste(text: &str, bracketed: bool) -> Vec<u8> {
    let text = text.replace("\r\n", "\r").replace('\n', "\r");
    if !bracketed {
        return text.into_bytes();
    }
    let mut body = text.into_bytes();
    while let Some(at) = body.windows(PASTE_END.len()).position(|w| w == PASTE_END) {
        body.drain(at..at + PASTE_END.len());
    }
    [PASTE_START, &body, PASTE_END].concat()
}
