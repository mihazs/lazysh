//! Admission for explicitly requested inline PNG/JPEG bytes; never follows URIs.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageDecoder;
use serde_json::{json, Value};
use std::io::Cursor;

const MAX_ENCODED: usize = 64 * 1024;
const MAX_PIXELS: u64 = 1024 * 1024;

pub(super) fn admit(content: &Value) -> Option<Value> {
    if content["type"] != "image" {
        return None;
    }
    admit_base64(content["mimeType"].as_str()?, content["data"].as_str()?)
}

pub(super) fn admit_base64(mime: &str, data: &str) -> Option<Value> {
    if data.is_empty() || data.len() > MAX_ENCODED {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    if bytes.len() > 48 * 1024 || STANDARD.encode(&bytes) != data {
        return None;
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    // Decoder-specific advisory budget, not a hard peak-allocation cap (JPEG
    // progressive coefficient buffers are not all charged by image::Limits).
    limits.max_alloc = Some(8 * 1024 * 1024);
    let decoded = match mime {
        "image/png" => {
            let decoder =
                image::codecs::png::PngDecoder::with_limits(Cursor::new(&bytes), limits).ok()?;
            if decoder.is_apng().ok()? || !dimensions(decoder.dimensions()) {
                return None;
            }
            image::DynamicImage::from_decoder(decoder).ok()?
        }
        "image/jpeg" => {
            let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(&bytes)).ok()?;
            decoder.set_limits(limits).ok()?;
            if !dimensions(decoder.dimensions()) {
                return None;
            }
            image::DynamicImage::from_decoder(decoder).ok()?
        }
        _ => return None,
    };
    Some(json!({"mimeType":mime,"data":data,"width":decoded.width(),"height":decoded.height()}))
}

fn dimensions((width, height): (u32, u32)) -> bool {
    width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_PIXELS
}
