# Local desktop terminals

[Issue #25](https://github.com/mihazs/lazysh/issues/25), implemented in the [PR #24 stack](https://github.com/mihazs/lazysh/pull/24), tracks the desktop local-host terminal.

Choose **Open local terminal** in Hosts, or **Local terminal · this device** in the connection picker. This explicitly starts the current desktop user's default shell in their home directory. It inherits the native app's environment and has that user's ordinary filesystem and process permissions. No localhost SSH server, credentials, network listener or fabricated host identity is involved. Mobile builds report that local terminals require the desktop app.

Local sessions use the existing terminal input, UTF-8 display, selection, search, clipboard, keyboard and dictation composer. The session is labelled **Local PTY**. Host agent queries, SFTP, remote previews, usage reports, Apple host status and remote multiplexer tools are unavailable for local sessions. Terminal I/O routes through a separate local registry; SSH-only bridge helpers reject local session IDs. Local sessions are excluded from remote agent notification polling. The planned parity work that lifts these limits is specified in [Local workspace](local-workspace.md).

Workspace restoration saves only `{ "local": true }`. Restoring starts a fresh local shell after the explicit restore action; it cannot recover a terminated shell process, terminal output or working directory. Shell history follows the user's shell configuration, independently of workspace metadata.

To start one local workspace from a terminal, close existing lazysh instances and run:

```sh
lazysh --dir '/absolute/project directory'
lazysh -dir ./relative-project
```

`-dir=PATH` and `--dir=PATH` are also accepted. Paths are literal: lazysh performs no shell expansion, globbing or command interpolation. Relative paths resolve against the launching process's working directory and are canonicalized. The supplied and resolved paths must be valid Unicode and at most 4096 UTF-8 bytes. Invalid/missing directories, non-Unicode paths, Windows drive-relative paths such as `C:project`, duplicate directory options and combinations with other arguments fail before UI startup with exit 2. Saved-host cold launch is documented in [SSH connections](connections.md#cold-saved-host-desktop-launch); cold host/multiplexer picker composition is described there as well. Without an owned CLI option, framework flags and existing desktop URL handling retain their prior behavior.

Cold and warm directory launches keep the canonical path native in one bounded, non-overwritable intent. Its first protected read admits the request to that original access lease and returns its receipt once; only that lease may submit the receipt through the normal guarded local-connect command. Preparation failures do not retry automatically, and locking or replacing that lease before connect prevents a fresh renderer from replaying the old request. Manual local opens and workspace restoration do not claim it.

When an instance is already running, relative paths resolve against the secondary process's forwarded absolute working directory, never the running app's directory. Warm paths, and the caller directory when needed, must contain no Unicode replacement character (`U+FFFD`), even literally: the singleton transport cannot distinguish it from replaced OS bytes. Ambiguous conversions are refused with a localized notice after normal unlock; close the app and cold-launch to use a literal replacement character. A second valid request cannot replace an existing intent. The secondary process retains the singleton handoff exit behavior; a successful handoff is not confirmation of a directory terminal. Actual OS GUI launch acceptance remains tracked in issue #86.

On Windows, the canonical directory stays in native launch state. At PTY startup lazysh uses the already pinned `dunce` compatibility helper to simplify only safely representable names to an ordinary absolute drive path, then verifies that it canonicalizes to the same directory. UNC, device, verbatim-only and names/lengths that cannot safely simplify are refused with a localized error; a different shell is not selected automatically. The original hosted Windows trace showed `cmd.exe` rejecting a canonical verbatim drive prefix as UNC and falling back to `C:\Windows`; the compatibility correction must pass the actual default-shell cwd regression before Windows acceptance is claimed.

An explicitly requested directory never silently falls back to HOME. If it disappears before native process working-directory setup, startup fails. Filesystem changes after a child enters the directory follow OS semantics. Unix uses the selected login shell; user/system startup files can subsequently change directory, so this does not promise to override shell configuration. The launch mechanism does not serialize the directory into workspace metadata or launch-notification payloads. Restoration continues to use the normal HOME default.

Native regression tests cover parser bounds, caller-relative paths, literal shell-looking names, Unicode refusal without replacement, one-shot receipts, stale leases, actual login-shell `pwd`, and removal after validation. Windows has native drive/Unicode and actual ConPTY working-directory fixtures; executing those on a Windows runner remains a separate platform gate. Frontend tests cover deferred/fresh access, stale success/error suppression, localized warm notices, preparation failure without retry across busy transitions, raw sentinel-looking diagnostics remaining verbatim across locales, and unchanged manual/restoration calls. Source or component checks alone do not establish actual desktop GUI launch acceptance on every OS.

## Process and flow control

See [process and flow control](reference/local-terminal.md#process-and-flow-control) for details.

## Verification

Run `bunx turbo run test:local --filter=@lazysh/client`. This uncached task runs project-native Cargo tests with real processes. Linux tests cover executed UTF-8 input/output, `stty` resize, independent sessions, forged acknowledgment rejection, output-credit exhaustion/resumption, stalled-consumer cancellation, owned-process reaping, failed-spawn teardown and state-drop cleanup. A stopped window refuses new PTYs; registration checks the same shutdown flag again under the registry mutex.

The macOS/Windows desktop CI jobs execute the task after building. Windows cases run a real ConPTY shell, send UTF-8, resize, test credit backpressure/cancellation, and query the owned PID after close. Unsupported environments fail with their actual startup diagnostic rather than reporting a passing PTY test. macOS/Windows runtime results remain pending until those CI jobs execute; compilation on Linux does not establish their behavior.
