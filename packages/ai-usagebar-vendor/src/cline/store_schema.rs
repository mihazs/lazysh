//! Structural admission for Cline 3.0.74 (071e1b25), not authentication proof.
//! Mirrors StoredProviderSettingsSchema and its imported ProviderSettingsSchema.
use serde_json::Value;
type Check = fn(&Value) -> bool;
fn object(value: &Value, fields: &[(&str, Check)]) -> bool {
    value.is_object()
        && fields
            .iter()
            .all(|(key, check)| value.get(key).is_none_or(*check))
}
fn record(value: &Value, check: Check) -> bool {
    value.as_object().is_some_and(|map| map.values().all(check))
}
fn one_of(value: &Value, choices: &[&str]) -> bool {
    value.as_str().is_some_and(|text| choices.contains(&text))
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn provider_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.bytes()
                .enumerate()
                .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && c == b'-'))
    })
}
fn positive_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0)
}
fn url(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| reqwest::Url::parse(super::trim_cli(s)).is_ok())
}
fn digits(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0, |n, c| {
        c.is_ascii_digit().then(|| n * 10 + u32::from(c - b'0'))
    })
}
fn datetime(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let b = text.as_bytes();
    if b.len() < 17 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b.last() != Some(&b'Z') {
        return false;
    }
    let (Some(year), Some(month), Some(day)) =
        (digits(&b[..4]), digits(&b[5..7]), digits(&b[8..10]))
    else {
        return false;
    };
    if chrono::NaiveDate::from_ymd_opt(year as i32, month, day).is_none() {
        return false;
    }
    let t = &b[11..b.len() - 1];
    if t.len() < 5
        || t[2] != b':'
        || digits(&t[..2]).is_none_or(|n| n > 23)
        || digits(&t[3..5]).is_none_or(|n| n > 59)
    {
        return false;
    }
    if t.len() == 5 {
        return true;
    }
    if t.len() < 8 || t[5] != b':' || digits(&t[6..8]).is_none_or(|n| n > 59) {
        return false;
    }
    t.len() == 8 || (t.len() > 9 && t[8] == b'.' && t[9..].iter().all(u8::is_ascii_digit))
}
fn auth(value: &Value) -> bool {
    object(
        value,
        &[
            ("apiKey", Value::is_string),
            ("accessToken", Value::is_string),
            ("refreshToken", Value::is_string),
            ("expiresAt", positive_integer),
            ("accountId", Value::is_string),
            ("organizationId", Value::is_string),
            ("organizationName", Value::is_string),
            ("memberId", Value::is_string),
            ("metadata", Value::is_object),
        ],
    )
}
fn reasoning(value: &Value) -> bool {
    object(
        value,
        &[
            ("enabled", Value::is_boolean),
            ("effort", |v| {
                one_of(
                    v,
                    &["none", "minimal", "low", "medium", "high", "xhigh", "max"],
                )
            }),
            ("budgetTokens", positive_integer),
        ],
    )
}
fn aws(value: &Value) -> bool {
    object(
        value,
        &[
            ("accessKey", Value::is_string),
            ("secretKey", Value::is_string),
            ("sessionToken", Value::is_string),
            ("region", Value::is_string),
            ("profile", Value::is_string),
            ("authentication", |v| {
                one_of(v, &["iam", "api-key", "apikey", "profile"])
            }),
            ("usePromptCache", Value::is_boolean),
            ("useCrossRegionInference", Value::is_boolean),
            ("useGlobalInference", Value::is_boolean),
            ("endpoint", url),
            ("customModelBaseId", Value::is_string),
        ],
    )
}
fn gcp(value: &Value) -> bool {
    object(
        value,
        &[
            ("projectId", Value::is_string),
            ("region", Value::is_string),
        ],
    )
}
fn azure(value: &Value) -> bool {
    object(
        value,
        &[
            ("apiVersion", Value::is_string),
            ("useIdentity", Value::is_boolean),
        ],
    )
}
fn sap(value: &Value) -> bool {
    object(
        value,
        &[
            ("clientId", Value::is_string),
            ("clientSecret", Value::is_string),
            ("tokenUrl", url),
            ("resourceGroup", Value::is_string),
            ("deploymentId", Value::is_string),
            ("useOrchestrationMode", Value::is_boolean),
            ("api", |v| {
                one_of(v, &["orchestration", "foundation-models"])
            }),
            ("defaultSettings", Value::is_object),
        ],
    )
}
fn oca(value: &Value) -> bool {
    object(
        value,
        &[
            ("mode", |v| one_of(v, &["internal", "external"])),
            ("usePromptCache", Value::is_boolean),
        ],
    )
}
fn catalog(value: &Value) -> bool {
    object(
        value,
        &[
            ("loadLatestOnInit", Value::is_boolean),
            ("includeClineCloudModels", Value::is_boolean),
            ("loadPrivateOnAuth", Value::is_boolean),
            ("url", url),
            ("cacheTtlMs", positive_integer),
            ("failOnError", Value::is_boolean),
        ],
    )
}
fn settings(value: &Value) -> bool {
    value.get("provider").is_some_and(provider_id)
        && object(
            value,
            &[
                ("apiKey", Value::is_string),
                ("auth", auth),
                ("model", Value::is_string),
                ("protocol", |v| {
                    one_of(
                        v,
                        &[
                            "anthropic",
                            "gemini",
                            "openai-chat",
                            "openai-responses",
                            "openai-r1",
                            "ai-sdk",
                        ],
                    )
                }),
                ("client", |v| {
                    one_of(
                        v,
                        &[
                            "anthropic",
                            "ai-sdk",
                            "ai-sdk-community",
                            "openai",
                            "openai-compatible",
                            "openai-r1",
                            "gemini",
                            "bedrock",
                            "custom",
                            "fetch",
                            "vertex",
                        ],
                    )
                }),
                ("routingProviderId", provider_id),
                ("maxTokens", positive_integer),
                ("contextWindow", positive_integer),
                ("baseUrl", url),
                ("headers", |v| record(v, Value::is_string)),
                ("timeout", positive_integer),
                ("reasoning", reasoning),
                ("aws", aws),
                ("gcp", gcp),
                ("azure", azure),
                ("sap", sap),
                ("oca", oca),
                ("region", Value::is_string),
                ("apiLine", |v| one_of(v, &["china", "international"])),
                ("capabilities", |v| {
                    v.as_array().is_some_and(|a| {
                        a.iter().all(|x| {
                            one_of(
                                x,
                                &[
                                    "reasoning",
                                    "prompt-cache",
                                    "streaming",
                                    "tools",
                                    "vision",
                                    "computer-use",
                                    "oauth",
                                    "popular",
                                ],
                            )
                        })
                    })
                }),
                ("modelCatalog", catalog),
            ],
        )
}
fn entry(value: &Value) -> bool {
    value.get("settings").is_some_and(settings)
        && value.get("updatedAt").is_some_and(datetime)
        && object(
            value,
            &[("tokenSource", |v| {
                one_of(v, &["manual", "oauth", "migration"])
            })],
        )
}
fn voice(value: &Value) -> bool {
    value.is_object()
        && ["providerId", "modelId"]
            .iter()
            .all(|key| value.get(key).is_some_and(nonempty))
}
pub(super) fn valid(value: &Value) -> bool {
    value.get("version").and_then(Value::as_f64) == Some(1.0)
        && value.get("providers").is_some_and(|v| record(v, entry))
        && object(
            value,
            &[
                ("lastUsedProvider", nonempty),
                ("modes", |v| object(v, &[("voiceInput", voice)])),
                ("repairs", |v| {
                    object(v, &[("bedrockProfile", Value::is_boolean)])
                }),
            ],
        )
}
