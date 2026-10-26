// SPDX-License-Identifier: GPL-3.0-or-later

// Exercise the actual build-time renderer through the app's existing Cargo
// integration-test structure; the vendored package is not a workspace member.
#[allow(dead_code)]
mod config {
    use tauri::utils as tauri_utils;
    include!("../src/config.rs");
}

#[path = "../src/manifest.rs"]
mod manifest;

#[test]
fn host_deserialization_preserves_plain_optional_and_rejected_scheme_values() {
    for host in [
        serde_json::Value::Null,
        serde_json::json!("example.invalid"),
    ] {
        let value = serde_json::json!({"scheme":["lazysh"],"host":host,"appLink":false});
        let domain: config::AssociatedDomain = serde_json::from_value(value).unwrap();
        assert_eq!(domain.host.as_deref(), host.as_str());
    }
    let absent: config::AssociatedDomain =
        serde_json::from_str(r#"{"scheme":["lazysh"]}"#).unwrap();
    assert!(absent.host.is_none());
    let error = serde_json::from_value::<config::AssociatedDomain>(serde_json::json!({
        "scheme":["https"], "host":"https://example.invalid"
    }))
    .err()
    .expect("host schemes remain rejected");
    assert_eq!(error.to_string(), "host `https://example.invalid` cannot start with a scheme, please remove the `https://` prefix");
}
