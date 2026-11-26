# Windows native surface composition probe

Status: **probe with a first measurement, not shipped**. Answers the open question of the [Windows, macOS and iOS strategies](windows-macos-ios-surface-strategies.md#what-the-shipped-stack-does) for Windows ([#1332](https://github.com/mihazs/lazysh/issues/1332), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)): does a child window **below** a transparent windowed WebView2 show through it, so that a native terminal surface can sit under the page the way the Android, Linux (Wayland) and iOS surfaces do? The probe paints a solid colour, from the window class's GDI brush or from a wgpu Direct3D 12 swapchain: no terminal, no renderer, nothing in the app. Related: [Linux PoC](linux-surface-composition-poc.md) · [Android PoC](android-surface-composition-poc.md) · [iOS PoC](ios-surface-composition-poc.md) · [native rendering](native-rendering.md#composition-gate) · [migration plan](terminal-migration-plan.md).

## What was built

`packages/terminal-runtime/prototypes/windows-surface` is a standalone crate (its own lock file, like the Linux probe). It opens a window with **tao 0.37.2 and wry 0.57.1**, the versions in the root `Cargo.lock`, and builds the web view the way Tauri does: a transparent tao window (`with_transparent(true)`) and a WebView2 with a transparent background, hosted by wry in a child window that fills the client area. The page is a fixture: a transparent body, an anchor `div`, a red box that overlaps the anchor's lower right corner, and a script that reports the devicePixelRatio and both rectangles to Rust whenever the anchor moves (the DOM-to-native hop of the [Android PoC](android-surface-composition-poc.md)).

The probe runs six scenarios, each a way of **stacking** the surface and a way of **painting** it, once with a transparent tao window (DWM blur-behind, which is what `with_transparent(true)` makes) and once with an **opaque** tao window and only the web view transparent (the app's window is opaque today):

| Stacking | How |
| --- | --- |
| `below` | A child window of the app window, put at the bottom of its siblings with `SetWindowPos(HWND_BOTTOM)`, so wry's web view window is above it. No `WS_CLIPSIBLINGS`. |
| `belowclipped` | The same with `WS_CLIPSIBLINGS`, which makes Windows clip the surface by the siblings above it. |
| `abovecutout` | The child window on top (`HWND_TOP`) with the overlay's rectangle cut out of it by `SetWindowRgn` (`CombineRgn(RGN_DIFF)`), the region the page would feed. |

| Painting | How |
| --- | --- |
| `gdi` | The window class's background brush: GDI writes no alpha channel. |
| `direct3d12` | A wgpu 30 flip-model swapchain on the child's `HWND` (the renderer's backend on Windows), cleared to the colour and presented. On a hosted runner this is WARP, the CPU adapter that ships with Windows. |

For each scenario the probe creates the surface at the anchor (60,40 240x160 CSS pixels), moves the anchor (110,70 150x100), destroys the surface, and creates another of a different colour, and **after every step reads its own window back twice**: `PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT)`, which asks Windows to render the window's full content including DirectComposition into a bitmap, and a screen copy of the client rectangle (`BitBlt` with `CAPTUREBLT`), which is what the desktop compositor put on screen. Before any scenario a **control** reads the window with no surface: if the page's red box is not drawn in the screen readback, nothing the probe reports means anything and the program exits with status 2. Every judgement is in device pixels: the surface's colour must cover exactly the anchor minus the part under the overlay (same pixel count, same bounding box), and the overlay must be drawn in full (every red pixel present).

`.github/workflows/windows-surface-probe.yml` builds it and runs it on `windows-latest` (a pull request or push that touches the crate or the workflow), writes `report.md` of both window modes to the job summary and keeps a PNG of every readback as an artifact. The program exits 2 when the control shows the page is not drawn (nothing it reports then means anything) and 1 when the strategy recorded below stops holding on the screen readback, so the job guards the decision, not only the first measurement. It is not a required check and no `checks.yml` job selects it. The pixel arithmetic has two unit tests that run anywhere (`cargo test` in the crate).

## Results

Host: a GitHub-hosted `windows-latest` runner (Windows NT 10.0.26100, one 1024x768 32-bit display at 96 dpi, WebView2 runtime 156.0.4314.58). It has no GPU: the Direct3D 12 adapter was "Microsoft Basic Render Driver" (WARP, a CPU adapter). Two runs on the pull request: [44435024231](https://github.com/mihazs/lazysh/actions/runs/44435024231) (transparent window only; it ran the GDI scenarios first, and their leftover pixels sat under the scenarios after them) and [44436140521](https://github.com/mihazs/lazysh/actions/runs/44436140521) (Direct3D 12 first, both window modes). The Direct3D 12 rows below are identical in both window modes and in both runs' screen readbacks; every readback is exact in device pixels (the surface's colour covers the anchor minus the overlay with the same pixel count and bounding box, the red box is drawn in full).

| Surface | Created | Moved | Destroyed | Recreated | Page overlay over the surface | Colour at the anchor |
| --- | --- | --- | --- | --- | --- | --- |
| **Direct3D 12 child, below the web view** | pass | pass | pass | pass | yes | `#00c800`, the surface's own |
| Direct3D 12 child, below, with `WS_CLIPSIBLINGS` | fail | fail | pass (nothing there) | fail | yes | `#ffffff`: nothing of the surface shows |
| **Direct3D 12 child, above, overlay cut out with `SetWindowRgn`** | pass | pass | pass | pass | yes, through the hole | `#00c800` |
| GDI child, below, transparent tao window | fail on screen | fail | pass | fail | yes | `#0cd40c`: the surface's colour plus the backdrop |
| GDI child, below, opaque tao window | pass | fail | fail | pass | yes | `#00c800` |

`PrintWindow` and the screen copy agree on every Direct3D 12 step in both window modes. For GDI they differ.

| Gate item | Direct3D 12 child below a transparent WebView2 (hosted runner) |
| --- | --- |
| Surface shows through the transparent page | **Pass**, exactly, with a transparent tao window and with an opaque one (only the web view transparent) |
| DOM overlay over the surface | **Pass**: the red box is drawn in full over the surface |
| Placement at an anchor, following an anchor change, destroy, recreate | **Pass** (screen and `PrintWindow`) |
| Child created with `WS_CLIPSIBLINGS` | **Fail**: Windows clips it by the web view's window above it. The child must be created without it. |
| Child above the web view with the overlay cut out | **Pass**, as a fallback that needs the page to report every overlay rectangle |
| GDI-painted child | **Unusable**: GDI writes no alpha, so on a transparent tao window DWM adds the colour to what is behind the app (a screenshot shows the runner's console text through the green), and on either window a moved or destroyed child leaves its old pixels in the window's surface |
| Resize, per-monitor DPI change, input and focus, IME, device reset | **Not measured** |

What the measurement settles. The desk study's open question, whether a transparent windowed WebView2 shows a *sibling* window behind it and not only its parent's background, is answered yes for a window that presents with a flip-model swapchain, which is what the wgpu renderer does on Windows. It does not need the tao window to be transparent: an opaque window with a transparent web view shows the surface too, which also answers the study's second question (the web view background can be transparent while the host window is not layered). Composition hosting of WebView2, which needs a different wry, is therefore not needed and was not probed.

**Recommended strategy for Windows**: a child window of the app's window, created without `WS_CLIPSIBLINGS`, put at the bottom of its siblings (`SetWindowPos` with `HWND_BOTTOM`) at the anchor in the web view's coordinates (the web view fills the client area), presenting a Direct3D 12 flip-model swapchain through wgpu, under a web view with a transparent background; `SetWindowRgn` with the overlay rectangles cut out is the fallback. A CPU renderer cannot use GDI for this and would have to present through a swapchain too (inference from the GDI rows, not measured).

Decision for the plan: the Windows composition gate is **provisionally passed on a hosted runner** for that arrangement and is **not accepted**. [#1332](https://github.com/mihazs/lazysh/issues/1332) stays open: the app's own window and Tauri's setup, per-monitor DPI, IME through TSF, device-reset recovery, Narrator and NVDA, a real GPU, and the kill switch are still to be shown, so **Windows keeps xterm.js, Auto resolves to xterm.js there and the Native option stays disabled with the reason** until its native surface exists and passes ([S4](terminal-migration-plan.md#rollout-stages), [G19](terminal-migration-plan.md#acceptance-gates-and-evidence)). These runs are the pull request's; the run on `main` after the merge is the evidence the plan counts.


## App integration

The feature-enabled Windows app hosts a D3D12 renderer in a child HWND below WebView2. Its surface commands place the child in device pixels using the CSS anchor and report the drawable size. The web view keeps input ownership. The renderer worker stops before its child window is destroyed.

The Windows probe workflow also compiles the feature-enabled app and tests fractional and high-DPI anchor conversion. Real app capture, per-monitor DPI transitions, input, accessibility, device recovery and rollback still need their own acceptance evidence for [#1332](https://github.com/mihazs/lazysh/issues/1332).

The workflow's manual `installer_engine` input builds an unsigned release-profile NSIS test installer with the native engine enabled or disabled. It checks that the installer can install, repair, and uninstall the exact app binary on an owned Windows runner. The test package omits the bundled companion. Launching the installed terminal and verifying renderer selection or fallback are separate acceptance steps.

## What this does not establish

- **No hardware.** A hosted runner has no GPU (Direct3D 12 is WARP) and no physical display: a real driver's swapchain, its DirectFlip and independent flip paths, and multiple monitors are not measured. **Accepted risk, not measured.**
- **Composition hosting is not probed.** wry 0.57.1 hosts WebView2 in a window (`CreateCoreWebView2Controller` on an `HWND`); hosting it as a visual in the app's own DirectComposition tree needs a different wry (a fork or a patch, none proposed here). It is the strategy to evaluate if the two probed ones stop working, for example after a WebView2 update (the job fails then).
- **Per-monitor DPI changes, IME through TSF, device reset, Narrator and NVDA, input routing and focus** are the later acceptance items of #1332 and are not exercised: the runner is one monitor at one scale, and no input is injected.
- **The fixture page, not the app's.** The real page's opaque backgrounds, its cost when translucent and the real Tauri window setup were not in the loop.
- **One runner image and one WebView2 runtime**, and one run. A measurement of this kind is only as good as its repeatability; the main-branch runs are the evidence the plan counts.

## Reproducing

On Windows with the WebView2 runtime (Windows 11 and current Windows 10 have it):

```sh
cd packages/terminal-runtime/prototypes/windows-surface
cargo test --locked
cargo run --locked -- out
```

`out/report.md` has the table and `out/*.png` the readbacks. Run it on an interactive desktop with the window visible: the screen readback reads what is on screen.
