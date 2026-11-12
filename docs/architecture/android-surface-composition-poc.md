# Android native surface composition proof of concept

Status: **proof of concept, debug builds only**. Answers the composition gate in [native rendering](native-rendering.md#composition-gate) for Android ([#1310](https://github.com/mihazs/lazysh/issues/1310), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)). It draws a solid colour with plain Android APIs: no terminal, no wgpu, no shipped behaviour. Related: [platform integration](platform-integration.md) · [ADR 0001](adr-0001-terminal-runtime.md).

## What was built

| Piece | Where | Notes |
| --- | --- | --- |
| `NativeSurfaceHost` | `apps/client/src-tauri/gen/android/app/src/debug/java/app/lazysh/client/surfacepoc/` | A `SurfaceView` or `TextureView` placed in the content `FrameLayout` from a DOM anchor (`getBoundingClientRect()` in CSS pixels plus `devicePixelRatio`). Draws the colour held by `PocSession`, a process-owned stand-in for session state. Also exposes an input connection, a virtual accessibility node and touch counting. |
| `NativeSurfaceCompositionTest` | `.../app/src/androidTest/java/app/lazysh/client/` | Instrumentation on the real `MainActivity` and its Tauri WebView. Runs with the ordinary `bun run test:android` task (the `native-android-runtime` CI job). |

Gating: the host lives in the `debug` source set, so no release variant contains it, and nothing in the app, the Rust side or the capabilities file references it; only instrumentation attaches it. There is therefore no Tauri plugin and no IPC command in the PoC: registering a command would add a permission to the production capability file for a question that is about compositing. The renderer-to-native hop that would carry an anchor rectangle is the same pattern as `EdgeGesturePlugin.setExclusion`, which already ships view-coordinate rectangles; it is **not exercised here**.

## Results

Source: GitHub Actions run [43178220482](https://github.com/mihazs/lazysh/actions/runs/43178220482), job `native-android-runtime`, commit `e891b6d8`: API 36 AOSP `default` image, x86_64, `pixel_2` profile (1080x1920, density 2.625), `-gpu swiftshader` (software GPU), the system WebView of that image. "Pass" means the named test passed there. The same run reported all 10 tests of `NativeSurfaceCompositionTest` passed in the ordinary `test:android` stage; the first attempt (run 43171361443) failed two of them on test-harness defects (the page was not loaded yet; a viewport-relative anchor did not move), fixed in the retained code. No physical device, no other Android version and no other WebView build were used.

| Gate item | Result | Evidence and limit |
| --- | --- | --- |
| Placement at a DOM anchor | **Pass** | A surface placed from `getBoundingClientRect()` x `devicePixelRatio` lands within 1 px of the expected screen rectangle (`surfaceFollowsTheDomAnchor...`), and the composited display shows the surface colour inside the hole of the fixture page's anchor (`surfaceBelow...`, `textureBelow...`). **Not covered:** following the anchor during scroll or an animation (the renderer-to-native hop is asynchronous, so the surface can lag the DOM by at least a frame; not measured), orientation change, foldables, page zoom. |
| Overlap with React overlays | **Pass for surface or texture below a transparent WebView; fails for surface on top** | With the surface below, an opaque DOM box overlapping the hole is shown above it (red pixel over the hole). `SurfaceView` with `setZOrderOnTop` covers the same box (surface colour at the overlap), so menus, the keyboard toolbar and selection tools would be hidden by it (`surfaceOnTopHidesDomOverlaysThatOverlapIt`). Android `Dialog` and `PopupWindow` windows are separate and not tested. |
| Touch routing | **Pass (synthetic events)** | Events follow view order: a surface above the WebView receives them, a surface below does not, so with the recommended stacking all terminal gestures arrive in the DOM and must be forwarded. Real finger input, long press and scroll gestures were not injected. |
| Focus handoff | **Pass at view level** | The surface takes view focus and `InputMethodManager.isActive(surface)` was `true`; focus returns to the WebView on request. The soft keyboard was neither shown nor typed into, and IME composition, SwiftKey and Gboard are **not covered** ([#1328](https://github.com/mihazs/lazysh/issues/1328)). |
| Selection | **Partial** | A floating `ActionMode` starts from the surface. DOM selection tools (`TerminalSelectionTools.tsx`) stay above a surface that is below the WebView, per the overlap result. Native drag handles were not built. |
| Resize and insets | **Pass for a resized WebView** | Shrinking the WebView through its bottom margin, a stand-in for a docked keyboard, moves a bottom-anchored element, and re-reading the rectangle re-places the surface within 1 px. The real `MainActivity` IME inset listener, one-PTY-resize semantics, cutouts and orientation were not exercised. |
| Destroy and recreate | **Pass** | Observed on stop: the surface is destroyed (`created=1 destroyed=1`); after start a new one exists (`created=2`) and the process-owned `PocSession` redraws onto it with no draw reaching an invalid surface. After `ActivityScenario.recreate()` a host attached to the new Activity draws the same session. GPU context loss and process death were not exercised. |
| Accessibility feasibility | **Pass (route exists)** | A virtual `AccessibilityNodeProvider` node on the surface is found by UiAutomator, an accessibility client, with bounds inside the surface. TalkBack, reading order, live updates and selection announcements were **not** run; DOM mirroring remains the other candidate route ([#1329](https://github.com/mihazs/lazysh/issues/1329)). |
| Shipping behaviour unchanged | **Pass by construction** | Debug source set only; no app, Rust or capability file references it. |

Observations that were logged, not asserted: `imm.isActive(surface)=true`; stop and start counters above. They are in the per-test logcat (`lazysh-surface-poc`) of the job artifact.

## Recommended strategy

**Recommended: `SurfaceView` stacked below a transparent WebView, with the terminal pane left transparent in the DOM.** It is the only candidate that keeps every React overlay correct and keeps the DOM hit area, while a `SurfaceView` is its own compositor layer, so by design no per-frame copy goes through the WebView (not measured here). `TextureView` below the WebView passed the same composition cases and is the documented alternative if the hole approach fails on the real page or on a device (its extra GPU copy and latency are unmeasured). `SurfaceView` on top is rejected for the terminal pane: it hides any overlay that can intersect it. It may suit a deliberate full-screen terminal mode where no overlay can overlap.

What this implies, none of it verified against the real app:

- **The real page must be transparent over the pane.** The pixel cases use a fixture page because the shipping page paints opaque `html`, `body` and container backgrounds; every ancestor of the terminal anchor would have to stop painting there. Chrome-level compositing cost of a translucent WebView is unmeasured.
- **The WebView background must be set transparent.** wry sets it only at creation from the window `transparent` flag (`wry-0.57.1/src/android/main_pipe.rs`); `MainActivity.onWebViewCreate` could call `webView.setBackgroundColor(0)` instead. Neither was tried on the real WebView.
- **Gestures stay in the DOM.** With the surface below, the anchor element must forward touch and wheel input to the native core.
- **Anchor updates are an asynchronous hop.** A Tauri command modelled on `EdgeGesturePlugin.setExclusion` would carry the rectangle; lag during scroll and transitions needs a device measurement before committing.

Decision for the plan: the Android composition gate is **provisionally passed on an emulator**. It is not accepted: the migration plan and [ADR 0001](adr-0001-terminal-runtime.md) require the same result on a physical device, so the ADR stays Proposed and [#1310](https://github.com/mihazs/lazysh/issues/1310) stays open for that evidence.

## What this does not establish

- No physical device, so no real GPU, no vendor WebView variation, no refresh-rate, thermal or battery data, and no frame pacing or tearing observation. The emulator uses `-gpu swiftshader`.
- No soft keyboard, IME composition, Gboard or SwiftKey, no hardware keyboard, no TalkBack, no selection handles, no foldable or orientation change, no GPU loss, no system `Dialog` or `PopupWindow` overlap.
- No wgpu or Vulkan surface; the PoC draws through `Surface.lockCanvas`, which cannot be combined with a Vulkan swapchain on the same surface. The composition result does not depend on the producer, but the producer's latency and power do.
- The real Tauri page was not made transparent; see above.
- No Tauri command, so the renderer-to-native hop and its latency are untested.
- No performance or energy figure: the harness in [terminal benchmarks](terminal-benchmarks.md) has not been run.

## Reproducing

The class runs in the ordinary `bun run test:android` task (the `native-android-runtime` job). To run only it on a dedicated emulator, adapt the `test:android-theme-links` task in `apps/client/package.json` with `-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeSurfaceCompositionTest`. This has not been run locally.
