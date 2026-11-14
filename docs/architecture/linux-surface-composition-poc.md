# Linux native surface composition proof of concept

Status: **proof of concept, not shipped**. Answers the composition gate in [native rendering](native-rendering.md#composition-gate) for Linux ([#1331](https://github.com/mihazs/lazysh/issues/1331), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)): can a native surface sit next to the WebKitGTK web view Tauri uses, on Wayland and on X11? The probe paints a solid colour, from CPU buffers or from a wgpu Vulkan swapchain: no terminal, no renderer, nothing in the app. Related: [Android PoC](android-surface-composition-poc.md) · [Windows, macOS and iOS strategies](windows-macos-ios-surface-strategies.md) · [platform integration](platform-integration.md) · [ADR 0001](adr-0001-terminal-runtime.md).

## What was built

`packages/terminal-runtime/prototypes/linux-surface` is a standalone crate (its own lock file, like the other prototypes; no CI job builds it). It opens a window with **tao 0.37.2 and wry 0.57.1**, the versions in the root `Cargo.lock`, and builds the web view into the window's default box the way Tauri does, so the GTK widget tree is the app's. The page is a fixture: a transparent body, an anchor `div`, a red box that overlaps the anchor's lower right corner, an input field, and a script that reports the anchor's `getBoundingClientRect()` to Rust (the DOM-to-native hop the [Android proof of concept](android-surface-composition-poc.md) describes). On a request from `scripts/check.py` the probe creates, moves, recreates or removes a **native surface at the anchor**:

| Display server | Surface | How it is made |
| --- | --- | --- |
| Wayland | A `wl_subsurface` of the toplevel `wl_surface` GDK owns | `gdk_wayland_window_get_wl_surface` and `gdk_wayland_display_get_wl_display` (both exported by libgdk-3) give the handles; `wayland-client` wraps GDK's own `wl_display` (so the subsurface lives on the connection of its parent), binds `wl_compositor`, `wl_subcompositor` and `wl_shm` on a private event queue, sets the subsurface desynchronised, places it **below** the parent (or above, for the comparison), gives it an empty input region, sets `wl_surface.set_buffer_scale` to the window's integer scale, and fills it from a `wl_shm` buffer or, with `POC_RENDER=vulkan`, hands the subsurface's `wl_surface` and GDK's `wl_display` to wgpu 30 as raw Wayland handles and presents a Vulkan swapchain on it. |
| X11 | A child X window of the toplevel | `gdk_x11_window_get_xid` gives the parent; `x11rb` creates, maps, moves and destroys the child on its own connection. |

The anchor is in the web view's coordinates, so the probe adds the web view's offset inside the toplevel (`translate_coordinates`) before it positions the surface, and positions it again whenever the web view's allocation changes (`size-allocate`).

`scripts/check.py` drives the probe through a line protocol, captures what the **compositor** shows (not what the app believes) and asserts on the pixels. Wayland captures come from a headless KWin through `org.kde.KWin.ScreenShot2` (`scripts/virtual-kwin.sh`, `scripts/kwin_shot.py`). A second Wayland compositor, **niri 26.04**, can run nested in that KWin as a window (`POC_COMPOSITOR=niri`; its output scale is set from `POC_SCALE`), and the probe runs inside it. X11 runs on a real X server (a rootful Xwayland on the same KWin, captured with ImageMagick `import -window root`, driven with `xdotool`), which is what Xvfb offers too. The page origin is derived from the right and bottom edge of the red box, which no surface ever covers, so the compositor's window placement does not matter, and every comparison is exact in device pixels.

## Results

Host: CachyOS (Arch Linux), GTK 3.24.52, WebKitGTK 2.54.2 (4.1 API), KWin 6.8.2 started with `--virtual` (it composited with OpenGL ES on the host's AMD Radeon RX 5500 XT, radeonsi; the Vulkan device was the same GPU through RADV), niri 26.04 nested in it, Xwayland for the X11 runs. One run of each scenario; every check is exact (a surface's pixels must equal the anchor rectangle, with no tolerance). All checks of all eight scenarios passed:

| Scenario | Checks passed |
| --- | --- |
| KWin, Wayland, surface below, `wl_shm`, scale 1 | 6 of 6 |
| KWin, Wayland, surface below, wgpu Vulkan swapchain, scale 1 | 7 of 7 |
| KWin, Wayland, surface **above** (the comparison) | 6 of 6, with the DOM box hidden as expected |
| KWin, X11 child window | 9 of 9, with the DOM box hidden as expected |
| niri, Wayland, surface below, `wl_shm`, scale 1 | 6 of 6 |
| niri, Wayland, surface below, wgpu Vulkan swapchain, scale 1 | 7 of 7 |
| niri, Wayland, surface below, `wl_shm`, **scale 2** | 6 of 6 |
| niri, Wayland, surface below, wgpu Vulkan swapchain, **scale 2** | 7 of 7 |

| Gate item | Wayland, surface **below** the transparent web view | Wayland, surface above | X11 child window |
| --- | --- | --- | --- |
| Placement at a DOM anchor | **Pass**: 240x160 at the anchor (60,40) with 0 px error, at scale 1 and 2 (480x320 device pixels) | Pass, same | **Pass**, same |
| Follow an anchor change | **Pass**: after `setAnchor`, 150x100 at (110,70) | Pass | Pass |
| Overlap with DOM content | **Pass**: the red DOM box and the anchor's dashed outline are drawn over the surface (the pixel in the overlap is red) | **Fail by design**: the surface covers the DOM box | **Fail**: the child window covers the DOM box, and the web view has no X window of its own to stack the child below (not checked: that GTK paints it into the toplevel's window is the likely reason) |
| Resize | **Pass**: a window resize keeps the surface at its anchor (KWin re-centres the window; niri sizes the window itself) | Pass | Pass |
| Destroy and recreate | **Pass**: nothing is left on screen after destroy; a new surface of another colour appears with the exact colour (`#3366ff`) at the anchor | Pass | Pass |
| Vulkan swapchain on the surface | **Pass** on both compositors, at both scales | n/a | n/a |
| Pointer routing | **Not injectable** here (KWin offers a client no virtual pointer or keyboard protocol, as `wtype` reports; injection into the nested niri was not tried); the surface has an empty input region, so by protocol every pointer and touch event goes to the toplevel | n/a | **Pass**: a click on the child window arrives in the page at the same coordinates (the child selects no events, so X11 delivers them to the toplevel), as does a click on a DOM field |
| Keyboard routing and focus | **Not injectable** here (same); the probe never asks for keyboard focus on the subsurface, but whether a compositor focuses it was not observed | n/a | **Pass**: a key press reaches the page with the surface mapped |

The "above" column exists to show that the overlap check can fail: with the order reversed the same check reports the DOM box hidden. The X11 failure is not a probe defect: an X11 child window always draws over its parent's own drawing, and the web view's pixels belong to the toplevel's window as far as this measurement shows.

**What the second compositor found.** The first compositor hid two defects of the probe. KWin gives the window server-side decorations, so GTK draws none and the web view sits at the toplevel's origin. niri offers none, so GTK draws a title bar and a shadow into the same `wl_surface`: the web view is not at (0,0) of the surface a subsurface is positioned against, and the first niri run placed the surface 24 px left of and 58 px above its anchor (while the DOM was right). Adding the web view's offset fixed it. That offset changes with the window's size and state (tiling, maximizing, the shadow disappearing), so the probe also re-places the surface on every allocation change of the web view; no scenario here isolates that second step (the one niri run that looked like a displaced surface was the fixture being clipped by a half-width column), so it is design reasoning and not a measured defect. Both belong in the host.

## Recommended strategy

**Wayland: a `wl_subsurface` of the toplevel, placed below it, with a transparent toplevel and a transparent web view.** It is the Linux counterpart of the Android recommendation (`SurfaceView` below a transparent WebView): every React overlay stays correct, gestures stay in the DOM, and the compositor, not a copy through the web view, puts the terminal's pixels on screen. A wgpu Vulkan swapchain presents on such a subsurface (the renderer's backend on Linux).

**X11 and Xwayland: keep xterm.js.** A child window is always on top of the page, so the command palette, menus, the keyboard toolbar and selection handles that intersect the pane would be hidden, which the plan's overlap gate does not allow. Not tried, and not needed to reach this decision: cutting the DOM overlays out of the child window with the X Shape extension (the page would have to report every overlay rectangle), or compositing through an RGBA child window (needs a compositing manager and X11 does not blend child windows). A session is "Wayland" for this purpose when the GDK display of the window is Wayland, not when `XDG_SESSION_TYPE` says so: an app started with `GDK_BACKEND=x11` is X11 whatever the session is. Capability detection ([#1336](https://github.com/mihazs/lazysh/issues/1336)) must read the GDK display type and must refuse native on X11.

What this implies for the host, none of it built yet:

- **The window must be created transparent** (tao `with_transparent(true)`, which sets the RGBA visual and wry's transparent web view). The shipping page paints opaque `html`, `body` and container backgrounds; as on Android, every ancestor of the terminal anchor must stop painting there while a native surface is in use, and keep painting when it is not.
- **Position = anchor + the web view's offset in the toplevel**, recomputed on every `size-allocate` of the web view, not only when the page reports a new anchor (client-side decorations, tiling, maximizing and the shadow all move it).
- **Scale.** A CSS pixel is one logical pixel. The buffer is `anchor x scale` device pixels with `wl_surface.set_buffer_scale(scale)`, scale read from the toplevel at each placement (verified for 1 and 2). A fractional scale needs a `wp_viewport` destination instead; wgpu's Wayland `present` attaches a buffer and commits the subsurface itself, so the viewport must be set before it. Not verified.
- **`wl_subsurface.set_position` is applied with the parent's next commit**, so a host that moves the surface without the page changing must also ask GTK to redraw the toplevel (the probe invalidates the window).
- **Wayland-only Rust dependencies** (`wayland-client`, `wayland-backend` with `client_system`) behind `cfg(target_os = "linux")`, plus the two libgdk-3 symbols above. No new system library: libgdk-3 and libwayland-client are already linked through GTK.
- **The renderer takes the same two handles**: a raw `wl_display` (GDK's) and the subsurface's `wl_surface`, as the probe's wgpu mode does (`SurfaceTargetUnsafe::RawHandle`).
- The command contract is the Android one (`native_terminal_surface_place`, `_remove`, `_state`, anchor in CSS pixels plus the device pixel ratio), so the page side is shared.

Decision for the plan: the Linux composition gate is **provisionally passed on Wayland** (two compositors, one GPU) and **failed on X11**. It is not accepted: [#1331](https://github.com/mihazs/lazysh/issues/1331) stays open, its Wayland acceptance still needs GNOME's Mutter (the compositor most Linux desktops run), real input and the real page, and X11 stays on xterm.js unless the Shape route is evaluated later.

## What this does not establish

- **Two Wayland compositors, one of them nested.** KWin 6.8.2 and niri 26.04 (running as a window inside KWin, so its output is a KWin client's surface and its input would arrive through KWin). No Mutter (GNOME), Sway, Hyprland or Weston. `wl_subsurface` is core Wayland, so the protocol behaviour is expected to hold, but each compositor's stacking of a below-parent subsurface under a transparent parent was only run on those two.
- **One GPU and driver.** The Vulkan swapchain ran on an AMD discrete GPU (RADV) with the compositor's OpenGL ES output on the same GPU. No Intel or NVIDIA, no Mesa software Vulkan (lavapipe is not installed here), no EGL or OpenGL ES backend for wgpu on Wayland, no driver blocklist case. A frame was presented per request only; frame pacing, idle cost and what the swapchain costs the compositor were not measured ([#1324](https://github.com/mihazs/lazysh/issues/1324), [#1336](https://github.com/mihazs/lazysh/issues/1336)). The `wl_shm` path is the proof that a CPU-drawn surface (the reference renderer) composes the same way when no Vulkan device exists.
- **Integer scales 1 and 2 on niri only.** KWin's `--scale` option changed the output size, not the client's scale, so KWin ran at scale 1. No fractional scale, no scale change while the surface exists, no window moved between outputs of different scales.
- **No real pointer, touch or keyboard on Wayland**, and so no IME, no selection by drag, no Orca ([#1334](https://github.com/mihazs/lazysh/issues/1334), [#1335](https://github.com/mihazs/lazysh/issues/1335)). X11 routing was injected with XTEST on Xwayland, not on a native X server with a window manager.
- **Lag during scroll and animation.** The DOM-to-native hop is asynchronous, and a desynchronised subsurface commits independently of the parent, so the surface can trail the DOM by a frame; it was measured only between steps, never while the page moved.
- **The real page.** The fixture page, not the app's, was transparent; the real page, its cost when translucent and its overlays were not tried, and neither was the real Tauri window (the box tao creates is what Tauri uses, but Tauri's own window setup was not in the loop).
- **No performance or energy figure**: the [benchmark harness](terminal-benchmarks.md) was not run.

## Reproducing

Needs `kwin_wayland`, `dbus-run-session`, `Xwayland`, `xdotool`, ImageMagick, Python with PyGObject, NumPy and Pillow, the GTK 3 and WebKitGTK 4.1 development packages, and `niri` for its scenarios.

```sh
cd packages/terminal-runtime/prototypes/linux-surface
cargo build
run() { scripts/virtual-kwin.sh scripts/check.py "$@" /tmp/surface-poc-out; }
run wayland below                      # KWin, wl_shm buffers
POC_RENDER=vulkan run wayland below    # KWin, a wgpu Vulkan swapchain
run wayland above                      # the order that must not be used
run x11 below                          # an X11 child window
POC_COMPOSITOR=niri run wayland below  # niri nested in KWin
POC_WIDTH=2560 POC_HEIGHT=1600 POC_SCALE=2 POC_COMPOSITOR=niri POC_RENDER=vulkan run wayland below
```

Each run prints one `PASS` or `FAIL` line per check and leaves a PNG of every step in the output directory. The "above" and X11 scenarios are expected to pass with the DOM box drawn under the surface; they document what must not be used. This has been run on one host only, not in CI: the repository's CI has no Wayland compositor with a screenshot interface, and its Linux runners have no GPU.
