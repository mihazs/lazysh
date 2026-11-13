# VT conformance fixtures

Replayable byte streams with the screen, cursor, modes, terminal replies and events they must produce
([#1314](https://github.com/mihazs/lazysh/issues/1314)). One set of files, two engines:

- **xterm.js 5.5.0** (the behaviour lazysh ships today): `apps/client/src/vtConformance.test.ts`, in the
  normal `client` vitest run, on a terminal mounted in jsdom as the app mounts it (only a mounted terminal has a
  theme to answer colour queries with). `expect` is what xterm produced; the test fails if xterm changes.
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
cd apps/client && UPDATE_VT_FIXTURES=1 bunx vitest run src/vtConformance.test.ts   # rewrites `expect` (xterm)
```

For the core, run `tests/vt_fixtures.rs` (the README at `packages/terminal-runtime` has the build recipe);
`VT_FIXTURES_DUMP=<file>` writes what the core observed for every fixture, to write `core.expect` from.
A difference is never fixed by editing `expect` to match the core: it is either a fixture mistake or an
entry in `divergences.json` with a reason.

## Divergences

`divergences.json` has 28 entries (15 accepted, 13 open). Open ones are questions for the migration
gates, not approvals: the fixtures keep failing loudly if the core's behaviour moves, but nobody has
signed off the user-visible ones (Unicode widths and the grapheme and colour-scheme modes that go with them, explicit zero counts and parameterless tab clears (libghostty-vt deviates from the standard),
Alt+arrow encodings, the Kitty keyboard
protocol, theme colour queries, DA identity, the OSC 52 selection filter, DECXCPR, scrollback units, resize reflow). They are
tracked on #1314, #1316 and #1305.

Mouse reports match xterm.js event for event except for the 1005 and 1015 encodings, which only the core
implements (`mouse-extended-encodings-honoured`). Finding that comparison also fixed a core defect: the core
sent a motion report for every pointer event in a cell where xterm.js sends one (a resting pointer would
have flooded the pty under any-event tracking); `tests/conformance.rs` pins the fix.

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
- The canonical (non-reflowing, host-applied) Mosh resize of #1317: `vt/mosh-frames.json` replays three of the six
  captured frames (2, 3 and 6; 4, 5 and 7 redraw the same screens after different resize sequences, and the e2e
  spec covers them) after a plain resize, which both engines render identically.
- Android, iOS, Windows and macOS: both suites ran on Linux only.
