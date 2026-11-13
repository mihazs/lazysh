# Native rendering

Status: **proposed; the Renderer API and a CPU reference renderer exist ([below](#terminal-renderer-api)), and a wgpu implementation of it ([`packages/terminal-renderer-wgpu`](../../packages/terminal-renderer-wgpu/README.md), [below](#wgpu-renderer)) draws the reference's dot-pattern glyphs into an offscreen texture with a bounded glyph atlas, dirty-row batching and no frames while idle; no renderer draws text, is shipped or is wired into the app, and the decisions so far are in [ADR 0001](adr-0001-terminal-runtime.md)**. The shootout also built an Android `Canvas` replay of the layout on Waydroid and libghostty-vt as WebAssembly for the parse stage. The repository contains no `MTKView` or Skia code and, apart from the debug-only [Android composition PoC](android-surface-composition-poc.md), no `SurfaceView` or `TextureView` code (searched under `apps/` and `packages/`, excluding vendored sources). wgpu is a first candidate, not an assumed winner. Related: [runtime](terminal-runtime.md) · [platform integration](platform-integration.md) · [benchmarks](terminal-benchmarks.md) · [ADR 0001](adr-0001-terminal-runtime.md).

## What must be decided by evidence

1. Whether a native surface can be composed with the Tauri WebView at all on each platform (the **composition gate**).
2. Which renderer is faster and more efficient than an optimized xterm.js on the target devices (the **renderer shootout**, [#1323](https://github.com/mihazs/lazysh/issues/1323)).
3. Whether the input, selection and accessibility story on a native surface reaches parity. A native renderer with broken input or inaccessible content is never shipped.

## Terminal Renderer API

Implemented in [`packages/terminal-runtime`](../../packages/terminal-runtime/README.md) ([#1322](https://github.com/mihazs/lazysh/issues/1322)): the `TerminalRenderer` trait, the shared `Screen` model and a deterministic CPU `ReferenceRenderer`. The trait names no graphics type; a renderer is generic over its own `Surface` (a window handle, an `ANativeWindow`, a `CAMetalLayer`, an image).

| Part | Contract |
| --- | --- |
| Input from the core | `apply(&Frame)`: a full frame or the dirty rows of libghostty-vt's `RenderState`, with the cursor. An incremental frame for a grid the renderer does not hold fails with `NeedsFullFrame`, and the host answers with `TerminalRuntime::snapshot`. |
| Input from the host | `Appearance` (cell metrics in device pixels, font family and fallback list, theme) and `Overlay` (selection, cursor blink phase from one host timer). Changing `Appearance` repaints every row. |
| Drawing and presentation | `draw()` repaints exactly the rows that changed since the last `draw` and returns how many; `present()` shows the result and does nothing when nothing was drawn. Any number of `apply` calls may precede one `draw` per display refresh. `needs_draw()` is true exactly when `draw()` would paint a row, so the host requests a display frame only when it is true and runs no frame loop while it is false; `wants_blink_timer()` is true only while a visible blinking cursor is on a live renderer. |
| Lifecycle | `create(surface, appearance)`, `resize`, `suspend`, `resume`, `destroy`; all but `create` are idempotent. A suspended renderer drops its screen copy and does no work; `resume` is followed by a snapshot. `DeviceLost` has the same recovery. After `destroy` everything but `destroy` and `stats` fails with `Destroyed`. `create` fails with `Unsupported` when the device has no graphics backend the renderer may use (not a loss: `resume` does not help, the host keeps its fallback renderer). |
| Statistics | `stats()` returns cumulative frames drawn and presented, rows and cells drawn, bytes uploaded to the surface, draw and present time, for the benchmarks. |

`Screen` is the half every renderer shares: it applies frames, validates them (a malformed frame is refused and changes nothing), and answers which rows need repainting, including the rows a cursor left and entered, a blink phase change of a blinking cursor, and only the rows whose selected cells changed. GPU and platform renderers keep their own resources but reuse it, so "what changed" is decided once.

`RendererCore` is the third: the lifecycle phases, device loss (including a loss reported from another thread by a GPU callback), the screen copy, "what to draw" (`begin_draw`) and the counters, so every implementation answers the contract the same way and only adds its surface, resources and rasterization. The `forward_to_core!` macro generates the five trait methods that do nothing but forward to it (`apply`, `set_overlay`, `needs_draw`, `wants_blink_timer`, `suspend`, `stats`), which the second implementation (wgpu) showed to be identical for every renderer.

`layout::row_draws` is the other shared half: it turns a row of the `Screen`, the cursor, the selection and the `Appearance` into an ordered list of rectangles and glyph runs in device pixels (cell backgrounds, inverse, faint and hidden colors, underline styles, strike-through, overline, cursor shapes), so "what to paint" is decided once as well. The CPU reference renderer rasterizes the list; a GPU renderer turns it into instances and an atlas, a platform canvas into drawing calls. Renderers then differ only in rasterization, which is what the golden images compare.

**Reference renderer.** It rasterizes the shared layout: cells, wide and combining clusters, default, inverse, faint and hidden colors, underline styles, strike-through, overline, the four cursor shapes and a linear or block selection, using integer arithmetic only, so every host produces the same bytes. It has no typography: each grapheme cluster becomes a 5x7 dot pattern derived from its text, so a wrong cell, width or cluster changes the image without any font. It is not a performance candidate and says nothing about shaping, font fallback, italic, text blink or sub-pixel positioning.

**Golden images.** `packages/terminal-runtime/tests/golden/*.png` (ASCII, ANSI colors, attributes, wide, combining, emoji including a ZWJ family, flag and skin-tone sequence, each cursor shape, cursor on a wide character, linear and block selection) are rendered from real libghostty-vt output and compared pixel for pixel. Separate tests check pixels against the frame instead of a golden, and prove that a sequence of incremental updates ends in the same image as one full repaint.

**Review against the shootout candidates** ([#1323](https://github.com/mihazs/lazysh/issues/1323)). A desk review of how each candidate would plug in; no candidate was built or measured for it.

| Candidate | How it fits | Gap found |
| --- | --- | --- |
| wgpu | Implements the trait directly in Rust. `Surface` wraps a raw window handle, `draw` records instanced quads for the rows `Screen` reports, `present` presents the swapchain, a lost device maps to `DeviceLost`. **Built as a prototype against the trait, which did not change** (`Surface` is the size of an offscreen texture there; `RendererCore` and `layout::row_draws` were enough, and the golden-image oracle was applied to it pixel for pixel, [wgpu measurements](terminal-benchmarks.md#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device)). | `Frame` cells carry an owned `String` each, so a glyph atlas keyed by cluster allocates per cell, which the prototype does (its atlas key is an owned `String` built for every glyph, hit or miss; the cost was not isolated). [#1337](https://github.com/mihazs/lazysh/issues/1337) owns a compact cell format. Not exercised: a window surface, swapchain recreation and a real text pipeline, so `present` and `Surface` are unproven for a window. |
| Native drawing (Skia, Android Canvas) | A Rust implementation is a JNI bridge whose `Surface` is the Java surface; the Kotlin side draws. A replay of `layout::row_draws` on the Android `Canvas` was built and measured (the draws crossed as files, not JNI). Its output was not compared with the reference renderer's pixels (it draws real text); the tuned replay differs from the as-is one in 0 to 0.27 % of pixels. | Rows must cross JNI: the API has no wire format for a frame, which the compact cell format of #1337 should also define. |
| Optimized xterm.js | Does not implement the trait: it parses and renders inside the WebView, so it is a `TerminalAdapter` backend. | None for the API. Its correctness comes from final screen text in the [harness](terminal-benchmarks.md), not from pixels. |
| WASM terminal | The same when it owns parsing and rendering. If only rendering moved to the WebView, `Frame` would have to cross the JavaScript bridge. The parse stage was built and measured (libghostty-vt as WebAssembly, no renderer), not the renderer. | The same wire-format gap. |

The review changed the API in these ways: a statistics record with bytes uploaded, so GPU and surface-copy renderers can be compared on the same counter; a lifecycle in which loss, suspension and recreation recover from core state; and `Frame` now also reports cursor-only changes (see the runtime document). It found no reason to prefer one candidate.

## wgpu renderer

[`packages/terminal-renderer-wgpu`](../../packages/terminal-renderer-wgpu/README.md) ([#1324](https://github.com/mihazs/lazysh/issues/1324)) is the production form of the shootout's wgpu prototype. Its measurements are in [wgpu renderer: idle, atlas and memory](terminal-benchmarks.md#wgpu-renderer-idle-atlas-and-memory-host-gpu-not-a-device).

- **Pipeline.** `layout::row_draws` becomes instances of one instanced-quad pipeline (a solid rectangle or a glyph mask from the atlas, 32 bytes each) drawn into a persistent `Rgba8Unorm` target. A frame submits only the rows that changed: each gets a background instance of the theme color, the cell backgrounds that differ from it are merged into runs, and everything else follows in layout order (no draw leaves its cell, so painting backgrounds first gives the same pixels). A repaint clears first.
- **Glyph atlas.** A fixed-size `R8` texture of slots one cell or two cells wide, with least-recently-used eviction and no compaction (`src/atlas.rs`). Slots used by the frame being built are never evicted; a frame with more distinct glyphs than slots is split into several passes. GPU memory is therefore bounded by the atlas size, the target and a capped instance buffer, whatever passes through. Masks are the reference renderer's dot patterns for now; real fonts are [#1325](https://github.com/mihazs/lazysh/issues/1325).
- **No idle frames.** `needs_draw()` is false and `draw()` touches nothing for an unchanged screen (no submission, upload or atlas lookup), including when an application rewrites identical cells: `Screen` marks a row dirty only when its cells differ. `GpuStats::submissions` counts `Queue::submit` calls so this is a measured property, not a claim.
- **Backends.** A `Policy` lists backends in order of preference: Vulkan then OpenGL ES on Android and Linux, Metal on Apple, Direct3D 12 then Vulkan on Windows. Within a backend discrete GPUs rank before integrated and virtual ones; CPU adapters are refused unless the policy allows them, because a device keeps xterm.js unless the native renderer can beat it and a software rasterizer cannot. The device is requested with the downlevel (OpenGL ES 3.0) limits raised to what the adapter offers, so the same pipeline runs on the fallback. Metal and Direct3D 12 are compiled in by target but have never run: `cargo check --target aarch64-apple-darwin` passes (the Metal backend and the Apple-only dependency table compile), Windows could not be checked from the Linux host (Zig has no MSVC libc headers for the runtime's build script, as the [runtime README](../../packages/terminal-runtime/README.md#target-status) records) and Android is blocked by the runtime's build script having no Android mapping yet (#1327).
- **Device loss.** A lost device is replaced from core state (`resume`, then a snapshot); the device-lost callback carries an epoch so a loss reported by a device that was already replaced does not mark the new one lost.
- **Cursor blink.** The phase is host state; the timer is one for every session. `BlinkClock` derives the phase from a monotonic clock, so all sessions share it, and `next_wake` is the earliest instant any renderer needs, or `None` when no renderer `wants_blink_timer()` (a visible blinking cursor on a live renderer): a steady or hidden cursor, a suspended, lost or destroyed renderer arms no timer. A phase change redraws one row in one pass. `FramePacer` is the same for frames: at most one per display refresh (`set_refresh_hz` when the display changes), none while `needs_draw()` is false.
- **Display scale.** A scale change is a new `Appearance` with `CellMetrics::scaled(n, d)` and a `resize`: the renderer repaints every row from the screen it holds, with no snapshot, rebuilds the atlas for the new cell size (refusing a size the atlas cannot hold with everything unchanged) and draws the same pixels as a renderer created at that scale. Goldens at 2x and 3x pin them.
- **Device loss.** `lose_device()` is the test hook; a reset the renderer was not told about is learned from the device's lost callback or from the errors a destroyed device answers every call with (an out-of-memory or internal error also marks the device lost; a validation error stays a panic, because it is this crate's bug). Recovery is `resume`, a snapshot, a draw: five losses in a row ended in the uninterrupted picture and the driver's resource counts of a new renderer.
- **Not done yet.** A window or `ANativeWindow` surface and swapchain (the target is an offscreen texture; [#1327](https://github.com/mihazs/lazysh/issues/1327)), text, shaping and font fallback ([#1325](https://github.com/mihazs/lazysh/issues/1325)), losing a window surface (as opposed to the device), and any run on Android, Apple or Windows hardware.

## Renderer candidates

| Candidate | Why considered | Known unknowns (all unmeasured) |
| --- | --- | --- |
| Current xterm.js DOM renderer | Baseline and fallback | CPU, memory, energy, idle activity |
| Optimized xterm.js (WebGL or canvas renderer, binary IPC) | Cheapest possible improvement; no new composition risk | Measured on one desktop Chromium host only ([shootout](terminal-benchmarks.md#renderer-shootout-xtermjs-renderers-1323)): the WebGL addon on hardware GL is on par with DOM for plain output and much cheaper for ANSI-heavy output but has worse W3 frame pacing; the canvas addon is far slower; software GL is unusable. The bold-color seam is refused on both addons. Android: unmeasured |
| wgpu (Vulkan on Android and Linux, Metal on Apple, D3D12 on Windows) | One renderer in Rust shared with the core | Measured on one discrete desktop GPU only, with dot-pattern glyphs and no text ([prototype](terminal-benchmarks.md#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device)): a frame is cheap, a first GPU context is not (about 61 MiB resident). Its OpenGL and OpenGL ES backends render the same pixels at about the same median frame cost at the phone grid on that GPU, with a worse tail and about 65 MiB for the first context ([measurement](terminal-benchmarks.md#wgpu-on-its-opengl-and-opengl-es-backends-against-vulkan-same-host-gpu-not-a-device)). Unmeasured: Android driver quality, binary size, idle wakeups, shaping and font fallback effort |
| Native drawing (Skia or Canvas, especially Android) | Platform-tuned text drawing and fonts | Replay of the shared layout with the Android `Canvas` (Skia) on Waydroid, whose GPU is a desktop part ([measurement](terminal-benchmarks.md#android-canvas-drawing-of-the-shared-layout-waydroid-not-a-device)): every frame fit in 16.7 ms and the cost was the number of Canvas calls, not the GPU. Unmeasured: any phone, the app's fonts, per-row display lists, Rust-to-Kotlin transport, cross-platform reuse |
| WASM terminal in the WebView | Keeps DOM composition and removes JS parsing | Parse stage only, on one V8 in Node ([measurement](terminal-benchmarks.md#webassembly-vt-versus-xtermjs-parse-only-host-microbenchmark-not-a-candidate)): libghostty-vt built to WebAssembly from the vendored source parsed 1.3 to 5.8 times faster than xterm.js's parser. Unmeasured: a renderer, the JS bridge that carries every byte and dirty row, Chromium and Android WebViews, SIMD, startup |

Decision rule: choose per platform by validated responsiveness, energy, memory and correctness; ship only the winner; if none beats the xterm.js fallback on a device, that device keeps xterm.js. Prototypes are not shipped.

## Composition gate

Required before any production surface work. Each item is recorded pass or fail with evidence (device, OS, WebView version):

| Gate | What is checked |
| --- | --- |
| Placement | A surface tracks a DOM anchor through scroll, resize and layout changes. |
| Overlap | React overlays, menus, the command palette, the toolbar and selection handles draw correctly over or around the surface. |
| Focus handoff | Focus moves between WebView inputs and the terminal without losing the keyboard state. |
| Selection | Handles and the selection toolbar work (they are DOM today: `TerminalSelectionTools.tsx`). |
| Resize | Keyboard show or hide, orientation, foldables and insets resize the surface and the PTY once. |
| Destroy and recreate | Surface loss and activity recreation rebuild the view from core state. |
| Accessibility feasibility | A route to screen-reader content exists ([accessibility](#accessibility)). |

Android emulator results: [Android surface composition PoC](android-surface-composition-poc.md). Proof-of-concept issues: Android [#1310](https://github.com/mihazs/lazysh/issues/1310), iOS [#1311](https://github.com/mihazs/lazysh/issues/1311). Desktop PoCs are the first step of [#1331](https://github.com/mihazs/lazysh/issues/1331), [#1332](https://github.com/mihazs/lazysh/issues/1332) and [#1333](https://github.com/mihazs/lazysh/issues/1333). A platform that fails its gate keeps xterm.js, or uses the documented alternative.

Android strategies in order of trial: `SurfaceView` first (lowest compositing cost where it works; z-order and clipping against a WebView are the risk), then `TextureView` if clipping, z-order or transitions demand it. What the WebView host does today: `MainActivity` extends `TauriActivity`, registers Kotlin plugins in `onWebViewCreate`, and applies system-bar, cutout and IME insets as padding on the content view so the WebView itself is resized.

## Frame scheduling

- Event-driven: a frame is requested only when core state, the cursor blink phase, selection or the viewport changed. No fixed 60 or 120 Hz loop while idle.
- Coalescing: output bursts produce at most one frame per display refresh; the core continues parsing between frames.
- Inactive sessions do not render; a hidden surface releases or parks GPU work.
- Cursor blink uses a single coalesced timer and is skipped entirely when blink is off or the surface is hidden (`BlinkClock` and `wants_blink_timer`, [above](#wgpu-renderer); [measurement](terminal-benchmarks.md#cursor-blink-display-scale-and-device-loss-host-gpu-not-a-device)).
- Acceptance: zero frames submitted while the screen is unchanged and blink is off ([#1324](https://github.com/mihazs/lazysh/issues/1324)). Met by the wgpu renderer for an unchanged screen: `needs_draw()` is the host's question, `GpuStats::submissions` the proof ([measurement](terminal-benchmarks.md#wgpu-renderer-idle-atlas-and-memory-host-gpu-not-a-device)); the blink timer is [#1326](https://github.com/mihazs/lazysh/issues/1326).

## Glyph atlas, shaping and layout

- Dirty-row and cell-run tracking, instanced quads, a glyph atlas with bounded size and eviction (done in the wgpu renderer, [above](#wgpu-renderer)), minimal uploads, resources shared across sessions where fonts match ([#1337](https://github.com/mihazs/lazysh/issues/1337)).
- Cell widths come from the core (`unicode_grapheme_width`); shaping must not move glyphs off the grid for CJK, ZWJ emoji and combining marks ([#1325](https://github.com/mihazs/lazysh/issues/1325)). The user's font and CJK fallback settings (`fonts.ts`, [font downloads](../font-downloads.md)) must be honoured.
- Cursor styles, blink, selection highlight, high-DPI scale changes and device-loss recovery are covered by [#1326](https://github.com/mihazs/lazysh/issues/1326) for the dot-pattern glyphs the reference renderer draws: tested in `packages/terminal-renderer-wgpu/tests/lifecycle.rs` ([above](#wgpu-renderer)). With real fonts they are the same tests again.

## Graphics backends and fallbacks (to verify)

| Platform | Primary | Fallback |
| --- | --- | --- |
| Android | Vulkan | xterm.js (and a GLES or software path only if the shootout supports it) |
| iOS and macOS | Metal | xterm.js |
| Windows | Direct3D 12 | xterm.js |
| Linux | Vulkan | xterm.js |

Capability must be detected on real hardware (driver blocklists, surface creation, a short render self-test), not inferred from the OS version ([#1336](https://github.com/mihazs/lazysh/issues/1336)). No claim is made here about which backends work on which devices.

## Input and IME

The highest-risk area. Today input depends on xterm's hidden textarea and the pinned IME layer (`terminalIme.ts`). A native surface needs either a hidden DOM editor kept alongside the surface or a native input connection. The decision is made in the Android PoC and validated against SwiftKey and Gboard behaviour (#1215), the `terminal-ime` and `terminal-swiftkey` scenarios, and the owned IME test service in the Android instrumentation sources. Required: no duplicate or corrupt commits, hardware keyboards, Shift+Enter (#805), toolbar Enter (#1043), touch scrolling (#938) and selection handles. Tracked in [#1328](https://github.com/mihazs/lazysh/issues/1328).

## Accessibility

xterm.js offers `screenReaderMode` (wired to `preferences.screenReader`). A GPU surface has no DOM. Options to evaluate: a virtual accessibility tree built from `readRows`, or a hidden DOM live region. If neither reaches parity on a platform, capability detection must refuse the native backend while a screen reader is active, and that fallback is tested. Tracked in [#1329](https://github.com/mihazs/lazysh/issues/1329) and [#1335](https://github.com/mihazs/lazysh/issues/1335).

## Rejected or deferred alternatives

- **Port the xterm DOM renderer to Rust**: no benefit; the cost is parsing and DOM updates, which this design moves out of JavaScript only if measured.
- **A second VT engine for rendering**: duplicates state; rejected by the one-authoritative-state principle.
- **Immediate-mode redraw of the whole grid each frame**: conflicts with the idle requirement.
- **Choosing wgpu first**: rejected by the requirement to decide on measurements.

## Unresolved questions

- Can a `SurfaceView` be z-ordered with a transparent hole in the Tauri WebView, or is `TextureView` required? On an API 36 emulator a `SurfaceView` below a transparent WebView works and keeps DOM overlays on top, and `TextureView` works too ([result](android-surface-composition-poc.md)). Still open: the real, currently opaque page, and a physical device.
- Does iOS allow a Metal view at the required z-order without interfering with WKWebView scrolling and hit testing?
- How are Wayland subsurfaces handled by the WebKitGTK window Tauri uses?
