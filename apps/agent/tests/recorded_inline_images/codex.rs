use super::*;

fn image(bytes: &[u8], mime: &str) -> Value {
    json!({"type":"input_image","image_url":format!("data:{mime};base64,{}",STANDARD.encode(bytes)),"detail":"auto"})
}
fn message(id: &str, role: &str, content: Vec<Value>) -> Value {
    json!({"timestamp":"2026-10-26T00:00:00Z","type":"response_item","payload":{"type":"message","id":id,"role":role,"content":content}})
}

#[test]
fn only_codex_top_level_user_data_urls_gain_original_preview_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout.jsonl");
    jsonl::write(
        &path,
        &[
            message(
                "owned-user",
                "user",
                vec![
                    json!({"type":"input_text","text":"Original text"}),
                    image(PNG, "image/png"),
                    image(JPEG, "image/jpeg"),
                ],
            ),
            message(
                "owned-assistant",
                "assistant",
                vec![image(PNG, "image/png")],
            ),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"tool","output":[image(PNG,"image/png")]}}),
            json!({"type":"response_item","payload":{"type":"image_generation_call","result":STANDARD.encode(PNG)}}),
        ],
    );
    let original = fs::read(&path).unwrap();
    let legacy =
        serde_json::to_value(read_page(&path, TranscriptAgent::Codex, 0, 100).unwrap()).unwrap();
    let mut admitted = serde_json::to_value(
        read_inline_images(&path, TranscriptAgent::Codex, 0, 100, false, None).unwrap(),
    )
    .unwrap();
    for (index, (bytes, mime)) in [(PNG, "image/png"), (JPEG, "image/jpeg")]
        .into_iter()
        .enumerate()
    {
        let block = &mut admitted["messages"][0]["blocks"][index + 1];
        recorded_image::assert_regions_preview(&block["imagePreview"], bytes, mime);
        block.as_object_mut().unwrap().remove("imagePreview");
    }
    assert_eq!(
        serde_json::to_vec(&admitted).unwrap(),
        serde_json::to_vec(&legacy).unwrap()
    );
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn references_unknown_aliases_and_invalid_data_urls_remain_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("inert.jsonl");
    let encoded = STANDARD.encode(PNG);
    let apng = include_bytes!("../../../client/e2e/fixtures/recorded-images/regions-animated.png");
    let mut blocks = vec![
        json!({"type":"input_image","file_id":"file-unresolved"}),
        json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":encoded}}),
    ];
    for url in [
        "https://never-fetch.invalid/image.png".to_owned(),
        "file:///never-read.png".into(),
        "/never-read.png".into(),
        format!("data:image/webp;base64,{encoded}"),
        format!("DATA:image/png;base64,{encoded}"),
        format!("data:image/png;charset=utf-8;base64,{encoded}"),
        "data:image/png;base64,%2Fbad".into(),
        format!("data:image/png;base64,{}", "AAAA".repeat(16385)),
        format!("data:image/png;base64,{}", STANDARD.encode(apng)),
        format!("data:image/jpeg;base64,{encoded}"),
    ] {
        blocks.push(json!({"type":"input_image","image_url":url}));
    }
    for alias in ["image", "image_url", "file"] {
        let mut block = image(PNG, "image/png");
        block["type"] = json!(alias);
        blocks.push(block);
    }
    for block in blocks {
        jsonl::write(
            &path,
            &[message(
                "fallback",
                "user",
                vec![
                    json!({"type":"input_text","text":"Keep literal text"}),
                    block,
                ],
            )],
        );
        let admitted =
            read_inline_images(&path, TranscriptAgent::Codex, 0, 50, false, None).unwrap();
        let legacy = read_page(&path, TranscriptAgent::Codex, 0, 50).unwrap();
        assert_eq!(
            serde_json::to_value(admitted).unwrap(),
            serde_json::to_value(legacy).unwrap()
        );
    }
    // A Codex-shaped block cannot gain preview bytes in the Claude format either.
    jsonl::write(
        &path,
        &[json!({"type":"user","uuid":"claude","message":{"content":[image(PNG,"image/png")]}})],
    );
    assert_eq!(
        serde_json::to_value(
            read_inline_images(&path, TranscriptAgent::Claude, 0, 50, false, None).unwrap()
        )
        .unwrap(),
        serde_json::to_value(read_page(&path, TranscriptAgent::Claude, 0, 50).unwrap()).unwrap()
    );
}

#[test]
fn paging_charges_data_bytes_without_changing_ids_offsets_or_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("paged-rollout.jsonl");
    let content = image(&recorded_image::noisy_png(), "image/png");
    let ids: Vec<_> = (0..30)
        .map(|index| format!("codex-image-{index}"))
        .collect();
    let records: Vec<_> = ids
        .iter()
        .map(|id| message(id, "user", vec![content.clone()]))
        .collect();
    jsonl::write(&path, &records);
    let original = fs::read(&path).unwrap();
    let (returned, offset) = recorded_image::collect_image_ids(&path, TranscriptAgent::Codex);
    assert_eq!(returned, ids);
    assert_eq!(offset, original.len() as u64);
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn codex_cli_image_opt_in_rejects_non_record_and_checkpoint_combinations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cli-rollout.jsonl");
    jsonl::write(
        &path,
        &[message("cli-user", "user", vec![image(PNG, "image/png")])],
    );
    let run = |args: &[&str]| recorded_image::transcript("codex", &path, args);
    let legacy = run(&[]);
    assert!(legacy.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&legacy.stdout).unwrap(),
        serde_json::to_value(read_page(&path, TranscriptAgent::Codex, 0, 50).unwrap()).unwrap()
    );
    let explicit = run(&["--inline-images"]);
    assert!(explicit.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&explicit.stdout).unwrap(),
        serde_json::to_value(
            read_inline_images(&path, TranscriptAgent::Codex, 0, 50, false, None).unwrap()
        )
        .unwrap()
    );
    for extra in [
        vec!["--view", "conversation"],
        vec!["--checkpointed"],
        vec!["--checkpoint", "invalid"],
        vec!["--session-id", "other"],
    ] {
        recorded_image::assert_rejected("codex", &path, &extra);
    }
}
