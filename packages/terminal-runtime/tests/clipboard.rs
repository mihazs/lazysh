//! OSC 52 through the core against what the consent flow is offered today
//! (`fixtures/osc52.json`; `apps/client/src/osc52Fixture.test.ts` records `decodeClipboardRequest`'s
//! answers for the same requests and fails if they drift).

mod support;

use lazysh_terminal_runtime::{clipboard_consent_text, MAX_CLIPBOARD_TEXT_BYTES};
use serde_json::Value;
use support::*;

#[test]
fn osc52_requests_reach_the_consent_flow_as_they_do_today() {
    let path = format!("{}/fixtures/osc52.json", env!("CARGO_MANIFEST_DIR"));
    let json: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for case in json["cases"].as_array().unwrap() {
        let (id, data) = (case["id"].as_str().unwrap(), case["data"].as_str().unwrap());
        let mut rt = runtime(20, 3);
        feed(&mut rt, format!("\x1b]52;{data}\x07").as_bytes());
        let events = rt.take_events();
        let offered: Vec<String> = events
            .clipboard_writes
            .iter()
            .filter_map(|payload| clipboard_consent_text(payload))
            .collect();
        // Where libghostty-vt decides differently, the fixture says how and why (and it must differ).
        let core = &case["core"];
        let text = if core.is_object() {
            &core["text"]
        } else {
            &case["text"]
        };
        if core.is_object() {
            assert!(
                core["text"] != case["text"] && !core["why"].as_str().unwrap().is_empty(),
                "{id}: a recorded divergence must differ and say why"
            );
        }
        let expected: Vec<&str> = text.as_str().into_iter().collect();
        assert_eq!(offered, expected, "{id}: {data:.40}");
        assert!(
            rt.take_replies().0.is_empty(),
            "{id}: a clipboard request is never answered"
        );
    }
}

#[test]
fn the_bound_is_the_decoded_size() {
    assert!(clipboard_consent_text(&vec![b'a'; MAX_CLIPBOARD_TEXT_BYTES]).is_some());
    assert!(clipboard_consent_text(&vec![b'a'; MAX_CLIPBOARD_TEXT_BYTES + 1]).is_none());
    assert!(
        clipboard_consent_text(&[0xff, 0x41]).is_none(),
        "invalid UTF-8 is dropped whole"
    );
    assert_eq!(clipboard_consent_text(b"a\0b").as_deref(), Some("a\0b"));
}
