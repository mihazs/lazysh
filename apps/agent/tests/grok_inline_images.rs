use base64::{engine::general_purpose::STANDARD, Engine};
use lazysh_agent::transcript::{read_grok_images, read_page, TranscriptAgent};
use serde_json::{json, Value};
use std::{fs, io::Cursor, process::Command};
const PNG: &[u8] = include_bytes!("../../client/e2e/fixtures/recorded-images/regions.png");
const JPEG: &[u8] =
    include_bytes!("../../client/e2e/fixtures/recorded-images/regions-orientation6.jpg");
const PROGRESSIVE: &[u8] =
    include_bytes!("../../client/e2e/fixtures/recorded-images/regions-progressive.jpg");
const APNG: &[u8] =
    include_bytes!("../../client/e2e/fixtures/recorded-images/regions-animated.png");
fn image(bytes: &[u8], mime: &str) -> Value {
    json!({"type":"image","mimeType":mime,"data":STANDARD.encode(bytes),"uri":"https://never-fetched.invalid/private"})
}
fn event(content: Value) -> Value {
    json!({"timestamp":1,"method":"session/update","params":{"sessionId":"owned-image","update":{"sessionUpdate":"user_message_chunk","content":content}}})
}
#[path = "support/jsonl.rs"]
mod jsonl;

fn source() -> (tempfile::TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("updates.jsonl");
    (directory, path)
}

#[test]
fn preview_admission_is_explicit_keeps_original_bytes_and_legacy_output_inert() {
    let (_directory, path) = source();
    for (bytes, mime) in [
        (PNG, "image/png"),
        (JPEG, "image/jpeg"),
        (PROGRESSIVE, "image/jpeg"),
    ] {
        jsonl::write(&path, &[event(image(bytes, mime))]);
        let before = fs::read(&path).unwrap();
        let legacy = read_page(&path, TranscriptAgent::GrokAcp, 0, 50).unwrap();
        assert!(legacy.messages[0]["blocks"][0]
            .get("imagePreview")
            .is_none());
        let admitted = read_grok_images(&path, 0, 50, false, None).unwrap();
        let preview = &admitted.messages[0]["blocks"][0]["imagePreview"];
        assert_eq!(preview["data"], STANDARD.encode(bytes));
        assert_eq!(preview["mimeType"], mime);
        assert_eq!(
            (preview["width"].as_u64(), preview["height"].as_u64()),
            (Some(32), Some(16))
        );
        assert!(preview.get("uri").is_none());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[test]
fn corrupt_oversize_animated_and_other_media_remain_metadata_without_hiding_text() {
    let (_directory, path) = source();
    let mut wrong = image(PNG, "image/jpeg");
    wrong["data"] = json!("not-base64");
    let mut audio = image(PNG, "image/png");
    audio["type"] = json!("audio");
    let mut over = image(PNG, "image/png");
    over["data"] = json!("AAAA".repeat(16385));
    let mut sizes = Vec::new();
    for (w, h) in [(2049, 1), (2048, 1024)] {
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(w, h)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        sizes.push(image(&encoded.into_inner(), "image/png"));
    }
    for content in [
        wrong,
        audio,
        over,
        image(APNG, "image/png"),
        image(&PNG[..PNG.len() / 2], "image/png"),
        image(PNG, "image/jpeg"),
        json!({"type":"image","uri":"file:///must-not-read.png"}),
    ]
    .into_iter()
    .chain(sizes)
    {
        jsonl::write(
            &path,
            &[
                event(json!({"type":"text","text":"Keep original text"})),
                event(content),
            ],
        );
        let page = read_grok_images(&path, 0, 50, false, None).unwrap();
        assert_eq!(page.messages.len(), 2);
        assert_eq!(page.messages[0]["blocks"][0]["text"], "Keep original text");
        assert_eq!(page.messages[1]["blocks"][0]["type"], "image");
        assert!(page.messages[1]["blocks"][0].get("imagePreview").is_none());
    }
    let tool = json!({"timestamp":1,"method":"session/update","params":{"sessionId":"owned-image","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool","content":[{"type":"content","content":image(PNG,"image/png")}],"status":"completed"}}});
    jsonl::write(&path, &[tool]);
    let page = read_grok_images(&path, 0, 50, false, None).unwrap();
    assert!(page.messages[0]["blocks"][0].get("imagePreview").is_none());
}

#[cfg(unix)]
#[test]
fn image_records_preserve_checkpoint_offsets_and_continuation() {
    let (_directory, path) = source();
    jsonl::write(
        &path,
        &[
            event(image(PNG, "image/png")),
            event(image(JPEG, "image/jpeg")),
        ],
    );
    let first = read_grok_images(&path, 0, 1, true, None).unwrap();
    assert!(first.has_more);
    let next = read_grok_images(
        &path,
        first.next_offset,
        1,
        true,
        first.checkpoint.as_deref(),
    )
    .unwrap();
    assert!(!next.has_more);
    assert_eq!(next.next_offset, fs::metadata(&path).unwrap().len());
    assert!(next.messages[0]["blocks"][0]["imagePreview"].is_object());
}

#[test]
fn admitted_data_is_charged_to_existing_page_budget_without_skipping_images() {
    let mut seed = 0x12345678u32;
    let pixels = image::RgbImage::from_fn(120, 100, |_, _| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        image::Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8])
    });
    let mut encoded = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let row = event(image(&encoded.into_inner(), "image/png"));
    let (_directory, path) = source();
    jsonl::write(&path, &vec![row; 30]);
    let mut cursor = 0;
    let mut total = 0;
    loop {
        let page = read_grok_images(&path, cursor, 100, false, None).unwrap();
        assert!(!page.messages.is_empty());
        assert!(serde_json::to_vec(&page.messages).unwrap().len() < 512 * 1024);
        assert!(page
            .messages
            .iter()
            .all(|row| row["blocks"][0]["imagePreview"].is_object()));
        total += page.messages.len();
        assert!(page.next_offset > cursor);
        cursor = page.next_offset;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(total, 30);
}

#[test]
fn cli_rejects_unsupported_options_and_legacy_json_is_unchanged() {
    let (_directory, path) = source();
    jsonl::write(&path, &[event(image(PNG, "image/png"))]);
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(["transcript", "--path"])
            .arg(&path)
            .args(args)
            .output()
            .unwrap()
    };
    let legacy = run(&["--agent", "grok-acp"]);
    assert!(legacy.status.success());
    let parsed: Value = serde_json::from_slice(&legacy.stdout).unwrap();
    assert_eq!(
        parsed,
        serde_json::to_value(read_page(&path, TranscriptAgent::GrokAcp, 0, 50).unwrap()).unwrap()
    );
    let included = run(&["--agent", "grok-acp", "--inline-images"]);
    assert!(included.status.success());
    assert!(
        serde_json::from_slice::<Value>(&included.stdout).unwrap()["messages"][0]["blocks"][0]
            ["imagePreview"]
            .is_object()
    );
    for args in [
        vec!["--agent", "claude", "--inline-images"],
        vec![
            "--agent",
            "grok-acp",
            "--inline-images",
            "--view",
            "conversation",
        ],
        vec![
            "--agent",
            "grok-acp",
            "--inline-images",
            "--session-id",
            "recording",
        ],
    ] {
        let result = run(&args);
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }
}
