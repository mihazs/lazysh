# Native rendering

Status: **proposed; nothing here is implemented or measured**. The repository contains no `MTKView`, `wgpu` or Skia code and, apart from the debug-only [Android composition PoC](android-surface-composition-poc.md), no `SurfaceView` or `TextureView` code (searched under `apps/` and `packages/`, excluding vendored sources). wgpu is a first candidate, not an assumed winner. Related: [runtime](terminal-runtime.md) · [platform integration](platform-integration.md) · [benchmarks](terminal-benchmarks.md) · [ADR 0001](adr-0001-terminal-runtime.md).

## What must be decided by evidence

1. Whether a native surface can be composed with the Tauri WebView at all on each platform (the **composition gate**).
2. Which renderer is faster and more efficient than an optimized xterm.js on the target devices (the **renderer shootout**, [#1323](https://github.com/mihazs/lazysh/issues/1323)).
3. Whether the input, selection and accessibility story on a native surface reaches parity. A native renderer with broken input or inaccessible content is never shipped.

## Terminal Renderer API

A Rust trait, independent of any graphics library ([#1322](https://github.com/mihazs/lazysh/issues/1322)):

- input: incremental updates from the core (dirty rows via libghostty-vt `RenderState`, cursor, colors, viewport), font metrics and fallback list, theme, selection overlay, scale factor;
- output: a presentation to an opaque surface handle, plus a statistics record (rows drawn, bytes uploaded, frame time) for the benchmarks;
- lifecycle: `create(surface)`, `resize`, `suspend`, `resume`, `destroy`, each idempotent; device loss is reported and recovered from core state;
- a CPU reference implementation producing deterministic images, used for golden-image tests so correctness does not depend on a GPU.

## Renderer candidates

| Candidate | Why considered | Known unknowns (all unmeasured) |
| --- | --- | --- |
| Current xterm.js DOM renderer | Baseline and fallback | CPU, memory, energy, idle activity |
| Optimized xterm.js (WebGL or canvas renderer, binary IPC) | Cheapest possible improvement; no new composition risk | Gain size; interaction with the version-pinned bold-color seam (`terminalBold.ts` reaches into the DOM renderer's row factory) |
| wgpu (Vulkan on Android and Linux, Metal on Apple, D3D12 on Windows) | One renderer in Rust shared with the core | Android driver quality, binary size, idle wakeups, shaping and font fallback effort |
| Native drawing (Skia or Canvas, especially Android) | Platform-tuned text drawing and fonts | Cross-platform reuse, Rust integration cost |
| WASM terminal in the WebView | Keeps DOM composition and removes JS parsing | JS bridge still carries bytes; GPU access from WebView |

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
- Cursor blink uses a single coalesced timer and is skipped entirely when blink is off or the surface is hidden.
- Acceptance: zero frames submitted while the screen is unchanged and blink is off ([#1324](https://github.com/mihazs/lazysh/issues/1324)).

## Glyph atlas, shaping and layout

- Dirty-row and cell-run tracking, instanced quads, a glyph atlas with bounded size and eviction, minimal uploads, resources shared across sessions where fonts match ([#1337](https://github.com/mihazs/lazysh/issues/1337)).
- Cell widths come from the core (`unicode_grapheme_width`); shaping must not move glyphs off the grid for CJK, ZWJ emoji and combining marks ([#1325](https://github.com/mihazs/lazysh/issues/1325)). The user's font and CJK fallback settings (`fonts.ts`, [font downloads](../font-downloads.md)) must be honoured.
- Cursor styles, blink, selection highlight, high-DPI scale changes and device-loss recovery are covered by [#1326](https://github.com/mihazs/lazysh/issues/1326).

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
