//! DOM `KeyboardEvent` to the encoder's key model, so every host that forwards browser key events (the
//! WebView today) shares one mapping instead of each carrying a table.

use crate::input::KeyInput;
use ghostty_vt::{ffi, MOD_ALT, MOD_CTRL, MOD_SHIFT, MOD_SUPER};

// Letters, digits, numpad digits and F1 to F24 are mapped by offset from their first key.
const _: () = {
    assert!(
        ffi::GhosttyKey_GHOSTTY_KEY_Z - ffi::GhosttyKey_GHOSTTY_KEY_A == 25
            && ffi::GhosttyKey_GHOSTTY_KEY_DIGIT_9 - ffi::GhosttyKey_GHOSTTY_KEY_DIGIT_0 == 9
            && ffi::GhosttyKey_GHOSTTY_KEY_NUMPAD_9 - ffi::GhosttyKey_GHOSTTY_KEY_NUMPAD_0 == 9
            && ffi::GhosttyKey_GHOSTTY_KEY_F24 - ffi::GhosttyKey_GHOSTTY_KEY_F1 == 23
    );
};

/// The Ghostty modifier bits for a DOM event's `shiftKey`, `ctrlKey`, `altKey` and `metaKey`.
pub fn dom_mods(shift: bool, ctrl: bool, alt: bool, meta: bool) -> u16 {
    [
        (shift, MOD_SHIFT),
        (ctrl, MOD_CTRL),
        (alt, MOD_ALT),
        (meta, MOD_SUPER),
    ]
    .into_iter()
    .filter(|(held, _)| *held)
    .fold(0, |mods, (_, bit)| mods | bit)
}

/// `n` in `prefix` + `n` (`Digit` + `7`, `F` + `12`) when it is within `range`.
fn number(code: &str, prefix: &str, range: std::ops::RangeInclusive<u32>) -> Option<u32> {
    let digits = code.strip_prefix(prefix)?;
    // `parse` alone would take "+1" and "01".
    let canonical =
        digits.bytes().all(|b| b.is_ascii_digit()) && (digits == "0" || !digits.starts_with('0'));
    let n = digits.parse::<u32>().ok().filter(|_| canonical)?;
    range.contains(&n).then_some(n)
}

/// A key from `KeyboardEvent.code` (the physical key) or, for the named keys, `KeyboardEvent.key`.
fn key_from_code(code: &str) -> Option<ffi::GhosttyKey> {
    use ffi::*;
    if let [b'K', b'e', b'y', letter @ b'A'..=b'Z'] = code.as_bytes() {
        return Some(GhosttyKey_GHOSTTY_KEY_A + i32::from(letter - b'A'));
    }
    if let Some(n) = number(code, "Digit", 0..=9) {
        return Some(GhosttyKey_GHOSTTY_KEY_DIGIT_0 + n as i32);
    }
    if let Some(n) = number(code, "Numpad", 0..=9) {
        return Some(GhosttyKey_GHOSTTY_KEY_NUMPAD_0 + n as i32);
    }
    if let Some(n) = number(code, "F", 1..=24) {
        return Some(GhosttyKey_GHOSTTY_KEY_F1 + n as i32 - 1);
    }
    Some(match code {
        "Backquote" => GhosttyKey_GHOSTTY_KEY_BACKQUOTE,
        "Backslash" => GhosttyKey_GHOSTTY_KEY_BACKSLASH,
        "BracketLeft" => GhosttyKey_GHOSTTY_KEY_BRACKET_LEFT,
        "BracketRight" => GhosttyKey_GHOSTTY_KEY_BRACKET_RIGHT,
        "Comma" => GhosttyKey_GHOSTTY_KEY_COMMA,
        "Equal" => GhosttyKey_GHOSTTY_KEY_EQUAL,
        "IntlBackslash" => GhosttyKey_GHOSTTY_KEY_INTL_BACKSLASH,
        "Minus" => GhosttyKey_GHOSTTY_KEY_MINUS,
        "Period" => GhosttyKey_GHOSTTY_KEY_PERIOD,
        "Quote" => GhosttyKey_GHOSTTY_KEY_QUOTE,
        "Semicolon" => GhosttyKey_GHOSTTY_KEY_SEMICOLON,
        "Slash" => GhosttyKey_GHOSTTY_KEY_SLASH,
        "AltLeft" => GhosttyKey_GHOSTTY_KEY_ALT_LEFT,
        "AltRight" => GhosttyKey_GHOSTTY_KEY_ALT_RIGHT,
        "Backspace" => GhosttyKey_GHOSTTY_KEY_BACKSPACE,
        "CapsLock" => GhosttyKey_GHOSTTY_KEY_CAPS_LOCK,
        "ContextMenu" => GhosttyKey_GHOSTTY_KEY_CONTEXT_MENU,
        "ControlLeft" => GhosttyKey_GHOSTTY_KEY_CONTROL_LEFT,
        "ControlRight" => GhosttyKey_GHOSTTY_KEY_CONTROL_RIGHT,
        "Enter" => GhosttyKey_GHOSTTY_KEY_ENTER,
        "MetaLeft" => GhosttyKey_GHOSTTY_KEY_META_LEFT,
        "MetaRight" => GhosttyKey_GHOSTTY_KEY_META_RIGHT,
        "ShiftLeft" => GhosttyKey_GHOSTTY_KEY_SHIFT_LEFT,
        "ShiftRight" => GhosttyKey_GHOSTTY_KEY_SHIFT_RIGHT,
        "Space" => GhosttyKey_GHOSTTY_KEY_SPACE,
        "Tab" => GhosttyKey_GHOSTTY_KEY_TAB,
        "Delete" => GhosttyKey_GHOSTTY_KEY_DELETE,
        "End" => GhosttyKey_GHOSTTY_KEY_END,
        "Home" => GhosttyKey_GHOSTTY_KEY_HOME,
        "Insert" => GhosttyKey_GHOSTTY_KEY_INSERT,
        "PageDown" => GhosttyKey_GHOSTTY_KEY_PAGE_DOWN,
        "PageUp" => GhosttyKey_GHOSTTY_KEY_PAGE_UP,
        "ArrowDown" => GhosttyKey_GHOSTTY_KEY_ARROW_DOWN,
        "ArrowLeft" => GhosttyKey_GHOSTTY_KEY_ARROW_LEFT,
        "ArrowRight" => GhosttyKey_GHOSTTY_KEY_ARROW_RIGHT,
        "ArrowUp" => GhosttyKey_GHOSTTY_KEY_ARROW_UP,
        "NumLock" => GhosttyKey_GHOSTTY_KEY_NUM_LOCK,
        "NumpadAdd" => GhosttyKey_GHOSTTY_KEY_NUMPAD_ADD,
        "NumpadComma" => GhosttyKey_GHOSTTY_KEY_NUMPAD_COMMA,
        "NumpadDecimal" => GhosttyKey_GHOSTTY_KEY_NUMPAD_DECIMAL,
        "NumpadDivide" => GhosttyKey_GHOSTTY_KEY_NUMPAD_DIVIDE,
        "NumpadEnter" => GhosttyKey_GHOSTTY_KEY_NUMPAD_ENTER,
        "NumpadEqual" => GhosttyKey_GHOSTTY_KEY_NUMPAD_EQUAL,
        "NumpadMultiply" => GhosttyKey_GHOSTTY_KEY_NUMPAD_MULTIPLY,
        "NumpadSubtract" => GhosttyKey_GHOSTTY_KEY_NUMPAD_SUBTRACT,
        "Escape" => GhosttyKey_GHOSTTY_KEY_ESCAPE,
        "PrintScreen" => GhosttyKey_GHOSTTY_KEY_PRINT_SCREEN,
        "ScrollLock" => GhosttyKey_GHOSTTY_KEY_SCROLL_LOCK,
        "Pause" => GhosttyKey_GHOSTTY_KEY_PAUSE,
        _ => return None,
    })
}

/// A DOM `keydown` or `keyup`. `code` names the physical key and `key` is what it produced; `mods` come from
/// [`dom_mods`], `repeat` and `composing` are `repeat` and `isComposing`.
#[derive(Debug, Clone, Copy, Default)]
pub struct DomKey<'a> {
    pub code: &'a str,
    pub key: &'a str,
    pub mods: u16,
    pub repeat: bool,
    pub release: bool,
    pub composing: bool,
}

impl KeyInput {
    /// The encoder's input for a DOM key event. Soft keyboards that report no `code` (Android IMEs send an
    /// empty one or "Unidentified") still work: a named key (`Enter`, `Backspace`, `ArrowUp`) is found by
    /// `key`, and a single printable character becomes text that names no key. Dead keys, `Process` and
    /// modifier-only presses on such keyboards encode to nothing.
    ///
    /// shortcut: a `key` of several characters is not text here, because IME commits arrive as composition
    /// results built by the IME bridge (#1328) rather than as key events.
    pub fn from_dom(event: DomKey) -> Self {
        let mut chars = event.key.chars();
        let text = chars
            .next()
            .filter(|c| !c.is_control() && chars.next().is_none())
            .map(String::from);
        Self {
            key: key_from_code(event.code)
                .or_else(|| key_from_code(event.key))
                .unwrap_or(ffi::GhosttyKey_GHOSTTY_KEY_UNIDENTIFIED),
            mods: event.mods,
            text,
            composing: event.composing,
            repeat: event.repeat,
            release: event.release,
        }
    }
}
