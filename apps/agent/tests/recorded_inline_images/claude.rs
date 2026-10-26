use super::*;

fn image(bytes: &[u8], mime: &str) -> Value {
    json!({"type":"image","source":{"type":"base64","media_type":mime,"data":STANDARD.encode(bytes)}})
}
fn message(id: &str, parent: Option<&str>, role: &str, blocks: Vec<Value>) -> Value {
    json!({"type":role,"uuid":id,"parentUuid":parent,"message":{"role":role,"content":blocks}})
}
fn page(path: &std::path::Path, branch: bool, images: bool) -> Value {
    let result = match (branch, images) {
        (true, true) => claude_conversation_images(path, 100),
        (true, false) => conversation(path, TranscriptAgent::Claude, 100),
        (false, true) => read_inline_images(path, TranscriptAgent::Claude, 0, 100, false, None),
        (false, false) => read_page(path, TranscriptAgent::Claude, 0, 100),
    };
    serde_json::to_value(result.unwrap()).unwrap()
}

#[test]
fn only_top_level_user_base64_images_gain_bytes_in_both_views() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned-session.jsonl");
    let records = [
        message(
            "root",
            None,
            "user",
            vec![
                json!({"type":"text","text":"Original text"}),
                image(PNG, "image/png"),
                image(JPEG, "image/jpeg"),
            ],
        ),
        message(
            "assistant",
            Some("root"),
            "assistant",
            vec![image(PNG, "image/png")],
        ),
        message(
            "tool",
            Some("assistant"),
            "user",
            vec![
                json!({"type":"tool_result","tool_use_id":"owned","content":[image(PNG,"image/png")]}),
            ],
        ),
    ];
    jsonl::write(&path, &records);
    let original = fs::read(&path).unwrap();
    for branch in [false, true] {
        let legacy = page(&path, branch, false);
        let mut admitted = page(&path, branch, true);
        for (index, (bytes, mime)) in [(PNG, "image/png"), (JPEG, "image/jpeg")]
            .into_iter()
            .enumerate()
        {
            let preview = &admitted["messages"][0]["blocks"][index + 1]["imagePreview"];
            recorded_image::assert_regions_preview(preview, bytes, mime);
            admitted["messages"][0]["blocks"][index + 1]
                .as_object_mut()
                .unwrap()
                .remove("imagePreview");
        }
        // No assistant or nested tool preview, and no other output change.
        assert_eq!(
            serde_json::to_vec(&admitted).unwrap(),
            serde_json::to_vec(&legacy).unwrap()
        );
    }
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn unsupported_and_invalid_claude_sources_keep_metadata_and_neighboring_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fallback.jsonl");
    let valid = image(PNG, "image/png");
    let mut sources = vec![
        Value::Null,
        json!({"type":"url","url":"https://never-fetch.invalid/image.png"}),
        json!({"type":"file","path":"/never-read.png"}),
    ];
    for (mime, data) in [
        ("image/gif", STANDARD.encode(PNG)),
        ("image/png", "not-base64".into()),
        ("image/jpeg", STANDARD.encode(PNG)),
        ("image/png", "AAAA".repeat(16385)),
    ] {
        sources.push(json!({"type":"base64","media_type":mime,"data":data}));
    }
    for source in sources {
        let mut block = valid.clone();
        block["source"] = source;
        jsonl::write(
            &path,
            &[message(
                "only",
                None,
                "user",
                vec![json!({"type":"text","text":"Keep literal text"}), block],
            )],
        );
        for branch in [false, true] {
            assert_eq!(page(&path, branch, true), page(&path, branch, false));
        }
    }
}

#[test]
fn branch_selection_and_record_paging_preserve_exact_identity_and_offsets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("branches.jsonl");
    let mut side = message("side", None, "user", vec![image(PNG, "image/png")]);
    side["isSidechain"] = json!(true);
    let mut meta = message("meta", None, "user", vec![image(PNG, "image/png")]);
    meta["isMeta"] = json!(true);
    let records = [
        side,
        meta,
        message(
            "root",
            None,
            "user",
            vec![json!({"type":"text","text":"Root"})],
        ),
        message("old", Some("root"), "user", vec![image(PNG, "image/png")]),
        message("new", Some("root"), "user", vec![image(JPEG, "image/jpeg")]),
    ];
    jsonl::write(&path, &records);
    let branch = page(&path, true, true);
    assert_eq!(branch["branchId"], "new");
    assert_eq!(
        branch["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["root", "new"]
    );
    assert_eq!(
        branch["messages"][1]["blocks"][0]["imagePreview"]["data"],
        STANDARD.encode(JPEG)
    );
    let first = read_inline_images(&path, TranscriptAgent::Claude, 0, 1, false, None).unwrap();
    let next = read_inline_images(
        &path,
        TranscriptAgent::Claude,
        first.next_offset,
        100,
        false,
        None,
    )
    .unwrap();
    assert_eq!(first.messages[0]["id"], "root");
    assert_eq!(
        next.messages
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["old", "new"]
    );
    assert_eq!(next.next_offset, fs::metadata(&path).unwrap().len());
    assert!(!next.has_more);
}

#[test]
fn cli_opts_in_for_claude_without_allowing_checkpoint_or_selector_combinations() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cli-user.jsonl");
    jsonl::write(
        &path,
        &[message("user", None, "user", vec![image(PNG, "image/png")])],
    );
    let run = |args: &[&str]| recorded_image::transcript("claude", &path, args);
    for view in ["records", "conversation"] {
        let result = run(&["--view", view, "--inline-images"]);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let output: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(output, page(&path, view == "conversation", true));
        let legacy = run(&["--view", view]);
        assert!(legacy.status.success());
        assert_eq!(
            serde_json::from_slice::<Value>(&legacy.stdout).unwrap(),
            page(&path, view == "conversation", false)
        );
    }
    for extra in [
        vec!["--checkpointed"],
        vec!["--checkpoint", "invalid"],
        vec!["--session-id", "other"],
        vec!["--view", "conversation", "--offset", "1"],
    ] {
        recorded_image::assert_rejected("claude", &path, &extra);
    }
}

#[test]
fn both_views_charge_image_bytes_to_the_existing_output_budget() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bounded-images.jsonl");
    let content = image(&recorded_image::noisy_png(), "image/png");
    let ids: Vec<_> = (0..30).map(|index| format!("owned-{index}")).collect();
    let records: Vec<_> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            message(
                id,
                index.checked_sub(1).map(|parent| ids[parent].as_str()),
                "user",
                vec![content.clone()],
            )
        })
        .collect();
    jsonl::write(&path, &records);
    let (returned, offset) = recorded_image::collect_image_ids(&path, TranscriptAgent::Claude);
    assert_eq!(returned, ids);
    assert_eq!(offset, fs::metadata(&path).unwrap().len());
    let branch = claude_conversation_images(&path, 100).unwrap();
    assert!(branch.truncated);
    recorded_image::assert_image_page(&branch.messages);
    assert!(branch.messages.len() < 30);
    assert_eq!(branch.messages.last().unwrap()["id"], "owned-29");
}
