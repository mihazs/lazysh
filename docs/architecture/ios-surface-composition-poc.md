# iOS native surface composition proof of concept

Status: **proof of concept on the hosted iOS simulator, not shipped**. Answers the composition gate in [native rendering](native-rendering.md#composition-gate) for iOS ([#1311](https://github.com/mihazs/lazysh/issues/1311), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)): can an `MTKView` sit **below** the transparent `WKWebView` Tauri uses, without taking the web view's scrolling, hit testing or overlays from it? It draws one solid colour: no terminal, no renderer, nothing in the app. Related: [Android PoC](android-surface-composition-poc.md) · [Linux PoC](linux-surface-composition-poc.md) · [Windows, macOS and iOS strategies](windows-macos-ios-surface-strategies.md) · [iOS testing](../ios-testing.md#surface-composition-proof-of-concept) · [ADR 0001](adr-0001-terminal-runtime.md).

**Decision for the plan: go on the simulator** ([#1330](https://github.com/mihazs/lazysh/issues/1330) may start from this arrangement). The gate is **not accepted**: it was measured on one simulator, one display scale and a fixture page, never on a device, and the real Tauri window and the real page were not in the loop ([what this does not establish](#what-this-does-not-establish)). Until a native surface exists on iOS and passes its own gates, Auto resolves to xterm.js there and the Native option stays disabled with the reason.

## What was built

| Piece | Where | Notes |
| --- | --- | --- |
| `LazyshSurfacePoc` | `apps/client/src-tauri/apple/SurfacePocHost/` | A standalone UIKit application, built only by its own scheme: no Rust phase, no Tauri plugin, no IPC command, not embedded in the app, so no capability, entitlement or shipped code changes. It builds the hierarchy wry 0.57.1 builds on iOS (`wkwebview/mod.rs`: `setOpaque(false)`, a clear background, flexible width and height, bounce off, `addSubview` on the window's view) and inserts an `MTKView` **below** the web view. The page reports the anchor's rectangle (`getBoundingClientRect()` minus the visual viewport's offset, in CSS pixels) through a `WKScriptMessageHandler`, and the host sets the surface's frame to it. The surface is drawn on request only (`isPaused` and no `enableSetNeedsDisplay`): it clears to one colour. The host publishes its own state (surface frame, sizes, counters, safe-area insets) as the accessibility label of one element. |
| Fixture page | `SurfacePocPage.swift` | Transparent over the pane, `viewport-fit=cover` as the app's `index.html`, a pane (`#anchor`) placed from `env(safe-area-inset-*)` and sized from the visual viewport the way [`TerminalPane`](../../apps/client/src/TerminalPane.tsx) reads it (a simpler formula, not the shipping code), an opaque red DOM box over the pane's lower right corner (the menu, toolbar or selection handle that must stay on top), a text field, and two buttons that remove and recreate the surface. |
| `LazyshSurfacePocUITests` | `apps/client/src-tauri/apple/SurfacePocUITests/` | An XCUITest launching the host on the job's isolated simulator. Each placement or overlap verdict compares three readings: the page's own accessibility frame for the anchor, the rectangle the host says it gave the surface, and the **pixels the simulator composited** (`XCUIScreen.main.screenshot()`, with the display's native orientation undone). The pixel arithmetic has its own tests on a synthetic raster (`SurfacePocAnalysisTests`), which also run on Linux. |
| `native-ios-simulator` step | `.github/workflows/checks.yml`, `bun run test:ios-surface-poc` | Runs after the app acceptance, on the same simulator; keeps one JSON record per test (`lazysh-surface-poc.jsonl`, printed in the job summary and uploaded with the result bundle). Like the whole job it runs on pushes to `main`, not on pull requests. |

## Results

Source: [run 44394809545](https://github.com/mihazs/lazysh/actions/runs/44394809545) of the branch's proof-of-concept workflow on commit `5c108de0`, this branch before its rebase onto `main`, which changed no code (the same steps as the `native-ios-simulator` step, run by a temporary workflow because that job does not run on pull requests; its first run on `main` will repeat the proof there): hosted `macos-26-arm64` runner image 20261112.0504, Xcode 26.6, iOS 26.5 simulator, **iPhone 16 Pro** (402x874 points, 3x, Dynamic Island), the simulator's own GPU ("Apple iOS simulator GPU"). All 9 UI tests and the 4 pixel-arithmetic tests passed, and the same run passed again when re-run (attempt 2: the same sizes, 0 pt placement errors; the only record that differed was the number of refused background frames, 12 then 14). "Pass" means the named test passed there; the numbers are from its records.

| Gate item | Result | Evidence and limit |
| --- | --- | --- |
| Metal on the host | **Pass** | `MTLCreateSystemDefaultDevice()` returned a device and the view drew frames (`testMetalDeviceIsAvailableAndDrawsTheSurface`). The hosted runner is a virtual machine; the simulator's GPU is not a device GPU. |
| Placement at a DOM anchor | **Pass** | The surface sits at the anchor's rectangle with **0 pt error** on both readings: the host's frame and the surface-coloured pixels of the screenshot equal the page's accessibility frame, 200x634 pt at (40,110), i.e. 600x1902 device pixels at 3x (`testSurfaceBelow...`). After a **scroll** of 80 pt the anchor and the surface moved to (40,30) together with the same size and 0 pt error (`testScrollingMovesTheWebView...`). Not covered: the surface *during* the scroll (the page-to-native hop is asynchronous, so it can trail the DOM by a frame; measured only after the page settled), page zoom, a fractional scale. |
| Overlap with DOM overlays | **Pass below; fails above, as it must** | With the surface below the transparent web view the red DOM box is drawn over the surface (the pixel at the centre of the overlap is the box's colour) and the surface shows through the page elsewhere. The same host with the surface **above** the web view shows the surface colour at that pixel (`testSurfaceAboveTheWebView...`): the check can fail, and a surface on top would hide menus, the palette and the keyboard toolbar. |
| Touch routing and web view scrolling | **Pass (synthetic touches through XCUITest)** | A tap on the anchor reaches the page (1 DOM tap, 0 touches on the `MTKView`); with the surface above it is the reverse (1 on the view, 0 in the page). A swipe over the page scrolls it by 80 pt with the surface below: the web view keeps its scrolling and hit testing, the open question of [native rendering](native-rendering.md#unresolved-questions). With the surface below every gesture arrives in the DOM and must be forwarded to the core. Real fingers, long press, pinch and the Pencil were not tried. |
| Resize and the keyboard | **Pass: one resize per transition** | Focusing the field shows the soft keyboard and the page's visual viewport shrinks (the 258 pt pane implies a 498 pt viewport, 376 pt less than the screen); the surface was resized **exactly once**, 634 to 258 pt high, and followed the anchor with 0 pt error; dismissing it resized once more, back to 634 (`testKeyboardResizesTheSurfaceOnce`, sizes `[600,696,634,258,634]`). The first three sizes are the **launch** (below). Not covered: the keyboard's undocked, split and floating forms, the predictive bar toggling, hardware keyboards (the soft keyboard did appear on the runner), one-PTY-resize semantics (nothing is wired to a PTY). |
| Safe areas and rotation | **Pass** | The page's `env(safe-area-inset-top)` and `-left` equal the host's `safeAreaInsets` in portrait (62, 0: the Dynamic Island) and landscape (0, 62), and the anchor lands on the inset plus the fixture's offset. The surface equals the anchor in portrait (0 pt error), in landscape (within the test's 1.5 pt tolerance, the error was not recorded) and after rotating back, and in portrait it stays between the top inset and the home indicator. The Dynamic Island, the home indicator and the side insets of other devices, iPad window sizes and Stage Manager were not exercised. |
| Destroy and recreate | **Pass** | Removing the surface from the page leaves nothing on screen at the anchor (the backdrop shows); creating a new one draws the same colour at the same place from the same session (`created=2`, `destroyed=1`). A **process restart** (terminate, launch) places a new surface at the anchor again. GPU loss and memory warnings were not exercised. |
| Background and foreground | **Pass** | While the app was in the background the host's simulated output asked for 12 frames, **all refused, none drawn** (iOS does not allow GPU work from the background). After returning, the first frame was drawn when the app became active and the surface was at the anchor again. The simulator does not enforce the background prohibition, so this shows the host's guard, not iOS's reaction to a violation. |
| Accessibility feasibility | **Not run** | The page's DOM elements and the surface's accessibility label are visible to XCUITest, which is not VoiceOver. A screen-reader route is [#1335](https://github.com/mihazs/lazysh/issues/1335). |
| Shipping behaviour unchanged | **Pass by construction** | A separate target and scheme; the app target, its Rust build phase, its capabilities and the other test schemes are untouched. |

**What the launch showed.** The first three sizes the surface took, 600, 696 then 634 pt high, are the page settling. Read from the fixture's formula (the pane is the visual viewport's height less its offset and 130 pt), they match a first layout inside the safe area (a 778 pt viewport), then the full 874 pt screen while `env(safe-area-inset-top)` is still 0, then the inset arriving, which fires neither a `resize` nor a `scroll` event; the viewport heights themselves were not recorded. The fixture observes a probe element whose size is the inset (`ResizeObserver`) and the host follows each report, so the surface ends exact; earlier runs of the fixture without the probe (one also asking the page to measure again from native when the insets changed) left the surface 62 pt above its anchor. A real host must treat the first reports as transient (and not send each to the PTY as a resize), and must watch the safe-area insets as the fixture's probe does.

## Recommended strategy

**Recommended: an `MTKView` (or a `CAMetalLayer`-backed view) inserted below the transparent `WKWebView` in the window's view, with the terminal pane left transparent in the DOM.** It is the iOS counterpart of the Android `SurfaceView` and Linux `wl_subsurface` results: every DOM overlay stays correct, gestures stay in the DOM (and are forwarded), and the web view's scrolling is unchanged. **Surface above the web view is rejected for the terminal pane** (it hid the DOM box and took the touches); it may suit a deliberate full-screen terminal mode where no overlay can intersect it.

What this implies, none of it verified against the real app:

- **The real page must be transparent over the pane.** The fixture paints nothing under the anchor; the shipping page paints opaque `html`, `body` and container backgrounds, and every ancestor of the pane must stop painting there while a native surface is in use. wry sets the web view's background colour at creation (`systemBackgroundColor` unless one is given, with `setOpaque(false)`); the app would need a clear one, and the cost of a translucent web view is unmeasured.
- **A plugin, as `packages/apple-status` is.** The host's code is the starting point of a Swift plugin that finds the web view's superview and inserts the view below it, and a command carrying the anchor in CSS pixels plus the visual viewport's offset (the Android and Linux contract). The page-to-native hop is the same asynchronous one.
- **Placement uses the visual viewport.** `getBoundingClientRect()` is relative to the layout viewport; with the keyboard up or the page zoomed the screen position is the rectangle minus the visual viewport's offset, as the fixture does.
- **The first reports are transient** and the safe-area insets change without an event (above).
- **Draw on request and never from the background.** An idle terminal draws nothing (the host draws only when asked); a draw requested in the background must be dropped and the surface redrawn when the app becomes active.

## What this does not establish

- **No device.** No real GPU, no frame pacing, tearing, refresh-rate (ProMotion), thermal or energy figure, and no Metal behaviour a device enforces and the simulator does not (background GPU permission, memory limits). **Accepted risk, not measured** (battery energy is gate G16).
- **One simulator, one scale.** iPhone 16 Pro on iOS 26.5, 3x; no 2x device, no iPad (split view, Stage Manager, window resizing), no older OS (the app targets iOS 16.0), no other safe-area shape.
- **The fixture, not the app.** The hierarchy is wry's as read from its source, but the real Tauri window, tao's view controller, the app's custom protocol and its opaque page were not in the loop, and no Tauri plugin or command carried the anchor.
- **No real input.** Touches were synthesized by XCUITest; no real finger, hardware keyboard, IME, Pencil or pointer, no VoiceOver ([#1334](https://github.com/mihazs/lazysh/issues/1334), [#1335](https://github.com/mihazs/lazysh/issues/1335)).
- **No terminal and no performance figure.** The frame cost and idle wakeups of the empty view the issue asks for are **not measured**: the [benchmark harness](terminal-benchmarks.md) was not run; the host only shows that it draws on request. No wgpu or Metal-via-Rust surface: the host clears through Metal directly, and the shared core does not build for iOS yet ([#1312](https://github.com/mihazs/lazysh/issues/1312)).
- **Little stability evidence.** Two attempts of one commit on one hosted runner image, both green (two earlier commits needed fixes to the harness, not to the arrangement, before the first green run); no flake rate.

## Reproducing

On macOS with Xcode, after the Xcode project exists (`bun run build:ios`, or `bunx moon run client:init-ios` alone, which is all the proof needs) and an isolated simulator is booted as in [iOS testing](../ios-testing.md):

```sh
export TEST_RUNNER_LAZYSH_SURFACE_POC_RESULTS=/tmp/surface-poc.jsonl; : > "$TEST_RUNNER_LAZYSH_SURFACE_POC_RESULTS"
bun run test:ios-surface-poc
```

The records are the JSON lines in that file; the screenshots (surface below, above, after scroll, with the keyboard, in landscape, removed) are attachments of `apps/client/src-tauri/gen/apple/surface-poc-ui.xcresult`. The pixel arithmetic can be run anywhere Swift and XCTest are: `SurfacePocAnalysis.swift` and `SurfacePocAnalysisTests.swift` use only Foundation.

## Installed app verification

The native-enabled iOS Simulator app admitted Metal and attached a terminal
surface to an owned SSH session. The harness checked the known frame through
the native core, sent input over the real Tauri bridge and received a response
from the SSH peer. Releasing the core preserved the connection and delivered
the next response to the WebView channel. The same run compiled the native
runtime for iOS device and simulator and passed the simulator runtime tests.
[Hosted run](https://github.com/mihazs/lazysh/actions/runs/45781635304/job/139779972510)

Physical iPhone lifecycle, keyboard behavior, VoiceOver, and battery
measurements remain tracked in [#1330](https://github.com/mihazs/lazysh/issues/1330).
