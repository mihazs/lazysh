//! Control: what the phone's input messages become (docs/host-browser.md, "Input mapping for a phone").
//!
//! [`commands`] (Chrome) and [`bidi_commands`] (Firefox) are the only producers of input protocol calls. It checks a message against the bounds below,
//! refuses it with a class when it is outside them, and otherwise returns the calls that
//! `inputCommands` in `apps/client/src/hostBrowser/cdp.ts` returns for the same message, so the developer
//! prototype and the relay stay equal. The relay still asks [`super::allow::command`] before it writes each one.
//! Nothing here keeps or logs a coordinate, a key or a text.
use super::{
    allow::{Refusal, BIDI_KEY_RANGE, BIDI_MODIFIER_KEYS, BIDI_NAMED_KEYS},
    wire::{Button, Client, PointerKind, Viewport},
};
use serde_json::{json, Value};
use std::time::Instant;

/// A refusal class, sent to the client in `refused {reason, count}`.
pub const CONTROL_OFF: &str = "ControlOff";
pub const OUT_OF_RANGE: &str = "InputOutOfRange";
pub const RATE_LIMITED: &str = "InputRateLimited";
/// A key event that would move the clipboard; the same class as the allow-list's.
const CLIPBOARD: &str = "PermissionRefused";

pub type Call = (&'static str, Value);

/// The most text one message carries, in bytes.
pub const MAX_TEXT: usize = 4096;
/// The most a wheel message scrolls on one axis, in CSS pixels; the client sends one per frame.
const MAX_WHEEL: f64 = 10_000.0;
/// The range of page scale the browser takes.
const SCALE: std::ops::RangeInclusive<f64> = 1.0..=5.0;
const MAX_CLICKS: u8 = 3;
/// Alt, Control, Meta and Shift, as the client sends them (the browser's own bits).
const ALT: u8 = 1;
const CONTROL: u8 = 2;
const META: u8 = 4;
const SHIFT: u8 = 8;
/// The keys that are not text, with their virtual key codes: the fixed list in the client.
const SPECIAL: [(&str, u32); 13] = [
    ("Backspace", 8),
    ("Tab", 9),
    ("Enter", 13),
    ("Escape", 27),
    ("PageUp", 33),
    ("PageDown", 34),
    ("End", 35),
    ("Home", 36),
    ("ArrowLeft", 37),
    ("ArrowUp", 38),
    ("ArrowRight", 39),
    ("ArrowDown", 40),
    ("Delete", 46),
];

/// Whether the bounds allow `message`, or the class it is refused with. Every adapter asks it before it maps a
/// message, so that Chrome and Firefox refuse exactly the same ones. Anything that is not an input message is out
/// of range.
pub fn check(message: &Client, viewport: Viewport) -> Result<(), &'static str> {
    let inside = |x: f64, y: f64| {
        (0.0..=f64::from(viewport.width)).contains(&x)
            && (0.0..=f64::from(viewport.height)).contains(&y)
    };
    let allowed = match *message {
        // A press or a release belongs to a button; only a move may have none.
        Client::Pointer {
            kind,
            x,
            y,
            button,
            click_count,
        } => {
            inside(x, y)
                && click_count <= MAX_CLICKS
                && (kind == PointerKind::Move || button != Button::None)
        }
        Client::Wheel {
            x,
            y,
            delta_x,
            delta_y,
        } => inside(x, y) && delta_x.abs() <= MAX_WHEEL && delta_y.abs() <= MAX_WHEEL,
        Client::Pinch { scale } => SCALE.contains(&scale),
        Client::Text { ref text } => text.len() <= MAX_TEXT,
        Client::Key { ref key, modifiers } => return key_code(key, modifiers).map(|_| ()),
        _ => false,
    };
    allowed.then_some(()).ok_or(OUT_OF_RANGE)
}

/// The protocol calls for one input message, or the class it is refused with.
pub fn commands(message: &Client, viewport: Viewport) -> Result<Vec<Call>, &'static str> {
    check(message, viewport)?;
    match *message {
        Client::Pointer {
            kind,
            x,
            y,
            button,
            click_count,
        } => {
            let (kind, held) = match kind {
                PointerKind::Move => ("mouseMoved", 1),
                PointerKind::Press => ("mousePressed", 1),
                PointerKind::Release => ("mouseReleased", 0),
            };
            let buttons = held
                * match button {
                    Button::None => 0,
                    Button::Left => 1,
                    Button::Right => 2,
                };
            Ok(vec![mouse(
                json!({"type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": click_count}),
            )])
        }
        Client::Wheel {
            x,
            y,
            delta_x,
            delta_y,
        } => Ok(vec![mouse(
            json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": delta_x, "deltaY": delta_y}),
        )]),
        Client::Pinch { scale } => Ok(vec![(
            "Emulation.setPageScaleFactor",
            json!({"pageScaleFactor": scale}),
        )]),
        Client::Text { ref text } => Ok(vec![("Input.insertText", json!({"text": text}))]),
        Client::Key { ref key, modifiers } => key_events(key, modifiers),
        _ => Err(OUT_OF_RANGE),
    }
}

/// A BiDi key source with `events`, each a `keyDown` or a `keyUp` of one WebDriver key value.
pub(super) fn key_source(events: Vec<(&'static str, char)>) -> Value {
    let actions: Vec<_> = events
        .into_iter()
        .map(|(kind, value)| json!({"type": kind, "value": value.to_string()}))
        .collect();
    json!({"type": "key", "id": "keyboard", "actions": actions})
}

/// The WebDriver BiDi call for one input message, or the class it is refused with (`context` is the adapter's to add):
/// the same bounds as [`commands`], so Firefox refuses what Chrome refuses. The pointer is a mouse, because a held
/// touch gave no context menu and a right click did; a drag is a wheel action; text is one key action per character,
/// because BiDi has no `insertText` and no composition; and there is no page pinch, so that message is refused as
/// an operation the adapter does not have.
pub fn bidi_commands(message: &Client, viewport: Viewport) -> Result<Vec<Call>, &'static str> {
    check(message, viewport)?;
    // BiDi takes whole CSS pixels.
    let pixel = |value: f64| value.round() as i64;
    let source = match *message {
        Client::Pointer {
            kind, x, y, button, ..
        } => {
            let number = if button == Button::Right { 2 } else { 0 };
            let mut actions = vec![
                json!({"type": "pointerMove", "x": pixel(x), "y": pixel(y), "origin": "viewport"}),
            ];
            match kind {
                PointerKind::Move => {}
                PointerKind::Press => {
                    actions.push(json!({"type": "pointerDown", "button": number}))
                }
                PointerKind::Release => {
                    actions.push(json!({"type": "pointerUp", "button": number}))
                }
            }
            json!({"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": actions})
        }
        Client::Wheel {
            x,
            y,
            delta_x,
            delta_y,
        } => json!({"type": "wheel", "id": "wheel", "actions": [
            {"type": "scroll", "x": pixel(x), "y": pixel(y), "deltaX": pixel(delta_x), "deltaY": pixel(delta_y), "origin": "viewport"},
        ]}),
        // A character in the key range would be a key and not text: Control held for the rest of the text, say.
        Client::Text { ref text } if text.chars().any(|c| BIDI_KEY_RANGE.contains(&c)) => {
            return Err(OUT_OF_RANGE)
        }
        Client::Text { ref text } => key_source(
            text.chars()
                .flat_map(|c| [("keyDown", c), ("keyUp", c)])
                .collect(),
        ),
        Client::Key { ref key, modifiers } => {
            let value = match BIDI_NAMED_KEYS.iter().find(|(name, _)| name == key) {
                Some(&(_, value)) => value,
                None => key.chars().next().unwrap_or_default(),
            };
            let held: Vec<_> = [ALT, CONTROL, META, SHIFT]
                .into_iter()
                .zip(BIDI_MODIFIER_KEYS)
                .filter(|(bit, _)| modifiers & bit != 0)
                .map(|(_, value)| value)
                .collect();
            let presses = held.iter().map(|m| ("keyDown", *m));
            let releases = held.iter().rev().map(|m| ("keyUp", *m));
            key_source(
                presses
                    .chain([("keyDown", value), ("keyUp", value)])
                    .chain(releases)
                    .collect(),
            )
        }
        _ => return Err(Refusal::Unlisted.reason()),
    };
    Ok(vec![("input.performActions", json!({"actions": [source]}))])
}

fn mouse(params: Value) -> Call {
    ("Input.dispatchMouseEvent", params)
}

/// The code and the virtual key code of a key the client may send: one of [`SPECIAL`], or one ASCII letter or digit
/// with a Control or Meta modifier (a chord); everything else the person types reaches the page as `text`. An
/// editing shortcut that reads or writes the host's clipboard is refused, as the client never sends one.
fn key_code(key: &str, modifiers: u8) -> Result<(String, u32), &'static str> {
    let chord = modifiers & (CONTROL | META) != 0;
    let (code, virtual_key) = match (
        SPECIAL.iter().find(|(name, _)| *name == key),
        key.as_bytes(),
    ) {
        _ if modifiers >= SHIFT << 1 => return Err(OUT_OF_RANGE),
        (Some(&(name, virtual_key)), _) => (name.to_string(), virtual_key),
        (None, &[byte]) if chord && byte.is_ascii_alphanumeric() => {
            let upper = byte.to_ascii_uppercase();
            let code = if upper.is_ascii_digit() {
                "Digit"
            } else {
                "Key"
            };
            (format!("{code}{}", char::from(upper)), u32::from(upper))
        }
        _ => return Err(OUT_OF_RANGE),
    };
    let clipboard = (chord && matches!(key.to_ascii_lowercase().as_str(), "c" | "x" | "v"))
        || (modifiers & SHIFT != 0 && key == "Delete");
    if clipboard {
        return Err(CLIPBOARD);
    }
    Ok((code, virtual_key))
}

/// A key down and a key up.
fn key_events(key: &str, modifiers: u8) -> Result<Vec<Call>, &'static str> {
    let (code, virtual_key) = key_code(key, modifiers)?;
    let base = json!({"key": key, "code": code, "windowsVirtualKeyCode": virtual_key, "modifiers": modifiers});
    // Enter types a line break; a chord and the other keys are not text, so they are raw key events.
    let types_text = key == "Enter" && modifiers & (ALT | CONTROL | META) == 0;
    let (mut down, mut up) = (base.clone(), base);
    down["type"] = if types_text { "keyDown" } else { "rawKeyDown" }.into();
    if types_text {
        down["text"] = "\r".into();
    }
    up["type"] = "keyUp".into();
    Ok(vec![
        ("Input.dispatchKeyEvent", down),
        ("Input.dispatchKeyEvent", up),
    ])
}

/// How many input messages a second the relay forwards, and the burst it takes at once. A hand on a phone sends
/// well under this (a drag is one wheel message per frame); a flood is refused.
const RATE: f64 = 240.0;

/// A token bucket.
pub struct Limit {
    tokens: f64,
    at: Instant,
}
impl Limit {
    pub fn new(now: Instant) -> Self {
        Self {
            tokens: RATE,
            at: now,
        }
    }
    /// Whether a message may pass at `now`.
    pub fn take(&mut self, now: Instant) -> bool {
        let waited = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens = (self.tokens + waited * RATE).min(RATE);
        self.at = now;
        let allowed = self.tokens >= 1.0;
        if allowed {
            self.tokens -= 1.0;
        }
        allowed
    }
}

#[cfg(test)]
mod tests {
    use super::super::allow;
    use super::*;
    use std::time::Duration;

    const PHONE: Viewport = Viewport {
        width: 412,
        height: 915,
        scale: 1.0,
    };

    fn message(value: Value) -> Client {
        serde_json::from_value(value).unwrap()
    }
    fn calls(value: Value) -> Vec<(&'static str, Value)> {
        commands(&message(value), PHONE).unwrap()
    }
    fn refused(value: Value) -> &'static str {
        commands(&message(value), PHONE).unwrap_err()
    }
    fn key(name: &str, modifiers: u8) -> Value {
        json!({"type": "key", "key": name, "modifiers": modifiers})
    }

    #[test]
    fn pointer_messages_become_mouse_events_with_the_buttons_that_are_held() {
        let pointer = |kind: &str, button: &str, clicks: u8| json!({"type": "pointer", "kind": kind, "x": 12, "y": 34, "button": button, "clickCount": clicks});
        for (kind, button, clicks, expected) in [
            (
                "move",
                "none",
                0,
                json!({"type": "mouseMoved", "button": "none", "buttons": 0, "clickCount": 0}),
            ),
            (
                "move",
                "left",
                0,
                json!({"type": "mouseMoved", "button": "left", "buttons": 1, "clickCount": 0}),
            ),
            (
                "press",
                "right",
                1,
                json!({"type": "mousePressed", "button": "right", "buttons": 2, "clickCount": 1}),
            ),
            (
                "release",
                "left",
                2,
                json!({"type": "mouseReleased", "button": "left", "buttons": 0, "clickCount": 2}),
            ),
        ] {
            let mut params = expected;
            params["x"] = json!(12.0);
            params["y"] = json!(34.0);
            assert_eq!(
                calls(pointer(kind, button, clicks)),
                [("Input.dispatchMouseEvent", params)],
                "{kind} {button}"
            );
        }
    }

    #[test]
    fn wheel_pinch_and_text_have_one_call_each() {
        assert_eq!(
            calls(json!({"type": "wheel", "x": 5, "y": 6, "deltaX": 0, "deltaY": 120.5})),
            [(
                "Input.dispatchMouseEvent",
                json!({"type": "mouseWheel", "x": 5.0, "y": 6.0, "deltaX": 0.0, "deltaY": 120.5})
            )]
        );
        assert_eq!(
            calls(json!({"type": "pinch", "scale": 2.5})),
            [(
                "Emulation.setPageScaleFactor",
                json!({"pageScaleFactor": 2.5})
            )]
        );
        assert_eq!(
            calls(json!({"type": "text", "text": "héllo 😀"})),
            [("Input.insertText", json!({"text": "héllo 😀"}))]
        );
    }

    #[test]
    fn keys_are_a_down_and_an_up_and_only_enter_types_a_character() {
        let enter = |down: &str, text: Option<&str>, modifiers: u8| {
            let mut down = json!({"type": down, "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "modifiers": modifiers});
            if let Some(text) = text {
                down["text"] = text.into();
            }
            let up = json!({"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "modifiers": modifiers});
            [
                ("Input.dispatchKeyEvent", down),
                ("Input.dispatchKeyEvent", up),
            ]
        };
        assert_eq!(calls(key("Enter", 0)), enter("keyDown", Some("\r"), 0));
        // Shift alone still types a line break; a chord does not.
        assert_eq!(calls(key("Enter", SHIFT)), enter("keyDown", Some("\r"), 8));
        assert_eq!(calls(key("Enter", CONTROL)), enter("rawKeyDown", None, 2));
        assert_eq!(calls(key("Enter", ALT)), enter("rawKeyDown", None, 1));

        let backspace = calls(key("Backspace", 0));
        assert_eq!(backspace[0].1["type"], "rawKeyDown");
        assert_eq!(backspace[0].1["windowsVirtualKeyCode"], 8);
        assert!(backspace[0].1.get("text").is_none());
        assert_eq!(
            calls(key("a", CONTROL))[0].1,
            json!({"type": "rawKeyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "modifiers": 2})
        );
        let digit = &calls(key("7", META))[0].1;
        assert_eq!(digit["code"], "Digit7");
        assert_eq!(digit["windowsVirtualKeyCode"], 55);
        for (name, virtual_key) in SPECIAL {
            assert_eq!(
                calls(key(name, 0))[1].1["windowsVirtualKeyCode"],
                virtual_key
            );
        }
    }

    #[test]
    fn a_message_outside_the_bounds_is_refused() {
        let pointer = |kind: &str, x: f64, y: f64, button: &str, clicks: u32| json!({"type": "pointer", "kind": kind, "x": x, "y": y, "button": button, "clickCount": clicks});
        let wheel = |x: f64, y: f64, dx: f64, dy: f64| json!({"type": "wheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy});
        for bad in [
            pointer("move", -0.5, 10.0, "none", 0),
            pointer("move", 412.5, 10.0, "none", 0),
            pointer("move", 10.0, 915.5, "none", 0),
            pointer("press", 10.0, 10.0, "none", 1),
            pointer("release", 10.0, 10.0, "none", 1),
            pointer("press", 10.0, 10.0, "left", 4),
            wheel(413.0, 10.0, 0.0, 1.0),
            wheel(10.0, -1.0, 0.0, 1.0),
            wheel(10.0, 10.0, 10_001.0, 0.0),
            wheel(10.0, 10.0, 0.0, -10_001.0),
            json!({"type": "pinch", "scale": 0.99}),
            json!({"type": "pinch", "scale": 5.01}),
            json!({"type": "text", "text": "a".repeat(MAX_TEXT + 1)}),
            key("Insert", 0),
            key("F5", 0),
            key("a", 0),
            key("a", ALT | SHIFT),
            key("ab", CONTROL),
            key("é", CONTROL),
            key("-", CONTROL),
            key("", CONTROL),
            key("Enter", 16),
            key("Enter", 255),
        ] {
            assert_eq!(refused(bad.clone()), OUT_OF_RANGE, "{bad}");
        }
        // The edges are inside.
        calls(pointer("move", 0.0, 0.0, "none", 0));
        calls(pointer("press", 412.0, 915.0, "left", 3));
        calls(wheel(412.0, 915.0, -10_000.0, 10_000.0));
        calls(json!({"type": "pinch", "scale": 1}));
        calls(json!({"type": "pinch", "scale": 5}));
        calls(json!({"type": "text", "text": "a".repeat(MAX_TEXT)}));
        calls(key("Enter", 15));
    }

    #[test]
    fn the_clipboard_is_never_reached_by_a_key() {
        for (name, modifiers) in [
            ("c", CONTROL),
            ("X", CONTROL),
            ("v", META),
            ("V", CONTROL | SHIFT),
            ("c", CONTROL | META | ALT | SHIFT),
            ("Delete", SHIFT),
            ("Delete", SHIFT | CONTROL),
        ] {
            assert_eq!(
                refused(key(name, modifiers)),
                CLIPBOARD,
                "{name} {modifiers}"
            );
        }
        // Other chords, and a plain Delete, are not clipboard commands.
        for (name, modifiers) in [
            ("a", CONTROL),
            ("z", META),
            ("Delete", 0),
            ("Delete", CONTROL),
        ] {
            calls(key(name, modifiers));
        }
    }

    /// Every kind of message at its edges and beyond them, valid or not.
    fn sweep() -> Vec<Client> {
        let numbers = [-1.0e9, -1.0, 0.0, 0.5, 1.0, 5.0, 411.5, 412.0, 915.0, 1.0e9];
        let mut messages = Vec::new();
        for kind in ["move", "press", "release"] {
            for button in ["none", "left", "right"] {
                for x in numbers {
                    for clicks in [0, 1, 3, 4, 255] {
                        messages.push(json!({"type": "pointer", "kind": kind, "x": x, "y": x, "button": button, "clickCount": clicks}));
                    }
                }
            }
        }
        for x in numbers {
            messages.push(json!({"type": "wheel", "x": x, "y": x, "deltaX": x, "deltaY": x}));
            messages.push(json!({"type": "pinch", "scale": x}));
        }
        for text in [
            "",
            "ação 日本 😀",
            "\0",
            "'); drop table",
            "\u{E009}v",
            "\u{E000}",
        ] {
            messages.push(json!({"type": "text", "text": text}));
        }
        let names = SPECIAL.map(|(name, _)| name);
        for name in names
            .into_iter()
            .chain(["a", "Z", "0", "c", "v", "x", "Insert", "F1", "", "ab"])
        {
            for modifiers in 0..=255u8 {
                messages.push(key(name, modifiers));
            }
        }
        messages
            .into_iter()
            .filter_map(|value| serde_json::from_value(value).ok())
            .collect()
    }

    /// Whatever the client sends, every call is one the allow-list takes, and none carries editing commands
    /// (the only way a key event reaches the clipboard).
    #[test]
    fn every_call_that_can_be_made_passes_the_allow_list() {
        let mut forwarded = 0;
        for client in sweep() {
            for (method, params) in commands(&client, PHONE).unwrap_or_default() {
                forwarded += 1;
                assert_eq!(allow::command(method, &params), Ok(()), "{method} {params}");
                assert!(
                    matches!(
                        method,
                        "Input.dispatchMouseEvent"
                            | "Input.dispatchKeyEvent"
                            | "Input.insertText"
                            | "Emulation.setPageScaleFactor"
                    ),
                    "{method}"
                );
                assert!(params.get("commands").is_none(), "{params}");
            }
        }
        assert!(forwarded > 500, "the sweep forwarded only {forwarded}");
    }

    /// The same sweep for Firefox: every call is an `input.performActions` the allow-list takes, with the page's
    /// context added.
    #[test]
    fn every_bidi_call_that_can_be_made_passes_the_allow_list() {
        let mut forwarded = 0;
        for client in sweep() {
            for (method, mut params) in bidi_commands(&client, PHONE).unwrap_or_default() {
                forwarded += 1;
                params["context"] = "c".into();
                assert_eq!(method, "input.performActions");
                assert_eq!(allow::bidi(method, &params), Ok(()), "{params}");
            }
        }
        assert!(forwarded > 300, "the sweep forwarded only {forwarded}");
    }

    /// Firefox takes the same bounds as Chrome: what Chrome refuses it refuses with the same class, except that a
    /// pinch is an operation it does not have and a text that names keys is not text.
    #[test]
    fn firefox_refuses_what_chrome_refuses_with_the_same_class() {
        for client in sweep() {
            let chrome = commands(&client, PHONE).map(|_| ());
            let firefox = bidi_commands(&client, PHONE).map(|_| ());
            match &client {
                Client::Pinch { .. } if chrome.is_ok() => {
                    assert_eq!(firefox, Err(Refusal::Unlisted.reason()));
                }
                Client::Text { text }
                    if chrome.is_ok() && text.chars().any(|c| BIDI_KEY_RANGE.contains(&c)) =>
                {
                    assert_eq!(firefox, Err(OUT_OF_RANGE), "{text:?}");
                }
                _ => assert_eq!(firefox, chrome, "{client:?}"),
            }
        }
    }

    fn actions(value: Value) -> Vec<Value> {
        let calls = bidi_commands(&message(value), PHONE).unwrap();
        assert_eq!(calls.len(), 1);
        let (method, params) = &calls[0];
        assert_eq!(*method, "input.performActions");
        assert!(params.get("context").is_none(), "the adapter adds it");
        let sources = params["actions"].as_array().unwrap();
        assert_eq!(sources.len(), 1);
        sources[0]["actions"].as_array().unwrap().clone()
    }

    #[test]
    fn firefox_input_becomes_one_action_sequence_per_message() {
        let pointer = |kind: &str, button: &str, x: f64| json!({"type": "pointer", "kind": kind, "x": x, "y": 34, "button": button, "clickCount": 1});
        let to = json!({"type": "pointerMove", "x": 13, "y": 34, "origin": "viewport"});
        assert_eq!(
            actions(pointer("move", "none", 12.5)),
            std::slice::from_ref(&to)
        );
        assert_eq!(
            actions(pointer("press", "left", 12.5)),
            [to.clone(), json!({"type": "pointerDown", "button": 0})]
        );
        assert_eq!(
            actions(pointer("press", "right", 12.5)),
            [to.clone(), json!({"type": "pointerDown", "button": 2})]
        );
        assert_eq!(
            actions(pointer("release", "left", 12.5)),
            [to, json!({"type": "pointerUp", "button": 0})]
        );
        // Whole pixels, rounded away from zero.
        assert_eq!(
            actions(json!({"type": "wheel", "x": 5, "y": 6, "deltaX": -0.4, "deltaY": -120.5})),
            [
                json!({"type": "scroll", "x": 5, "y": 6, "deltaX": 0, "deltaY": -121, "origin": "viewport"})
            ]
        );
        let key = |kind: &str, value: &str| json!({"type": kind, "value": value});
        assert_eq!(
            actions(json!({"type": "text", "text": "aç😀"})),
            [
                key("keyDown", "a"),
                key("keyUp", "a"),
                key("keyDown", "ç"),
                key("keyUp", "ç"),
                key("keyDown", "😀"),
                key("keyUp", "😀"),
            ]
        );
        assert_eq!(
            actions(self::key("Enter", 0)),
            [key("keyDown", "\u{E006}"), key("keyUp", "\u{E006}")]
        );
        // A chord holds its modifiers around the key, and lets go of them in the opposite order.
        assert_eq!(
            actions(self::key("a", CONTROL | SHIFT)),
            [
                key("keyDown", "\u{E009}"),
                key("keyDown", "\u{E008}"),
                key("keyDown", "a"),
                key("keyUp", "a"),
                key("keyUp", "\u{E008}"),
                key("keyUp", "\u{E009}"),
            ]
        );
        for (name, _) in SPECIAL {
            assert!(
                BIDI_NAMED_KEYS.iter().any(|(named, _)| *named == name),
                "{name} has no WebDriver key"
            );
        }
    }

    #[test]
    fn a_message_that_is_not_input_has_no_calls() {
        for other in [
            json!({"type": "pause"}),
            json!({"type": "control", "on": true}),
        ] {
            assert_eq!(refused(other), OUT_OF_RANGE);
        }
    }

    #[test]
    fn the_limit_passes_a_burst_then_the_rate_and_recovers_when_the_flood_stops() {
        let start = Instant::now();
        let mut limit = Limit::new(start);
        let burst = (0..1000).filter(|_| limit.take(start)).count();
        assert_eq!(burst, RATE as usize);
        // An eighth of a second later, an eighth of the rate is back.
        let later = start + Duration::from_millis(125);
        let refilled = (0..1000).filter(|_| limit.take(later)).count();
        assert_eq!(refilled, 30);
        // A quiet minute refills the bucket, never beyond one burst.
        let quiet = later + Duration::from_secs(60);
        let after = (0..1000).filter(|_| limit.take(quiet)).count();
        assert_eq!(after, RATE as usize);
    }
}
