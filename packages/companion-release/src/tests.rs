use crate::{
    error::{Detail, Error, Kind},
    http::{allowed, recheck_body, recheck_reference, recheck_transport, Body},
    metadata::{select, Selection, MAX_BINARY},
    version,
};
use serde_json::{json, Value};

fn extensions(target: &str) -> &'static [&'static str] {
    match target {
        "linux-x64" => &["deb", "AppImage"],
        "windows-x64" => &["exe"],
        "android-google-arm64" | "android-foss-arm64" => &["apk"],
        "linux-agent-x64" | "linux-agent-arm64" | "macos-agent-x64" | "macos-agent-arm64" => {
            &["bin"]
        }
        "windows-agent-x64" => &["exe"],
        _ => unreachable!(),
    }
}
fn fixture() -> (Value, Value, Value) {
    let source = "a".repeat(40);
    let checksum = "b".repeat(64);
    let mut platforms = Vec::new();
    let mut assets = Vec::new();
    for target in [
        "linux-x64",
        "windows-x64",
        "android-google-arm64",
        "android-foss-arm64",
        "linux-agent-x64",
        "linux-agent-arm64",
        "macos-agent-x64",
        "macos-agent-arm64",
        "windows-agent-x64",
    ] {
        let files = extensions(target)
            .iter()
            .map(|ext| {
                let name = format!("lazysh-0.24.0-{target}.{ext}");
                assets.push(json!({"id":assets.len()+1,"name":name,"size":100,"digest":format!("sha256:{checksum}"),"state":"uploaded"}));
                json!({"name":name,"bytes":100,"sha256":checksum})
            })
            .collect::<Vec<_>>();
        platforms.push(json!({"schema":1,"sha":source,"version":"0.24.0","target":target,"signing":if target.starts_with("android"){"signed"}else if target.starts_with("macos"){"ad-hoc"}else{"unsigned"},"files":files}));
    }
    for name in [
        "release.json",
        "release-notes.md",
        "INSTALL-AND-UPDATE.md",
        "SHA256SUMS",
    ] {
        assets.push(json!({"id":assets.len()+1,"name":name,"size":100,"digest":format!("sha256:{checksum}"),"state":"uploaded"}));
    }
    (
        json!({"tag_name":"v0.24.0","draft":false,"prerelease":false,"assets":assets}),
        json!({"schema":1,"sha":source,"version":"0.24.0","platforms":platforms}),
        json!({"ref":"refs/tags/v0.24.0","object":{"type":"commit","sha":source}}),
    )
}
fn chosen_for(
    (release, manifest, reference): (Value, Value, Value),
    target: &str,
) -> crate::Result<Selection> {
    select(
        serde_json::from_value(release).unwrap(),
        serde_json::from_value(manifest).unwrap(),
        serde_json::from_value(reference).unwrap(),
        target,
        false,
    )
}
fn chosen(parts: (Value, Value, Value)) -> crate::Result<Selection> {
    chosen_for(parts, "linux-agent-x64")
}

#[tokio::test]
async fn recheck_failures_classify_status_body_and_json_without_remote_text() {
    for (status, code) in [(403, "403"), (429, "429"), (599, "599"), (600, "other")] {
        let response = http::Response::builder()
            .status(status)
            .header("x-private-header", "private-value")
            .body("private response body")
            .unwrap();
        assert_eq!(
            recheck_body(reqwest::Response::from(response))
                .await
                .err()
                .unwrap(),
            format!("status:{code}")
        );
    }
    for (body, length, code) in [("private-not-json", "16", "json"), ("{}", "17000", "body")] {
        let response = http::Response::builder()
            .header("content-length", length)
            .body(body)
            .unwrap();
        assert_eq!(
            recheck_body(reqwest::Response::from(response))
                .await
                .err()
                .unwrap(),
            code
        );
    }
}
#[test]
fn recheck_provenance_failures_are_closed_and_still_rejected() {
    let selection = chosen(fixture()).unwrap();
    for (field, code) in [("ref", "ref"), ("type", "type"), ("sha", "sha")] {
        let (_, _, mut reference) = fixture();
        if field == "ref" {
            reference[field] = json!("private-ref");
        } else {
            reference["object"][field] = json!("private-value");
        }
        assert_eq!(
            recheck_reference(serde_json::from_value(reference).unwrap(), &selection).unwrap_err(),
            code
        );
    }
    let (_, _, reference) = fixture();
    assert!(recheck_reference(serde_json::from_value(reference).unwrap(), &selection).is_ok());
    let invalid = reqwest::Client::new()
        .get("http://[private-invalid-url")
        .build()
        .unwrap_err();
    assert_eq!(recheck_transport(invalid), "transport:other");
}
#[test]
fn selected_receipt_source_tag_and_api_digest_must_agree() {
    let selection = chosen(fixture()).unwrap();
    assert_eq!(selection.version, "0.24.0");
    assert_eq!(selection.tag, "v0.24.0");
    assert_eq!(selection.asset_name, "lazysh-0.24.0-linux-agent-x64.bin");
    let expected = [
        Kind::Verification, // 0: tag points at another commit
        Kind::Unavailable,  // 1: annotated tag object
        Kind::Unavailable,  // 2: manifest version
        Kind::Unavailable,  // 3: platform not published
        Kind::Verification, // 4: GitHub digest differs from the receipt
        Kind::Verification, // 5: GitHub size differs from the receipt
        Kind::Unavailable,  // 6: larger than the cap
        Kind::Unavailable,  // 7: prerelease
        Kind::Unavailable,  // 8: duplicate asset
        Kind::Unavailable,  // 9: duplicate receipt
        Kind::Unavailable,  // 10: receipt schema
        Kind::Unavailable,  // 11: signing label of another platform
    ];
    for (mutation, kind) in expected.into_iter().enumerate() {
        let (mut r, mut m, mut t) = fixture();
        let selected = r["assets"]
            .as_array()
            .unwrap()
            .iter()
            .position(|v| v["name"] == "lazysh-0.24.0-linux-agent-x64.bin")
            .unwrap();
        match mutation {
            0 => t["object"]["sha"] = json!("c".repeat(40)),
            1 => t["object"]["type"] = json!("tag"),
            2 => m["version"] = json!("0.25.0"),
            3 => {
                m["platforms"].as_array_mut().unwrap().remove(4);
            }
            4 => r["assets"][selected]["digest"] = json!(format!("sha256:{}", "c".repeat(64))),
            5 => r["assets"][selected]["size"] = json!(101),
            6 => m["platforms"][4]["files"][0]["bytes"] = json!(MAX_BINARY + 1),
            7 => r["prerelease"] = json!(true),
            8 => {
                let duplicate = r["assets"][selected].clone();
                r["assets"].as_array_mut().unwrap().push(duplicate);
            }
            9 => {
                let duplicate = m["platforms"][4].clone();
                m["platforms"].as_array_mut().unwrap().push(duplicate);
            }
            10 => m["platforms"][4]["schema"] = json!(2),
            _ => m["platforms"][4]["signing"] = json!("ad-hoc"),
        }
        assert_eq!(
            chosen((r, m, t)).unwrap_err().kind,
            kind,
            "mutation {mutation}"
        );
    }
}
#[test]
fn disagreements_between_independent_sources_name_their_detail() {
    let (mut r, m, t) = fixture();
    let index = r["assets"]
        .as_array()
        .unwrap()
        .iter()
        .position(|v| v["name"] == "lazysh-0.24.0-linux-agent-x64.bin")
        .unwrap();
    r["assets"][index]["digest"] = json!(format!("sha256:{}", "c".repeat(64)));
    assert_eq!(
        chosen((r, m, t)).unwrap_err(),
        Error::verification(Detail::DigestMismatch)
    );
    let (mut r, m, t) = fixture();
    r["assets"][index]["size"] = json!(7);
    assert_eq!(
        chosen((r, m, t)).unwrap_err(),
        Error::verification(Detail::SizeMismatch)
    );
    let (r, m, mut t) = fixture();
    t["object"]["sha"] = json!("c".repeat(40));
    assert_eq!(
        chosen((r, m, t)).unwrap_err(),
        Error::verification(Detail::CommitMismatch)
    );
}
#[test]
fn every_published_agent_target_selects_its_own_extension() {
    for (target, name) in [
        ("linux-agent-arm64", "lazysh-0.24.0-linux-agent-arm64.bin"),
        ("macos-agent-x64", "lazysh-0.24.0-macos-agent-x64.bin"),
        ("macos-agent-arm64", "lazysh-0.24.0-macos-agent-arm64.bin"),
        ("windows-agent-x64", "lazysh-0.24.0-windows-agent-x64.exe"),
    ] {
        let selection = chosen_for(fixture(), target).unwrap();
        assert_eq!(
            (selection.target.as_str(), selection.asset_name.as_str()),
            (target, name)
        );
    }
    for target in [
        "linux-x64",
        "windows-x64",
        "android-google-arm64",
        "linux-agent-riscv64",
    ] {
        assert_eq!(
            chosen_for(fixture(), target).unwrap_err().kind,
            Kind::Unavailable
        );
    }
}
#[test]
fn unrelated_platforms_and_assets_do_not_change_selected_authority() {
    let (mut r, mut m, t) = fixture();
    m["platforms"].as_array_mut().unwrap().push(json!({"schema":1,"sha":"a".repeat(40),"version":"0.24.0","target":"macos-arm64","signing":"ad-hoc","files":[{"name":"lazysh-0.24.0-macos-arm64.dmg","bytes":1000000000,"sha256":"c".repeat(64)}]}));
    r["assets"].as_array_mut().unwrap().push(json!({"name":"lazysh-0.24.0-macos-arm64.dmg","id":999,"size":1000000000,"digest":format!("sha256:{}","c".repeat(64)),"state":"uploaded"}));
    r["assets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"unrelated-future-asset","opaque":"no authority"}));
    let selection = chosen((r, m, t)).unwrap();
    assert_eq!(selection.digest, "b".repeat(64));
    assert_eq!(selection.bytes, 100);
}
#[test]
fn url_boundaries_and_versions_do_not_admit_injection() {
    for bad in [
        "http://api.github.com",
        "https://api.github.com.evil.invalid",
        "https://user@api.github.com",
        "https://api.github.com:444",
        "https://release-assets.githubusercontent.com/#fragment",
    ] {
        assert!(!allowed(&bad.parse().unwrap()), "{bad}");
    }
    assert!(allowed(
        &"https://release-assets.githubusercontent.com/asset?signature=owned"
            .parse()
            .unwrap()
    ));
    for bad in ["01.2.3", "1.2.3-dev", "1.2.3/../../evil", "1.2", "1.2.3\n"] {
        assert!(version(bad).is_none());
    }
    assert_eq!(version("1.55.0"), Some([1, 55, 0]));
}
#[tokio::test]
async fn response_stream_rejects_truncation_extra_bytes_compression_and_size_headers() {
    for (length, expected, encoding) in [
        (3, 3, None),
        (2, 3, None),
        (4, 3, None),
        (3, 3, Some("gzip")),
    ] {
        let mut builder = http::Response::builder().status(200);
        if let Some(encoding) = encoding {
            builder = builder.header("content-encoding", encoding);
        }
        let response = reqwest::Response::from(builder.body(vec![b'x'; length]).unwrap());
        let result = async {
            let mut body = Body::new(response, 3, Some(expected))?;
            while body.chunk().await?.is_some() {}
            Ok::<(), Error>(())
        }
        .await;
        assert_eq!(result.is_ok(), length == 3 && encoding.is_none());
    }
    let response = reqwest::Response::from(
        http::Response::builder()
            .header("content-length", "999")
            .body(vec![0; 1])
            .unwrap(),
    );
    assert_eq!(
        Body::new(response, 3, None).err().unwrap(),
        Error::verification(Detail::SizeMismatch)
    );
}
