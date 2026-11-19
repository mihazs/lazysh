# Windows native surface composition probe

Status: **probe, first measurement pending**. Answers the open question of the [Windows, macOS and iOS strategies](windows-macos-ios-surface-strategies.md#what-the-shipped-stack-does) for Windows ([#1332](https://github.com/mihazs/lazysh/issues/1332), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)): does a child window **below** a transparent windowed WebView2 show through it, so that a native terminal surface can sit under the page the way the Android, Linux (Wayland) and iOS surfaces do? The probe paints a solid colour, from the window class's GDI brush or from a wgpu Direct3D 12 swapchain: no terminal, no renderer, nothing in the app. Related: [Linux PoC](linux-surface-composition-poc.md) · [Android PoC](android-surface-composition-poc.md) · [iOS PoC](ios-surface-composition-poc.md) · [native rendering](native-rendering.md#composition-gate) · [migration plan](terminal-migration-plan.md).

## What was built

`packages/terminal-runtime/prototypes/windows-surface` is a standalone crate (its own lock file, like the Linux probe). It opens a window with **tao 0.37.2 and wry 0.57.1**, the versions in the root `Cargo.lock`, and builds the web view the way Tauri does: a transparent tao window (`with_transparent(true)`) and a WebView2 with a transparent background, hosted by wry in a child window that fills the client area. The page is a fixture: a transparent body, an anchor `div`, a red box that overlaps the anchor's lower right corner, and a script that reports the devicePixelRatio and both rectangles to Rust whenever the anchor moves (the DOM-to-native hop of the [Android PoC](android-surface-composition-poc.md)).

The probe runs six scenarios, each a way of **stacking** the surface and a way of **painting** it:

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

`.github/workflows/windows-surface-probe.yml` builds it and runs it on `windows-latest` (a pull request or push that touches the crate or the workflow), writes `report.md` to the job summary and keeps a PNG of every readback as an artifact. It is not a required check and no `checks.yml` job selects it. The pixel arithmetic has two unit tests that run anywhere (`cargo test` in the crate).

RESULTS_PLACEHOLDER

## What this does not establish

- **No hardware.** A hosted runner has no GPU (Direct3D 12 is WARP) and no physical display: a real driver's swapchain, its DirectFlip and independent flip paths, and multiple monitors are not measured. **Accepted risk, not measured.**
- **Composition hosting is not probed.** wry 0.57.1 hosts WebView2 in a window (`CreateCoreWebView2Controller` on an `HWND`); hosting it as a visual in the app's own DirectComposition tree needs a different wry (a fork or a patch, none proposed here). It is the strategy to evaluate if the two probed ones fail.
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
