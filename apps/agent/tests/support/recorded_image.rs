use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

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
