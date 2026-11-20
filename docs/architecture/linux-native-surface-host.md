# Linux native surface host

Status: **host only, in builds with the `native-terminal` feature, which no release enables**. A session's surface shows the pane background; no renderer draws on it yet and no input, IME or accessibility reaches it. It is the surface host of [#1331](https://github.com/mihazs/lazysh/issues/1331) (epic [#1302](https://github.com/mihazs/lazysh/issues/1302)) and follows the strategy the [composition proof of concept](linux-surface-composition-poc.md) recommended: a `wl_subsurface` below a transparent toplevel and web view on Wayland, and xterm.js on X11 and Xwayland. Related: [Android host](android-native-surface-host.md) · [native rendering](native-rendering.md) · [terminal adapter](terminal-adapter.md) · [migration plan](terminal-migration-plan.md).

## What exists

| Piece | Where | Role |
| --- | --- | --- |
| `native_terminal_surface_place`, `_remove`, `_state` | `apps/client/src-tauri/src/native_terminal_surface.rs` | The Android commands, with the same arguments, validation and locked-app rule. On Linux with the feature they run the host on the GTK main thread. Every other build answers that it has no surface. |
| The host | `apps/client/src-tauri/src/native_terminal_surface/linux.rs` | One `wl_subsurface` per session on GDK's own Wayland connection, a child of the toplevel `wl_surface`, placed below it, desynchronised, with an empty input region and a `wl_shm` buffer of the pane background. |
| The transparent window | `build_unspawned_windows` in `lib.rs` | With the feature, the window and its web view are created transparent. The page still paints its own backgrounds everywhere except above a native pane ([the pane](android-native-surface-host.md#the-pane)). Without the feature the window is what it was. |
| The display check | `surface()` in `terminal_core.rs` | `native_terminal_probe` reads the GDK display type recorded when the window was built. Anything but `GdkWaylandDisplay` is refused before the GPU is asked, with the display named in the reason. |

The page side is the Android one: `terminalSurfaceAnchor.ts` sends the same three commands, so nothing in the client changed.

## Contract

- **Position.** The anchor is the element's rectangle in CSS pixels with the page's `devicePixelRatio`. The host turns it into logical pixels of the toplevel (CSS pixels times the ratio, divided by GTK's scale) and adds the web view's offset inside the toplevel, which GTK's own title bar and shadow make non-zero. It places every surface again when the web view's allocation or the window's scale changes, without the page asking.
- **Size.** The buffer is the logical size times GTK's integer scale, with `wl_surface.set_buffer_scale`. `_state` and `_place` report it in device pixels. GTK 3 has no fractional scale: a fractional output scale reaches the host rounded up, as it does the page.
- **Generation** is 1 for a placed session and 0 otherwise: a session has one surface from `place` to `remove`.
- **Removal.** `remove` destroys the subsurface. Removing a session that is not there is not an error, and is allowed while the app is locked.
- **X11 and Xwayland.** `place` is refused with a reason that names the display, `state` answers unplaced, and the probe refuses native, so the registry keeps xterm.js and shows why. The window is on X11 when its GDK display is, whatever the session type says.
- **Limits.** At most 64 surfaces. A window that is unmapped loses its surfaces and the page is not told (the app never hides its window).

## Verification and limits

| Claim | Checked by | Not covered |
| --- | --- | --- |
| A surface placed through the app's own IPC appears at the anchor with exact pixels, below a DOM box that overlaps it; it follows a new anchor and a window resize; `remove` leaves nothing; a new surface shows a new colour; `_state` and `_place` report device pixels | `scripts/check.py --app` of the [probe's harness](linux-surface-composition-poc.md#ci-lane) against a debug build of the real app under a headless sway, at scale 1 and 2, pixels read back with grim (`native-terminal-bridge` CI job) | The app's real page (the harness serves a fixture page at the dev URL), a release build, Mutter and KWin in CI, a GPU, fractional scale, GTK's own title bar (sway draws none, so the web view's offset is zero there) |
| On X11 the probe refuses native and names the display, `place` is refused, and nothing is drawn | The same harness on Xvfb | A window manager, Xwayland |
| Only a Wayland display passes the display check; no window means no | unit test in `linux.rs` | |

Not established: a renderer on the surface (the wgpu swapchain was presented on such a subsurface by the probe only), input and IME ([#1334](https://github.com/mihazs/lazysh/issues/1334)), a screen reader ([#1335](https://github.com/mihazs/lazysh/issues/1335)), the cost of a translucent window, frame time and energy. Gate G19 stays not met for Linux.

## Next slices

1. Attach the [renderer host](native-rendering.md) to the subsurface (GDK's `wl_display` and the subsurface's `wl_surface` as raw handles) and replace the `wl_shm` fill.
2. Mount a native pane in the real page on Linux and measure it over the surface.
3. Input and selection parity ([#1334](https://github.com/mihazs/lazysh/issues/1334)), screen-reader parity or a tested refusal ([#1335](https://github.com/mihazs/lazysh/issues/1335)), then the Linux default flip as its own gated change.
