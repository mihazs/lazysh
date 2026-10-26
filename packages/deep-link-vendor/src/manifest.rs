// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use super::config::AssociatedDomain;

// TODO: Consider using activity-alias in case users may have multiple activities in their app.
pub(crate) fn intent_filter(domain: &AssociatedDomain) -> String {
    let data = [
        ("scheme", domain.scheme.as_slice()),
        ("host", domain.host.as_slice()),
        ("path", domain.path.as_slice()),
        ("pathPattern", domain.path_pattern.as_slice()),
        ("pathPrefix", domain.path_prefix.as_slice()),
        ("pathSuffix", domain.path_suffix.as_slice()),
    ]
    .into_iter()
    .flat_map(|(attribute, values)| {
        values
            .iter()
            .map(move |value| format!(r#"<data android:{attribute}="{value}" />"#))
    })
    .collect::<Vec<_>>()
    .join("\n    ");

    let auto_verify = if domain.is_app_link() {
        r#"android:autoVerify="true" "#.to_string()
    } else {
        String::new()
    };

    format!(
        r#"<intent-filter {auto_verify}>
    <action android:name="android.intent.action.VIEW" />
    <!-- ChromeOS ARC++ uses a different action for deep links -->
    <action android:name="org.chromium.arc.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    {data}
</intent-filter>"#,
    )
    .trim()
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_scheme_omits_empty_optional_lines_without_losing_actions() {
        let domain = serde_json::from_str(r#"{"scheme":["lazysh"],"appLink":false}"#).unwrap();
        let xml = intent_filter(&domain);
        assert!(xml.lines().all(|line| !line.trim().is_empty()));
        assert!(xml.contains(r#"<data android:scheme="lazysh" />"#));
        for action in [
            "android.intent.action.VIEW",
            "org.chromium.arc.intent.action.VIEW",
        ] {
            assert!(xml.contains(&format!(r#"<action android:name="{action}" />"#)));
        }
        assert!(!xml.contains("autoVerify"));
    }

    #[test]
    fn populated_fields_keep_every_attribute_when_optional_lines_are_removed() {
        let domain = serde_json::from_str(
            r#"{
            "scheme":["https","http"],"host":"example.invalid","appLink":true,
            "path":["/exact"],"pathPattern":["/pattern/.*"],
            "pathPrefix":["/prefix"],"pathSuffix":[".suffix"]
        }"#,
        )
        .unwrap();
        let xml = intent_filter(&domain);
        for attribute in [
            "autoVerify=\"true\"",
            "scheme=\"https\"",
            "scheme=\"http\"",
            "host=\"example.invalid\"",
            "path=\"/exact\"",
            "pathPattern=\"/pattern/.*\"",
            "pathPrefix=\"/prefix\"",
            "pathSuffix=\".suffix\"",
        ] {
            assert!(xml.contains(&format!("android:{attribute}")), "{attribute}");
        }
        assert!(xml.lines().all(|line| !line.trim().is_empty()));
    }

    #[test]
    fn multiline_and_whitespace_attribute_values_are_not_filtered() {
        let domain = serde_json::from_value(serde_json::json!({
            "scheme": ["lazysh"], "appLink": false,
            "path": ["/one\n    \n/two", "   "],
            "pathPattern": ["\n\n"], "pathPrefix": ["/prefix\t "], "pathSuffix": [" "]
        }))
        .unwrap();
        let xml = intent_filter(&domain);
        for (attribute, value) in [
            ("path", "/one\n    \n/two"),
            ("path", "   "),
            ("pathPattern", "\n\n"),
            ("pathPrefix", "/prefix\t "),
            ("pathSuffix", " "),
        ] {
            assert!(xml.contains(&format!(r#"<data android:{attribute}="{value}" />"#)));
        }
        let scheme = xml.find("android:scheme=").unwrap();
        let path = xml.find("android:path=").unwrap();
        let pattern = xml.find("android:pathPattern=").unwrap();
        let prefix = xml.find("android:pathPrefix=").unwrap();
        let suffix = xml.find("android:pathSuffix=").unwrap();
        assert!(scheme < path && path < pattern && pattern < prefix && prefix < suffix);
    }
}
