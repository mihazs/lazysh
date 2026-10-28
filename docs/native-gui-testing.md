# Linux native singleton acceptance

`bun run test:native-gui` builds the real bundled native application, checks the native-test types, and runs one serial Vitest/WebdriverIO specification. It drives official `tauri-driver` and `WebKitWebDriver`; it does not use the Vite server, mock `invoke`, replace the singleton transport, or enable a backend mocking plugin. The existing Tauri runtime's `TAURI_WEBVIEW_AUTOMATION=true` opt-in is set only on owned fixture children.

The specification starts the actual application without launch arguments, opens a manual connection dialog and enters a public synthetic password. A separately owned invocation of that same binary sends `--host gui-selected` through the real singleton D-Bus callback. The original private-bus owner, PID/start identity and native window remain; the manual form must survive until explicit Cancel. The selected saved-host dialog then appears with empty credentials. After cancellation, a second explicit invocation with a tmux selector must open another normal dialog. Connect is never pressed, and an owned loopback listener must observe zero SSH connections. These are two explicit test actions, never an automatic retry after uncertain delivery.

A second case starts a fresh original GUI and launches a literal Unicode, shell-looking directory from a separate caller working directory inside the owned fixture. It sends `pwd` through native WebDriver keyboard input and requires the real local terminal to display the canonical target path. The original GUI bus owner/PID/window must remain, and the SSH counter stays zero. The fixture rejects a secondary cwd outside its own canonical directory before launching a child.

## Isolation and process ownership

The entire Vitest process runs in an outer private user/network namespace with loopback only. The target listener, test worker and GUI drivers therefore share that private network; host processes cannot reach its listener. A controlled case verifies that a nested namespace cannot reach its parent listener while its own loopback still works. This removes ambient host traffic from the test boundary; it does not identify the source of historical failures.

Every run creates a mode-0700 directory under `/tmp`, an authenticated fresh Xvfb display, and its own D-Bus daemon with no installed activation directories. Child-only environment values point HOME, XDG storage and both bus addresses into this directory. Wayland, user bus, SSH-agent, loader and desktop variables are not inherited. No user desktop, existing application or saved host is used.

The driver and application live inside a bubblewrap PID namespace with `--die-with-parent`. The foreground-process helper remains deliberately unsuitable for a daemonizing workload on its own; the kernel namespace supplies the descendant lifetime boundary. Host home/runtime/temp mounts are hidden, with only the private display socket, private test directory and exact compiled executables made available. Namespace setup must succeed; the test does not disable AppArmor, user-namespace policy, WebKit sandboxing or other security controls to obtain a pass.

Before creating a WebDriver session, each loopback listener's kernel socket inode must belong to the expected executable in the owned namespace's descendant tree. This prevents a released ephemeral-port race from selecting another driver. The original GUI D-Bus owner must resolve to the same compiled application image in that tree. Cleanup closes the WebDriver session, stops/reaps the namespace supervisor and verifies all observed descendants retire, then stops the display/bus and removes the private directory. Failures in cleanup are reported alongside the original test failure.

Only a failed test's synthetic application window may be captured, after rechecking its owner. Its optional artifact is `apps/client/test-results/native-gui/owned-synthetic-window.png`. No host screenshot is taken.

## Dependencies and execution

The WebDriver client refuses proxy environment variables so loopback traffic cannot be redirected through an inherited proxy. Run it without HTTP/HTTPS/ALL proxy or Node environment-proxy settings; child GUI environments are independently allowlisted.

Use Linux as an unprivileged account with Node >=22.19 (CI uses24), Bun1.3.14, Xvfb, xauth, dbus-daemon/dbus-send, bubblewrap, and a WebKitWebDriver matching the installed WebKitGTK. The native Linux check uses the Ubuntu 22.04 hosted runner, a Tauri WebKitGTK 4.1 baseline. Its nested namespace preflight must pass before compilation. The Ubuntu 24.04 run failed at namespace setup under its enforced user-namespace policy; neither that failed run nor the runner selection establishes GUI acceptance. Release packaging keeps its separate runner configuration. Ubuntu CI installs `xvfb xauth webkit2gtk-driver bubblewrap` alongside the existing native dependencies. It installs official `tauri-driver` **2.1.0** into a task-specific tool directory using Cargo, rather than replacing a global tool.

```sh
cargo install --locked --version 2.1.0 tauri-driver --root /absolute/task-tools/native-driver
LAZYSH_NATIVE_GUI_DRIVER=/absolute/task-tools/native-driver/bin/tauri-driver bun run test:native-gui
```

`LAZYSH_NATIVE_GUI_WEBKIT_DRIVER` and `LAZYSH_NATIVE_GUI_XVFB` can select absolute verified tool paths when the distribution does not install `/usr/bin/WebKitWebDriver` or `/usr/bin/Xvfb`. The application path remains the newly built repository-owned `target/release/lazysh`. Turborepo keeps this acceptance uncached and builds the native application before executing it. Missing or unsupported dependencies fail this explicit task rather than yield a passing skip. The ordinary frontend suite never starts a GUI.

This is the [official direct-driver route](https://v2.tauri.app/develop/tests/webdriver/manual-setup/) integrated into the existing Vitest framework. Tauri's [CI guide](https://v2.tauri.app/develop/tests/webdriver/ci/) describes a fake Linux display; its [current overview](https://v2.tauri.app/develop/tests/webdriver/) recommends the WDIO service for new suites. This narrow integration uses WebdriverIO's remote client and existing framework lifecycle to keep display/bus/process ownership explicit.

## Acceptance limits

The suite covers Linux singleton handoff through the real WebView/native IPC,
original private-bus owner and preserved form state. It does not establish
Windows/macOS GUI delivery, biometric prompts, physical screens/devices,
accessibility/compositor effects, remote authentication, exact tmux-server
attachment. Those remain tracked in
[issue #86](https://github.com/mihazs/lazysh/issues/86) and
[issue #20](https://github.com/mihazs/lazysh/issues/20).

Two historical actual-app executions failed the strict zero-target-connection
assertion, including one connection during startup before UI interaction. Their
source remains unresolved. Later passing runs and controlled attribution tests
do not explain or erase those failures. Keep the raw connection counter and its
zero assertions unconditional. A successful secondary exit alone does not prove
a connection or GUI outcome.

The controlled tests cover a held owned child, the exact live test worker,
short-lived diagnostic events, native WebKit driver attribution and driver-port
reuse. Node's experimental diagnostic channel may report inconclusive runtime
coverage; that must never be counted as proof of no traffic. Missing or retired
socket peers remain unattributed.

[Issue #287](https://github.com/mihazs/lazysh/issues/287) retains the execution
ledger, historical failures, source revisions and binary digests. Record the
exact source commit, application SHA-256, selected case count, cleanup result and
limitations there for each qualifying run. Compilation, policy unit tests and an
older binary's success do not establish current-source native GUI acceptance.
