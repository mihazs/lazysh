# Android native terminal input

Status: **groundwork, developer builds only; nothing in the app creates it yet.** The soft keyboard, composition and hardware-key half of [#1328](https://github.com/mihazs/lazysh/issues/1328) (epic [#1302](https://github.com/mihazs/lazysh/issues/1302)) exists as a Kotlin bridge with JVM and in-process instrumentation tests. It is not connected to the shared core or to a surface, no renderer exists to show what it types, and touch scrolling, selection handles and the clipboard are not started. xterm.js stays the only engine and the default; no behaviour a user can reach changed. Related: [native rendering](native-rendering.md#input-and-ime) · [runtime](terminal-runtime.md) · [adapter](terminal-adapter.md) · [Android surface composition PoC](android-surface-composition-poc.md) · [migration plan](terminal-migration-plan.md).

## Decision: a native input connection, not a hidden DOM editor

The native surface has no DOM and, per the composition PoC, sits below the page, so every terminal gesture arrives in the DOM and is forwarded. A hidden `<textarea>` kept beside it would put the keyboard's editor back inside the WebView, which is where the keyboard problems #1328 lists live ([#602](https://github.com/mihazs/lazysh/issues/602), [#1214](https://github.com/mihazs/lazysh/issues/1214), [#1215](https://github.com/mihazs/lazysh/issues/1215), [#1245](https://github.com/mihazs/lazysh/issues/1245)): it depends on Chromium's `InputConnection`, on private xterm fields and on event ordering that differs per keyboard. The bridge is instead the keyboard's own editor, owned by the app: `TerminalInputView` is a focusable view whose `onCreateInputConnection` returns a connection backed by `TerminalImeEditor`, and whose `onKeyDown` and `onKeyUp` receive hardware keys. This is the implementation that the plan will carry to the opt-in stage; it is not a statement that the native engine is selected ([ADR 0001](adr-0001-terminal-runtime.md) stays Proposed).

## How an edit becomes terminal input

`TerminalImeEditor` is plain Kotlin (no Android types), so the connection and the JVM tests run the same instance. It is the native twin of `terminalIme.ts` and keeps its rules:

- **The keyboard edits a small local editor.** The remote command line only ever follows the *owned suffix* of it: the text typed since a key, Enter or a toolbar key last ended ownership. Whatever the keyboard changes, the bridge sends the shortest remote edit with the same effect: backspaces over the changed tail, then the new text. Every delivery updates what the remote line is known to hold, so the same change can never be sent twice.
- **Composition stays on the device.** Text in the composing region is never sent; it is delivered when the keyboard ends the composition (`commitText`, `finishComposingText`, or the end of a batch with no composing region left), as xterm.js delivers on `compositionend`. `composing` exposes the preedit for the surface to draw at the cursor.
- **Only plain ASCII is backspaced.** Erasing the end of the editor is a Backspace press, even over text a key made unowned. Any other change must keep the text before the owned suffix and may only erase printable ASCII: the peer owns erase units, so rolling back committed Unicode, or text before the owned suffix, is never guessed. Such an edit is surfaced as an `UnappliedEdit` (bounded to 64 KiB without splitting a supplementary character), nothing is replayed, and the editor starts again empty and tells the keyboard to read it again.
- **Enter.** A line break the keyboard commits as text (exactly `\n`) is sent as `\r`, verbatim in every keyboard mode ([#1043](https://github.com/mihazs/lazysh/issues/1043)). Enter sent as a key event is a key. Either ends ownership.
- **Keys.** A hardware key, or a key event the keyboard sends (Enter, Backspace, arrows), first delivers pending composition as typed, ends ownership and then goes to the terminal as a DOM-shaped key (`code`, `key`, Shift, Ctrl, Alt, Meta, repeat, release). Backspace and Delete also edit the local editor so the keyboard's next read matches the terminal, and Backspace over an empty editor still reaches the terminal. A modifier alone changes nothing. Android's Back, Home, volume and media keys are not the terminal's and stay with the system.
- **Focus.** Losing view or window focus drops the editor, composing text included, and delivers nothing. A closed connection (the keyboard restarting) commits what it was composing. While input is gated (locked, backgrounded, another renderer) nothing is delivered and the editor empties.

Editor setup follows the page's terminal editor: plain multi-line text without autocorrect or capitalisation and without an action key, and while Private keyboard is on, `PrivateKeyboard.INPUT_TYPE` with no personalised learning. The setting is read when the keyboard connects.

## What reaches the core

The bridge delivers through `TerminalInputSink`. Its two calls map onto the core that exists today ([runtime](terminal-runtime.md)): `key` becomes `KeyInput::from_dom(DomKey { code, key, mods, repeat, release, composing })` with `dom_mods`, so Shift+Enter, Ctrl+C and the protocols a program enabled are encoded by the core, which is held to what xterm.js sends and not by a byte table here; `text` becomes `KeyInput { key: UNIDENTIFIED, text }`, which the core sends verbatim in every mode, DEL erase units and CR included. The Android key codes use the US-layout `code` for each physical key, since Android reports no layout-independent position; the layout's text rides in `key`.

## Tests and what they establish

| Test | Runs | Establishes |
|---|---|---|
| `TerminalImeEditorTest` (23, JVM) | `:app:testUniversalDebugUnitTest` | The fixed `OwnedImeService` transactions (autocorrect, tail extension, ASCII erase, repeated word, prediction, swipe, composing Backspace, replace previous, SwiftKey's web profile) leave the remote line equal to the editor at every step; composition is never sent; no change is sent twice; identical consecutive commands are both sent; non-ASCII and earlier-line erasures are staged, not replayed; bounds; gating; key ordering. |
| `TerminalKeysTest` (9, JVM) | same | Shift+Enter is the Enter key with Shift and not text; Ctrl+C keeps `c` as its key; named, function, keypad and punctuation keys; system keys are refused; no two Android keys share a DOM code. |
| `NativeTerminalInputTest` (8, instrumentation) | `bun run test:android` stage | The real `InputConnection` and `KeyEvent` classes: editor setup, the same transactions replayed in `OwnedImeService`'s order with its expected reads, `getSurroundingText` on API 31 and later, Enter as key event or text, hardware shortcuts, focus loss. |

Run on Waydroid (Android 13, API 33, x86_64, host AMD GPU): `NativeTerminalInputTest` `OK (8 tests)`.

## Not established

- **Gboard and SwiftKey.** The instrumentation replays the transactions in the process. The real keyboard process, the remote `InputConnection` proxy of `OwnedImeService` and both keyboards are not exercised, so the first acceptance criterion of #1328 is not met: it needs a physical device.
- **Wiring.** No view is created, attached to the surface host or given a sink; no Kotlin to Rust delivery path exists, and the access lease is the core writer's, not this bridge's. The surface host and the core's input writer are separate open work ([#1327](https://github.com/mihazs/lazysh/issues/1327), [#1316](https://github.com/mihazs/lazysh/issues/1316)).
- **Touch.** Scrolling, long-press selection with handles, and the clipboard, against the expectations of [#16](https://github.com/mihazs/lazysh/issues/16) and [#938](https://github.com/mihazs/lazysh/issues/938), need the renderer and the core's selection ([#1320](https://github.com/mihazs/lazysh/issues/1320)).
- **Hardware keyboards.** Only synthetic key events. No physical keyboard, non-US layout, AltGr, Option as Meta ([#1653](https://github.com/mihazs/lazysh/pull/1653) is open), IME-composed hardware input or dead keys beyond naming them.
- **Latency.** Keystroke-to-presentation p50/p95/p99 from the [benchmark harness](terminal-benchmarks.md) needs a presenting renderer; no number exists.
- **Not copied from `terminalIme.ts`** because they are DOM artefacts: key 229, `Process`, `keypress`, `beforeinput` input types and the deferred Enter replay. A keyboard that behaves in a way the fixtures do not cover is the open risk of this bridge.
