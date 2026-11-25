# macOS native surface composition proof of concept

Status: **proof of concept on the hosted macOS runner at 1x, not shipped**. Answers the composition gate in [native rendering](native-rendering.md#composition-gate) for macOS ([#1333](https://github.com/mihazs/lazysh/issues/1333), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)): can an `NSView` that hosts a `CAMetalLayer` sit **below** the transparent `WKWebView` Tauri uses, inside wry's `WryWebViewParent`, without hiding the DOM overlays or taking the web view's pointer and keyboard? The probe paints one solid colour: no terminal, no renderer, nothing in the app. Related: [iOS PoC](ios-surface-composition-poc.md) · [Linux PoC](linux-surface-composition-poc.md) · [Android PoC](android-surface-composition-poc.md) · [Windows, macOS and iOS strategies](windows-macos-ios-surface-strategies.md) · [ADR 0001](adr-0001-terminal-runtime.md).

**Decision for the plan: go at 1x** ([#1333](https://github.com/mihazs/lazysh/issues/1333) may start from this arrangement). The gate is **not accepted**: the display scale 2 could not be measured on the hosted runner (it has no 2x display and a virtual one did not come up), so Retina placement is **accepted risk, not measured** and, as the plan requires for an item a host cannot exercise, macOS does not flip. Until a native surface exists on macOS and passes its own gates, Auto resolves to xterm.js there and the Native option stays disabled with the reason ([what this does not establish](#what-this-does-not-establish)). The `drawsBackground` question is answered in [its own section](#the-drawsbackground-private-key).

## What was built

| Piece | Where | Notes |
| --- | --- | --- |
| `surface-poc` | `packages/terminal-runtime/prototypes/macos-surface` | A standalone crate (its own lock file and workspace, like the [Linux prototype](linux-surface-composition-poc.md#what-was-built)), macOS only. It opens a window with **tao 0.37.2 and wry 0.57.1**, the versions in the root `Cargo.lock`, and builds the web view with `WebViewBuilder::build(&window)` the way Tauri does, so the hierarchy is wry's: `WryWebViewParent` is the window's content view and the `WKWebView` its only subview (the probe prints the class chain). It inserts a layer-hosting `NSView` whose layer is a `CAMetalLayer` into that parent with `addSubview:positioned:relativeTo:` (`NSWindowBelow` the web view, or `NSWindowAbove` for the comparison) and clears it to one colour through Metal directly. Its frame is the anchor, its drawable `anchor x backingScaleFactor` pixels, and it is placed again on every anchor report from the page and every window resize. |
| Fixture page | `host.rs` | A transparent body, an anchor `div` the page reports in CSS pixels through `window.ipc` (the DOM-to-native hop of the [Android](android-surface-composition-poc.md) and [Linux](linux-surface-composition-poc.md) probes), an opaque red DOM box over the anchor's lower right corner (the menu, palette or selection handle that must stay on top), a text field, and a `mousedown` log. The window is created transparent (`with_transparent(true)`), the web view with `with_transparent(true)`, which is what sets wry's `drawsBackground` key. |
| Readback | `capture.rs`, `probe.rs` | The probe reads **its own window back from the window server** (`CGWindowListCreateImage` for the window's number, with the framing excluded, found with `dlsym` because Apple obsoleted it for new code in macOS 15; `screencapture -l` is the fallback and was not needed). That image is the window's own composited pixels: transparent (alpha 0) wherever nothing is drawn, so nothing behind the window disturbs a verdict. The page origin in the image is measured from the DOM box (the largest red region of the size of the box, because the title bar's close button is red too), so the title bar needs no assumption, and every expectation is the anchor's CSS rectangle times the scale plus that origin. |
| `surface_analysis` | `src/analysis.rs` | The pixel arithmetic (bounding boxes, connected regions, edge error, byte layouts of a capture) is platform-neutral and has its own tests on synthetic rasters at 1x and 2x, which run on any host (`cargo test --lib`). |
| `terminal-macos-surface` workflow | `.github/workflows/terminal-macos-surface.yml` | Report-only and not a required check. Clippy and the analysis tests, a release build, then three runs of the probe (1x, 2x, and the opaque control), each its own process and window, with the step images and `records.jsonl` uploaded. It runs on a pull request or push that changes the probe or the workflow, and on demand. |

## Results

Source: [run 44449961441](https://github.com/mihazs/lazysh/actions/runs/44449961441) of the workflow on commit `c446fced` (this branch before its squash, which changed no probe file; the first run of the workflow on `main` will repeat it): hosted `macos-latest`, macOS 26.7.2 (25G332) on Apple silicon, Xcode 26.6, Rust 1.96.1, one display of 1024x768 points at 1x, a virtual machine. The same 31 checks passed in three earlier runs of the branch after its harness fixes ([44446393377](https://github.com/mihazs/lazysh/actions/runs/44446393377), [44447159255](https://github.com/mihazs/lazysh/actions/runs/44447159255), [44448715876](https://github.com/mihazs/lazysh/actions/runs/44448715876); their probe code differed only in the 2x attempt below). Every check is exact in device pixels, with no tolerance on placement. "Pass" means the named checks passed there; the numbers are from the records.

| Gate item | Result | Evidence and limit |
| --- | --- | --- |
| Readback of the app's own window | **Pass** | The capture is 640x432 px for the 640x432 point window at 1x and equals the window's geometry (a 32 point title bar over a 640x400 content view). Where nothing is drawn the capture is transparent, so the web view and the window are transparent as built. |
| Placement at a DOM anchor | **Pass** | The surface covers 240x160 px at (60,72), the anchor's (60,40) plus the 32 px title bar, with **0 px error on all four edges**, and the colour read back is the colour asked for (51,102,255), 0 off. Not covered: a fractional anchor, the surface *during* a page movement (the page-to-native hop is asynchronous; the capture is polled until the arrangement holds, which took 28 ms the first time). |
| Follow an anchor change | **Pass** | After `setAnchor`, 150x100 px at (110,102), 0 px error, 56 ms after the page's report. |
| Overlap with DOM content | **Pass below; fails above, as it must** | With the surface below, the DOM box is drawn over it (the pixel at the centre of the overlap is the box's red) and the box is whole (0 px error). With the same surface above the web view that pixel is the surface's colour: the check can fail, and a surface on top would hide menus, the palette and selection handles. |
| Resize | **Pass** | The window went from 640x400 to 560x360 and back (points); each time the surface stayed at its anchor with 0 px error. The parent view is not flipped (its origin is bottom left), so the host has to place the surface again on a resize, as the probe does; whether skipping that would displace it was not run. |
| Destroy and recreate | **Pass** | After `removeFromSuperview` no pixel of the surface's colour remains; a new surface of another colour appears at the same anchor with 0 px error in the same process (13 ms). Not covered: recreating the web view, GPU loss, a Metal device removed. |
| Pointer routing | **Pass (AppKit hit test and one synthesized click)** | With the surface below, `hitTest` at a point inside the anchor returns the web view and a left click sent through `NSWindow.sendEvent` arrives in the page; with the surface above the hit test returns the surface view, so the comparison fails as it must. A synthesized click still reached the page with the surface above, which is not understood and was reported, not judged (the arrangement to use is the one below). Real events (a pointer, a trackpad, a touch) were not tried. |
| Keyboard focus | **Pass** | The first responder is the web view before the surface exists and after it is added, below or above (`NSView` does not take first responder). No key event was injected, and no IME was run ([#1334](https://github.com/mihazs/lazysh/issues/1334)). |
| `drawsBackground` | **Answered**, [below](#the-drawsbackground-private-key) | The control run, a web view built without the key, paints opaque white over the pane and hides the surface completely. |
| Scale 2 | **Not measured** | The hosted display offers only 1x modes (12 modes from 640x480 to 1920x1080, all 1x). A virtual 2x display from the private `CGVirtualDisplay` API was tried in three runs of the branch: it was created (display 2, active and online, one mode on the object) but CoreGraphics reported no mode for it, so no window could be placed at 2x, and the attempt was removed from the probe. The `contentsScale` and drawable-size arithmetic are exercised at 2x on synthetic rasters only. Accepted risk, not measured. |
| Shipping behaviour unchanged | **Pass by construction** | A separate crate and workflow; no app source, dependency, capability or entitlement changed. |

## The `drawsBackground` private key

wry 0.57.1 makes the web view transparent by setting the KVC key `drawsBackground` to `NO` on the `WKWebViewConfiguration` when a web view is built with `transparent` (or a background colour), and `set_background_color` repeats it on the instance (the source marks that call as private API). The control run shows what it buys: **without it the `WKWebView` paints opaque white over the pane and a surface below it is never seen**, so a native surface below the web view needs the key, and no public alternative exists in the arrangement (`underPageBackgroundColor`, public since macOS 12, only colours the overscroll area).

Whether the key is **acceptable** depends on the channel, and that is the maintainer's decision, recorded here with what is known:

- Tauri 2.12.5, the version the app ships, documents the private-API gate for the transparent window as a no-op since 2.12.1 ("the APIs are always enabled now"): the selector string is already compiled into every build, and the app sets neither `transparent` nor a background colour, so it is never called today (`tauri.conf.json` has no transparent window). A native surface would be the first caller on macOS.
- No macOS application package is published (`docs/install-and-update.md`: public macOS packages are deferred, use a source build), and nothing distributes through the Mac App Store. Private selectors are an App Review matter, not a notarization one; for source builds and any future Developer ID distribution the key is acceptable, for the **Mac App Store it is not**.
- Decision for the plan: the key is acceptable for the channels that exist. **If a macOS release ever goes through the Mac App Store, macOS keeps xterm.js there, a documented refusal**, and the surface's registry probe ([#1336](https://github.com/mihazs/lazysh/issues/1336)) must report it as such.

## Recommended strategy

**A layer-hosting `NSView` with a `CAMetalLayer`, inserted below the transparent `WKWebView` in `WryWebViewParent`, with the terminal pane left transparent in the DOM.** It is the macOS counterpart of the Android `SurfaceView`, Linux `wl_subsurface` and iOS `MTKView` results: every DOM overlay stays correct, the web view keeps the pointer and the keyboard, and the compositor shows the terminal's pixels. A surface **above** the web view is rejected for the terminal pane (it hid the DOM box and took the hit test).

What this implies for the host, none of it verified against the real app:

- **The real page must be transparent over the pane.** The fixture paints nothing under the anchor; the shipping page paints opaque `html`, `body` and container backgrounds, and every ancestor of the pane must stop painting there while a native surface is in use. The window and the web view must be built transparent, which needs the key above.
- **Position = anchor in CSS pixels from the web view's corner, converted to the parent's bottom-left origin and placed again on every anchor report and every window resize.** The drawable is `anchor x backingScaleFactor` pixels with `contentsScale` set, and it has to be drawn again after it is resized (resizing discards its contents).
- **A Tauri command carries the anchor** (the Android and Linux contract, `native_terminal_surface_place`, `_remove`, `_state`), and the host finds the web view's superview from the `WKWebView` Tauri exposes. Tauri's own window setup and its `with_webview` hook were not in the loop here.
- **The renderer's surface.** `terminal-renderer-wgpu` presents through wgpu's Metal backend; wgpu making a Metal surface from this `NSView` (it sets up its own `CAMetalLayer`) was not tried, the probe clears through Metal directly.

## App integration

The feature-enabled Tauri app uses the existing terminal surface commands to place an AppKit view beneath WKWebView. It converts the page anchor through the display backing scale and web view coordinates, and gives the shared renderer worker the retained Metal layer. Teardown joins that worker before removing the view.

The hosted app job builds the native-enabled app and runs the anchor conversion test for Retina scale, page zoom, and flipped coordinates. The standalone probe supplies the window-server pixel evidence. The actual app still needs window readback, Retina and input checks, VoiceOver or a tested refusal, performance, and rollback acceptance for [#1333](https://github.com/mihazs/lazysh/issues/1333).

## What this does not establish

- **Scale 2.** The one measurement the plan asks for that the runner could not give (above). A 2x host, or a runner image with a Retina display, is needed before macOS can flip; fractional scales, a window moved between displays of different scales and a scale change while a surface exists were not exercised.
- **One host.** macOS 26.7.2 on a virtual machine, one 1x display, one GPU (the runner's virtual one; its name was not recorded), one run image. No other macOS (the app targets macOS 13.0), no real GPU, no HDR, no wide-gamut colour management (the colours came back exact on the runner's display), no dark-mode or Stage Manager or full-screen or Spaces case.
- **The fixture, not the app.** The hierarchy is wry's as built here, but the real Tauri window (its title bar, overlay or traffic-light options), the app's custom protocol and its opaque page were not in the loop.
- **No real input.** A hit test, a first-responder check and one click synthesized through `NSWindow.sendEvent`; no real pointer, trackpad, key, IME, or VoiceOver ([#1334](https://github.com/mihazs/lazysh/issues/1334), [#1335](https://github.com/mihazs/lazysh/issues/1335)).
- **Lag during scroll and animation.** Verdicts are taken after the arrangement settles; the surface was not measured while the page moved.
- **No terminal and no performance figure.** Frame time and idle CPU of an empty view are **not measured**; the [benchmark harness](terminal-benchmarks.md) was not run, and energy is [gate G16](terminal-migration-plan.md), accepted risk, not measured.
- **Little stability evidence.** Four green runs of the same checks on the same runner image; no flake rate. The runs before the last fixes failed in the harness (the title bar's red close button was taken for the DOM box), not in the arrangement.

## Reproducing

On a Mac with a logged-in graphical session (the probe opens a window and captures it), with Rust:

```sh
cd packages/terminal-runtime/prototypes/macos-surface
cargo test --lib                     # the pixel arithmetic, on any host
cargo build --release
export POC_OUT=/tmp/surface-poc
POC_SCALE=1 target/release/surface-poc            # 1x; POC_SCALE=2 switches the display to a 2x mode if it has one
POC_TRANSPARENT=0 target/release/surface-poc      # the control: a web view without the drawsBackground key
```

Each run prints one `PASS`, `FAIL` or `INFO` line per check and appends one JSON record to `$POC_OUT/records.jsonl`, with a PNG of every step. Exit status: 0 every check passed, 1 a check failed, 2 the probe could not measure, 3 the display has no such scale (not a failure: not measured). The runs above are the `terminal-macos-surface` workflow, which uploads the records and images as the `lazysh-macos-surface-poc` artifact.

## Checking the real app window

With the feature-enabled macOS host from #2647, build a debug app and run the app-window driver in a logged-in macOS session with Xcode command-line tools and Python Pillow installed.

```sh
cargo build --locked --manifest-path apps/client/src-tauri/Cargo.toml --features native-terminal
python3 packages/terminal-runtime/prototypes/macos-surface/scripts/check-app.py target/debug/lazysh /tmp/lazysh-app-window
```

The driver uses the same development URL and Tauri command fixture as the Wayland app test. It starts an owned local terminal, looks up the window belonging to the process it launched, and measures the four coloured cells during placement and movement. The DOM overlay is the visible capture control. Removal requires the native pixels to disappear while the overlay remains visible. The output directory retains frame images, the app log and a success report. The check requires macOS permission to capture the owned window.

[The hosted macOS app run](https://github.com/mihazs/lazysh/actions/runs/45669417189) measured placement at (60, 72) and movement to (110, 102) on a 1x display. The renderer uses the WebView's safe area as its origin, so the 32-point title bar does not shift the terminal relative to the DOM. The window capture verified that removing the terminal cleared its pixels and left the overlay visible. Retina placement still needs a 2x capture.
