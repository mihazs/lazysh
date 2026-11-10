# Theme QR processing reference

## Bounded work and cancellation

Camera snapshots preserve aspect ratio within 500 × 500 pixels and are encoded
as JPEG at quality 0.85 before dispatch. Each encoded input is capped at
196,608 bytes. This uses the existing portable JSON byte-array IPC style:
even worst-case decimal bytes plus the fixed command/nonce envelope stay below
1 MiB. Android cannot read Tauri's raw request bodies, so this flow does not
depend on raw-body IPC support. A shared renderer permit admits at most one
capture/decode pipeline, including across React view remounts. It is acquired
before permission/file reads and released only by that exact pipeline's actual
async completion. Cancellation and unmount do not free it early. A refused new
attempt reports Busy and allows an explicit later retry; nothing is queued.
A frame with no decodable QR may be followed by a new frame within the same
attempt deadline; failed native operations are not retried automatically.

One native worker slot covers image decoding, grayscale conversion and the
pure-Rust `quircs` decoder. Native input bounds are checked before extra clones
or decoder allocation: PNG/JPEG only, 4096 pixels per axis and at most
4,194,304 pixels. Image codec allocation limits are set to 32 MiB but are
**advisory**; progressive JPEG coefficients, grayscale conversion and QR work
add allocations. No strict total-memory or measured peak-RSS bound is claimed.
The hard byte/dimension/pixel bounds and single worker limit finite work.

The original native access lease, input and worker permit stay owned through
synchronous processing. The command awaits actual worker exit before its
guarded reply; lock/revocation rejects a late payload under that original lease.
Stopping the UI discards delivery and closes the camera; it does not abort an
already-running native decoder. A pending operation keeps the local controls
finishing until it settles, and native capacity cannot be freed early by a
cancelled/dropped invocation. Multiple detected QR grids fail closed rather than
choosing an arbitrary theme. Missing or undecodable QR yields no result.

## Evidence and platform acceptance

See [theme QR acceptance](../theme-qr-acceptance.md) for evidence and pending platform checks.

For setup and usage, see [theme-qr](../theme-qr.md). Return to the [documentation map](../README.md).
