use lazysh_account_usage::{from_wire, normalize, OUTPUT_LIMIT};
use serde_json::{json, Value};
fn fixture(rows: Vec<Value>) -> Value {
    json!({"schema_version":1,"primary":"openai@work","entries":[{"id":"openai@work","name":"Codex","display_name":"Codex work","short_name":"OAI","plan":"Pro","status":"ready","error":null,"stale":false,"fetched_at":"2026-10-30T15:00:00Z","sections":rows,"reset_credits":{"available":2,"credits":[{"title":"Weekly reset","expires_at":"2026-11-02T01:00:00Z","token_id":"NEVER-SEND"}]}}]})
}
fn metric() -> Value {
    json!({"type":"metric","label":"Weekly","percent":112,"percent_precise":112.5,"value":"112.5%","detail":"Provider-reported quota","headline":"percent","reset_at":"2026-11-01T00:00:00Z","window_secs":604800})
}
fn normalized(raw: Value) -> Value {
    serde_json::to_value(normalize(&serde_json::to_vec(&raw).unwrap(), "builtin")).unwrap()
}
#[test]
fn precise_quota_resets_and_credit_inventory_survive_without_credentials() {
    let result = normalized(fixture(vec![metric()]));
    assert_eq!(result["source"], "builtin");
    let entry = &result["report"]["entries"][0];
    let row = &entry["rows"][0];
    assert_eq!(row["percent"], 112.5);
    assert_eq!(row["reading"], "used");
    assert_eq!(row["windowSeconds"], 604800);
    assert_eq!(entry["resetCredits"]["available"], 2);
    assert!(!result.to_string().contains("NEVER-SEND"));
    let wire = from_wire(&serde_json::to_vec(&result).unwrap());
    assert_eq!(wire.state, "ready");
}
#[test]
fn context_unknown_text_errors_paths_and_activity_are_dropped_positive_allowlist() {
    let mut context = metric();
    context["group"] = json!("Sessions");
    context["label"] = json!("PRIVATE PROMPT");
    let mut raw = fixture(vec![
        context,
        json!({"type":"text","label":"Prompt","value":"SECRET"}),
        json!({"type":"text","label":"API key","value":"SECRET"}),
        json!({"type":"text","label":"/private/raw/path","value":"SECRET"}),
        json!({"type":"text","label":"Activity","value":"2 working"}),
        json!({"type":"block","label":"Context","body":["SECRET"]}),
        json!({"type":"text","label":"Credits","value":"123.4"}),
    ]);
    raw["entries"][0]["error"] = json!("Bearer SECRET /private/raw/path");
    raw["entries"][0]["activity"] = json!({"working":2});
    let result = normalized(raw);
    let rows = result["report"]["entries"][0]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["value"], "123.4");
    assert!(!result.to_string().contains("SECRET"));
    assert!(!result.to_string().contains("PRIVATE PROMPT"));
    assert!(!result.to_string().contains("private/raw/path"));
}
#[test]
fn known_balance_only_and_uncapped_spend_rows_do_not_invent_percentages() {
    let labels = [
        "Balance",
        "Available balance",
        "Amount used",
        "Subscription credits",
        "Top-up credits",
        "Total usable credits",
        "Spend (mo)",
        "Overage balance",
        "Extra usage balance",
        "On-Demand",
    ];
    let result = normalized(fixture(
        labels
            .iter()
            .map(|label| json!({"type":"text","label":label,"value":"$12.30"}))
            .collect(),
    ));
    let rows = result["report"]["entries"][0]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), labels.len());
    assert!(rows.iter().all(|r| r["percent"].is_null()));
    let mut refill = metric();
    refill["reading"] = json!("left");
    refill["headline"] = json!("value");
    refill["value"] = json!("$12.30");
    refill["regen"] = json!("2%");
    refill["model_pool"] = json!(true);
    let result = normalized(fixture(vec![refill]));
    let row = &result["report"]["entries"][0]["rows"][0];
    assert_eq!(row["reading"], "left");
    assert_eq!(row["headline"], "value");
    assert_eq!(row["modelPool"], true);
}
#[test]
fn unsupported_schema_oversized_and_contradictory_reports_fail_closed() {
    let mut bad = fixture(vec![metric()]);
    bad["schema_version"] = json!(2);
    assert_eq!(normalized(bad)["state"], "invalid_report");
    assert_eq!(
        normalize(&vec![b' '; OUTPUT_LIMIT + 1], "builtin").state,
        "invalid_report"
    );
    let mut repeated = fixture(vec![metric()]);
    let clone = repeated["entries"][0].clone();
    repeated["entries"].as_array_mut().unwrap().push(clone);
    assert_eq!(normalized(repeated)["state"], "invalid_report");
    let mut bad = fixture(vec![metric()]);
    bad["entries"][0]["sections"][0]["label"] = json!("quota\u{1b}[0m");
    assert_eq!(
        normalized(bad)["report"]["entries"][0]["rows"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}
#[test]
fn unknown_or_impossible_timestamps_remain_unknown() {
    let mut raw = fixture(vec![metric()]);
    raw["entries"][0]["fetched_at"] = json!("2026-02-31T00:00:00Z");
    raw["entries"][0]["sections"][0]["reset_at"] = Value::Null;
    let result = normalized(raw);
    assert!(result["report"]["entries"][0]["fetchedAt"].is_null());
    assert!(result["report"]["entries"][0]["rows"][0]["resetAt"].is_null());
}

#[test]
fn malformed_companion_wire_rejects_times_windows_money_and_duplicate_accounts() {
    let valid = normalized(fixture(vec![
        metric(),
        json!({"type":"text","label":"On-Demand","value":"$2 / $10","used_cents":200,"limit_cents":1000,"percent":20}),
    ]));
    let paths = [
        "/report/entries/0/fetchedAt",
        "/report/entries/0/rows/0/resetAt",
        "/report/entries/0/resetCredits/credits/0/expiresAt",
    ];
    for path in paths {
        let mut bad = valid.clone();
        *bad.pointer_mut(path).unwrap() = json!("2026-02-31T00:00:00Z");
        assert_eq!(
            from_wire(&serde_json::to_vec(&bad).unwrap()).state,
            "invalid_report"
        );
    }
    for (path, value) in [
        ("/report/entries/0/rows/0/windowSeconds", json!(0)),
        ("/report/entries/0/rows/0/windowSeconds", json!(u64::MAX)),
        ("/report/entries/0/rows/1/usedCents", json!(-1)),
        (
            "/report/entries/0/rows/1/limitCents",
            json!(9_007_199_254_740_992i64),
        ),
    ] {
        let mut bad = valid.clone();
        *bad.pointer_mut(path).unwrap() = value;
        assert_eq!(
            from_wire(&serde_json::to_vec(&bad).unwrap()).state,
            "invalid_report"
        );
    }
    let mut bad = valid.clone();
    let duplicate = bad["report"]["entries"][0].clone();
    bad["report"]["entries"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert_eq!(
        from_wire(&serde_json::to_vec(&bad).unwrap()).state,
        "invalid_report"
    );
}
