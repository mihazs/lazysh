# Offline theme QR import

Choose **Scan theme QR** in Settings → Import and share theme to start the
camera explicitly. Camera acquisition requests video only, with a preference
for the rear camera; no audio is requested. Scanning stops after one decoded
result, Cancel, the 30-second attempt deadline, background/pagehide, access
revocation or closing the view. A late permission result is stopped instead of
restarting a cancelled scan. No camera or file operation starts on mount.

The result goes through the existing theme parser and preview. Your manually
typed import draft is preserved. Review the palette and choose **Apply to app
and terminal** explicitly; scanning never changes preferences automatically.
Editing the manual source/name/mode or taking another import action invalidates
an older scan. Changing the interface language alone does not restart it.

If a camera is unavailable or permission is denied, **Read QR from image** is
an explicit alternative. It accepts PNG/JPEG files up to **192 KiB**. It does
not open a file chooser or switch to a camera automatically. Larger photos need
to be resized outside lazysh or scanned with the camera. SVG, GIF, WebP, HEIC,
remote image URLs and arbitrary filesystem paths are not accepted by this flow.

All image and QR processing is local. The scanner neither fetches nor opens a
scanned URL, acknowledges a pending theme link, uploads a frame, nor writes
frames or payloads to disk or logs. JSON and `lazysh-theme:` share codes retain
their existing validation: 16 KiB input,
8 KiB decoded JSON, explicit light/dark mode, bounded name and allowed hex
colors. Arbitrary URLs remain invalid. The OS `lazysh://theme?data=` link flow
is separate and still requires explicit review; vendor OS schemes are not
registered by lazysh.

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

The reference client personalization docs (source URL omitted) describe
the import-screen camera and system camera, clipboard and deep links as ways
to reach its theme import screen. Selected-image decoding is a lazysh fallback;
it does not replace that documented camera requirement.

Static inspection of official gallery chunks `_slug-FOOdwbYM.js` (SHA-256
`82367a065e24ffa55d23df05ac966396790e27f9289e1f8c982832cdd24c4bd9`)
and `theme-format-DRBCINxa.js` (SHA-256
`9f1669f443fb5fc60ec452877a04e97cc7d3b0b83a0329de00621012233b3aec`)
found the gallery passing a vendor-prefixed base64 JSON share code to its
QR generator. REA parent evidence
`ev_c5987d54acf886060e03e8beafca01d35b455b97f22e1663f78209942c3fea67`
records inert static analysis of the two selected chunks, artifact digest
`b02a0965dfe17ea6eb72567b0df484349d80bc2425f21af328df9fd90beddca3`.
Syntax/module inventory completed for this selected scope; semantic relationships
remain conservative and partly unknown. The initial wider index-bundle pass hit
the analysis heap limit. No vendor code/assets are copied into lazysh and no
reference client camera runtime was executed. The vendor's system-camera scheme handling
is not established by that static QR payload observation.

The shared decoder is pinned to [`quircs` 0.10.3](https://github.com/dignifiedquire/quircs),
using its existing grayscale identify/decode API. Upstream Cargo metadata declares
MIT, while the bundled LICENSE contains an ISC-style permission notice. The
actual notice is preserved byte-for-byte in About; this records upstream's
metadata/text discrepancy without reinterpreting or relicensing it. The registry
crate archive SHA-256 is
`d71dee9e56835add6f9c26227e6c690b19eda9414f5affc666c3ec833ba140dc`,
matching Cargo.lock; the bundled notice SHA-256 is
`166760d656f6bfc29dfc76a7f763e529bde0ed22dde2b20cf6b6c4b14a138a9a`.
`image` was already a
native dependency. The owned `fixtures/theme-qr.png` is generated by the installed
`qrencode` 4.1.1 CLI from a synthetic minimal `lazysh-theme:` palette named
`QR fixture`; it contains no vendor image or user data. The second fixture uses
the same CLI's binary mode with a single invalid UTF-8 byte. Standard native Cargo
tests decode the actual PNG and a JPEG encoding, reject malformed/oversized/
multiple-code inputs, and hold fake workers across cancellation and revocation.
Frontend tests and browser media fixtures cover the UI lifecycle separately.

Android declares CAMERA with optional camera/autofocus features, so the fallback
does not make camera hardware a distribution requirement. Installed Wry's
`isMediaCaptureSupported` checks whether CAMERA is declared or already granted.
Adding the declaration can therefore make the existing explicit Attachment Photo
action request camera permission too; the ordinary file-picker branch is
unchanged. This is a source-supported interaction, not executed OS permission
proof. The QR component never requests media without Scan. See
[Android's feature filtering contract](https://developer.android.com/guide/topics/manifest/uses-feature-element).
Apple builds include camera purpose strings in English, Brazilian Portuguese
and Spanish for both explicit QR scans and attachment-photo capture. Only QR
frames are covered by the local-only statement; attachment photos can later be
explicitly uploaded through the existing attachment workflow. macOS declares the
camera entitlement. See
[Apple's camera entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.camera).
Installed Wry source contains Android runtime video-permission mapping, WebKit
media-capture decisions and WebView2 camera mapping. These source observations
and manifest declarations do not establish successful permission/capture on
any device. CSP allows only local/blob media and keeps existing remote-connect
restrictions. Cross-origin preview frames have no camera permission delegation.

Actual Android WebView serialization and allow/deny, iOS/macOS signing and
privacy prompts, desktop WebView camera support, hardware focus/dense-code
recognition, background/resume and physical camera-indicator shutdown need native
and physical acceptance. Browser synthetic media and Linux decoder tests are
distinct evidence and do not close that platform gap. Track #208 under #16;
the wider parity issue remains open until real-camera acceptance is recorded.

Pending native/physical acceptance includes:

- Fresh Android install: no camera prompt on launch/render; explicitly Scan,
  deny permission, and verify a usable local-image fallback and no native decode.
- Android: grant only after Scan, decode an owned theme QR into preview without
  Apply, then cancel/background while capture or permission is pending and verify
  camera-indicator shutdown and stale-result rejection. Deny the existing explicit
  Attachment Photo action independently and verify ordinary file picking still
  works; its new CAMERA-declaration branch must not be mistaken for startup use.
- iOS/macOS: verify built purpose strings/entitlement and localized allow/deny,
  rear/front availability, late permission response, indicator shutdown on cancel,
  background and view closure, plus explicit Apply only after review.
- Windows/Linux desktop: verify actual WebView camera permission/capture and
  absent-device behavior, then run the same owned QR and cancellation checks.
