# Linux native singleton acceptance

`bun run test:native-gui` builds the real bundled native application, checks the native-test types, and runs the serial Vitest/WebdriverIO suite. It drives official `tauri-driver` and `WebKitWebDriver`; it does not use the Vite server, mock `invoke`, replace the singleton transport, or enable a backend mocking plugin. The existing Tauri runtime's `TAURI_WEBVIEW_AUTOMATION=true` opt-in is set only on owned fixture children.

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

Use Linux as an unprivileged account with Node >=22.19 (CI uses24), Bun1.3.14, Xvfb, xauth, dbus-daemon/dbus-send, bubblewrap, and a WebKitWebDriver matching the installed WebKitGTK. The native Linux check uses the Ubuntu 22.04 hosted runner, a Tauri WebKitGTK 4.1 baseline. Its nested namespace preflight must pass before compilation. Its Rust-cache prefix is specific to Ubuntu 22.04 so restored native dependency objects cannot require the Ubuntu 24.04 glibc ABI. The Ubuntu 24.04 run failed at namespace setup under its enforced user-namespace policy; neither that failed run nor the runner selection establishes GUI acceptance. Release packaging keeps its separate runner configuration. Ubuntu CI installs `xvfb xauth webkit2gtk-driver bubblewrap` alongside the existing native dependencies. Before entering the user namespace, CI copies the installed WebKitWebDriver and Xvfb into a fresh job-owned directory and compares their bytes. Host root maps to an unmapped UID inside that namespace; the copies preserve the executable ownership check. It installs official `tauri-driver` **2.1.0** into a task-specific tool directory using Cargo, rather than replacing a global tool.

Ubuntu 22.04's packaged Mosh is 1.3.2, while the existing interoperability oracle requires official Mosh 1.4.0. Before native compilation, this job builds the [official 1.4.0 distribution archive](https://github.com/mobile-shell/mosh/releases/download/mosh-1.4.0/mosh-1.4.0.tar.gz) into a fresh prefix under `RUNNER_TEMP` and prepends only its `bin` to `GITHUB_PATH`. It checks SHA256 `872e4b134e5df29c8933dff12350785054d2fd2839b5ae6b5587b14db1465ddd` against the [signed upstream release announcement](https://mosh.org/mosh-1.4.0-released.html), then asserts the resolved server path and exact release version. Its ncurses development dependency supplements the existing compiler, protobuf, OpenSSL, zlib and pkg-config dependencies; no global install or other distribution's binaries are used. The original Mosh version assertion and interoperability tests remain unchanged.

The same Ubuntu 22.04 job retains apt tmux 3.2a for the mandatory unsupported-loop rejection owner, selected only in that step with `LAZYSH_TEST_TMUX=/usr/bin/tmux`. It first lists and requires the exact qualified ignored case, then runs it. Positive tmux and later guarded Herdr acceptance use a private source-built tmux 3.4, matching the earlier Ubuntu 24.04 fixture baseline after the strict product guard fix (#461/#463). This fixture selection does not replace that product fix or establish acceptance by version alone.

The [official tmux 3.4 release archive](https://github.com/tmux/tmux/releases/download/3.4/tmux-3.4.tar.gz) is pinned to 707,213 bytes and measured SHA256 `551ab8dea0bf505c0ad6b7bb35ef567cdde0ccb84357df142c254f35a23e19aa`. This is a reviewed measured digest, not an upstream-published checksum: the official release asset has no published digest. Its 203 shared files were compared byte for byte with immutable upstream commit [`9ae69c3795ab5ef6b4d760f6398cd9281151f632`](https://github.com/tmux/tmux/tree/9ae69c3795ab5ef6b4d760f6398cd9281151f632); the distribution additionally contains 11 generated build/parser files. The [pinned source README](https://github.com/tmux/tmux/blob/9ae69c3795ab5ef6b4d760f6398cd9281151f632/README) requires a compiler, make, pkg-config, yacc/bison, libevent and ncurses. The job adds only libevent development headers and bison to its existing dependencies, installs under a fresh `RUNNER_TEMP` prefix, verifies the resolved binary path/version and prepends its bin to `GITHUB_PATH`. A rootless Ubuntu 22.04 container build/install as an unprivileged user passed with this archive; full workflow acceptance still requires CI. No system tmux replacement or namespace-policy change is made.

```sh
cargo install --locked --version 2.1.0 tauri-driver --root /absolute/task-tools/native-driver
LAZYSH_NATIVE_GUI_DRIVER=/absolute/task-tools/native-driver/bin/tauri-driver bun run test:native-gui
```

`LAZYSH_NATIVE_GUI_WEBKIT_DRIVER` and `LAZYSH_NATIVE_GUI_XVFB` can select absolute verified tool paths when the distribution does not install `/usr/bin/WebKitWebDriver` or `/usr/bin/Xvfb`. The application path remains the newly built repository-owned `target/release/lazysh`. Turborepo keeps this acceptance uncached and builds the native application before executing it. Missing or unsupported dependencies fail this explicit task rather than yield a passing skip. The ordinary frontend suite never starts a GUI.

This is the [official direct-driver route](https://v2.tauri.app/develop/tests/webdriver/manual-setup/) integrated into the existing Vitest framework. Tauri's [CI guide](https://v2.tauri.app/develop/tests/webdriver/ci/) describes a fake Linux display; its [current overview](https://v2.tauri.app/develop/tests/webdriver/) recommends the WDIO service for new suites. This narrow integration uses WebdriverIO's remote client and existing framework lifecycle to keep display/bus/process ownership explicit.

## Executed native GUI acceptance

[Run 40792616749, job 123184028252](https://github.com/mihazs/lazysh/actions/runs/40792616749/job/123184028252) executed source `447e3cc07c7b2a1852bb18ed23c07a3747feb7eb`: all eight native GUI/ownership cases passed, including both actual singleton and caller-relative directory cases. Both actual-app cases recorded binary SHA256 `90561c3a00621023ab3c235821e112ba71f076802ee7e15c7e297daa2fac1613`, observed zero target connections and completed owned cleanup. The job subsequently failed the separate official Mosh 1.4.0 fixture-version guard because Ubuntu 22.04 supplied Mosh 1.3.2. This proves the selected GUI cases for that source; the job as a whole failed. At that point, the pinned-source fixture repair still required a subsequent CI execution.

[Run 40807640820, job 123232191258](https://github.com/mihazs/lazysh/actions/runs/40807640820/job/123232191258) at source `813d28074f84f5eed9a2cdce3f317ba2f6261c86` also passed all eight GUI cases, with binary SHA256 `c99a02b97581147603be26c1d352596a7e32a73bf97fb83e10231fcd96102d31`. Both official and app Mosh owners passed after the private SSH environment bound the verified server path. The full job then failed two tmux cases, including the stale-client guard on unsupported tmux 3.2a; the separate teardown survivor remains unexplained. The final Herdr step was skipped. Current integration of the product guard repair, modern fixture and explicit older-server rejection still requires CI; no full-job acceptance is claimed.

[Run 40819338984, job 123269758740](https://github.com/mihazs/lazysh/actions/runs/40819338984/job/123269758740) at source `11501ad98b453cbcd03909d7ff6d0f4abb98ed79` passed all eight GUI cases, Mosh and the modern tmux suite. The legacy owner did not execute: its discovery pipeline failed because `rg` was unavailable, causing the test-list producer to report a broken pipe. Discovery now uses the standard non-quiet `grep -Fx` matcher, preserving exact qualified-case matching and consuming the full listing. The legacy runtime owner and final Herdr step still require the corrected workflow execution; no full-job pass is claimed.

A local check of source `377a1bcb9087c105b68f8f5fd08a37650d11b79d` with the privately source-built official tmux 3.4 passed `ssh::tmux_jump_fixture::real_tmux_chat_original_display_namespace_bytes_and_retirement` (one test, 0.21 seconds). The normal five-case `real_tmux_jump_` filter does not select this existing ignored Chat owner. Its explicit supported-tmux CI step therefore requires exact discovery before exact execution; the unchanged 30-second owner deadline still applies. This local result does not establish execution of that step in CI.

[Run 40823277921, job 123282607710](https://github.com/mihazs/lazysh/actions/runs/40823277921/job/123282607710) at source `377a1bcb9087c105b68f8f5fd08a37650d11b79d` passed the GUI, Mosh, modern tmux and explicit apt 3.2a rejection owners. The final Herdr owner failed before server readiness. Its downloaded artifact 12875613189 (archive SHA256 `79d44ba10393449b3459da024bb76f8f583b79f8e4a69b451a4c248e844a2595`) contained binary SHA256 `e82d75de1390026c550c2e977fbf9bfcb67c2b75b04bbfcb2c133600015f506f`, matching the same-run producer receipt. `readelf` showed a GLIBC_2.39 requirement; isolated execution of those exact bytes on Ubuntu 22.04 (glibc 2.35) failed before main with `GLIBC_2.39 not found`, exit 1. This is an ABI floor mismatch, not a checksum failure or evidence of a guard failure. The producer now uses Ubuntu 22.04, matching the oldest native consumer; the verified consumer binary must execute a bounded `--version` preflight before the unchanged SSH binding owner. The new-floor producer proof is recorded below; full consumer acceptance and the newly explicit Chat owner still require CI.

The Ubuntu 22.04 producer in [run 40827931880, job 123295170436](https://github.com/mihazs/lazysh/actions/runs/40827931880/job/123295170436), source `50f354ecde16e5c33e2832697b589730fcb60d21`, passed. Artifact 12877008642 archive SHA256 `e7362be8a02a0d76ecec19f7fbb56aa960e1af98b507c58e30a60b26062b92ed` matched the API receipt; its binary SHA256 was `0738a8079f58020ef21be0a5aa0ac64402c5d63b34254a28c5e374e31fdace0a`. The maximum required symbol version was GLIBC_2.34, and isolated execution of those exact bytes on Ubuntu 22.04/glibc 2.35 completed `--version` with exit 0. This verifies the producer ABI repair; full cross-job SSH/Chat acceptance must still run against fresh same-run artifacts after main integration. Historical artifacts are not substituted into later runs.





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

## Installed Windows GUI foundation

The native Windows job selects `actual Windows installed GUI` in the existing release-artifact owner after packaging NSIS. It reuses installer identity, collision, repair and uninstall gates, with a fixed GUI-only branch. Ordinary release maintenance does not launch the GUI. Only explicitly selected fresh GitHub-hosted Windows jobs are admitted; existing processes, application data or installation state are refused.

The transaction owns initially absent actual KnownFolder `app.lazysh.client` roaming/local directories with unique sentinels. Windows Tauri paths use KnownFolder APIs, so overriding `APPDATA` would not isolate them. After the GUI closes, cleanup rejects reparse points and removes only those owned application directories before the existing repair marker test and uninstall. No parent registry/data directory is removed.

Pinned official tauri-driver 2.1.0 launches the exact installed image through Microsoft EdgeDriver matching installed WebView2. Its Windows implementation creates a kill-on-close Job Object before spawning the native driver. The acceptance verifies loopback listener process ownership, native image/hash/PID/start/HWND, bundled frontend, About version and source revision. The parent retains the driver process, bounds the client and descendant retirement, suppresses raw native output, and requires cleanup/uninstall after failure. It captures no desktop screenshots or user application content.

Window admission requires one visible ownerless `Tauri Window` with positive outer and client dimensions. Only the pinned Tao and single-instance event-helper classes may accompany it; both require successful zero-client-area reads, the exact layered/tool/transparent/no-activate extended styles and either the pinned paint style or its observed WS_CLIPSIBLINGS variant. There is no fixed 16×16 outer-size rule: [GetWindowRect may include invisible resize borders](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect), while [GetClientRect reports the client dimensions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclientrect). Bounded failure metadata includes both sets of extents so native CI can reject an incorrect zero-client assumption.

After session creation fails, two bounded read-only `/status` probes record only finite health categories, after rechecking the original driver identities and listener roles before and after. Responses, capabilities and messages are discarded; READY does not establish session or GUI success. The original failure and cleanup gates remain authoritative.

A failure-only startup snapshot reuses the same bounded owned inventory. It reports at most 32 observed runtime processes and ancestry roots, numeric registered/driver/root-image versions, Microsoft signature status and fixed inherited-environment presence flags. A root has no verified WebView2 ancestor; renderer/GPU descendants do not add roots. These are observed process groups, [not WebView instance counts](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model). Zero observed descendants cannot establish that a browser never started or crashed; it may be brokered or outside the retained ancestry. Missing identities, races, signature/version uncertainty or overflow report UNVERIFIED. The original CIM CreationDate must match sampled StartTime in UTC at [CIM's microsecond representation](https://learn.microsoft.com/en-us/windows/win32/wmisdk/cim-datetime) (10 .NET ticks, matching the [MMI timestamp codec](https://github.com/PowerShell/MMI/blob/cf32fc695b32c2eae848b693395c09222fe1d2ae/src/Microsoft.Management.Infrastructure/Native/Structures/MI_Datetime.cs#L110)), with no millisecond/second allowance; missing, unspecified or unsupported-precision timestamps are unverified. Parent creation after child creation rejects the ancestry, following [Win32_Process PID-reuse guidance](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process). The flags describe the checker's inherited environment, not effective child values. No command lines, PIDs, process paths, user-data folders, profiles or raw stderr are retained.

The failure snapshot also reports `appIntegrity` as LOW, MEDIUM, HIGH, SYSTEM or UNVERIFIED for the exact retained installed application. It uses [TokenIntegrityLevel](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation) with TOKEN_QUERY and a process handle opened only for PROCESS_QUERY_LIMITED_INFORMATION. Native handle creation time must match the retained start, and existing PID/start/image-hash fences run before and after sampling. Unknown mandatory-label SID/RID, denied/failed queries or unsupported data yield UNVERIFIED for this field; lifetime or image failure still invalidates the census. No identity/group SID, privilege, token value or environment value is retained or changed. [Microsoft documents](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) that elevated WebView2 hosts ignore environment overrides, while API-specified flags are honored. Runner administrator membership and UI interactivity alone do not establish the installed app's integrity; HIGH remains unverified until observed. No environment treatment or security-policy change accompanies this observation.

The required Windows GUI owner now requests an ordinary-user context through the
existing #494 / #492 work, instead of requiring synthetic de-elevation of the
hosted runner's administrator token. An elevated broker creates one disposable
local Users account and starts one suspended bootstrap through
[CreateProcessWithLogonW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw)
with `LOGON_WITH_PROFILE` and a NULL environment. Before resume it verifies the
exact new SID, image/hash/birth, session, primary token, MEDIUM/non-elevation,
UIAccess false, Users membership and no enabled administrator group, and assigns
the owned kill-on-close Job. Existing WinSta0\Default access is required; no
window-station/desktop ACE, service, privilege or security-policy change is made.
Missing prerequisites stop the transaction.

The broker authenticates the same fresh account once with
[LogonUserW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-logonuserw).
Its SID-verified credential token provides a synchronous impersonation context only
for reading and duplicating the retained child's actual token. After reversion,
the parent reads its station/desktop descriptors and calls AccessCheck with that
explicit child duplicate. The duplicate closes even when observation fails; it
does not replace child evidence. Explicit-credential impersonation follows the
[documented exception](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-impersonateloggedonuser)
without enabling privileges. Job, identity, profile, capsule, resume and cleanup
operations remain outside that scope. Failed reversion terminates the broker
before outer cleanup; uncertain credential-token closure blocks account/profile
deletion even during SETUP. The extra token must close before profile cleanup.

The bootstrap drops unrelated environment variables and receives only a fixed
nonsecret configuration. It runs the complete existing NSIS/GUI/repair/uninstall
transaction within its own HKCU and profile; the new `requireStandard` proof is
separate from the restricted launcher. Source and dependencies are copied into a
bounded fixture with byte checks and read/execute access. Only the owned work
folder, precreated Vite `.vite`/`.vite-temp` and Vitest `.vitest-cache` directories
are writable. No host
profile, checkout `.git`, credentials or caches are copied. Passwords exist only
in native buffers and never enter argv, environment, capsules or logs.

The existing actual app/source/About/window checks and before/after MEDIUM proofs
remain required. A failed baseline does not enter the old restricted/capability
counterfactual, open another account or retry NewSession. A passing admission
cannot pass GUI acceptance. The earlier restricted ACCESS_DENIED and HIGH GUI
failures remain negative historical evidence, not newly passing tests.

The ordinary-user owner additionally provisions only the fresh **actual child**
logon SID while that child remains suspended and Job-bound. It rejects missing,
disabled, deny-only, malformed or multiple logon SID groups; the credential
logon SID is not substituted. Parent-side `OpenWindowStation`/`OpenDesktop`
handles must already admit READ_CONTROL and WRITE_DAC (plus the desktop
READOBJECTS/WRITEOBJECTS rights required by that API). No privilege is enabled,
owner changed or permission granted to Everyone, INTERACTIVE or the account SID.
Only noninheriting allow ACEs for station `0x2` and desktop `0x83` are added;
unchanged actual-child AccessChecks must then pass before resume. These minimum
masks are not yet proven sufficient for the complete Windows GUI transaction.

This setup requires an exclusively owned disposable GitHub-hosted VM with no
concurrent station/desktop ACL writer. SetSecurityInfo has no compare-and-swap:
read/check/write/readback detects changes around the write, but cannot guarantee
preservation of an update racing between the last read and setter. The owner
must not run this provisioning on a shared desktop. It preserves foreign ACE
bytes and order in its observed snapshot, rejects preexisting/ambiguous own-SID
entries, and never restores a stale whole DACL.

A bounded `desktop.owner` journal records only synthetic source, caller/account,
nonce, session, logon SID and two fixed phases. It is protected for the parent
and SYSTEM before payload is written, flushed durably before either ACL setter,
and excluded from artifacts. After confirmed Job retirement, ACL_RETIRING is
recorded; cleanup removes only its exact ACEs from the then-current DACL and
checks readback before marking each removal. Valid ACL_RETIRING recovery is
idempotent in the same fenced session; torn/private/ambiguous journals and
uncertain launch INTENT remain cleanup failures. No profile/account retirement
or fixture deletion is permitted while this journal remains. VM disposal is not
reported as successful cleanup. Portable byte-transform and compilation checks
do not qualify actual Windows ACL access, cancellation cleanup or GUI behavior.

The broker retires its Job before deleting only the initially absent exact-SID
profile and matching account. A parent-only recovery capsule contains synthetic
ownership metadata, never the password, and is excluded from artifacts. The
workflow always runs recovery. Capsule intent is not atomic with process creation:
if cancellation leaves INTENT, recovery reports cleanup uncertainty and refuses
profile/account deletion. It does not kill by SID/name or claim VM disposal as
cleanup. Setup, owner and cleanup share the existing650-second test/12-minute
workflow limits, with the600-second native and20-second session limits unchanged.
Actual Windows account/profile/desktop/GUI qualification remains unexecuted until
the reviewed normal CI head runs; portable compilation is not that qualification.

The restricted-context experiment additionally projects the exact application's `appElevation` as ELEVATED, NOT_ELEVATED or UNVERIFIED from the same held TOKEN_QUERY token. After unchanged HIGH baseline and capability-treatment cleanup, one MEDIUM_AUTOMATIC arm may run within the original 600-second budget. This is a restricted-context counterfactual, since administrator groups and privileges change with integrity. It cannot replace the original failing acceptance result.

The retained legacy restricted-token launcher uses [CreateProcessWithTokenW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithtokenw), requiring already-enabled SeImpersonate. It validates an own-user/session linked filtered token or a newly restricted own-token copy: MEDIUM, non-elevated, UIAccess false and administrator groups deny-only. No caller privilege is enabled or caller token modified. There is no AsUser fallback, account creation, foreign token, ACL repair, profile load, UAC/policy change or HIGH fallback. The explicit existing `winsta0\default` desktop avoids the API's implicit desktop-access adjustment. Each child starts suspended, enters an anonymous parent-owned kill-on-close Job, and passes native image/start/token checks before resume. The exact installed app must independently report MEDIUM and NOT_ELEVATED before frontend actions.

The retained opt-in restricted-launch owner exercises private write access, NUL stdin/stdout/stderr, command-line quoting, nested tauri-driver/Edge Job ownership and descendant retirement. Unsupported token rights, desktop access or NUL behavior stop this gate. Fixed native C# source travels through bounded stdin rather than the PowerShell command line; CreateProcessWithTokenW commands retain their 1,024-character limit, and every native PowerShell command is bounded below CreateProcessW's 32,767 UTF-16 limit. Local portable compilation/quoting tests do not establish Win32 token, stdio or nested-Job support; actual Windows evidence remains required. The original 20-second NewSession and 600-second transaction budgets, cleanup guards, installed-byte equality and final baseline failure remain unchanged.

Each retained runtime ancestry root contributes one `rootDebugTransports` record with exactly `role` and `transport`. Whole records are sorted together, preserving their correlation. Transport remains PIPE, EPHEMERAL_PORT, FIXED_PORT, ABSENT, AMBIGUOUS or UNVERIFIED. An absent or single empty `--type` yields BROWSER_CANDIDATE; a single nonempty ASCII/control-free selector yields TYPED_CHILD, without claiming that selector is valid. Duplicate selectors yield AMBIGUOUS; unsupported input yields UNVERIFIED. The candidate classification follows [pinned Chromium browser dispatch](https://github.com/chromium/chromium/blob/dbeca94f3190b496ceb20437995b29aaf20f5370/content/app/content_main_runner_impl.cc#L1240), not a claim about WebView counts or readiness. Only the original lifetime-verified CIM command line is parsed, using [CommandLineToArgvW/LocalFree](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw) and the [pinned Chromium Windows switch rules](https://github.com/chromium/chromium/blob/dbeca94f3190b496ceb20437995b29aaf20f5370/base/command_line.cc#L646). Duplicate/mixed transports are ambiguous; malformed values, special raw-tail parsing and unsupported whitespace are unverified. Parser failure preserves the valid base census. Categories expose neither arguments nor port numbers and describe startup switch presence only, not listening, readiness or a successful debugging handshake. They are not paired with the separately deduplicated image-version set. Actual Win32 tokenization vectors execute in the existing native Windows owner before GUI acceptance. Its 35-second outer Bun guard supervises the existing 30-second native helper guard: actual Windows evidence hit the former default five-second test deadline before that native guard could report. This helper supervision repair changes no application/session/transaction deadline. The endpoint owner composes only its required exported helpers, keeping its Windows command line below the documented CreateProcess limit.

A separate diagnostic treatment can run only after an automatic NewSession failure with verified installed-window ownership and complete owned GUI process/profile cleanup. It reuses the same installed image, verifies the retained driver hashes, recreates absent sentinel-owned data roots and starts a new driver Job. Its sole WebDriver capability delta is `webviewOptions.additionalBrowserArguments: ['--remote-debugging-port=0']`, the [documented browser-argument channel](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/capabilities-edge-options). The [pinned Chromium server defaults to IPv4/IPv6 loopback](https://github.com/chromium/chromium/blob/dbeca94f3190b496ceb20437995b29aaf20f5370/chrome/browser/devtools/remote_debugging_server.cc#L85); exact EdgeDriver/WebView2 discovery remains experimental. There is no fixed port, debuggerAddress, environment override, profile reuse/read, new endpoint probe or retry. Both sessions retain the 20-second deadline. The existing 600-second parent budget is unchanged: the treatment is skipped unless 420 seconds remain for startup/client, cleanup and uninstall. Separate finite treatment receipts never replace the original failure, including when the treatment passes; publication/acceptance remains failed. An inconclusive cleanup, image/tool change or profile collision stops the experiment. Native uninstall runs once through the existing transaction.

The original window identity or closed rejection is written before this snapshot. If signature/hash work consumes the existing 15-second probe budget, the client preserves that completed core proof and marks startup unavailable. No additional timer, session attempt or launch configuration is introduced; the original 20-second NewSession failure and cleanup remain authoritative.

This is a foundation gate; its first actual Windows execution remains required before merge. It does not establish warm singleton argv, ConPTY terminal behavior or authenticated SSH, which remain under #457. Published 0.23.0 assets are untouched; CI evidence belongs to its exact candidate source/binary.

The passive UIA snapshot can additionally retain `englishControlCounts` with exactly
`about`, `checking`, `locked`, `error` and `workspace`, each 0–2; 2 means two or
more eligible controls. The existing single own-HWND query uses a finite allowlist
from the English source: the versioned About button, access-check/locked headings,
three fixed access-error messages, Add a host and Preferences. Only enabled,
on-offscreen controls from retained owned providers within the unchanged physical
client rectangle contribute. At most 16 matching candidates are processed. Counts
are published only after the existing worker join and COM/DPI cleanup, then the
original process/image lifetime fences are checked again.

The same query can retain the separate optional `ownedDocumentCount`, capped at
0, 1 or 2 (two or more). It matches Document control type 50030 independently of
name and locale, with the same eligibility and lifetime checks. The document branch
does not consume cached Name, Value, URL or text. The uniform shared cache also
requests Name for Document candidates, although the managed document branch never
consumes or exports it. Provider-internal predicate evaluation is not constrained.
One eligible accessible document does not establish
its URL, JavaScript, React, IPC, paint or the cause of startup failure. Zero or
multiple documents remain ambiguous and cannot establish frontend acceptance.

The control counts are English-label observations, not an OS-locale assertion, DOM inventory,
paint/performance measurement or GUI acceptance. No locale is forced. A zero or
ambiguous count, an unknown locale or absent accessibility exposure cannot show
that the document, JavaScript or React is absent. Unknown text is never mapped to
an error state or retained. Positive counts cannot turn the original failed
NewSession into success; the normal frontend/About/source checks remain required.
No input, focus action, app IPC, script injection, browser flags or retries are
added, and the existing session/probe/worker budgets remain unchanged.

## Owned SSH connection

The Linux suite also creates a fresh loopback OpenSSH server using the same `SshFixture` as Android acceptance. Its portable process/SSH owner lives in `tests/support/sshFixture.ts`; Android keeps its existing re-exports. The test adds a host through the bundled UI, chooses SSH explicitly, enters only the ephemeral private key without saving it, reviews the exact generated host fingerprint and confirms trust. Ordinary terminal keyboard input must produce the fixture's non-echoable challenge output while the original GUI owner remains unchanged. The singleton cases retain their separate zero-connection target.

This case explicitly gives only its SSH daemon a private read-only `/etc/group`
view with `tty` mapped to the fixture user's primary group. The outer user
namespace cannot map the host's separate `tty` group: the unmodified fixture
fails its real OpenSSH challenge there with a PTY `chown` invalid-argument error,
while the private mapping passes. The host group file, GUI isolation and ordinary
Android fixture mode remain unchanged. Before GUI acceptance, CI exercises the
existing SSH host owner inside the same outer user/network namespace, including
unchanged host groups, complete listener cleanup and rejection of a supervisor
lost before teardown. The GUI case also requires a real OpenSSH challenge against
its own still-live server before starting the app; that preflight cannot replace
the separate native GUI SSH challenge.

The GUI stops before its SSH server. Cleanup verifies the exact owned server/descendants and listener retire. Before the connected terminal is visible, this case suppresses screenshots so the temporary private-key field cannot enter artifacts. It never injects host trust, calls native terminal writes, mocks the bridge or uses an operator credential. A source implementation or passing host-fixture check does not establish the new GUI case; require the corresponding actual Linux native CI result before claiming acceptance.
