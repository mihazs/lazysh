//! The relay's wire format on one SSH exec channel (docs/host-browser.md, "Relay wire format").
//!
//! Both directions carry messages of `length:u32be tag:u8 body`, where `length` counts the tag and the body. Tag
//! 1 is a UTF-8 JSON object. Tag 2, relay to client only, is a frame: a 20 byte header and the JPEG bytes
//! as they are, never base64.
use super::ladder::Choice;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, ErrorKind, Read};

pub const JSON: u8 = 1;
pub const FRAME: u8 = 2;
/// The largest JPEG the relay forwards; a bigger frame is dropped, never truncated.
pub const MAX_JPEG: usize = 4 << 20;
/// The largest message a client may send; the client only ever sends small controls.
pub const MAX_CLIENT: usize = 64 << 10;

pub struct Frame {
    pub sequence: u32,
    /// The page's viewport in CSS pixels, which is the space a later tap is mapped into.
    pub width: u16,
    pub height: u16,
    pub scroll_y: f32,
    pub timestamp_ms: u64,
    pub jpeg: Vec<u8>,
}

fn message(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(5 + body.len());
    bytes.extend_from_slice(&(body.len() as u32 + 1).to_be_bytes());
    bytes.push(tag);
    bytes.extend_from_slice(body);
    bytes
}

pub fn encode_json(value: &Value) -> Vec<u8> {
    message(JSON, value.to_string().as_bytes())
}

pub fn encode_frame(frame: &Frame) -> Vec<u8> {
    let mut body = Vec::with_capacity(20 + frame.jpeg.len());
    body.extend_from_slice(&frame.sequence.to_be_bytes());
    body.extend_from_slice(&frame.width.to_be_bytes());
    body.extend_from_slice(&frame.height.to_be_bytes());
    body.extend_from_slice(&frame.scroll_y.to_be_bytes());
    body.extend_from_slice(&frame.timestamp_ms.to_be_bytes());
    body.extend_from_slice(&frame.jpeg);
    message(FRAME, &body)
}

/// The next message, or `None` at a clean end of input. A length of zero or above `max` is `InvalidData`.
pub fn read(reader: &mut impl Read, max: usize) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut length = [0u8; 4];
    match reader.read_exact(&mut length) {
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        other => other?,
    }
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > max + 1 {
        return Err(ErrorKind::InvalidData.into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let tag = body.remove(0);
    Ok(Some((tag, body)))
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    #[serde(default = "one")]
    pub scale: f32,
}
fn one() -> f32 {
    1.0
}
impl Viewport {
    /// A phone-sized to tablet-sized page, at most 3x, and at most 8 million pixels once scaled.
    pub fn valid(&self) -> bool {
        lazysh_common::host_browser::valid_viewport(self.width, self.height, self.scale)
    }
}

/// What a client may send. Anything else is refused and counted, never forwarded.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Client {
    Open {
        #[serde(default = "chrome")]
        browser: String,
        #[serde(default)]
        headed: bool,
        viewport: Viewport,
        url: Option<String>,
    },
    /// The device decoded frame `sequence`: the relay may send another.
    #[serde(rename_all = "camelCase")]
    Ack {
        sequence: u32,
        #[serde(default)]
        decode_ms: Option<u32>,
    },
    // Struct variants, not unit ones: `deny_unknown_fields` does not reach a unit variant.
    Pause {},
    Resume {},
    /// Let the relay choose the quality, or hold one rung of the ladder (Data saver holds the lowest).
    Quality {
        rung: Choice,
    },
    /// Turns Control on or off. It is off when a session starts.
    Control {
        on: bool,
    },
    // Navigation, tabs and dialogs: not input, so Control does not gate them (docs/host-browser.md, "Controls").
    Navigate {
        url: String,
    },
    Back {},
    Forward {},
    Reload {},
    Stop {},
    /// Asks for the tab list again.
    Tabs {},
    ActivateTab {
        id: String,
    },
    NewTab {},
    CloseTab {
        id: String,
    },
    /// The answer to the page's open dialog; `text` is a prompt's answer.
    AnswerDialog {
        accept: bool,
        #[serde(default)]
        text: Option<String>,
    },
    // Input, accepted only while Control is on, in the page's CSS pixels (docs/host-browser.md, "Input mapping").
    #[serde(rename_all = "camelCase")]
    Pointer {
        kind: PointerKind,
        x: f64,
        y: f64,
        button: Button,
        click_count: u8,
    },
    #[serde(rename_all = "camelCase")]
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
    },
    Pinch {
        scale: f64,
    },
    Key {
        key: String,
        modifiers: u8,
    },
    Text {
        text: String,
    },
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PointerKind {
    Move,
    Press,
    Release,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    None,
    Left,
    Right,
}
fn chrome() -> String {
    "chrome".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn messages_round_trip_and_a_frame_keeps_its_jpeg_bytes() {
        let json = encode_json(&json!({"type":"state","state":"running"}));
        let (tag, body) = read(&mut json.as_slice(), 1024).unwrap().unwrap();
        assert_eq!(tag, JSON);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["state"],
            "running"
        );

        let jpeg = vec![0xff, 0xd8, 0, 1, 2, 0xff, 0xd9];
        let bytes = encode_frame(&Frame {
            sequence: 7,
            width: 412,
            height: 915,
            scroll_y: 12.5,
            timestamp_ms: 1_700_000_000_123,
            jpeg: jpeg.clone(),
        });
        let (tag, body) = read(&mut bytes.as_slice(), MAX_JPEG).unwrap().unwrap();
        assert_eq!(tag, FRAME);
        assert_eq!(u32::from_be_bytes(body[0..4].try_into().unwrap()), 7);
        assert_eq!(u16::from_be_bytes(body[4..6].try_into().unwrap()), 412);
        assert_eq!(u16::from_be_bytes(body[6..8].try_into().unwrap()), 915);
        assert_eq!(f32::from_be_bytes(body[8..12].try_into().unwrap()), 12.5);
        assert_eq!(
            u64::from_be_bytes(body[12..20].try_into().unwrap()),
            1_700_000_000_123
        );
        assert_eq!(&body[20..], jpeg);
    }

    #[test]
    fn framing_errors_are_not_a_clean_end() {
        assert!(read(&mut [].as_slice(), 8).unwrap().is_none());
        for bad in [
            vec![0, 0, 0, 0],
            vec![0, 0, 0, 20, 1, 2],
            vec![0xff, 0xff, 0xff, 0xff],
        ] {
            assert!(read(&mut bad.as_slice(), 8).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn clients_send_a_closed_set_with_no_extra_fields() {
        let open: Client = serde_json::from_value(json!({
            "type": "open", "viewport": {"width": 412, "height": 915}
        }))
        .unwrap();
        assert_eq!(
            open,
            Client::Open {
                browser: "chrome".into(),
                headed: false,
                viewport: Viewport {
                    width: 412,
                    height: 915,
                    scale: 1.0
                },
                url: None
            }
        );
        for bad in [
            json!({"type": "evaluate", "expression": "document.cookie"}),
            json!({"type": "cdp", "method": "Network.getCookies"}),
            json!({"type": "ack", "sequence": 1, "method": "Runtime.evaluate"}),
            json!({"type": "ack"}),
            json!({"type": "pause", "extra": true}),
            json!({"type": "open"}),
        ] {
            assert!(
                serde_json::from_value::<Client>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn quality_names_one_rung_or_auto_and_nothing_else() {
        use super::super::ladder::Choice;
        for (name, choice) in [
            ("auto", Choice::Auto),
            ("high", Choice::High),
            ("balanced", Choice::Balanced),
            ("low", Choice::Low),
            ("minimal", Choice::Minimal),
        ] {
            let message = json!({"type": "quality", "rung": name});
            assert_eq!(
                serde_json::from_value::<Client>(message).unwrap(),
                Client::Quality { rung: choice }
            );
        }
        for bad in [
            json!({"type": "quality"}),
            json!({"type": "quality", "rung": "ultra"}),
            json!({"type": "quality", "rung": "High"}),
            json!({"type": "quality", "rung": 1}),
            json!({"type": "quality", "rung": "low", "quality": 100}),
        ] {
            assert!(
                serde_json::from_value::<Client>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn control_and_input_are_closed_sets_in_the_clients_own_field_names() {
        let pointer = json!({"type": "pointer", "kind": "press", "x": 1, "y": 2, "button": "left", "clickCount": 2});
        let wheel = json!({"type": "wheel", "x": 1, "y": 2, "deltaX": 0.5, "deltaY": -3});
        let key = json!({"type": "key", "key": "Enter", "modifiers": 0});
        assert_eq!(
            serde_json::from_value::<Client>(pointer.clone()).unwrap(),
            Client::Pointer {
                kind: PointerKind::Press,
                x: 1.0,
                y: 2.0,
                button: Button::Left,
                click_count: 2
            }
        );
        for good in [
            json!({"type": "control", "on": false}),
            wheel.clone(),
            json!({"type": "pinch", "scale": 2.5}),
            key.clone(),
            json!({"type": "text", "text": "ação 😀"}),
        ] {
            assert!(
                serde_json::from_value::<Client>(good.clone()).is_ok(),
                "{good}"
            );
        }
        // Each of these is one wrong field away from a message above.
        let with = |mut message: Value, field: &str, value: Value| {
            message[field] = value;
            message
        };
        for bad in [
            json!({"type": "control"}),
            json!({"type": "control", "on": "yes"}),
            with(json!({"type": "control", "on": true}), "extra", json!(1)),
            with(pointer.clone(), "extra", json!(1)),
            with(pointer.clone(), "kind", json!("tap")),
            with(pointer.clone(), "button", json!("middle")),
            with(pointer.clone(), "clickCount", json!(256)),
            with(pointer.clone(), "clickCount", json!(-1)),
            with(pointer.clone(), "clickCount", json!(1.5)),
            with(pointer.clone(), "x", json!("1")),
            with(pointer.clone(), "x", Value::Null),
            with(pointer.clone(), "click_count", json!(1)),
            with(wheel.clone(), "method", json!("Input.dispatchDragEvent")),
            with(key.clone(), "modifiers", json!(256)),
            with(key.clone(), "commands", json!(["paste"])),
            with(key, "key", json!(13)),
            json!({"type": "pointer", "kind": "move", "x": 1, "y": 2}),
            json!({"type": "wheel", "x": 1, "y": 2, "deltaX": 1}),
            json!({"type": "pinch"}),
            json!({"type": "text", "text": "a", "x": 1}),
            json!({"type": "text", "text": 1}),
        ] {
            assert!(
                serde_json::from_value::<Client>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn navigation_tabs_and_dialog_answers_are_closed_sets_in_the_clients_own_field_names() {
        assert_eq!(
            serde_json::from_value::<Client>(json!({"type": "activateTab", "id": "T2"})).unwrap(),
            Client::ActivateTab { id: "T2".into() }
        );
        assert_eq!(
            serde_json::from_value::<Client>(json!({"type": "answerDialog", "accept": true}))
                .unwrap(),
            Client::AnswerDialog {
                accept: true,
                text: None
            }
        );
        for good in [
            json!({"type": "navigate", "url": "https://example.com/"}),
            json!({"type": "back"}),
            json!({"type": "forward"}),
            json!({"type": "reload"}),
            json!({"type": "stop"}),
            json!({"type": "tabs"}),
            json!({"type": "newTab"}),
            json!({"type": "closeTab", "id": "T2"}),
            json!({"type": "answerDialog", "accept": false, "text": "ação"}),
        ] {
            assert!(
                serde_json::from_value::<Client>(good.clone()).is_ok(),
                "{good}"
            );
        }
        // Each of these is one wrong field away from a message above.
        for bad in [
            json!({"type": "navigate"}),
            json!({"type": "navigate", "url": 1}),
            json!({"type": "navigate", "url": "https://a.test/", "method": "Page.navigate"}),
            json!({"type": "back", "steps": 2}),
            json!({"type": "reload", "ignoreCache": true}),
            json!({"type": "stop", "extra": 1}),
            json!({"type": "tabs", "extra": 1}),
            json!({"type": "newTab", "url": "https://a.test/"}),
            json!({"type": "activateTab"}),
            json!({"type": "activateTab", "id": 2}),
            json!({"type": "closeTab", "id": "T2", "force": true}),
            json!({"type": "answerDialog"}),
            json!({"type": "answerDialog", "accept": "yes"}),
            json!({"type": "answerDialog", "accept": true, "promptText": "a"}),
            json!({"type": "answerDialog", "accept": true, "text": 1}),
            json!({"type": "navigate_to", "url": "https://a.test/"}),
        ] {
            assert!(
                serde_json::from_value::<Client>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn viewports_are_bounded() {
        let viewport = |width, height, scale| Viewport {
            width,
            height,
            scale,
        };
        assert!(viewport(412, 915, 1.0).valid());
        assert!(viewport(412, 915, 3.0).valid());
        for bad in [
            viewport(99, 915, 1.0),
            viewport(412, 2049, 1.0),
            viewport(412, 915, 0.5),
            viewport(412, 915, 3.1),
            viewport(2048, 2048, 1.5),
            viewport(412, 915, f32::NAN),
        ] {
            assert!(!bad.valid(), "{bad:?}");
        }
    }
}
