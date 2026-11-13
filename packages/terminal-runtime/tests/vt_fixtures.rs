//! Replays every fixture in `fixtures/vt` through the core and compares what a renderer, the
//! transport and the host would observe with the fixture's `expect`. The same files are replayed
//! through xterm.js 5.5.0 by `apps/client/src/vtConformance.test.ts`, so any difference between the
//! two engines is a recorded `core` divergence with a reason, never a silent edit.

mod support;

use base64::Engine;
use lazysh_terminal_runtime::{
    default_palette, dom_mods, ffi, CellColor, CellWide, Config, DomKey, KeyInput, MouseInput,
    RgbColor, Size, TerminalRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use support::{lines, CELL_H, CELL_W};

#[derive(Deserialize)]
#[serde(untagged)]
enum Step {
    Write {
        write: String,
    },
    WriteBase64 {
        #[serde(rename = "writeBase64")]
        write_base64: String,
    },
    WriteFile {
        #[serde(rename = "writeFile")]
        write_file: String,
    },
    Resize {
        resize: (u16, u16),
    },
    Paste {
        paste: String,
    },
}

/// Where the core knowingly differs from xterm.js: ids into `fixtures/divergences.json` and the
/// core's own expectation (a partial observation for screens, the bytes sent for keys).
#[derive(Deserialize)]
struct Divergence<T> {
    divergence: Vec<String>,
    expect: T,
}

impl<T> Divergence<T> {
    fn checked(&self, what: &str, registry: &BTreeMap<String, Value>) -> &T {
        assert!(
            !self.divergence.is_empty()
                && self.divergence.iter().all(|id| registry.contains_key(id)),
            "{what}: divergences must name entries of fixtures/divergences.json"
        );
        &self.expect
    }
}

/// What the core must produce: xterm's `expect`, or the listed divergence, which may not equal it.
fn core_expectation<'a, T: PartialEq>(
    id: &str,
    xterm: &'a T,
    core: &'a Option<Divergence<T>>,
    registry: &BTreeMap<String, Value>,
) -> &'a T {
    match core {
        Some(divergence) => {
            let expected = divergence.checked(id, registry);
            assert!(
                expected != xterm,
                "{id}: the divergence equals xterm's value"
            );
            expected
        }
        None => xterm,
    }
}

#[derive(Deserialize)]
struct Fixture {
    id: String,
    cols: u16,
    rows: u16,
    steps: Vec<Step>,
    #[serde(default)]
    probes: Vec<(u16, u16)>,
    expect: Value,
    core: Option<Divergence<serde_json::Map<String, Value>>>,
}

#[derive(Serialize)]
struct Observation {
    lines: Vec<String>,
    cursor: Cursor,
    buffer: &'static str,
    modes: Modes,
    #[serde(rename = "scrollbackRows")]
    scrollback_rows: usize,
    cells: Vec<Cell>,
    data: String,
    events: Events,
}

#[derive(Serialize)]
struct Cursor {
    x: u16,
    y: u16,
}

#[derive(Serialize)]
struct Modes {
    #[serde(rename = "bracketedPaste")]
    bracketed_paste: bool,
    #[serde(rename = "applicationCursorKeys")]
    application_cursor_keys: bool,
    #[serde(rename = "mouseTracking")]
    mouse_tracking: bool,
    #[serde(rename = "sendFocus")]
    send_focus: bool,
}

#[derive(Serialize)]
struct Cell {
    x: u16,
    y: u16,
    text: String,
    width: u8,
    fg: String,
    bg: String,
    flags: Vec<&'static str>,
}

#[derive(Serialize)]
struct Events {
    bell: u16,
    osc52: Vec<String>,
}

/// A style colour, or for a blank cell erased with a colour the resolved background, which
/// libghostty-vt keeps in the cell rather than the style: named by its palette index when it is
/// one of the default palette's colours.
fn color(color: Option<CellColor>, resolved: Option<RgbColor>) -> String {
    let color = color.or_else(|| {
        let rgb = resolved?;
        match default_palette().iter().position(|entry| *entry == rgb) {
            Some(index) => Some(CellColor::Palette(index as u8)),
            None => Some(CellColor::Rgb(rgb)),
        }
    });
    match color {
        None => "default".into(),
        Some(CellColor::Palette(index)) => format!("p:{index}"),
        Some(CellColor::Rgb(rgb)) => format!("rgb:{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b),
    }
}

/// The full observation a sparse `expect` stands for: fixtures store only what differs from a
/// quiet terminal (all modes off, nothing sent, no events), the same defaults the xterm side uses.
fn dense(sparse: &Value) -> Value {
    let mut full = serde_json::json!({
        "buffer": "normal", "scrollbackRows": 0, "cells": [], "data": "",
        "events": {"bell": 0, "osc52": []},
        "modes": {"bracketedPaste": false, "applicationCursorKeys": false, "mouseTracking": false, "sendFocus": false},
    });
    for (key, value) in sparse.as_object().expect("expect is an object") {
        match (full.get_mut(key), value) {
            (Some(Value::Object(base)), Value::Object(over)) => base.extend(over.clone()),
            _ => {
                full[key] = value.clone();
            }
        }
    }
    full
}

fn observe(fixture: &Fixture) -> Value {
    let mut runtime = TerminalRuntime::new(Config {
        size: Size::new(fixture.cols, fixture.rows),
        ..Config::default()
    })
    .expect("runtime");
    let (mut data, mut events) = (
        Vec::new(),
        Events {
            bell: 0,
            osc52: Vec::new(),
        },
    );
    for step in &fixture.steps {
        let bytes = match step {
            Step::Write { write } => write.as_bytes().to_vec(),
            Step::WriteBase64 { write_base64 } => base64::engine::general_purpose::STANDARD
                .decode(write_base64)
                .expect("base64"),
            Step::WriteFile { write_file } => std::fs::read(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("fixtures")
                    .join(write_file),
            )
            .expect("capture"),
            Step::Resize { resize } => {
                runtime
                    .request_size(Size::new(resize.0, resize.1))
                    .expect("resize");
                continue;
            }
            Step::Paste { paste } => {
                data.extend(runtime.encode_paste(paste).expect("paste"));
                continue;
            }
        };
        support::feed(&mut runtime, &bytes);
        data.extend(runtime.take_replies().0);
    }
    let taken = runtime.take_events();
    events.bell = taken.bell;
    events.osc52 = taken
        .clipboard_writes
        .iter()
        .map(|payload| String::from_utf8_lossy(payload).into_owned())
        .collect();
    let modes = runtime.modes().expect("modes");
    let scrollback_rows = runtime.scrollback_rows().expect("scrollback");
    let frame = runtime.snapshot().expect("snapshot");
    let cursor = frame.cursor.viewport.map_or((0, 0), |at| (at.x, at.y));
    let cells = fixture
        .probes
        .iter()
        .map(|&(x, y)| {
            let row = frame.dirty.iter().find(|row| row.y == y).expect("row");
            let cell = &row.cells[usize::from(x)];
            let style = &cell.style;
            let flags = [
                ("bold", style.bold),
                ("italic", style.italic),
                ("underline", style.underlined),
                ("inverse", style.inverse),
                ("faint", style.faint),
                ("strikethrough", style.strikethrough),
                ("invisible", style.invisible),
                ("blink", style.blink),
            ]
            .into_iter()
            .filter_map(|(name, on)| on.then_some(name))
            .collect();
            Cell {
                x,
                y,
                text: cell.text.clone(),
                width: match cell.wide {
                    CellWide::Narrow => 1,
                    CellWide::Wide => 2,
                    _ => 0,
                },
                fg: color(style.fg_color, cell.fg),
                bg: color(style.bg_color, cell.bg),
                flags,
            }
        })
        .collect();
    serde_json::to_value(Observation {
        lines: lines(&frame),
        cursor: Cursor {
            x: cursor.0,
            y: cursor.1,
        },
        buffer: if modes.alternate_screen {
            "alternate"
        } else {
            "normal"
        },
        modes: Modes {
            bracketed_paste: modes.bracketed_paste,
            application_cursor_keys: modes.application_cursor_keys,
            mouse_tracking: modes.mouse_tracking,
            send_focus: modes.focus_events,
        },
        scrollback_rows,
        cells,
        data: String::from_utf8_lossy(&data).into_owned(),
        events,
    })
    .expect("observation")
}

/// Every intentional difference from xterm.js, with the reason and who has to approve it.
fn divergences() -> BTreeMap<String, Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/divergences.json");
    let all: BTreeMap<String, Value> =
        serde_json::from_slice(&std::fs::read(path).expect("divergences.json")).expect("parse");
    for (id, entry) in &all {
        for field in ["summary", "rationale", "status"] {
            assert!(
                entry[field].as_str().is_some_and(|text| text.len() > 10),
                "{id}: missing {field}"
            );
        }
    }
    all
}

fn fixtures() -> Vec<(String, Fixture)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/vt");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("fixtures/vt")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .flat_map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let all: Vec<Fixture> =
                serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("parse");
            all.into_iter().map(move |fixture| (name.clone(), fixture))
        })
        .collect()
}

#[test]
fn the_core_matches_every_fixture_or_records_why_it_differs() {
    let registry = divergences();
    let (mut failures, mut dump) = (Vec::new(), serde_json::Map::new());
    let all = fixtures();
    assert!(all.len() >= 90, "fixtures went missing: {}", all.len());
    for (file, fixture) in &all {
        let observed = observe(fixture);
        dump.insert(fixture.id.clone(), observed.clone());
        let mut expected = dense(&fixture.expect);
        if let Some(divergence) = &fixture.core {
            for (key, value) in divergence.checked(&format!("{file}/{}", fixture.id), &registry) {
                assert_ne!(
                    &expected[key.as_str()],
                    value,
                    "{file}/{}: the {key} divergence equals xterm's value; remove it",
                    fixture.id
                );
                expected[key.as_str()] = value.clone();
            }
        }
        if observed != expected {
            let differing: Vec<_> = expected
                .as_object()
                .expect("object")
                .iter()
                .filter(|(key, value)| observed.get(key.as_str()) != Some(*value))
                .map(|(key, value)| {
                    format!(
                        "  {key}: expected {value}\n  {} observed {}",
                        " ".repeat(key.len()),
                        observed[key.as_str()]
                    )
                })
                .collect();
            failures.push(format!("{file}/{}\n{}", fixture.id, differing.join("\n")));
        }
    }
    if let Some(path) = std::env::var_os("VT_FIXTURES_DUMP") {
        // Authoring aid: what the core observed for every fixture, to write `core.expect` from.
        std::fs::write(path, serde_json::to_vec_pretty(&dump).unwrap()).unwrap();
    }
    assert!(
        failures.is_empty(),
        "{} fixture(s) differ:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[derive(Deserialize)]
struct KeyFixture {
    id: String,
    setup: String,
    key: String,
    code: String,
    mods: Vec<String>,
    expect: String,
    core: Option<Divergence<String>>,
}

fn key_fixtures() -> Vec<KeyFixture> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/keys.json");
    serde_json::from_slice(&std::fs::read(path).expect("keys.json")).expect("parse")
}

#[test]
fn the_core_encodes_every_key_like_xterm_or_records_why_not() {
    let registry = divergences();
    let all = key_fixtures();
    let mut failures = Vec::new();
    for fixture in &all {
        let mut runtime = TerminalRuntime::new(Config::default()).expect("runtime");
        support::feed(&mut runtime, fixture.setup.as_bytes());
        let has = |name: &str| fixture.mods.iter().any(|held| held == name);
        let sent = runtime
            .encode_key(&KeyInput::from_dom(DomKey {
                code: &fixture.code,
                key: &fixture.key,
                mods: dom_mods(has("shift"), has("ctrl"), has("alt"), has("meta")),
                ..DomKey::default()
            }))
            .expect("encode");
        let expected = core_expectation(&fixture.id, &fixture.expect, &fixture.core, &registry);
        if sent != expected.as_bytes() {
            failures.push(format!(
                "{}: xterm sends {:?}, expected from the core {:?}, core sent {:?}",
                fixture.id,
                fixture.expect,
                expected,
                String::from_utf8_lossy(&sent)
            ));
        }
        if let Some(path) = std::env::var_os("VT_FIXTURES_DUMP_KEYS") {
            let mut dump: serde_json::Map<String, Value> = std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            dump.insert(
                fixture.id.clone(),
                Value::String(String::from_utf8_lossy(&sent).into_owned()),
            );
            std::fs::write(path, serde_json::to_vec_pretty(&dump).unwrap()).unwrap();
        }
    }
    assert!(
        failures.is_empty(),
        "{} key(s) differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[derive(Deserialize)]
struct MouseFixture {
    id: String,
    cols: u16,
    rows: u16,
    setup: String,
    events: Vec<String>,
    expect: Vec<String>,
    core: Option<Divergence<Vec<String>>>,
}

fn mouse_fixtures() -> Vec<MouseFixture> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/mouse.json");
    serde_json::from_slice(&std::fs::read(path).expect("mouse.json")).expect("parse")
}

/// An event spec (see `apps/client/src/vtConformance.ts`) as the core's input.
fn mouse_input(spec: &str) -> MouseInput {
    let mut parts = spec.split(' ');
    let (kind, button, cell) = (
        parts.next().expect("type"),
        parts.next().expect("button"),
        parts.next().expect("cell"),
    );
    let (mut mods, mut pixel) = (0, None);
    for part in parts {
        if let Some(at) = part.strip_prefix('@') {
            let (x, y) = at.split_once(',').expect("pixel");
            pixel = Some((x.parse().expect("x"), y.parse().expect("y")));
        } else {
            mods = part.split('+').fold(0, |bits, name| {
                bits | match name {
                    "shift" => 1,
                    "ctrl" => 1 << 1,
                    "alt" => 1 << 2,
                    other => panic!("unknown modifier {other}"),
                }
            });
        }
    }
    let (col, row) = cell.split_once(',').expect("col,row");
    let (col, row): (f32, f32) = (col.parse().expect("col"), row.parse().expect("row"));
    let (x, y) = pixel.unwrap_or((
        col * CELL_W as f32 + CELL_W as f32 / 2.0,
        row * CELL_H as f32 + CELL_H as f32 / 2.0,
    ));
    let button = match (kind == "wheel", button) {
        (_, "none") => None,
        (false, "left") => Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_LEFT),
        (false, "middle") => Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_MIDDLE),
        (false, "right") => Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_RIGHT),
        (true, "up") => Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_FOUR),
        (true, "down") => Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_FIVE),
        (true, "left") => Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_SIX),
        (true, "right") => Some(ffi::GhosttyMouseButton_GHOSTTY_MOUSE_BUTTON_SEVEN),
        other => panic!("unknown button {other:?}"),
    };
    MouseInput {
        action: match kind {
            "release" => ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_RELEASE,
            "motion" => ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_MOTION,
            _ => ffi::GhosttyMouseAction_GHOSTTY_MOUSE_ACTION_PRESS,
        },
        button,
        mods,
        x,
        y,
    }
}

#[test]
fn the_core_reports_every_mouse_event_like_xterm_or_records_why_not() {
    let registry = divergences();
    let (all, mut failures) = (mouse_fixtures(), Vec::new());
    let mut dump = serde_json::Map::new();
    for fixture in &all {
        let mut runtime = support::runtime(fixture.cols, fixture.rows);
        support::feed(&mut runtime, fixture.setup.as_bytes());
        // One character per byte, like the xterm side: the default encoding sends bytes above 0x7f.
        let sent: Vec<String> = fixture
            .events
            .iter()
            .map(|spec| {
                let bytes = runtime.encode_mouse(mouse_input(spec)).expect("encode");
                bytes.iter().map(|&byte| char::from(byte)).collect()
            })
            .collect();
        dump.insert(fixture.id.clone(), serde_json::json!(sent));
        let expected = core_expectation(&fixture.id, &fixture.expect, &fixture.core, &registry);
        assert_eq!(expected.len(), fixture.events.len(), "{}", fixture.id);
        for (at, spec) in fixture.events.iter().enumerate() {
            if sent[at] != expected[at] {
                failures.push(format!(
                    "{} `{spec}`: xterm sends {:?}, expected from the core {:?}, core sent {:?}",
                    fixture.id, fixture.expect[at], expected[at], sent[at]
                ));
            }
        }
    }
    if let Some(path) = std::env::var_os("VT_FIXTURES_DUMP_MOUSE") {
        std::fs::write(path, serde_json::to_vec_pretty(&dump).unwrap()).unwrap();
    }
    assert!(
        failures.is_empty(),
        "{} mouse report(s) differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn every_listed_divergence_is_used_and_every_use_is_listed() {
    let registry = divergences();
    let keys = key_fixtures();
    let used: std::collections::BTreeSet<String> = fixtures()
        .into_iter()
        .filter_map(|(_, fixture)| fixture.core)
        .flat_map(|core| core.divergence)
        .chain(
            keys.into_iter()
                .filter_map(|key| key.core)
                .flat_map(|core| core.divergence),
        )
        .chain(
            mouse_fixtures()
                .into_iter()
                .filter_map(|mouse| mouse.core)
                .flat_map(|core| core.divergence),
        )
        .collect();
    let listed: std::collections::BTreeSet<String> = registry.keys().cloned().collect();
    assert_eq!(
        used, listed,
        "fixtures/divergences.json and the fixtures' `core` entries must agree"
    );
}
