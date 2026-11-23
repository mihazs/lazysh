# VT conformance fixtures

Replayable byte streams with the screen, cursor, modes, terminal replies and events they must produce
([#1314](https://github.com/mihazs/lazysh/issues/1314)). One set of files, two engines:

- **xterm.js 5.5.0** (the behaviour lazysh ships today): `apps/client/src/xterm/vtConformance.test.ts`, in the
  normal `client` vitest run, on a terminal mounted in jsdom as the app mounts it (only a mounted terminal has a
  theme to answer colour queries with). `expect` is what xterm produced; the test fails if xterm changes. The core is
  given xterm.js's default theme (`xterm_theme()` in `tests/support/mod.rs`) so its colour replies can match.
- **The core** (`lazysh-terminal-runtime` on libghostty-vt): `tests/vt_fixtures.rs`, in the
  `herdr-native` job. The core must produce `expect`, or the fixture carries a `core` block naming
  why it does not.

## Layout

| Path | Contents |
| --- | --- |
| `vt/*.json` | Arrays of screen fixtures, one file per category (SGR, cursor, erase/edit, edge cases, wrapping and scrollback, Unicode, alternate screen, modes and queries, paste, events, resize, TUI streams, captures, Mosh frames) |
| `keys.json` | Key presses: a W3C `key`/`code`/modifiers and the exact bytes xterm sends, from a real `keydown` on a mounted terminal |
| `mouse.json` | Mouse reports: the protocol and encoding set by escape sequences, then events (`press left 5,2 ctrl`, `motion none 6,2 @64,45`, `wheel up 5,2`: type, button, 0-based cell, modifiers, optional surface pixel on a 10x20 pixel grid) and the exact bytes each one makes xterm send, one string per event |
| `captures/*.bin` | Raw pty streams of vim, less, tmux, Claude Code, Codex, OpenCode, Zellij and Herdr (`captures/README.md` has provenance and what was cut) |
| `divergences.json` | Every intentional difference between the engines: summary, rationale, status |

A screen fixture is `{id, about, cols, rows, scrollback, steps, probes, expect, core?}`. Steps are
`write` (UTF-8 text), `writeBase64`, `writeFile` (a path under this directory), `resize` and `paste`.
`probes` are cells whose width, text, colours and attributes are compared. `expect` holds the visible
lines (trailing blanks trimmed), cursor, active buffer, the modes both engines expose, scrollback row
count, the probed cells, every byte the terminal sent back (replies and paste output) and bell/OSC 52
events. `core.expect` replaces the listed keys only for the core, and `core.divergence` must name
entries of `divergences.json`; a test fails if a divergence is unused, unlisted, or equals xterm's value.

## Changing a fixture

Edit the JSON, then regenerate xterm's side and review the diff like any other change:

```sh
cd apps/client && UPDATE_VT_FIXTURES=1 bunx vitest run src/xterm/vtConformance.test.ts   # rewrites `expect` (xterm)
```

For the core, run `tests/vt_fixtures.rs` (the README at `packages/terminal-runtime` has the build recipe);
`VT_FIXTURES_DUMP=<file>` writes what the core observed for every fixture, to write `core.expect` from.
A difference is never fixed by editing `expect` to match the core: it is either a fixture mistake or an
entry in `divergences.json` with a reason.

## Divergences

`divergences.json` has 29 entries, none open. Every entry but `osc52-target-letters` was reviewed on 2026-11-18 (#1314, slice
1314b), and that one on 2026-11-22 (#1314); the ones that decide something a user or a program could notice carry a `status` that says what was decided
and an `evidence` field that names the test or fixture that pins it. The user-visible approvals are the Unicode 11
and later widths and the grapheme and colour-scheme modes that go with them, the standard Alt+arrow encodings, reflow
on resize, the OSC 52 selection filter, the Kitty keyboard protocol for Codex and Herdr, libghostty-vt's device
attributes and the terminator of colour replies; the release notes of the Android default (#2094) must call out the
widths, the Alt+arrow form, reflow, the dropped primary-selection writes and the three OSC 52 target differences. `shift-pageup-handled-by-host` was closed on
2026-11-19 by #1334 (slice 1334a): the native input editor scrolls the history on Shift+PageUp and Shift+PageDown and never
sends them to the core. The last one, `osc52-target-letters` (a write to `ccc` dropped, an unknown
target letter offered, an empty write not queued; `osc52.json` records each request), was accepted on 2026-11-22: the VT cannot see the
letters, no program lazysh targets sends them, and what is offered is only an offer to approve or refuse. The release notes of the Android default (#2094) name
them with the dropped primary-selection writes. Explicit zero counts, parameterless tab clears and
DECXCPR are accepted because no program lazysh targets sends them (`tests/programs` scans every capture and every
live run); they should be reported to Ghostty with the fixtures as the reproduction, which this repository does not do.

`tests/programs/main.rs` is the real-program half of the review: tmux, vim, bash, Herdr, Claude Code, Codex and
OpenCode run on a pty with the core as their terminal, the core's replies go back to them and the keys it encodes
reach them, and each test asserts what the program then did. tmux, vim, bash and Herdr are required in CI (set
`LAZYSH_TEST_<NAME>` to a path, for example `LAZYSH_TEST_HERDR`, when the program is not on the `PATH`); an agent TUI
that is not installed skips its test. Linux only; the macOS, Windows, iOS and Android hosts have no such run.

Mouse reports match xterm.js event for event except for the 1005 and 1015 encodings, which only the core
implements (`mouse-extended-encodings-honoured`). Finding that comparison also fixed a core defect: the core
sent a motion report for every pointer event in a cell where xterm.js sends one (a resting pointer would
have flooded the pty under any-event tracking); `tests/conformance.rs` pins the fix.

## Replay time (by-product measurement)

Measured on the Linux x86_64 development host (not a device, not the baseline of `terminal-benchmarks.md`): the xterm.js suite
(194 tests, jsdom included) reported 1.20 to 1.87 s in three `vitest run` invocations; the core suite (91 screens, 75 key presses,
130 mouse events, in a debug build) reported 0.03 s in three `cargo test --test vt_fixtures` runs. The two numbers measure
different things (jsdom start-up and a DOM-mounted terminal versus the bare core), so they are not a speed comparison of the engines.

## What is not here

- Signed-in sessions of Claude Code, Codex and OpenCode doing work (streamed replies, tool cards, diffs).
  Those need an account and a network, and a capture would hold a prompt and a response. The captures are
  first-run screens (theme picker, login menus, the OpenCode home screen), which exercise the same escape
  sequences, modes and queries; `vt/tui-streams.json` holds synthetic streams shaped like the live-region
  redraws.
- The DOM half of xterm.js's mouse handling (pixel to cell conversion, Shift+click forcing a selection
  instead of a report, wheel to arrow keys in the alternate screen when no mouse mode is on): jsdom has no
  layout. The mouse fixtures drive `CoreMouseService`, the encoder `bindMouse` feeds, directly. The native
  adapter owns those host decisions.
- Key encodings under Kitty keyboard flags: xterm.js does not implement the protocol, so there is nothing to compare.
  The core's own golden encodings (Ctrl and Alt chords, release and repeat events, the alternate-key and text flags)
  are in `tests/conformance.rs` and `tests/keys.rs` (#1316).
- The canonical (non-reflowing, host-applied) Mosh resize of #1317: `vt/mosh-frames.json` replays frames 2, 3 and 6 each after
  a plain resize, and all six captured frames in the order the e2e spec feeds them (`mosh-frames-in-order`, ending with one more
  shrink), which both engines render identically. That is what a plain resize does with Mosh's repeated redraws, not the
  canonical resize.
- Android, iOS, Windows and macOS: both suites ran on Linux only.
