# Capture the README screenshots and clips

The images and clips in the README are real captures of the Android app running on the [Waydroid lane](../architecture/waydroid-lane.md): the app driven through its real interface against owned hosts, with nothing mocked or drawn. This guide reproduces them. The files live in `docs/assets/readme/`.

## What it needs

| Need | Why |
| --- | --- |
| A running Waydroid session whose adb is authorised (`adb devices` shows `192.168.240.112:5555` as `device`) | The guest. A new guest answers `unauthorized` until its adb key is accepted once; the lane never changes that for you |
| The x86_64 debug APK | A CI artifact: `gh run download <run> -n lazysh-android-debug-x86_64` from a `checks` run on `main`, then `universal/debug/app-universal-debug.apk`. The released arm64 APK does not run on an x86_64 guest |
| `ffmpeg`, `ffprobe`, ImageMagick 7 (`magick`), `bwrap`, `bun`, `tmux`, the JDK and Android SDK of the Appium suite | Capture, encoding and the suite itself ([mobile end-to-end suite](../../apps/client/mobile-e2e/README.md)) |
| The companion binary (`lazysh-agent` on `PATH`, or `LAZYSH_TEST_AGENT_BIN`) | The agent chat and the approval card are read by the companion on the host |

Hold the [lane lock](../architecture/waydroid-lane.md#the-lock) for the whole run (`mkdir /tmp/lazysh-waydroid-lane.lock`, `rmdir` it afterwards): the run takes the guest for about two minutes and two sessions kill each other.

## Run it

```sh
export ANDROID_HOME=<sdk> JAVA_HOME=<jdk>
apps/client/bench/readme-capture-run.sh <app-universal-debug.apk>
```

It writes the images and clips to `docs/assets/readme/` (`README_MEDIA_OUT` chooses another directory) and keeps the raw recordings and keyframe files in `README_RAW_DIR`. The run is deterministic apart from timing; look at every output before you commit it.

## How the capture works

1. **No private data.** `readme-capture-run.sh` runs the suite inside a bubblewrap view where `/etc/passwd` names the current account `demo` with no real name, so the host list, the prompt and the footer show `demo@127.0.0.1`. The hosts are the suite's owned fixtures: a tmux host and a plain SSH host with the file-transfer subsystem, both on loopback with throw-away keys. The demo files, the build script, the agent transcript (`apps/client/bench/readme-demo/transcript.jsonl`, text written for this purpose) and the two approval requests are synthetic. The status bar and the navigation bar are cropped from every capture (`README_CROP_TOP`, `README_CROP_BOTTOM`).
2. **Real app, real input.** `apps/client/mobile-e2e/capture/readme-media.e2e.ts` adds the hosts through the editor, types on the soft keyboard, opens the Transcript tool, answers the approval card and opens Preferences. Run it only through the script above, which sets what it needs.
3. **Screenshots** are taken with `readme-capture.sh shot <name>` (`adb exec-out screencap`, with the guest's stderr kept out of the PNG), then optimised in steps (palette, then resolution) until the file is at most 300 KB.
4. **Clips** start as a raw `screenrecord` of the guest. `readmeZoom.ts` crops the bars, resamples to a steady 30 frames per second and draws the zoom: a list of keyframes `{t, zoom, x, y}` (a time, how much closer, and the centre as a fraction of the frame) with smoothstep easing between them, held before the first and after the last. ffmpeg's `zoompan` does the drawing on a 2x upscaled frame, so the pan does not jitter. The keyframes come from marks the spec sets while it drives the app, so the zoom follows what happens. The result is an H.264 MP4 (`+faststart`, at most 5 MB). `readme-capture.sh gif-from <name> <mp4>` turns that into a GIF with a generated palette, lowering the frame rate, width and colours until it fits (at most 5 MB; the walk-through is capped lower, see below).
5. `readme-capture.sh check` verifies that every file in `docs/assets/readme/` has a valid name and fits its budget.

## Build the walk-through

The tour at the top of the README (`walkthrough.mp4` and `walkthrough.gif`) is assembled from the captures above, not recorded again, so it needs no guest:

```sh
bun apps/client/bench/readmeWalkthrough.ts --scenes apps/client/bench/readme-demo/walkthrough.json --dir docs/assets/readme --out docs/assets/readme/walkthrough.mp4
README_GIF_MAX_KB=4800 apps/client/bench/readme-capture.sh gif-from walkthrough docs/assets/readme/walkthrough.mp4
```

`walkthrough.json` lists the scenes in order: a title card, a still image (it moves with the same keyframed ease-in/out zoom as a clip, `{t, zoom, x, y}`), or a clip with a start and a duration (it keeps the zoom it was recorded with). Each scene has a short English caption, burned into a band under the 540 x 1100 picture with ffmpeg `drawtext` (the text goes through a file, so no quoting reaches the filtergraph). Scenes join with `xfade` (a zoom-through by default, `fade` or `fadeblack` where a card meets a screen), overlapping by 0.6 s, at 30 frames per second, as H.264 with `+faststart` and at most 5 MB. `README_FONT` names a bold sans-serif `.ttf` when none of the usual ones is installed. Every scene is a real capture: when the tour needs a part of the app that has no capture, record it with the spec first (a still or clip of the real screen), never draw it. The GIF is the inline embed: GitHub's Markdown sanitizer removes `<video>` elements (also with a `raw.githubusercontent.com` source: checked with the `/markdown` API), and plays MP4 only for `user-attachments` uploads, which have no API. To stay under 5 MB the 40-second tour is 10 frames per second, 300 px wide and 64 colours; the MP4 is the sharp version.

## Test it

```sh
bun run --cwd apps/client test -- bench/readmeCapture.test.ts bench/readmeZoom.test.ts bench/readmeWalkthrough.test.ts
```

`readmeCapture.test.ts` runs the script against a stub `adb` with the real ImageMagick and ffmpeg: names, budgets, cropping, the refusal of a capture that cannot fit and of an unreachable guest. `readmeZoom.test.ts` checks the keyframes and the easing, then renders a clip from a synthetic video whose every pixel encodes its position, and asserts which part of the source is on screen at the start, in the middle of a transition and while held. `readmeWalkthrough.test.ts` checks the scene timeline (starts, joins, total length), the refusals (a scene too short for its transitions, a missing caption, a keyframe past the end), the caption wrapping, and the committed scene list (valid, 25 to 45 seconds), then renders a tour of a synthetic card, still and clip and reads pixels back: which scene is on screen at a given second, a blend inside a join, the caption in its band, the output size, frame rate and length, and the refusal of a tour over budget. None of them runs the guest, so the live behaviour is checked by looking at the output.

## What Waydroid shows

The captures are an x86_64 guest on the host GPU, with the AOSP soft keyboard and a 1080x2400 window at 420 dpi that the suite sets and restores. They show the app, not a phone's fonts, keyboard or notification shade. Do not describe them as device captures.
