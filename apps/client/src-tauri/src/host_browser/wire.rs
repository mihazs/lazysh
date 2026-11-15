//! The host browser relay's wire format, read by the app (docs/host-browser.md, "Relay wire format").
//!
//! Both directions carry `length:u32be tag:u8 body`, where `length` counts the tag and the body. Tag 1 is a UTF-8
//! JSON object and tag 2, relay to app only, is a frame: a 20 byte header (`sequence:u32be width:u16be
//! height:u16be scrollY:f32be timestampMs:u64be`) and the JPEG bytes as they are. The bounds are the relay's: a
//! length of zero or above the largest message, a tag other than 1 and 2, a JSON object over 64 KiB, a frame
//! without its header or its JPEG, or a message that is not what it says breaks the stream.
//!
//! Nothing here keeps what a message said when it fails: the error is a unit value, never serde's text, which
//! can quote the page's title or address.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const JSON: u8 = 1;
pub(super) const FRAME: u8 = 2;
const HEADER: usize = 20;
const MAX_JSON: usize = 64 << 10;
/// The largest JPEG the relay forwards.
const MAX_JPEG: usize = 4 << 20;
const MAX_LENGTH: usize = 1 + HEADER + MAX_JPEG;
const MAX_TITLE: usize = 512;
const MAX_URL: usize = 2048;
const MAX_REASON: usize = 64;
const MAX_DETAIL: usize = 256;
const MAX_BROWSER: usize = 128;

/// The stream broke the format; the session ends with `ProtocolViolation`.
#[derive(Debug, PartialEq)]
pub(super) struct Violation;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct Viewport {
    pub(super) width: u32,
    pub(super) height: u32,
    #[serde(default = "one")]
    pub(super) scale: f32,
}
fn one() -> f32 {
    1.0
}
impl Viewport {
    /// The relay's limits: 100 to 2048 CSS pixels, scale 1 to 3, at most 8 million pixels once scaled.
    pub(super) fn valid(&self) -> bool {
        (100..=2048).contains(&self.width)
            && (100..=2048).contains(&self.height)
            && (1.0..=3.0).contains(&self.scale)
            && (self.width as f32 * self.height as f32 * self.scale * self.scale) <= 8_000_000.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Run {
    Running,
    Paused,
}

/// What the browser adapter can do; a field a later relay adds is ignored, a missing one is off.
#[derive(Debug, Default, Deserialize, PartialEq, Serialize)]
pub(super) struct Capabilities {
    #[serde(default)]
    view: bool,
    #[serde(default)]
    control: bool,
    #[serde(default)]
    navigation: bool,
    #[serde(default)]
    tabs: bool,
}

/// A relay message the renderer may see: a closed set, re-serialized from what was validated, so a field the
/// relay did not promise never reaches the webview.
#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum Control {
    /// The relay's first `state` says all of it; its answers to `pause` and `resume` name only `state`.
    State {
        state: Run,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        browser: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        viewport: Option<Viewport>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capabilities: Option<Capabilities>,
    },
    /// Untrusted text, shown as text only.
    Page {
        title: String,
        url: String,
    },
    Refused {
        reason: String,
        count: u64,
    },
    Closed {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}
impl Control {
    /// The app's own end of a session: `reason` is a class, like the relay's own.
    pub(super) fn closed(reason: &str) -> Self {
        Self::Closed {
            reason: reason.into(),
            detail: None,
        }
    }
    fn within(&self) -> bool {
        let text = |value: &str, most: usize| value.chars().count() <= most;
        match self {
            Self::State {
                browser, viewport, ..
            } => {
                browser
                    .as_deref()
                    .is_none_or(|browser| text(browser, MAX_BROWSER))
                    && viewport.is_none_or(|viewport| viewport.valid())
            }
            Self::Page { title, url } => text(title, MAX_TITLE) && text(url, MAX_URL),
            Self::Refused { reason, count } => text(reason, MAX_REASON) && *count > 0,
            Self::Closed { reason, detail } => {
                (1..=MAX_REASON).contains(&reason.len())
                    && reason.bytes().all(|byte| byte.is_ascii_alphanumeric())
                    && detail
                        .as_deref()
                        .is_none_or(|detail| text(detail, MAX_DETAIL))
            }
        }
    }
}

pub(super) enum Message {
    /// The tag and the frame, as the relay sent them: what the renderer reads.
    Frame(Vec<u8>),
    Control(Control),
}

/// Reads messages from a stream that arrives in pieces. Its buffer never holds more than one message and the
/// piece that completed it, because the length is judged as soon as it is in.
#[derive(Default)]
pub(super) struct Decoder(Vec<u8>);
impl Decoder {
    pub(super) fn push(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    /// The next message, `None` until more bytes arrive. A JSON object whose type this app does not know is
    /// skipped, so a later relay may add messages.
    pub(super) fn next(&mut self) -> Result<Option<Message>, Violation> {
        loop {
            let Some(prefix) = self.0.get(..4) else {
                return Ok(None);
            };
            let length = u32::from_be_bytes(prefix.try_into().unwrap()) as usize;
            if length == 0 || length > MAX_LENGTH {
                return Err(Violation);
            }
            let Some(&tag) = self.0.get(4) else {
                return Ok(None);
            };
            let body = length - 1;
            let sized = match tag {
                JSON => body <= MAX_JSON,
                FRAME => (HEADER + 1..=HEADER + MAX_JPEG).contains(&body),
                _ => false,
            };
            if !sized {
                return Err(Violation);
            }
            if self.0.len() < 4 + length {
                return Ok(None);
            }
            self.0.drain(..4);
            let message: Vec<u8> = self.0.drain(..length).collect();
            if tag == FRAME {
                return frame(message).map(|frame| Some(Message::Frame(frame)));
            }
            if let Some(control) = control(&message[1..])? {
                return Ok(Some(Message::Control(control)));
            }
        }
    }
}

/// A frame the renderer can draw: a page size, and a JPEG.
fn frame(message: Vec<u8>) -> Result<Vec<u8>, Violation> {
    let size = |at: usize| u16::from_be_bytes([message[at], message[at + 1]]);
    let jpeg = message[1 + HEADER..].starts_with(&[0xff, 0xd8, 0xff]);
    if size(5) == 0 || size(7) == 0 || !jpeg {
        return Err(Violation);
    }
    Ok(message)
}

fn control(body: &[u8]) -> Result<Option<Control>, Violation> {
    let value: Value = serde_json::from_slice(body).map_err(|_| Violation)?;
    if !matches!(
        value["type"].as_str(),
        Some("state" | "page" | "refused" | "closed")
    ) {
        return value.is_object().then_some(None).ok_or(Violation);
    }
    let control: Control = serde_json::from_value(value).map_err(|_| Violation)?;
    control.within().then_some(Some(control)).ok_or(Violation)
}

/// One client message: `length`, the JSON tag and the object.
pub(super) fn encode(value: &Value) -> Vec<u8> {
    let body = value.to_string();
    let mut bytes = Vec::with_capacity(5 + body.len());
    bytes.extend_from_slice(&(body.len() as u32 + 1).to_be_bytes());
    bytes.push(JSON);
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// Messages as the relay writes them, for the tests of this module and of the bridge.
#[cfg(test)]
pub(super) mod fixtures {
    use super::*;

    pub(crate) fn message(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut bytes = (body.len() as u32 + 1).to_be_bytes().to_vec();
        bytes.push(tag);
        bytes.extend_from_slice(body);
        bytes
    }
    pub(crate) fn json_message(value: Value) -> Vec<u8> {
        message(JSON, value.to_string().as_bytes())
    }
    /// What a client message says: its length is checked and its tag must be JSON.
    pub(crate) fn client_message(bytes: &[u8]) -> Value {
        let (length, rest) = bytes.split_at(4);
        assert_eq!(
            u32::from_be_bytes(length.try_into().unwrap()) as usize,
            rest.len()
        );
        assert_eq!(rest[0], JSON);
        serde_json::from_slice(&rest[1..]).unwrap()
    }
    /// A frame: sequence, a 412 by 915 page, scroll 12.5, a time, then the JPEG.
    pub(crate) fn frame_message(sequence: u32, jpeg: &[u8]) -> Vec<u8> {
        let mut body = sequence.to_be_bytes().to_vec();
        body.extend_from_slice(&412u16.to_be_bytes());
        body.extend_from_slice(&915u16.to_be_bytes());
        body.extend_from_slice(&12.5f32.to_be_bytes());
        body.extend_from_slice(&1_700_000_000_123u64.to_be_bytes());
        body.extend_from_slice(jpeg);
        message(FRAME, &body)
    }
}

#[cfg(test)]
mod tests {
    use super::{fixtures::*, *};
    use serde_json::json;

    fn decode(bytes: &[u8]) -> Result<Vec<Message>, Violation> {
        let mut decoder = Decoder::default();
        decoder.push(bytes);
        let mut messages = Vec::new();
        while let Some(message) = decoder.next()? {
            messages.push(message);
        }
        Ok(messages)
    }

    #[test]
    fn json_and_frames_arrive_whole_however_the_stream_is_cut() {
        let jpeg = [0xff, 0xd8, 0xff, 0, 1, 2, 0xff, 0xd9];
        let stream = [
            json_message(json!({"type":"page","title":"T","url":"http://example.test/"})),
            frame_message(7, &jpeg),
            json_message(json!({"type":"closed","reason":"PageClosed"})),
        ]
        .concat();
        for piece in [1, 3, 5, 64, stream.len()] {
            let mut decoder = Decoder::default();
            let mut messages = Vec::new();
            for chunk in stream.chunks(piece) {
                decoder.push(chunk);
                while let Some(message) = decoder.next().unwrap() {
                    messages.push(message);
                }
            }
            assert_eq!(messages.len(), 3, "pieces of {piece}");
            assert!(
                matches!(&messages[0], Message::Control(Control::Page { title, .. }) if title == "T")
            );
            let Message::Frame(bytes) = &messages[1] else {
                panic!("not a frame")
            };
            assert_eq!(bytes[0], FRAME);
            assert_eq!(u32::from_be_bytes(bytes[1..5].try_into().unwrap()), 7);
            assert_eq!(
                &bytes[1 + HEADER..],
                jpeg,
                "the JPEG bytes are the relay's, not re-encoded"
            );
            assert!(
                matches!(&messages[2], Message::Control(Control::Closed { reason, .. }) if reason == "PageClosed")
            );
        }
    }

    #[test]
    fn a_broken_length_an_oversized_frame_and_an_unknown_tag_break_the_stream() {
        let frame = frame_message(1, &[0xff, 0xd8, 0xff, 1]);
        let oversized = {
            let mut bytes = ((1 + HEADER + MAX_JPEG + 1) as u32).to_be_bytes().to_vec();
            bytes.push(FRAME);
            bytes
        };
        for (name, bytes) in [
            ("a length of zero", vec![0, 0, 0, 0]),
            ("a length no message may have", vec![0xff, 0xff, 0xff, 0xff]),
            ("a frame over the cap, before its body arrives", oversized),
            (
                "an unknown tag, before its body arrives",
                vec![0, 0, 0, 9, 3],
            ),
            ("the relay's own client tag", message(0, b"{}")),
            (
                "a JSON object over 64 KiB",
                message(JSON, &vec![b' '; MAX_JSON + 1]),
            ),
            ("a frame without its header", message(FRAME, &[0; HEADER])),
            ("a frame that is not a JPEG", {
                let mut bytes = frame.clone();
                let first_jpeg_byte = bytes.len() - 4;
                bytes[first_jpeg_byte] = 0;
                bytes
            }),
            ("a page of no size", {
                let mut bytes = frame.clone();
                bytes[9..13].fill(0);
                bytes
            }),
            (
                "text that is not JSON",
                message(JSON, b"usage: lazysh-agent"),
            ),
            ("JSON that is not an object", message(JSON, b"[]")),
        ] {
            assert_eq!(decode(&bytes).err(), Some(Violation), "{name}");
        }
        // A message that has not fully arrived is not an error yet.
        assert!(decode(&frame[..frame.len() - 1]).unwrap().is_empty());
    }

    #[test]
    fn relay_messages_are_a_closed_set_with_bounds_and_unknown_ones_are_skipped() {
        let state = json!({"type":"state","state":"running","browser":"Chrome/120","viewport":{"width":412,"height":915,"scale":1.0},
            "capabilities":{"view":true,"control":false,"navigation":false,"tabs":false,"future":1},"future":2});
        let Some(Message::Control(Control::State {
            state,
            capabilities,
            ..
        })) = decode(&json_message(state)).unwrap().pop()
        else {
            panic!("not a state")
        };
        assert_eq!(state, Run::Running);
        let capabilities = capabilities.expect("the first state carries the capabilities");
        assert!(capabilities.view && !capabilities.control);
        assert!(
            decode(&json_message(json!({"type":"tabs","tabs":[]})))
                .unwrap()
                .is_empty(),
            "a message a later relay adds is skipped"
        );
        let long = |count: usize| "a".repeat(count);
        for (name, bad) in [
            (
                "a title over 512 characters",
                json!({"type":"page","title":long(513),"url":"u"}),
            ),
            (
                "an address over 2048 characters",
                json!({"type":"page","title":"t","url":long(2049)}),
            ),
            (
                "a page without an address",
                json!({"type":"page","title":"t"}),
            ),
            (
                "a title that is not text",
                json!({"type":"page","title":3,"url":"u"}),
            ),
            (
                "a reason with a space",
                json!({"type":"closed","reason":"Page Closed"}),
            ),
            ("an empty reason", json!({"type":"closed","reason":""})),
            (
                "a detail over 256 characters",
                json!({"type":"closed","reason":"X","detail":long(257)}),
            ),
            (
                "a count of zero",
                json!({"type":"refused","reason":"Unlisted","count":0}),
            ),
            (
                "a viewport the relay would refuse",
                json!({"type":"state","state":"running","browser":"C","viewport":{"width":50,"height":915},"capabilities":{}}),
            ),
            (
                "a state that is neither",
                json!({"type":"state","state":"flying","browser":"C","viewport":{"width":412,"height":915},"capabilities":{}}),
            ),
        ] {
            assert_eq!(decode(&json_message(bad)).err(), Some(Violation), "{name}");
        }
    }

    #[test]
    fn what_the_renderer_receives_is_only_what_was_validated() {
        let message = decode(&json_message(
            json!({"type":"closed","reason":"BrowserExited","detail":"x","secret":"y"}),
        ))
        .unwrap()
        .pop();
        let Some(Message::Control(control)) = message else {
            panic!("not a control")
        };
        assert_eq!(
            serde_json::to_value(&control).unwrap(),
            json!({"type":"closed","reason":"BrowserExited","detail":"x"})
        );
        assert_eq!(
            serde_json::to_value(Control::closed("Stopped")).unwrap(),
            json!({"type":"closed","reason":"Stopped"})
        );
    }

    #[test]
    fn client_messages_use_the_relay_framing() {
        assert_eq!(
            client_message(&encode(&json!({"type":"pause"}))),
            json!({"type":"pause"})
        );
    }

    #[test]
    fn viewports_are_bounded_like_the_relays() {
        let viewport = |width, height, scale| Viewport {
            width,
            height,
            scale,
        };
        assert!(viewport(412, 915, 1.0).valid() && viewport(412, 915, 3.0).valid());
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
