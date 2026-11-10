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

See [bounded work and cancellation](reference/theme-qr.md#bounded-work-and-cancellation) for details.

## Evidence and platform acceptance

See [evidence and platform acceptance](reference/theme-qr.md#evidence-and-platform-acceptance) for details.
