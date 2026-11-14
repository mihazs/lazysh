# Android native surface host

Status: **host and lifecycle only, developer builds only**. No renderer draws on it, no input, IME or accessibility reaches it, and nothing in the app calls it yet. It is the first slice of [#1327](https://github.com/mihazs/lazysh/issues/1327) (epic [#1302](https://github.com/mihazs/lazysh/issues/1302)) and follows the strategy the [composition proof of concept](android-surface-composition-poc.md) recommended: a `SurfaceView` stacked below a transparent WebView. Related: [native rendering](native-rendering.md) · [runtime](terminal-runtime.md) · [platform integration](platform-integration.md) · [migration plan](terminal-migration-plan.md).

## What exists

| Piece | Where | Role |
| --- | --- | --- |
| `TerminalSurfaces`, `SurfaceHost`, `BackgroundPainter` | `gen/android/app/src/main/java/app/lazysh/client/TerminalSurfaces.kt` | A process-owned registry of sessions. Each session has one `SurfaceView` at index 0 of the content frame (so the WebView paints over it), placed from a DOM anchor, and a client that draws on it. |
| `SurfaceLifecycle`, `SurfaceClient`, `SurfaceAnchor`, `SurfacePlacement` | `SurfaceLifecycle.kt` | Pure Kotlin. Turns `SurfaceHolder` callbacks into the ordered calls a renderer gets, counts surface generations, and computes margins from an anchor. |
| `NativeTerminalSurfacePlugin` | `NativeTerminalSurfacePlugin.kt` | Kotlin Tauri plugin behind three app commands. Runs on the UI thread against the Activity in front. |
| `native_terminal_surface_place`, `_remove`, `_state` | `apps/client/src-tauri/src/native_terminal_surface.rs` | Validates the renderer's arguments (session id, anchor, colour) and forwards them. Same shape as `edge_gesture_exclusion`: an app command with an ACL entry, the plugin itself unreachable from the page. `_remove` is allowed while the app is locked, like `terminal_core_close`; the others are not. |

The seam for the renderer is `SurfaceClient`: `onSurfaceReady(surface, generation, width, height)`, `onSurfaceChanged(...)` and `onSurfaceLost(generation)`. `TerminalSurfaces.clientFactory` replaces the default `BackgroundPainter`, which fills the surface with the pane background so a surface never shows undrawn memory before a renderer attaches. The Rust renderer will be a client behind a JNI hop; that hop is not built.

## Contract

- **One surface per placed session, below the WebView.** Anchor changes move or resize the same surface. Margins are measured from the content frame's padding box, where the activity's insets listener lays the WebView out, so system bars, cutouts and the keyboard move the surface exactly as they move the page; only the page's own layout needs a new `place`.
- **Generation.** `generation` starts at 0 and rises by one for every new surface the session gets (stop and start, hide, recreation). A resize keeps it. The client sees `ready` once per surface, any number of `changed`, and `lost` once, whatever order the window delivers its callbacks in. A zero-sized surface is no surface yet, and a late size after destruction does not bring a surface back.
- **Stop and start.** Android destroys a `SurfaceView`'s surface when its window stops and creates a new one on start. The session, its client and its generation count live in the registry, so the client is told `lost` and then `ready` with the new generation and draws the whole session again. A window that is only paused but still visible (multi-window) keeps its surface, and nothing is suspended: pausing is not a reason to stop drawing.
- **Activity recreation.** The registry outlives the Activity. When an Activity is destroyed its host views go (the client is told `lost`) and every session of that window is left unplaced, with its generation count kept. Nothing is shown on the new page until that page places the session again, so a stale pane never appears on a page that does not expect it. Whether a session may outlive its Activity at all is the open security decision in [runtime](terminal-runtime.md#lifecycle); this host decides nothing about it.
- **Pixel format.** A `SurfaceView` asks for RGB_565 unless told otherwise, which quantises every colour (a pane background of `#1a2b3c` reads back as `#192d3a`). The host asks for `RGBA_8888` when it creates the view; a renderer that picks its own EGL or wgpu surface format must keep 8 bits per channel for the same reason.
- **Removal.** `remove` ends the surface and the session's count. Removing a session that is not there is not an error.
- **Developer-only.** `TerminalSurfaces.enabled` defaults to `BuildConfig.DEBUG`: a release build refuses every command with `native_surface_disabled` before creating a view. The rollout stage that opens the native backend to users (S2) replaces this with a preference.
- **Not owned here.** Touch, focus, IME and the soft keyboard (#1328), accessibility (#1329), and GPU device loss and thermal handling belong to the renderer and the later slices. The host view is not focusable and is hidden from accessibility until those exist.

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
2. The page side: an anchor tracker that follows scroll, layout and transitions and sends `place`, and the transparent pane on the real page, measured on a device.
3. Input, IME and selection handles on the surface ([#1328](https://github.com/mihazs/lazysh/issues/1328)), accessibility ([#1329](https://github.com/mihazs/lazysh/issues/1329)).
