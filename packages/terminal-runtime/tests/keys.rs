//! DOM key events through [`KeyInput::from_dom`] and the encoder, compared with what xterm.js 5.5.0 puts on
//! the wire for the same `keydown`. The xterm column was captured by dispatching each event to a mounted
//! `Terminal` (jsdom, the app's constructor options, `setup` written first), the way #1314's harness
//! produces `fixtures/keys.json`; this table is the wider set of chords that file does not hold. Printable
//! keys without Ctrl or Alt are not in it: xterm.js sends them from `keypress`, which is not a key event.

mod support;

use lazysh_terminal_runtime::{ffi, KeyInput};
use support::{feed, runtime};

const SHIFT: u16 = ffi::GHOSTTY_MODS_SHIFT as u16;
const CTRL: u16 = ffi::GHOSTTY_MODS_CTRL as u16;
const ALT: u16 = ffi::GHOSTTY_MODS_ALT as u16;
const SUPER: u16 = ffi::GHOSTTY_MODS_SUPER as u16;

type Same = (
    &'static str,
    &'static str,
    u16,
    &'static [u8],
    &'static [u8],
);
type Different = (
    &'static str,
    &'static str,
    u16,
    &'static [u8],
    &'static [u8],
    &'static [u8],
    &'static str,
);

/// `(code, key, modifiers, bytes written first, what xterm.js sends)`, all of which the core sends too.
#[rustfmt::skip]
const SAME: &[Same] = &[
        ("KeyA", "A", SHIFT|CTRL, b"", b""),
        ("KeyA", "a", SUPER, b"", b""),
        ("KeyB", "B", SHIFT|CTRL, b"", b""),
        ("KeyB", "b", SUPER, b"", b""),
        ("KeyC", "C", SHIFT|CTRL, b"", b""),
        ("KeyC", "c", SUPER, b"", b""),
        ("KeyZ", "Z", SHIFT|CTRL, b"", b""),
        ("KeyZ", "z", SUPER, b"", b""),
        ("Digit3", "3", CTRL, b"", b"\x1b"),
        ("Digit4", "4", CTRL, b"", b"\x1c"),
        ("Digit5", "5", CTRL, b"", b"\x1d"),
        ("Digit6", "6", CTRL, b"", b"\x1e"),
        ("Digit7", "7", CTRL, b"", b"\x1f"),
        ("Digit8", "8", CTRL, b"", b"\x7f"),
        ("BracketLeft", "[", CTRL, b"", b"\x1b"),
        ("BracketLeft", "[", ALT, b"", b"\x1b["),
        ("BracketRight", "]", CTRL, b"", b"\x1d"),
        ("BracketRight", "]", ALT, b"", b"\x1b]"),
        ("Backslash", "\\", CTRL, b"", b"\x1c"),
        ("Backslash", "\\", ALT, b"", b"\x1b\\"),
        ("Slash", "/", ALT, b"", b"\x1b/"),
        ("Minus", "-", CTRL, b"", b""),
        ("Minus", "-", ALT, b"", b"\x1b-"),
        ("Equal", "=", CTRL, b"", b""),
        ("Equal", "=", ALT, b"", b"\x1b="),
        ("Comma", ",", CTRL, b"", b""),
        ("Comma", ",", ALT, b"", b"\x1b,"),
        ("Period", ".", CTRL, b"", b""),
        ("Period", ".", ALT, b"", b"\x1b."),
        ("Semicolon", ";", CTRL, b"", b""),
        ("Semicolon", ";", ALT, b"", b"\x1b;"),
        ("Quote", "'", CTRL, b"", b""),
        ("Quote", "'", ALT, b"", b"\x1b'"),
        ("Backquote", "`", CTRL, b"", b""),
        ("Backquote", "`", ALT, b"", b"\x1b`"),
        ("ArrowUp", "ArrowUp", SHIFT, b"", b"\x1b[1;2A"),
        ("ArrowUp", "ArrowUp", CTRL|ALT, b"", b"\x1b[1;7A"),
        ("Home", "Home", ALT, b"", b"\x1b[1;3H"),
        ("Home", "Home", SHIFT, b"", b"\x1b[1;2H"),
        ("Home", "Home", CTRL|ALT, b"", b"\x1b[1;7H"),
        ("Home", "Home", SUPER, b"", b"\x1b[1;9H"),
        ("Delete", "Delete", ALT, b"", b"\x1b[3;3~"),
        ("Delete", "Delete", SHIFT, b"", b"\x1b[3;2~"),
        ("Delete", "Delete", CTRL|ALT, b"", b"\x1b[3;7~"),
        ("Delete", "Delete", SUPER, b"", b"\x1b[3;9~"),
        ("PageDown", "PageDown", CTRL|ALT, b"", b"\x1b[6;7~"),
        ("Tab", "Tab", SHIFT|CTRL, b"", b"\x1b[Z"),
        ("Tab", "Tab", SHIFT|ALT, b"", b"\x1b[Z"),
        ("Enter", "Enter", SHIFT|CTRL, b"", b"\x0d"),
        ("Enter", "Enter", SUPER, b"", b"\x0d"),
        ("Backspace", "Backspace", SHIFT, b"", b"\x7f"),
        ("Backspace", "Backspace", CTRL|ALT, b"", b"\x1b\x08"),
        ("Escape", "Escape", CTRL, b"", b"\x1b"),
        ("Escape", "Escape", SHIFT, b"", b"\x1b"),
        ("F1", "F1", SHIFT, b"", b"\x1b[1;2P"),
        ("F1", "F1", CTRL, b"", b"\x1b[1;5P"),
        ("F1", "F1", ALT, b"", b"\x1b[1;3P"),
        ("F12", "F12", SHIFT, b"", b"\x1b[24;2~"),
        ("F12", "F12", SHIFT|CTRL, b"", b"\x1b[24;6~"),
        ("Space", " ", CTRL|ALT, b"", b"\x1b\x00"),
        ("NumpadEnter", "Enter", SHIFT, b"", b"\x0d"),
        ("NumpadAdd", "+", 0, b"\x1b=", b"+"),
        ("Numpad5", "5", SHIFT, b"\x1b=", b"5"),
        ("Numpad0", "0", 0, b"\x1b=", b"0"),
        ("ArrowUp", "ArrowUp", 0, b"\x1b[?1h", b"\x1bOA"),
        ("ArrowUp", "ArrowUp", CTRL, b"\x1b[?1h", b"\x1b[1;5A"),
        ("ArrowUp", "ArrowUp", SHIFT, b"\x1b[?1h", b"\x1b[1;2A"),
        ("F1", "F1", 0, b"\x1b[?1h", b"\x1bOP"),
        ("Home", "Home", SHIFT, b"\x1b[?1h", b"\x1b[1;2H"),
];

/// `(code, key, modifiers, setup, xterm.js, core, why they differ)`.
#[rustfmt::skip]
const DIFFERENT: &[Different] = &[
        ("KeyA", "A", SHIFT|CTRL|ALT, b"", b"\x1b\x01", b"", "xterm.js sends ESC and the control character for Ctrl+Alt+Shift+letter; the core sends nothing without a keyboard protocol"),
        ("KeyA", "A", SHIFT, b"", b"", b"A", "xterm.js sends printable text from keypress, which this harness does not dispatch; the core sends the key's text"),
        ("KeyB", "B", SHIFT|CTRL|ALT, b"", b"\x1b\x02", b"", "xterm.js sends ESC and the control character for Ctrl+Alt+Shift+letter; the core sends nothing without a keyboard protocol"),
        ("KeyB", "B", SHIFT, b"", b"", b"B", "xterm.js sends printable text from keypress, which this harness does not dispatch; the core sends the key's text"),
        ("KeyC", "C", SHIFT|CTRL|ALT, b"", b"\x1b\x03", b"", "xterm.js sends ESC and the control character for Ctrl+Alt+Shift+letter; the core sends nothing without a keyboard protocol"),
        ("KeyC", "C", SHIFT, b"", b"", b"C", "xterm.js sends printable text from keypress, which this harness does not dispatch; the core sends the key's text"),
        ("KeyZ", "Z", SHIFT|CTRL|ALT, b"", b"\x1b\x1a", b"", "xterm.js sends ESC and the control character for Ctrl+Alt+Shift+letter; the core sends nothing without a keyboard protocol"),
        ("KeyZ", "Z", SHIFT, b"", b"", b"Z", "xterm.js sends printable text from keypress, which this harness does not dispatch; the core sends the key's text"),
        ("Digit1", "1", CTRL, b"", b"", b"1", "xterm.js sends nothing for Ctrl+digit (NUL only for 2 and ESC to US for 3 to 8); the core sends the conventional byte or the digit"),
        ("Digit1", "1", SHIFT|CTRL, b"", b"", b"1", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit2", "2", CTRL, b"", b"", b"\x00", "xterm.js sends nothing for Ctrl+digit (NUL only for 2 and ESC to US for 3 to 8); the core sends the conventional byte or the digit"),
        ("Digit2", "2", SHIFT|CTRL, b"", b"", b"\x00", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit3", "3", SHIFT|CTRL, b"", b"", b"\x1b", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit4", "4", SHIFT|CTRL, b"", b"", b"\x1c", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit5", "5", SHIFT|CTRL, b"", b"", b"\x1d", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit6", "6", SHIFT|CTRL, b"", b"", b"\x1e", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit7", "7", SHIFT|CTRL, b"", b"", b"\x1f", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit8", "8", SHIFT|CTRL, b"", b"", b"\x7f", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit9", "9", CTRL, b"", b"", b"9", "xterm.js sends nothing for Ctrl+digit (NUL only for 2 and ESC to US for 3 to 8); the core sends the conventional byte or the digit"),
        ("Digit9", "9", SHIFT|CTRL, b"", b"", b"9", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Digit0", "0", CTRL, b"", b"", b"0", "xterm.js sends nothing for Ctrl+digit (NUL only for 2 and ESC to US for 3 to 8); the core sends the conventional byte or the digit"),
        ("Digit0", "0", SHIFT|CTRL, b"", b"", b"0", "xterm.js ignores Ctrl+Shift+digit; the core sends the conventional control byte"),
        ("Slash", "/", CTRL, b"", b"", b"\x1f", "xterm.js sends nothing for Ctrl+/; the core sends US (0x1f), the conventional byte"),
        ("ArrowUp", "ArrowUp", ALT, b"", b"\x1b[1;5A", b"\x1b[1;3A", "xterm.js turns Alt+arrow into Ctrl+arrow and drops Alt on PageDown and Insert; the core sends the standard Alt form"),
        ("ArrowUp", "ArrowUp", SUPER, b"", b"", b"\x1b[1;9A", "xterm.js sends nothing, or the unmodified key, for Meta chords on navigation keys; the core sends the standard Super form"),
        ("PageDown", "PageDown", ALT, b"", b"\x1b[6~", b"\x1b[6;3~", "xterm.js turns Alt+arrow into Ctrl+arrow and drops Alt on PageDown and Insert; the core sends the standard Alt form"),
        ("PageDown", "PageDown", SHIFT, b"", b"", b"\x1b[6;2~", "xterm.js leaves Shift+PageDown and Shift+Insert to the host (scroll, paste); the core encodes them"),
        ("PageDown", "PageDown", SUPER, b"", b"\x1b[6~", b"\x1b[6;9~", "xterm.js sends nothing, or the unmodified key, for Meta chords on navigation keys; the core sends the standard Super form"),
        ("Insert", "Insert", ALT, b"", b"\x1b[2~", b"\x1b[2;3~", "xterm.js turns Alt+arrow into Ctrl+arrow and drops Alt on PageDown and Insert; the core sends the standard Alt form"),
        ("Insert", "Insert", SHIFT, b"", b"", b"\x1b[2;2~", "xterm.js leaves Shift+PageDown and Shift+Insert to the host (scroll, paste); the core encodes them"),
        ("Insert", "Insert", CTRL|ALT, b"", b"", b"\x1b[2;7~", "xterm.js ignores Ctrl+Alt+Insert; the core sends the standard form"),
        ("Insert", "Insert", SUPER, b"", b"\x1b[2~", b"\x1b[2;9~", "xterm.js sends nothing, or the unmodified key, for Meta chords on navigation keys; the core sends the standard Super form"),
        ("Tab", "Tab", ALT, b"", b"\x09", b"\x1b\x09", "xterm.js drops Alt on Tab; the core sends ESC HT"),
        ("Space", " ", SHIFT, b"", b"", b" ", "xterm.js sends printable text from keypress, which this harness does not dispatch; the core sends the key's text"),
        ("Space", " ", SHIFT|CTRL, b"", b"", b"\x00", "xterm.js ignores Ctrl+Shift+Space; the core sends NUL"),
];

fn core_sends(code: &str, key: &str, mods: u16, setup: &[u8]) -> Vec<u8> {
    let mut rt = runtime(20, 4);
    feed(&mut rt, setup);
    rt.encode_key(&KeyInput::from_dom(code, key, mods, false, false))
        .unwrap()
}

#[test]
fn dom_key_events_encode_like_xterm_js() {
    for &(code, key, mods, setup, xterm) in SAME {
        assert_eq!(
            core_sends(code, key, mods, setup),
            xterm,
            "{code} {key:?} mods {mods} after {setup:?}"
        );
    }
}

#[test]
fn every_difference_from_xterm_js_is_listed_with_its_reason() {
    for &(code, key, mods, setup, xterm, core, why) in DIFFERENT {
        assert_ne!(
            core, xterm,
            "{code} {key:?} mods {mods}: no longer differs, move it to SAME"
        );
        assert_eq!(
            core_sends(code, key, mods, setup),
            core,
            "{code} {key:?} mods {mods} after {setup:?} ({why})"
        );
    }
}

#[test]
fn letters_digits_numpad_and_function_keys_map_to_their_physical_keys() {
    let key = |code: &str| KeyInput::from_dom(code, "", 0, false, false).key;
    for (code, expected) in [
        ("KeyA", ffi::GhosttyKey_GHOSTTY_KEY_A),
        ("KeyZ", ffi::GhosttyKey_GHOSTTY_KEY_Z),
        ("Digit0", ffi::GhosttyKey_GHOSTTY_KEY_DIGIT_0),
        ("Digit9", ffi::GhosttyKey_GHOSTTY_KEY_DIGIT_9),
        ("Numpad0", ffi::GhosttyKey_GHOSTTY_KEY_NUMPAD_0),
        ("Numpad9", ffi::GhosttyKey_GHOSTTY_KEY_NUMPAD_9),
        ("F1", ffi::GhosttyKey_GHOSTTY_KEY_F1),
        ("F12", ffi::GhosttyKey_GHOSTTY_KEY_F12),
        ("F24", ffi::GhosttyKey_GHOSTTY_KEY_F24),
        ("ShiftLeft", ffi::GhosttyKey_GHOSTTY_KEY_SHIFT_LEFT),
        ("NumpadEnter", ffi::GhosttyKey_GHOSTTY_KEY_NUMPAD_ENTER),
    ] {
        assert_eq!(key(code), expected, "{code}");
    }
    for unmapped in [
        "",
        "Unidentified",
        "F0",
        "F25",
        "F+1",
        "Digit10",
        "Digit+",
        "KeyAA",
        "Keya",
        "Key1",
        "Numpad10",
        "Lang1",
    ] {
        assert_eq!(
            key(unmapped),
            ffi::GhosttyKey_GHOSTTY_KEY_UNIDENTIFIED,
            "{unmapped:?}"
        );
    }
}

/// Android IMEs report no usable `code`: typed characters arrive as text and Enter or Backspace as named
/// keys; dead keys, `Process` and a bare modifier carry nothing the terminal can use.
#[test]
fn soft_keyboards_without_a_code_still_type_and_press_named_keys() {
    let mut rt = runtime(20, 4);
    let mut send = |code: &str, key: &str| {
        rt.encode_key(&KeyInput::from_dom(code, key, 0, false, false))
            .unwrap()
    };
    assert_eq!(send("", "a"), b"a");
    assert_eq!(send("Unidentified", "é"), "é".as_bytes());
    assert_eq!(send("", "Enter"), b"\r");
    assert_eq!(send("Unidentified", "Backspace"), b"\x7f");
    assert_eq!(send("", "ArrowUp"), b"\x1b[A");
    for (code, key) in [
        ("", "Unidentified"),
        ("", "Dead"),
        ("KeyE", "Dead"),
        ("", "Process"),
        ("", "Shift"),
    ] {
        assert!(send(code, key).is_empty(), "{code:?} {key:?}");
    }
    let composing = KeyInput::from_dom("KeyA", "a", 0, false, true);
    assert!(rt.encode_key(&composing).unwrap().is_empty());
}

#[test]
fn dom_modifier_flags_become_the_encoders_bits() {
    assert_eq!(
        lazysh_terminal_runtime::dom_mods(false, false, false, false),
        0
    );
    assert_eq!(
        lazysh_terminal_runtime::dom_mods(true, false, false, false),
        SHIFT
    );
    assert_eq!(
        lazysh_terminal_runtime::dom_mods(true, true, true, true),
        SHIFT | CTRL | ALT | SUPER
    );
    assert_eq!(
        lazysh_terminal_runtime::dom_mods(false, true, false, true),
        CTRL | SUPER
    );
}
