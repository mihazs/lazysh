# Linux native surface composition proof of concept

Status: **proof of concept, not shipped**. Answers the composition gate in [native rendering](native-rendering.md#composition-gate) for Linux ([#1331](https://github.com/mihazs/lazysh/issues/1331), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)): can a native surface sit next to the WebKitGTK web view Tauri uses, on Wayland and on X11? The probe paints a solid colour, from CPU buffers or from a wgpu Vulkan swapchain: no terminal, no renderer, nothing in the app. Related: [Android PoC](android-surface-composition-poc.md) · [platform integration](platform-integration.md) · [ADR 0001](adr-0001-terminal-runtime.md).

## What was built

`packages/terminal-runtime/prototypes/linux-surface` is a standalone crate (its own lock file, like the other prototypes; no CI job builds it). It opens a window with **tao 0.37.2 and wry 0.57.1**, the versions in the root `Cargo.lock`, and builds the web view into the window's default box the way Tauri does, so the GTK widget tree is the app's. The page is a fixture: a transparent body, an anchor `div`, a red box that overlaps the anchor's lower right corner, an input field, and a script that reports the anchor's `getBoundingClientRect()` to Rust (the same DOM-to-native hop the [Android host](android-native-surface-host.md) uses). On a request from `scripts/check.py` the probe creates, moves, recreates or removes a **native surface at the anchor**:

| Display server | Surface | How it is made |
| --- | --- | --- |
| Wayland | A `wl_subsurface` of the toplevel `wl_surface` GDK owns | `gdk_wayland_window_get_wl_surface` and `gdk_wayland_display_get_wl_display` (both exported by libgdk-3) give the handles; `wayland-client` wraps GDK's own `wl_display` (so the subsurface lives on the connection of its parent), binds `wl_compositor`, `wl_subcompositor` and `wl_shm` on a private event queue, sets the subsurface desynchronised, places it **below** the parent (or above, for the comparison), gives it an empty input region and fills it from a `wl_shm` buffer, or, with `POC_RENDER=vulkan`, hands the subsurface's `wl_surface` and GDK's `wl_display` to wgpu 30 as raw Wayland handles and presents a Vulkan swapchain on it. |
| X11 | A child X window of the toplevel | `gdk_x11_window_get_xid` gives the parent; `x11rb` creates, maps, moves and destroys the child on its own connection. |

`scripts/check.py` drives the probe through a line protocol, captures what the **compositor** shows (not what the app believes) and asserts on the pixels. Wayland captures come from a headless KWin through `org.kde.KWin.ScreenShot2` (`scripts/virtual-kwin.sh`, `scripts/kwin_shot.py`); X11 runs on a real X server (a rootful Xwayland on the same KWin, captured with ImageMagick `import -window root`, driven with `xdotool`), which is what Xvfb offers too. The page origin is derived from the right and bottom edge of the red box, which no surface ever covers, so the compositor's window placement does not matter.

## Results

Host: CachyOS (Arch Linux), GTK 3.24.52, WebKitGTK 2.54.2 (4.1 API), KWin 6.8.2 started with `--virtual` (it composited with OpenGL ES on the host's AMD Radeon RX 5500 XT, radeonsi; the Vulkan device was the same GPU through RADV), Xwayland for the X11 runs, scale 1. One run each; every check is exact (a surface's pixels must equal the anchor rectangle, with no tolerance). All checks of all four scenarios passed: Wayland below with `wl_shm` buffers, Wayland below with the Vulkan swapchain, Wayland above, X11.

| Gate item | Wayland, surface **below** the transparent web view (`wl_shm` and wgpu Vulkan swapchain: same results) | Wayland, surface above | X11 child window |
| --- | --- | --- | --- |
| Placement at a DOM anchor | **Pass**: 400x300 at the anchor (100,80) with 0 px error | Pass, same | **Pass**, same |
| Follow an anchor change | **Pass**: after `setAnchor`, 300x200 at (220,150) | Pass | Pass |
| Overlap with DOM content | **Pass**: the red DOM box and the anchor's dashed outline are drawn over the surface (pixel in the overlap is red) | **Fail by design**: the surface covers the DOM box | **Fail**: the child window covers the DOM box, and the web view has no X window of its own to stack the child below (not checked: that GTK paints it into the toplevel's window is the likely reason) |
| Resize | **Pass**: a window resize (KWin re-centres the window) keeps the surface at its anchor | Pass | Pass |
| Destroy and recreate | **Pass**: nothing is left on screen after destroy; a new surface of another colour appears with the exact colour (`#3366ff`) at the anchor | Pass | Pass |
| Pointer routing | **Not injectable** here (KWin virtual offers no virtual pointer); the surface has an empty input region, so by protocol every pointer and touch event goes to the toplevel | n/a | **Pass**: a click on the child window arrives in the page at the same coordinates (the child selects no events, so X11 delivers them to the toplevel), as does a click on a DOM field |
| Keyboard routing and focus | **Not injectable** here (`wtype` reports that the compositor has no virtual keyboard protocol); a subsurface never takes keyboard focus on its own | n/a | **Pass**: a key press reaches the page with the surface mapped |

The "above" column exists to show that the overlap check can fail: with the order reversed the same check reports the DOM box hidden. The X11 failure is not a probe defect: an X11 child window always draws over its parent's own drawing, and the web view's pixels belong to the toplevel's window as far as this measurement shows.

## Recommended strategy

**Wayland: a `wl_subsurface` of the toplevel, placed below it, with a transparent toplevel and a transparent web view.** It is the Linux counterpart of the Android recommendation (`SurfaceView` below a transparent WebView): every React overlay stays correct, gestures stay in the DOM, and the compositor, not a copy through the web view, puts the terminal's pixels on screen. A wgpu Vulkan swapchain presents on such a subsurface (the renderer's backend on Linux).

**X11 and Xwayland: keep xterm.js.** A child window is always on top of the page, so the command palette, menus, the keyboard toolbar and selection handles that intersect the pane would be hidden, which the plan's overlap gate does not allow. Not tried, and not needed to reach this decision: cutting the DOM overlays out of the child window with the X Shape extension (the page would have to report every overlay rectangle), or compositing through an RGBA child window (needs a compositing manager and X11 does not blend child windows). A session is "Wayland" for this purpose when the GDK display of the window is Wayland, not when `XDG_SESSION_TYPE` says so: an app started with `GDK_BACKEND=x11` is X11 whatever the session is. `capability detection` ([#1336](https://github.com/mihazs/lazysh/issues/1336)) must read the GDK display type and must refuse native on X11.

What this implies for the host, none of it built yet:

- **The window must be created transparent** (tao `with_transparent(true)`, which sets the RGBA visual and wry's transparent web view). The shipping page paints opaque `html`, `body` and container backgrounds; as on Android, every ancestor of the terminal anchor must stop painting there while a native surface is in use, and keep painting when it is not.
- **Wayland-only Rust dependencies** (`wayland-client`, `wayland-backend` with `client_system`) behind `cfg(target_os = "linux")`, plus the two libgdk-3 symbols above. No new system library: libgdk-3 and libwayland-client are already linked through GTK.
- **The renderer takes the same two handles**: a raw `wl_display` (GDK's) and the subsurface's `wl_surface`, as the probe's wgpu mode does (`SurfaceTargetUnsafe::RawHandle`). Two details the probe met: wgpu's Wayland `present` attaches a buffer and commits the subsurface itself, so anything that must be part of that commit (a viewport destination for a fractional scale) is set before it; and `wl_subsurface.set_position` is applied with the **parent's** next commit, so a host that moves the surface without the page changing must also ask GTK to redraw the toplevel (the probe invalidates the window).
- The command contract is the Android one (`native_terminal_surface_place`, `_remove`, `_state`, anchor in CSS pixels plus the device pixel ratio), so the page side is shared.

Decision for the plan: the Linux composition gate is **provisionally passed on Wayland, on one compositor, without a GPU** and **failed on X11**. It is not accepted: [#1331](https://github.com/mihazs/lazysh/issues/1331) stays open, its Wayland acceptance needs a second compositor and a real GPU, and X11 stays on xterm.js unless the Shape route is evaluated later.

## What this does not establish

- **One Wayland compositor.** KWin 6.8.2 only; no Mutter (GNOME), wlroots (Sway, Hyprland, niri) or Weston. `wl_subsurface` is core Wayland, so the protocol behaviour is expected to hold, but whether each compositor stacks a below-parent subsurface under a transparent parent the same way was not run.
- **One GPU and driver.** The Vulkan swapchain ran on an AMD discrete GPU (RADV) with KWin's OpenGL ES compositor on the same GPU. No Intel or NVIDIA, no Mesa software Vulkan (lavapipe is not installed here), no EGL or OpenGL ES backend for wgpu on Wayland, no driver blocklist case. A frame was presented per request only; frame pacing, idle cost and what the swapchain costs the compositor were not measured ([#1324](https://github.com/mihazs/lazysh/issues/1324), [#1336](https://github.com/mihazs/lazysh/issues/1336)). The `wl_shm` path is the proof that a CPU-drawn surface (the reference renderer) composes the same way when no Vulkan device exists.
- **No high-DPI.** Everything ran at scale 1 (an attempt with KWin's `--scale 2` gave a 2560x1600 output on which the page still rendered at scale 1, so it did not exercise a high-DPI client). Positions and sizes are in logical pixels, like CSS pixels, so the anchor maps one to one; the buffer must be `anchor x scale` pixels with `wl_surface.set_buffer_scale` (integer scale) or a `wp_viewport` destination (fractional scale). Unverified.
- **No real pointer, touch or keyboard on Wayland**, and so no IME, no selection by drag, no Orca ([#1334](https://github.com/mihazs/lazysh/issues/1334), [#1335](https://github.com/mihazs/lazysh/issues/1335)). X11 routing was injected with XTEST on Xwayland, not on a native X server with a window manager.
- **Lag during scroll and animation.** The DOM-to-native hop is asynchronous, and a desynchronised subsurface commits independently of the parent, so the surface can trail the DOM by a frame; it was measured only between steps, never while the page moved.
- **The real page.** The fixture page, not the app's, was transparent; the real page, its cost when translucent and its overlays were not tried, and neither was the real Tauri window (the box tao creates is what Tauri uses, but Tauri's own window setup was not in the loop).
- **No performance or energy figure**: the [benchmark harness](terminal-benchmarks.md) was not run.

## Reproducing

Needs `kwin_wayland`, `dbus-run-session`, `Xwayland`, `xdotool`, ImageMagick, Python with PyGObject, NumPy and Pillow, and the GTK 3 and WebKitGTK 4.1 development packages.

```sh
cd packages/terminal-runtime/prototypes/linux-surface
cargo build
for scenario in "wayland below" "wayland above" "x11 below"; do
  scripts/virtual-kwin.sh scripts/check.py $scenario /tmp/surface-poc-out
done
# the same Wayland scenario with a wgpu Vulkan swapchain instead of CPU buffers
POC_RENDER=vulkan scripts/virtual-kwin.sh scripts/check.py wayland below /tmp/surface-poc-out-vulkan
```

Each run prints one `PASS` or `FAIL` line per check and leaves a PNG of every step in the output directory. The "above" scenario is expected to pass with the DOM box drawn under the surface; it documents the order that must not be used. This has been run on one host only, not in CI: the repository's CI has no Wayland compositor with a screenshot interface, and its Linux runners have no GPU.
