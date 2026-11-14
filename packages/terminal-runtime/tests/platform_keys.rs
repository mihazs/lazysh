//! The keys that differ by platform (Option and AltGr typing a character, Option as Meta, the platform's word
//! movement), as the app's key mapping (`apps/client/src/terminalPlatformKeys.ts`) hands them to the core,
//! against what xterm.js 5.5.0 sends on that platform. The fixtures are written by
//! `apps/client/src/xterm/platformKeys.*.test.ts`, which also holds xterm.js to the bytes recorded here and the
//! mapping to the fixtures. A case either sends exactly what xterm.js sends or lists why it does not.
//! The directory comes from `LAZYSH_PLATFORM_KEYS_FIXTURES` or, in a checkout, its place in the repository.

mod support;

use lazysh_terminal_runtime::{dom_mods, DomKey, KeyInput};
use serde_json::Value;
use support::{feed, runtime};

fn fixtures() -> Vec<(String, Vec<Value>)> {
    let dir = std::env::var("LAZYSH_PLATFORM_KEYS_FIXTURES").unwrap_or_else(|_| {
        format!(
            "{}/../../apps/client/e2e/fixtures/platform-keys",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let mut platforms: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("fixtures {dir}: {err}"))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let json: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            (name, json.as_array().unwrap().clone())
        })
        .collect();
    platforms.sort_by(|a, b| a.0.cmp(&b.0));
    platforms
}

fn core_sends(input: &Value) -> Vec<u8> {
    let flag = |object: &Value, name: &str| object[name].as_bool().unwrap_or(false);
    let mods = &input["mods"];
    let mut rt = runtime(20, 4);
    feed(&mut rt, b"");
    let event = DomKey {
        code: input["code"].as_str().unwrap(),
        key: input["key"].as_str().unwrap(),
        mods: dom_mods(
            flag(mods, "shift"),
            flag(mods, "ctrl"),
            flag(mods, "alt"),
            flag(mods, "meta"),
        ),
        repeat: flag(input, "repeat"),
        release: flag(input, "release"),
        composing: flag(input, "composing"),
    };
    rt.encode_key(&KeyInput::from_dom(event)).unwrap()
}

#[test]
fn every_platform_has_cases_and_each_sends_what_xterm_js_sends_or_lists_why_not() {
    let platforms = fixtures();
    assert_eq!(
        platforms
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["mac", "other", "windows"]
    );
    for (platform, entries) in &platforms {
        assert!(!entries.is_empty(), "{platform} has no cases");
        for entry in entries {
            let name = entry["name"].as_str().unwrap();
            let (xterm, core) = (
                entry["xterm"].as_str().unwrap(),
                entry["core"].as_str().unwrap(),
            );
            let context = format!(
                "{platform}: {name} (option as meta: {})",
                entry["optionAsMeta"]
            );
            assert_eq!(
                core_sends(&entry["input"]),
                core.as_bytes(),
                "{context}: the core no longer sends what the fixture says it sends"
            );
            // The mapping changes an event exactly where the core, given the event as the browser fired it,
            // would not send what the core sends for the mapped one.
            if entry["raw"] != entry["input"] {
                assert_ne!(
                    core_sends(&entry["raw"]),
                    core.as_bytes(),
                    "{context}: the core handles the event as fired; drop the mapping for it"
                );
            }
            // Only a listed difference may send other bytes than xterm.js, and it must say why.
            assert_eq!(
                xterm != core,
                entry["why"].is_string(),
                "{context}: a case differs from xterm.js exactly when it carries a reason"
            );
        }
    }
}
