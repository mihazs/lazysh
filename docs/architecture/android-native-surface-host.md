# Android native surface host

Status: **host, lifecycle and a JNI renderer client, open to release builds only through an explicit Native choice**. The renderer client is built but has not yet drawn a core on a device (see [the renderer client](#the-renderer-client)); no input, IME or accessibility reaches it, and the pane that would place it is mounted only by tests: no backend registration gives a session a native terminal yet. It is the first slice of [#1327](https://github.com/mihazs/lazysh/issues/1327) (epic [#1302](https://github.com/mihazs/lazysh/issues/1302)) and follows the strategy the [composition proof of concept](android-surface-composition-poc.md) recommended: a `SurfaceView` stacked below a transparent WebView. Related: [native rendering](native-rendering.md) · [runtime](terminal-runtime.md) · [platform integration](platform-integration.md) · [migration plan](terminal-migration-plan.md).

## What exists

| Piece | Where | Role |
| --- | --- | --- |
| `TerminalSurfaces`, `SurfaceHost`, `BackgroundPainter` | `gen/android/app/src/main/java/app/lazysh/client/TerminalSurfaces.kt` | A process-owned registry of sessions. Each session has one `SurfaceView` at index 0 of the content frame (so the WebView paints over it), placed from a DOM anchor, and a client that draws on it. |
| `SurfaceLifecycle`, `SurfaceClient`, `SurfaceAnchor`, `SurfacePlacement` | `SurfaceLifecycle.kt` | Pure Kotlin. Turns `SurfaceHolder` callbacks into the ordered calls a renderer gets, counts surface generations, and computes margins from an anchor. |
| `NativeTerminalSurfacePlugin` | `NativeTerminalSurfacePlugin.kt` | Kotlin Tauri plugin behind three app commands. Runs on the UI thread against the Activity in front. |
| `native_terminal_surface_place`, `_remove`, `_state` | `apps/client/src-tauri/src/native_terminal_surface.rs` | Validates the renderer's arguments (session id, anchor, colour) and forwards them. Same shape as `edge_gesture_exclusion`: an app command with an ACL entry, the plugin itself unreachable from the page. `_remove` is allowed while the app is locked, like `terminal_core_close`; the others are not. |

The seam for the renderer is `SurfaceClient`: `onSurfaceReady(surface, generation, width, height)`, `onSurfaceChanged(...)` and `onSurfaceLost(generation)`. `TerminalSurfaces.clientFactory(id, background)` makes a session's client. The default is `NativeSurfaceClient`, the JNI renderer client below, with `BackgroundPainter` (fills the surface with the pane background) as its fallback, so a surface never shows undrawn memory.

## The renderer client

`NativeSurfaceClient` forwards each `SurfaceClient` call to `JniSurface` (`JniSurface.kt`, library `lazysh_lib`), whose entry points live in `native_terminal_surface/android.rs` and exist only in a build with the `native-terminal` feature. `ready` takes an `ANativeWindow` from the `Surface` and makes a wgpu surface on it (Vulkan, then GLES, per the renderer's policy: a CPU rasterizer is refused), draws the session of the same id from the core registry from a snapshot, and answers whether it can. `changed` resizes (and re-applies the pane colour and the display density), `lost` destroys the renderer's handles on the surface and releases the `ANativeWindow` before it returns, a newer generation draws the same session again from a snapshot (one host per session, kept across surfaces), and `remove` (the session's end) stops the host. A false answer, a missing library or a library built without the feature leaves the surface to `BackgroundPainter`; nothing crashes. The font is the system's `monospace` at 14 CSS pixels and the colours the default theme on the pane background until the page sends the user's preferences with the anchor. Calls run on the UI thread and `ready` waits for the GPU device to be created there.

Checked by `NativeSurfaceClientTest` (JVM: what the host is told and the fallback), `panes.rs` tests (host kept across generations, stale generation refused, removal) and `NativeTerminalSurfaceTest.theDefaultClientKeepsTheBackgroundForASessionTheRendererHostCannotDraw` (emulator). **Not established:** pixels of a core on the surface across stop/start and rotation (`PixelCopy` against the reference renderer) wait for the core running in the app on the emulator ([#2147](https://github.com/mihazs/lazysh/pull/2147)); the Android font directories, real GPU drivers and the UI-thread cost of device creation have not been measured.

## Contract

- **One surface per placed session, below the WebView.** Anchor changes move or resize the same surface. Margins are measured from the content frame's padding box, where the activity's insets listener lays the WebView out, so system bars, cutouts and the keyboard move the surface exactly as they move the page; only the page's own layout needs a new `place`.
- **Generation.** `generation` starts at 0 and rises by one for every new surface the session gets (stop and start, hide, recreation). A resize keeps it. The client sees `ready` once per surface, any number of `changed`, and `lost` once, whatever order the window delivers its callbacks in. A zero-sized surface is no surface yet, and a late size after destruction does not bring a surface back.
- **Stop and start.** Android destroys a `SurfaceView`'s surface when its window stops and creates a new one on start. The session, its client and its generation count live in the registry, so the client is told `lost` and then `ready` with the new generation and draws the whole session again. A window that is only paused but still visible (multi-window) keeps its surface, and nothing is suspended: pausing is not a reason to stop drawing.
- **Activity recreation.** The registry outlives the Activity. When an Activity is destroyed its host views go (the client is told `lost`) and every session of that window is left unplaced, with its generation count kept. Nothing is shown on the new page until that page places the session again, so a stale pane never appears on a page that does not expect it. Whether a session may outlive its Activity at all is the open security decision in [runtime](terminal-runtime.md#lifecycle); this host decides nothing about it.
- **Pixel format.** A `SurfaceView` asks for RGB_565 unless told otherwise, which quantises every colour (a pane background of `#1a2b3c` reads back as `#192d3a`). The host asks for `RGBA_8888` when it creates the view; a renderer that picks its own EGL or wgpu surface format must keep 8 bits per channel for the same reason.
- **Removal.** `remove` ends the surface and the session's count. Removing a session that is not there is not an error.
- **Gated by the choice, not by the build type.** `TerminalSurfaces.enabled` is true in every build ([#2306](https://github.com/mihazs/lazysh/issues/2306)); a release build no longer refuses on its own. The page asks for a surface only for a session whose backend the registry selected: never under Auto (`autoEligible` false), only when the user picked Native in Settings > Terminal engine (or a developer override), the probe passed and the build's kill switch (`LAZYSH_NATIVE_TERMINAL=off`, refused in Rust with `native_surface_disabled`-style errors) is not set. Otherwise the session stays on xterm.js. Not verified on a physical device.
- **Not owned here.** Touch, focus, IME and the soft keyboard (#1328), accessibility (#1329), and GPU device loss and thermal handling belong to the renderer and the later slices. The host view is not focusable and is hidden from accessibility until those exist.

## The page side

`apps/client/src/terminalSurfaceAnchor.ts` keeps a session's surface on a DOM element and is the only code that sends `place` and `remove` from the page. `TerminalPane` creates one for a session whose adapter is native (see [the pane](#the-pane)).

- **Hints, then a short look.** Layout, scroll, zoom and CSS transitions change an element's rectangle without telling the page which. A resize or scroll event, a `ResizeObserver` or `MutationObserver` callback, or a transition or animation event starts a frame-by-frame look at `getBoundingClientRect()` that ends after 12 frames with no change, so an idle page runs nothing.
- **One command in flight.** A rectangle that moved while a `place` was pending is not queued: when the command returns, the latest rectangle goes out as one command. The shell does not order commands, so `stop` waits for the command in flight before it sends `remove`, and a `remove` never overtakes a `place`.
- **No box, no surface.** An element that is hidden, zero-sized or detached ends the surface with `remove`; the next time it has a box it is placed again.
- **Refusal.** When the shell refuses or a command fails (a release build answers `native_surface_disabled`), tracking stops, a surface already placed is removed, and `onError` is told. The caller decides what to show; the tracker never retries.
- **Background.** The pane colour (`rgbOf` turns `#rgb`, `#rrggbb`, `rgb()` and `rgba()` into the `0xRRGGBB` the shell takes) is read on every placement, so a theme change reaches the surface with the next one.

Checked by `terminalSurfaceAnchor.test.ts` (Vitest, jsdom, frames driven by hand, the shell's commands mocked). Not established: the real placement round trip while a WebView scrolls or animates; it needs a device.

## The pane

`TerminalPane` mounts a session by the engine of its adapter (`adapter.backend`), and nothing else about the pane differs.

- **Native.** The terminal container gets an id (`useId`) and a `data-terminal-surface="native"` marker, the adapter is attached with `{kind: 'native', anchorId}`, and a tracker places the session's surface on the container for as long as the pane is shown (`active`, or `swiping` between the terminal and the Agent view). A pane that is hidden or ended stops the tracker, which sends `remove`; showing it again places the surface again. A refusal (a release build answers `native_surface_disabled`) is reported through the pane's `reportError`, the marker goes, and the page paints again.
- **Transparent over the surface, and only then.** While the marker is set, every ancestor of the container (`TerminalNativeSurface.css`: `:has(.terminal-canvas[data-terminal-surface="native"])`) paints no background, from the pane up to `html`. The pane's overlays (toolbar, composer, notices, search, selection tools) are not ancestors and keep their backgrounds above the surface. An xterm.js pane has no id and no marker, so no rule matches and its DOM is what it was.
- **Input stays on the container.** Pointer, touch, wheel and key handlers are still the container's and the pane's. A native adapter has no typed-input editor to observe (`observeInput` is absent without the `ime` capability), so the pane runs without the IME observer and offers no virtual modifiers; the platform's own input view is [#1328](https://github.com/mihazs/lazysh/issues/1328).
- **The surface colour** is the terminal theme's background, read on every placement.

Checked by `terminal-native-surface.spec.ts` (Playwright, Chromium, desktop and phone projects): the native adapter over the headless stand-in core in the app's own `app-viewport`, `app-shell`, `workspace` and `session-body` chain, with the shell's surface commands recorded. It asserts the placement rectangle and colour, that the surface follows a layout move, `remove` on hide and on unmount and `place` again on show, the computed background of every ancestor (transparent for native, opaque for xterm.js, opaque again when the pane is hidden or the shell refuses) and the alpha read back from a screenshot, the composer sheet painting and taking the hit above the container, and a finger drag on the container still scrolling. Not established: the real `App` chain (the harness repeats its class names, and the real page never mounts a native pane until a backend is registered), the Android WebView's own background (`onWebViewCreate` does not make it transparent yet, so on a device the pane would show the WebView's colour and not the surface), compositing on Waydroid or a device, and the cost of a translucent WebView.

## Verification and limits

See the pull request for the run that produced the figures below; this section is only what the code can and cannot show.

| Claim | Checked by | Not covered |
| --- | --- | --- |
| Margins and sizes from an anchor, anchor validation | `SurfacePlacementTest` (JVM) | Page zoom, foldables, orientation change |
| Order of ready, changed and lost; generation counting; late and out-of-order callbacks | `SurfaceLifecycleTest` (JVM) | Real window ordering on a vendor ROM |
| Placement through the renderer's own IPC on the real MainActivity and Tauri WebView; stop and start; Activity recreation; removal; the developer gate; argument refusal | `NativeTerminalSurfaceTest` (instrumentation, `native-android-runtime` CI) | Physical device, a real GPU, other WebView builds |
| What is on the surface after recreation, and its pixel format | The test reads the surface buffer back with `PixelCopy` (not the composited screen) and compares it with the session's background exactly; with the format request removed it fails with the quantised `#ff192d3a` | A real renderer, the screen state of a live session |
| Rust argument validation, error-code passthrough and the locked-app rule | unit tests in `native_terminal_surface.rs` | The Android half of the commands runs only on Android |

Not established: that the real page can be made transparent over the pane (the shipping page paints opaque backgrounds, see the proof of concept), the latency of the placement round trip while the page scrolls or animates, resume latency, idle CPU and GPU, battery, a physical device, TalkBack, IME, hardware keyboards, selection handles, foldables, cutout and orientation changes, GPU context loss, and any number from the [benchmark harness](terminal-benchmarks.md).

## Next slices

1. Renderer attachment: a JNI client that turns `ready` and `lost` into the Renderer API lifecycle (`create`, `resize`, `destroy`) and calls `Session::attach` and `detach`, once a renderer is selected ([#1323](https://github.com/mihazs/lazysh/issues/1323), [#1324](https://github.com/mihazs/lazysh/issues/1324)) and the core builds for Android ([#1312](https://github.com/mihazs/lazysh/issues/1312)).
2. Make the Android WebView background transparent and measure the real page over a surface on Waydroid (the pane and its transparency exist, see [the pane](#the-pane), and are checked in a browser only).
3. Input, IME and selection handles on the surface ([#1328](https://github.com/mihazs/lazysh/issues/1328)), accessibility ([#1329](https://github.com/mihazs/lazysh/issues/1329)).
