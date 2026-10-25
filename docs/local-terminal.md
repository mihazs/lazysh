# Local desktop terminals

[Issue #25](https://github.com/mihazs/lazysh/issues/25), implemented in the [PR #24 stack](https://github.com/mihazs/lazysh/pull/24), tracks the desktop local-host terminal.

Choose **Open local terminal** in Hosts, or **Local terminal · this device** in the connection picker. This explicitly starts the current desktop user's default shell in their home directory. It inherits the native app's environment and has that user's ordinary filesystem and process permissions. No localhost SSH server, credentials, network listener or fabricated host identity is involved. Mobile builds report that local terminals require the desktop app.

Local sessions use the existing terminal input, UTF-8 display, selection, search, clipboard, keyboard and dictation composer. The session is labelled **Local PTY**. Host agent queries, SFTP, remote previews, usage reports, Apple host status and remote multiplexer tools are unavailable for local sessions. Terminal I/O routes through a separate local registry; SSH-only bridge helpers reject local session IDs. Local sessions are excluded from remote agent notification polling.

Workspace restoration saves only `{ "local": true }`. Restoring starts a fresh local shell after the explicit restore action; it cannot recover a terminated shell process, terminal output or working directory. Shell history follows the user's shell configuration, independently of workspace metadata.

## Process and flow control

The native desktop implementation uses [portable-pty 0.9](https://docs.rs/portable-pty/0.9.0/portable_pty/): Unix PTYs on Linux/macOS and ConPTY on supported Windows systems. Each session has a 32-operation input queue, one queued 16 KiB output chunk and 256 KiB of unacknowledged terminal output. Input operations are limited to 64 KiB. Output acknowledgment cannot exceed the outstanding byte count. An unresponsive output consumer times out and closes the session. Terminal dimensions are validated before resize.

Disconnect cancels the independent session and reaps its owned shell. Unix cleanup fences foreground process-group signalling to the owned unreaped shell's terminal session. Cloned I/O descriptors use nonblocking mode with a blocking `poll` and a dedicated cancellation socket, so idle terminals do not wake on a timer and a program that stops reading cannot trap cancellation. Closing the native window or dropping its local state also terminates owned shells without relying on another asynchronous event-loop turn. Explicitly detached processes follow normal OS terminal semantics.

Windows reserves a separate shutdown drain before child creation and activates it through HPCON destruction, including failed startup and cancelled registration. The vendored portable-pty release removes inherited-parent cursor queries; its exact archive identity, preserved MIT notice and single flag change are recorded in [PROVENANCE](../packages/portable-pty-vendor/PROVENANCE.md). These safeguards address documented older ConPTY shutdown hazards; runtime acceptance on Windows versions before 11 24H2 remains pending.

## Verification

Run `bunx turbo run test:local --filter=@lazysh/client`. This uncached task runs project-native Cargo tests with real processes. Linux tests cover executed UTF-8 input/output, `stty` resize, independent sessions, forged acknowledgment rejection, output-credit exhaustion/resumption, stalled-consumer cancellation, owned-process reaping, failed-spawn teardown and state-drop cleanup. A stopped window refuses new PTYs; registration checks the same shutdown flag again under the registry mutex.

The macOS/Windows desktop CI jobs execute the task after building. Windows cases run a real ConPTY shell, send UTF-8, resize, test credit backpressure/cancellation, and query the owned PID after close. Unsupported environments fail with their actual startup diagnostic rather than reporting a passing PTY test. macOS/Windows runtime results remain pending until those CI jobs execute; compilation on Linux does not establish their behavior.
