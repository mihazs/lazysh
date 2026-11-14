# Getting help

lazysh is a development preview. Start with the [installation guide](docs/install-and-update.md),
[connections](docs/connections.md) and [public roadmap](https://github.com/mihazs/lazysh/issues/1).
Search [existing issues](https://github.com/mihazs/lazysh/issues) before opening a report.

Use the bug template for a reproducible failure and the feature template for a
bounded proposal. Questions can use a clearly titled issue while Discussions
are unavailable. Include the exact version, OS/device, APK flavor, transport,
steps, expected result and actual result. State whether you used a published
installer, source build or browser preview. A browser preview cannot test SSH.

Remove private addresses, usernames, credentials, host keys, file paths and agent
transcripts from attachments. Never upload your SSH private key or a credential
export. Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities.

## Example bug report

The example below is **illustrative and fictional**. It does not report an observed
defect, and its version, revision, distribution and symptom are invented. Copy only
its structure: one answer for each field of the [bug template](.github/ISSUE_TEMPLATE/bug.md),
with `None` or `Not run` and the reason in place of a blank.

> **Version**
> Browser preview from a source build. About shows version `0.0.0-example`, source revision `0000000`.
>
> **What happened**
> After opening Appearance and fonts in Preferences, the Font size field was not visible at a phone-sized window, and scrolling the page did not reveal it.
>
> **What I expected**
> The Font size field would be reachable by scrolling.
>
> **Steps to reproduce**
> 1. From a source checkout, run `bun run dev` and open the local address it prints.
> 2. Resize the browser window to 390 × 844 pixels.
> 3. Open Preferences, then Appearance and fonts.
> 4. Scroll to the end of the page and look for Font size.
>
> **Environment**
> - OS: Linux, example distribution 1.0
> - Device / simulator / desktop model: desktop computer, Chromium window resized to 390 × 844; no phone, emulator or simulator
> - Docker or remote-host environment (if relevant): None; the browser preview cannot reach a remote host
> - Agent (Claude Code / Codex / OpenCode / other): None
> - Transport (SSH / Mosh / Eternal Terminal / local terminal): None; the browser preview has no SSH, Mosh or Eternal Terminal transport
>
> **Relevant logs**
> None captured, so nothing needed redaction.
>
> Not run: Android native check. No Android device or emulator was used, so this report says nothing about the Android app, SSH or a physical device.

Mark every check you did not execute `Not run` and give the reason, as in the last
line above. Do not leave it blank, and do not describe a browser result as
native, SSH or device behavior.

Support is community based, with no guaranteed response time. Reproduction,
translations and documentation corrections are useful contributions too.
