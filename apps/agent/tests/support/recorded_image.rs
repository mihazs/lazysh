use base64::{engine::general_purpose::STANDARD, Engine};
use lazysh_agent::transcript::{read_inline_images, TranscriptAgent};
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Output},
};

pub const PNG: &[u8] = include_bytes!("../../../client/e2e/fixtures/recorded-images/regions.png");
pub const JPEG: &[u8] =
    include_bytes!("../../../client/e2e/fixtures/recorded-images/regions-orientation6.jpg");

pub fn transcript(agent: &str, path: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
        .args(["transcript", "--agent", agent, "--path"])
        .arg(path)
        .args(args)
        .output()
        .unwrap()
}

pub fn assert_rejected(agent: &str, path: &Path, extra: &[&str]) {
    let mut args = vec!["--inline-images"];
    args.extend_from_slice(extra);
    let result = transcript(agent, path, &args);
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
}

pub fn collect_image_ids(path: &Path, agent: TranscriptAgent) -> (Vec<String>, u64) {
    let mut offset = 0;
    let mut ids = Vec::new();
    loop {
        let page = read_inline_images(path, agent, offset, 100, false, None).unwrap();
        assert!(page.next_offset > offset);
        assert_image_page(&page.messages);
        ids.extend(
            page.messages
                .iter()
                .map(|row| row["id"].as_str().unwrap().to_owned()),
        );
        offset = page.next_offset;
        if !page.has_more {
            break;
        }
    }
    (ids, offset)
}

pub fn assert_image_page(messages: &[Value]) {
    assert!(!messages.is_empty());
    assert!(serde_json::to_vec(messages).unwrap().len() < 512 * 1024);
    assert!(messages
        .iter()
        .all(|row| row["blocks"][0]["imagePreview"].is_object()));
}

pub fn assert_regions_preview(preview: &Value, bytes: &[u8], mime: &str) {
    assert_eq!(preview["data"], STANDARD.encode(bytes));
    assert_eq!(preview["mimeType"], mime);
    assert_eq!(
        (preview["width"].as_u64(), preview["height"].as_u64()),
        (Some(32), Some(16))
    );
}

pub fn noisy_png() -> Vec<u8> {
    let mut seed = 0x12345678u32;
    let pixels = image::RgbImage::from_fn(120, 100, |_, _| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        image::Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8])
    });
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    encoded.into_inner()
}
