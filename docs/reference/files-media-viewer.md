# Files video and audio viewer

Files plays a host's video and audio in an isolated, non-executing frame. This page records why the frame is built the way it is (issue #1720, split from #993), what it accepts and what it does not do. For use, see [View files in Files](../repository-review.md#view-files-in-files).

## Trust boundary

A file on a host is untrusted input, and the main window holds the native bridge (see issue #10: no remote HTML or media inside the privileged WebView). The viewer therefore never gives the file's bytes to the main document.

- **Native reader.** `file_media` (`src-tauri/src/media.rs`) reads one regular file of the current directory over the verified SSH connection (SFTP) or the local disk, refuses a symbolic link, reads at most 8 MiB plus one byte, and names the file's type from its first bytes, not its name or the host. It answers with a type from a fixed list and the bytes as base64. A file whose signature is not the requested kind (a page named `x.mp4`, a video named `x.mp3`) is refused as `media_mislabeled`; one larger than 8 MiB is refused as `media_too_large`. The client also refuses a listed size over 8 MiB before asking, and rejects a response whose type is outside the list for that kind or whose data is not base64 within the bound.
- **Isolated frame.** `MediaFrame.tsx` renders one `<iframe sandbox="">` with a `srcdoc` that holds a single `<video controls>` or `<audio controls>`. An empty `sandbox` grants no token: the frame has an opaque origin, runs no script, submits no form, opens no popup and cannot touch this window, its storage or the native bridge (the bridge is not injected into frames either). The document carries its own policy, `default-src 'none'; media-src data:; style-src 'unsafe-inline'`, so nothing loads except the one data URL. There is no autoplay and no fullscreen.
- **Why a data URL.** A blob URL made by the main window is the first choice and does not work: an opaque origin cannot load it (Chromium refuses the media load as "rejected by URL safety check"). The main window's policy gains `data:` in `media-src` (`tauri.conf.json`) because a `srcdoc` frame inherits it; the other directives are unchanged, and `img-src` already allowed `data:`.
- **File types.** Video: `.mp4`, `.m4v`, `.webm` (MP4 or WebM signature). Audio: `.mp3`, `.m4a`, `.ogg`, `.oga`, `.opus`, `.wav`, `.flac` (MP3, MP4 audio brand, Ogg, WAV or FLAC signature). The signature decides; the extension only chooses which viewer is tried. Whether the frame then plays the stream is up to the platform's own decoders: a file with a codec the device lacks shows the engine's own "cannot play" player.

## Linux needs GStreamer's audio plugins

WebKitGTK aborts its web process, and so the whole window, when a media element loads on a system without GStreamer's `autoaudiosink` (observed with WebKitGTK 2.54.2 and GStreamer 1.28.9 without gst-plugins-good: "GStreamer element autoaudiosink not found" followed by a null-pointer abort). The viewer therefore asks the native `media_playback` command before it makes a frame. On Linux it answers true only when `libgstautodetect.so` is in a GStreamer plugin directory (`GST_PLUGIN_SYSTEM_PATH_1_0`, `GST_PLUGIN_SYSTEM_PATH`, `GST_PLUGIN_PATH_1_0`, `GST_PLUGIN_PATH`, or the usual `/usr/lib*/gstreamer-1.0` directories); on other platforms it is always true. Without it the file is not played and the app says so, naming `gst-plugins-good` or `gstreamer1.0-plugins-good`, and **Open with…** and **Download** keep working. A plugin installed in a directory outside that list is not found and is refused the same way. The check runs after the file was read and validated, so a mislabeled or oversized file gets its own message on every system.

## PDF

PDF is not drawn inside the app. Chromium does not run its PDF viewer in a sandboxed frame, and neither WebKitGTK nor Android's WebView draws PDFs inline, so a frame cannot be a portable PDF viewer. A PDF renderer written in JavaScript would be a large parser to carry and keep patched. Files shows a note for a `.pdf` entry and the existing **Open with…** and **Download** actions hand the file to the device's own PDF viewer, outside the WebView, which the issue allows. A bundled, sandboxed renderer remains possible and is tracked separately.

## Verified, and what is not

| Check | Where it runs |
| --- | --- |
| Signature sniffing, kind mismatch and the 8 MiB bound | Rust unit tests in `media.rs` (`cargo test --lib media::`) |
| The command over real OpenSSH SFTP: bytes round trip, mislabeled, oversized and symbolic-link refusals | `ssh/tests/repository_review_fixture.rs` in `test:openssh` |
| Frame attributes and policy, refusals with the app's own words, no player for a malformed answer, PDF note | Vitest `FilePreview.test.tsx` |
| A real WebM and MP3 decode in the frame (metadata, size, duration), opaque origin, no bridge, no access to the parent | Playwright `e2e/files-media.spec.ts` in Chromium, over a synthetic native layer |
| The command and the viewer through the real application: owned OpenSSH server, real window and bundled policy; a page named `.mp4`, an oversized video and a PDF are refused or handed on; the same sandbox and policy in the real WebKitGTK window have an opaque origin, no bridge, no way into the parent and no script | `native-e2e/mediaFiles.spec.ts` in the Linux native GUI suite (WebKitGTK) |

The native case branches on what the machine can do: with GStreamer's audio plugins it asserts the player frame (empty sandbox, no `src`, the file's exact bytes in the frame's document); without them it asserts the refusal above and that no frame and no crash follow. The local run (Xvfb, `tauri-driver` 2.1.0, WebKitGTK 2.54.2, no gst-plugins-good) took the second branch, so WebKitGTK has not been observed decoding a file in the frame; the frame's isolation was observed in WebKitGTK through a probe of the same sandbox and document without the media element. Decoding in a sandboxed opaque-origin frame was observed in Chromium only.

Not covered: Android WebView, macOS and iOS WKWebView and Windows WebView2 (no hardware or runtime here; the frame uses only standard attributes), and whether a given device decodes a given codec.
