# Local terminal process reference

## Process and flow control

The native desktop implementation uses [portable-pty 0.9](https://docs.rs/portable-pty/0.9.0/portable_pty/): Unix PTYs on Linux/macOS and ConPTY on supported Windows systems. Each session has a 32-operation input queue, one queued 16 KiB output chunk and 256 KiB of unacknowledged terminal output. Input operations are limited to 64 KiB. Output acknowledgment cannot exceed the outstanding byte count. An unresponsive output consumer times out and closes the session. Terminal dimensions are validated before resize.

Disconnect cancels the independent session and reaps its owned shell. Unix cleanup fences foreground process-group signalling to the owned unreaped shell's terminal session. Cloned I/O descriptors use nonblocking mode with a blocking `poll` and a dedicated cancellation socket, so idle terminals do not wake on a timer and a program that stops reading cannot trap cancellation. Closing the native window or dropping its local state also terminates owned shells without relying on another asynchronous event-loop turn. Explicitly detached processes follow normal OS terminal semantics.

Windows reserves a separate shutdown drain before child creation and activates it through HPCON destruction, including failed startup and cancelled registration. The vendored portable-pty release removes inherited-parent cursor queries; its exact archive identity, preserved MIT notice and single flag change are recorded in [PROVENANCE](../../packages/portable-pty-vendor/PROVENANCE.md). These safeguards address documented older ConPTY shutdown hazards; runtime acceptance on Windows versions before 11 24H2 remains pending.

## Verification

See [local terminal verification](../local-terminal.md#verification).

For setup and usage, see [local-terminal](../local-terminal.md). Return to the [documentation map](../README.md).
