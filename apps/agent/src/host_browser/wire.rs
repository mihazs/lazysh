//! The relay's wire format on one SSH exec channel (docs/host-browser.md, "Relay wire format").
//!
//! Both directions carry messages of `length:u32be tag:u8 body`, where `length` counts the tag and the body. Tag
//! 1 is a UTF-8 JSON object. Tag 2, relay to client only, is a frame: a 20 byte header and the JPEG bytes
//! as they are, never base64.
use serde::Deserialize;
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
        (100..=2048).contains(&self.width)
            && (100..=2048).contains(&self.height)
            && (1.0..=3.0).contains(&self.scale)
            && (self.width as f32 * self.height as f32 * self.scale * self.scale) <= 8_000_000.0
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
