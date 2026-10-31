# Real demonstration capture

## Evidence register

No reviewed product screenshots or recordings were found in main's public-facing
asset paths during the 2026-10-31 audit. Logos and test fixture images are not
workflow demonstrations. No native capture was executed in this documentation
change; Android SDK/device and Apple tooling are absent in this executor.
Do not turn browser mocks or generated imagery into claimed native evidence.

| Planned asset | Required capture | Current status |
| --- | --- | --- |
| 01-connect.png | Android SSH identity confirmation and terminal on an owned demo host | Missing |
| 02-sessions.png | Actual discovery/attachment to an existing tmux session | Missing |
| 03-agent.png | Supported agent record with safe, synthetic task content on a real host | Missing |
| 04-reconnect.png | Same remote tmux session after explicit reconnect | Missing |
| demo.mp4 | 30–60 second verified sequence with readable captions | Missing |
| walkthrough.mp4 | 3–5 minute installation, fingerprint, session and limitations explanation | Missing |

These are proposed filenames, not links to available files. A maintainer with a
device owns capture; a second reviewer checks privacy and captions before merge.

## Repeatable procedure

1. Choose a published APK or exact source build. Record version/commit, SHA256,
   Google/FOSS flavor, Android version, device and date in an adjacent capture receipt.
   Use a disposable host/account containing no real work or credentials.
2. Install through [Obtainium or the manual path](../install-and-update.md#android).
   Record install/startup outcome. Verify the SSH host fingerprint over an
   independent trusted channel before confirming the first connection.
3. Create an owned tmux session using the [walkthrough](launch-kit/tmux-tutorial.md).
   Connect in the real native app; discover/attach only if the build actually
   supports that path. Record terminal input and output without personal paths.
4. Optionally install the matching companion through the documented explicit
   action. Show only supported agent events; identify recorded activity as such.
   Skip this segment if it fails, and link a sanitized reproduction issue.
5. Disconnect and reconnect. Show the same tmux session and marker. Explain that
   tmux on the host provides persistence; do not imply lazysh hosts the agent.
6. Capture with the device's screen recorder or authorized ADB screenshot/recording
   tools. Avoid permission dialogs exposing account names, notifications, keyboard
   history, local paths or host/IP details. Restart with safe data if sensitive
   content appears; inspect every frame before publication.
7. Keep original aspect ratio, add captions and a text description. State actual
   device/version and checks performed beside the asset. Cosmetic cropping is
   allowed; do not hide a failing step or imply uninterrupted success by editing.
8. Store reviewed assets under `docs/community/media/` with an evidence receipt,
   alt text, license/creator permission, byte size and SHA256. Compress large video;
   choose a reviewed GitHub attachment if repository size would suffer. Only then
   add Watch Demo and screenshot links to the README or landing page.

Capture again when workflows or platform behavior change. Existing test logs
can substantiate a scoped test result, but cannot substitute for a missing visual.
A receipt must distinguish installed artifact, browser-only tests, emulator tests,
physical hardware and unexecuted behaviors. Never infer acceptance across versions.
