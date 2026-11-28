# @lazysh/client

## 1.107.1

### Patch Changes

- fix(release): restore publishing by moving the managed Herdr target directory out of the job-level env ([#2942](https://github.com/mihazs/lazysh/pull/2942))

  <details><summary>Details</summary>

  The release workflow was rejected by GitHub because a job-level env value read the runner context, so no version could be published after the managed Herdr job was added. The target directory is now exported from a step.

  </details>

## 1.107.0

### Minor Changes

- feat(browser): add Keep profile and Clear browser data to the Host browser settings ([#2820](https://github.com/mihazs/lazysh/pull/2820))

  <details><summary>Details</summary>

  Keep profile is off for every host until chosen, remembered on this device for that host only (never in the encrypted sync, host ids only) and passed to the host browser relay as `--keep-profile`, so cookies and sign-ins stay on the host's disk until cleared. Clear browser data deletes that kept profile directory on the host after a confirmation that names what is deleted; it is offered with the host browser switch off, reports when there is nothing to clear, is refused while a browser uses the profile, and asks you to update an older companion. No browser session starts from the app yet, so Keep profile takes effect when the Chrome viewer ships.

  </details>
- ci(release): publish the managed Herdr as verified release assets ([#2831](https://github.com/mihazs/lazysh/pull/2831))

  <details><summary>Details</summary>

  Each release now also carries the managed Herdr executable for Linux x86-64 (`lazysh-<version>-linux-herdr-x64.bin`) and its notice inventory, notice text and build receipt, all listed in `release.json` and `SHA256SUMS` and checked against the tag after publication. Installs stay opt-in and no platform support is claimed.

  </details>
- feat(herdr): keep the Herdr event stream open for the inbox while no Herdr view is shown ([#2813](https://github.com/mihazs/lazysh/pull/2813))

  <details><summary>Details</summary>

  With Monitor connected hosts on, each connected host that runs one Herdr server (or the attached one) is followed through the shared stream a visible Herdr view reads, so a blocked or finished Herdr agent becomes an inbox event and a notification whichever page is open. It is deduplicated against the same turn reported by a hook, and the stream closes when monitoring is turned off or the host disconnects.

  </details>

### Patch Changes

- fix(agents): open the Claude Code and OpenCode conversations that hold a large tool result ([#2790](https://github.com/mihazs/lazysh/pull/2790))

  <details><summary>Details</summary>

  The Agent view no longer refuses a Claude Code or OpenCode session because one tool result is megabytes long: the text is cut with a note of how many bytes were left out, and a compaction link that names a later record no longer makes the session a loop. Needs the updated host companion.

  </details>
- feat(desktop): find native Zellij and Herdr on Windows through PATHEXT in discovery and actions ([#2835](https://github.com/mihazs/lazysh/pull/2835))

  <details><summary>Details</summary>

  Find a native Zellij or Herdr on Windows the same way in multiplexer discovery, one-shot actions and attach. Discovery and actions only appended `.exe` to the program name, so a Zellij or Herdr installed as a `.com` file, or found through a different `PATHEXT` order, was reported missing or failed to start while attach found it. They now try each `PATH` directory in order with the name plus the `.com` and `.exe` entries of `PATHEXT`, and an action runs the file found; a `.bat` or `.cmd` still never resolves. Herdr is looked up on the `PATH` only on Windows. A program that resolved before still resolves, and Linux and macOS behave as before.

  </details>
- test(e2e): Appium regression spec for typing and Backspace through the real Android keyboard ([#2843](https://github.com/mihazs/lazysh/pull/2843))

  <details><summary>Details</summary>

  Adds the device spec that types a word, a correction, a toolbar key and Backspace through Android's own input path and checks the bytes the host receives.

  </details>
- fix(agent): start the working clock at the new turn instead of the previous finished prompt ([#2848](https://github.com/mihazs/lazysh/pull/2848))

## 1.106.0

### Minor Changes

- feat(companion): run the managed Windows companion before the PATH one on OpenSSH hosts ([#2810](https://github.com/mihazs/lazysh/pull/2810))

  <details><summary>Details</summary>

  Run the managed Windows companion before the `PATH` one on Windows hosts reached over OpenSSH (#1902, part of #1725 and #490). After the PowerShell probe identifies the host, the app reads `%LOCALAPPDATA%`, `lazysh`, `companion` and `lazysh-agent.exe` in one exec and decides them with the owner, DACL and reparse-point rules the companion's own admission uses: a link or junction, a directory another account can change, and an executable another account owns or can access are refused and reported, and the `PATH` lookup stays. An admitted file is run by its absolute path; a missing one, an unreadable namespace and a host that does not answer the read keep today's `PATH` lookup. The answer is remembered for the connection, so a change to the namespace is noticed on the next connection. Installation, hook setup and the Herdr lookup stay Unix-only. Changed default: a Windows host identified by the probe costs one more exec per connection.

  </details>

### Patch Changes

- fix(agent): keep hook setup working after a profile folder is restored, copied or remounted ([#2911](https://github.com/mihazs/lazysh/pull/2911))

  <details><summary>Details</summary>

  Inspecting a hook profile failed with `HooksForeignRecord: operation failed` once the profile directory's device or inode changed, for example after a reboot on btrfs, so hooks could be neither updated nor removed. The setup record now stays bound to the agent and profile path, and the plan still refuses a directory swapped before apply. A record written for another folder is reported as unsupported with a specific explanation instead of an error, and every other hook setup failure shows a fixed, localized message instead of the companion's internal error name.

  </details>
- fix(credentials): import ECDSA P-256 private keys whose secret starts with a zero byte ([#2827](https://github.com/mihazs/lazysh/pull/2827))

  <details><summary>Details</summary>

  About one OpenSSH ECDSA P-256 key in 256 failed to import with "Cannot unlock this private key", encrypted or not, because the SSH key decoder rejected the shortened 31-byte secret OpenSSH writes for it. Those keys now import and authenticate like any other.

  </details>

## 1.105.1

No changes in this release.

## 1.105.0

### Minor Changes

- feat(agents): label each file update card as created, edited, deleted or renamed ([#2803](https://github.com/mihazs/lazysh/pull/2803))

  <details><summary>Details</summary>

  Patch-style edits (Codex `apply_patch`, OpenCode `patch`) now show deleted and renamed files with their operation and old and new paths, and a Write says whether it created the file.

  </details>

### Patch Changes

- fix(multiplexers): show the newest pane history tail when a pane's scrollback exceeds 8 MiB ([#2809](https://github.com/mihazs/lazysh/pull/2809))

  <details><summary>Details</summary>

  Pane history for tmux, Zellij and Herdr now keeps only the newest part of the host output before it crosses the transport bound, so a wide, deep pane shows its latest 2 MiB with the truncation notice instead of failing.

  </details>
- fix(bench): match the native and xterm terminal grids in Android stream measurements ([#2754](https://github.com/mihazs/lazysh/pull/2754))

  <details><summary>Details</summary>

  The packaged xterm benchmark can match the native arm’s rows and columns using rendered cell dimensions, then checks the remote PTY size before replaying the matched fixture.

  </details>
- fix(android): keep the Back listener registered so Back never leaves the app while a page opens ([#2791](https://github.com/mihazs/lazysh/pull/2791))

  <details><summary>Details</summary>

  Back is handled for the whole session; when nothing is open it runs Android's default Back instead of the app finishing.

  </details>
- fix(ssh): refresh host-tool views automatically after the command connection recovers ([#2795](https://github.com/mihazs/lazysh/pull/2795))

  <details><summary>Details</summary>

  Herdr navigation, the Agent view, account usage, the multiplexer strip and live transcript watches now refresh on their own when a Mosh or Eternal Terminal session recovers its host-tools connection, and the terminal and session are untouched. The manual host-tools reconnect buttons and credential dialog are removed: while recovery runs the views say host tools are reconnecting, and when it cannot proceed (credentials, a changed host or a jump host) they say why. Reconnecting uploads still uses its own manual flow. Verified with an owned Linux Mosh/Herdr session; Android and iOS acceptance is not yet run.

  </details>
- build(fdroid): add release notes and phone screenshots to the F-Droid listing ([#2928](https://github.com/mihazs/lazysh/pull/2928))

  <details><summary>Details</summary>

  Each version PR now writes `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`, which lists the release's user-facing headlines and links to the full notes. The listing also gets six phone screenshots taken from the README captures.

  </details>
- test(windows): drive theme QR scan and shell link import through the installed GUI ([#2816](https://github.com/mihazs/lazysh/pull/2816))

  <details><summary>Details</summary>

  The installed Windows GUI check now scans a QR image through the real file input and opens a `lazysh://theme` link through the Windows shell with the registration the NSIS installer wrote; the theme changes only after Apply. Test-only; the application is unchanged.

  </details>
- fix(tmux): start new sessions, windows and panes in directories whose name contains a style marker ([#2800](https://github.com/mihazs/lazysh/pull/2800))

  <details><summary>Details</summary>

  A directory such as `a#[b]c` no longer makes tmux start the new session, window or split pane in Home.

  </details>
- feat(agents): always show the agent's reported mode, approval and sandbox in the Agent view header ([#2805](https://github.com/mihazs/lazysh/pull/2805))

  <details><summary>Details</summary>

  The header now draws the mode the agent reports even when it is the default one, plus a chip with the approval policy and sandbox when the agent reports them (Codex). An agent that reports nothing shows no chip.

  </details>
- test(android): wait for the auth activity to resume before the instrumentation test continues ([#2817](https://github.com/mihazs/lazysh/pull/2817))

  <details><summary>Details</summary>

  The Android auth instrumentation test no longer reads a transitional RESTARTED state, so the owned emulator job stops failing intermittently. No app behavior changes.

  </details>

## 1.104.2

### Patch Changes

- fix(onboarding): make the gesture tour match the hidden gesture lines ([#2784](https://github.com/mihazs/lazysh/pull/2784))

  <details><summary>Details</summary>

  The tour no longer draws a handle line or tells you to start from one while Show gesture lines is off, which is the default. On Android gesture navigation it now says to start in the strip just inside the system's zone, and where to turn the lines on.

  </details>
- fix(chat): Send and Stop in the Chat terminal input work from an open touch-keyboard composition ([#2783](https://github.com/mihazs/lazysh/pull/2783))

  <details><summary>Details</summary>

  Leaving the field ends the open composition first, then Send or Request stop acts once on the committed draft instead of staying disabled.

  </details>

## 1.104.1

### Patch Changes

- fix(release): declare the Debian protobuf runtime dependency ([#2785](https://github.com/mihazs/lazysh/pull/2785))

  <details><summary>Details</summary>

  Debian and Ubuntu installations pull in the protobuf library the Linux executable needs to start.

  </details>
- fix(zellij): Split right and Split down start in the chosen Directory ([#2793](https://github.com/mihazs/lazysh/pull/2793))

  <details><summary>Details</summary>

  Zellij ignores `--cwd` for a plain terminal pane, so a split in a directory other than the default `.` now runs your shell there as a command pane that closes on exit. The default `.` is unchanged.

  </details>
- fix(ci): gate the Android emulator on SystemUI readiness before native cases ([#2788](https://github.com/mihazs/lazysh/pull/2788))

  <details><summary>Details</summary>

  A boot-time SystemUI ANR now reboots the guest (at most twice) or fails the job early with a named cause, instead of failing the first native case with an unfocused window.

  </details>

## 1.104.0

### Minor Changes

- feat(agents): show running agent processes on Linux hosts ([#2542](https://github.com/mihazs/lazysh/pull/2542))

  <details><summary>Details</summary>

  The Agents page lists same-user processes recognized by executable name, including agents started outside a multiplexer. Process discovery is read-only and does not infer a conversation or input destination.

  </details>
- feat(settings): move agent image previews to Preferences ([#2538](https://github.com/mihazs/lazysh/pull/2538))

  <details><summary>Details</summary>

  Choose which agents load image previews under Agents and notifications. Existing choices carry over.

  </details>

### Patch Changes

- feat(terminal): add an opt-in Metal terminal surface on iOS ([#2692](https://github.com/mihazs/lazysh/pull/2692))

  <details><summary>Details</summary>

  New VoiceOver sessions use the accessible terminal backend. Turning on VoiceOver in an open native session exposes the current terminal rows.

  </details>
- fix(android): keep native terminal link taps inside the consent prompt ([#2697](https://github.com/mihazs/lazysh/pull/2697))
- perf(terminal): the native renderer repaints only the changed cells of a row ([#2830](https://github.com/mihazs/lazysh/pull/2830))

  <details><summary>Details</summary>

  A full-screen repaint in which only a counter changes per row sends 92 % fewer instances and bytes to the GPU in the benchmark on the host GPU, with the same pixels.

  </details>
- fix(terminal): preserve mouse modifiers and report desktop wheel events in native terminals ([#2778](https://github.com/mihazs/lazysh/pull/2778))
- perf(agents): draw the Agent view's folded tool activity only when it is opened ([#2829](https://github.com/mihazs/lazysh/pull/2829))

  <details><summary>Details</summary>

  A 100-message conversation puts about 400 elements in the page instead of about 1,500 and costs about 40 % less main-thread script at 4x CPU slowdown.

  </details>
- fix(agent): soften the focused message composer outline ([#2656](https://github.com/mihazs/lazysh/pull/2656))
- fix(agents): open long Claude Code conversations in the Agent view and page back through them ([#2782](https://github.com/mihazs/lazysh/pull/2782))

  <details><summary>Details</summary>

  A Claude Code transcript over 16 MiB (64 MiB when Herdr selects it) no longer reports "too large to open here". The companion reads the newest page and then the older or newer ones from a bounded part of the file, keeps the queued prompts and session state, and cuts a block over 256 KiB with a note instead of refusing the conversation.

  </details>
- fix(android): reopen Lazysh when the System WebView renderer exits ([#2763](https://github.com/mihazs/lazysh/pull/2763))

  <details><summary>Details</summary>

  Android rebuilds the Lazysh interface after its renderer exits, so saved connections remain available for reconnecting.

  </details>
- fix(ci): wait for exact Android connection form text in the published APK check ([#2719](https://github.com/mihazs/lazysh/pull/2719))
- fix(theme): say the QR image could not be read instead of blaming decoding ([#2774](https://github.com/mihazs/lazysh/pull/2774))

  <details><summary>Details</summary>

  When the page cannot read the chosen QR image file, the error now asks you to choose it again rather than saying the image could not be decoded.

  </details>
- fix(terminal): report incomplete Android frame-pacing counters as unmeasured ([#2713](https://github.com/mihazs/lazysh/pull/2713))
- feat(agents): attach files directly from the compact prompt composer ([#2775](https://github.com/mihazs/lazysh/pull/2775))

## 1.103.0

### Minor Changes

- feat(terminal): switch a live Mosh session from native to xterm.js ([#2635](https://github.com/mihazs/lazysh/pull/2635))

### Patch Changes

- fix(terminal): keep the native renderer when switching to xterm.js is refused ([#2635](https://github.com/mihazs/lazysh/pull/2635))

  <details><summary>Details</summary>

  A terminal that already switched keeps showing live output after unlock.

  </details>
- fix(bench): run only the Android terminal benchmark method ([#2752](https://github.com/mihazs/lazysh/pull/2752))

  <details><summary>Details</summary>

  The packaged benchmark collects its own AndroidJUnitRunner result when the optional SwiftKey test is present.

  </details>
- fix(bench): retry transient Android display capture misses ([#2758](https://github.com/mihazs/lazysh/pull/2758))

  <details><summary>Details</summary>

  The benchmark keeps the original timing window and counts only real screenshot observations. A sustained capture failure still fails the run.

  </details>

## 1.102.5

### Patch Changes

- fix(agents): show unrecognized follow-up questions with a terminal action ([#2777](https://github.com/mihazs/lazysh/pull/2777))
- fix(chat): keep every character typed quickly into the transcript path field ([#2905](https://github.com/mihazs/lazysh/pull/2905))

  <details><summary>Details</summary>

  A long path entered in one burst, such as native key events, could lose a character once React hit its nested-update limit. The path field's resets now leave no update pending after each keystroke.

  </details>

## 1.102.4

### Patch Changes

- fix(ci): allow individual iOS and macOS terminal rehearsals ([#2715](https://github.com/mihazs/lazysh/pull/2715))
- fix(release): keep the bundled companion executable in the restored Linux AppImage ([#2867](https://github.com/mihazs/lazysh/pull/2867))

  <details><summary>Details</summary>

  The restored AppImage installed the published companion with the mode of its downloaded artifact, so the release check found it not executable.

  </details>

## 1.102.3

### Patch Changes

- test(terminal): verify saved actions and D-pad holds on the native engine ([#2711](https://github.com/mihazs/lazysh/pull/2711))
- fix(terminal): require paired absolute memory for the same Android app ([#2708](https://github.com/mihazs/lazysh/pull/2708))

  <details><summary>Details</summary>

  The Android rollout comparison also keeps the key improvement target open when a required key benchmark is missing.

  </details>
- fix(terminal): include Android session memory and churn in native rollout evidence ([#2710](https://github.com/mihazs/lazysh/pull/2710))
- fix(terminal): keep the native editor focused after tapping the terminal ([#2701](https://github.com/mihazs/lazysh/pull/2701))
- fix(agents): acknowledge sends promptly and show when the agent queued them ([#2574](https://github.com/mihazs/lazysh/pull/2574))

  <details><summary>Details</summary>

  The composer acknowledges terminal submission, reports a confirmed queue entry, and refreshes the fallback transcript sooner.

  </details>
- feat(android): add the native terminal engine to the GitHub FOSS APK ([#2694](https://github.com/mihazs/lazysh/pull/2694))

  <details><summary>Details</summary>

  Choose Native in Settings under Terminal engine on supported devices. The APK still builds its native libraries from source, and the release kill switch applies to both Android flavors.

  </details>
- fix(terminal): start native touch selection at the new word after copying ([#2705](https://github.com/mihazs/lazysh/pull/2705))
- fix(release): keep the bundled companion runnable in Linux AppImages ([#2733](https://github.com/mihazs/lazysh/pull/2733))

  <details><summary>Details</summary>

  Preserve the source-built companion through AppImage packaging and check that the bundled binary starts and reports the release version.

  </details>
- fix(terminal): release closed session renderers from terminal IPC channels ([#2619](https://github.com/mihazs/lazysh/pull/2619))
- fix(terminal): discard canceled native composing text after a focus change ([#2707](https://github.com/mihazs/lazysh/pull/2707))
- fix(terminal): report mouse hover in native terminals when applications request it ([#2614](https://github.com/mihazs/lazysh/pull/2614))
- fix(terminal): keep the keyboard closed on Herdr navigation taps ([#2534](https://github.com/mihazs/lazysh/pull/2534))
- fix(android): preserve typed terminal words when SwiftKey inserts a space ([#2750](https://github.com/mihazs/lazysh/pull/2750))

  <details><summary>Details</summary>

  The native terminal keeps the existing shell text when SwiftKey automatically corrects an already typed word. Explicit keyboard suggestions and composing text still work.

  </details>

## 1.102.2

### Patch Changes

- feat(terminal): include the native Wayland engine in Linux packages ([#2693](https://github.com/mihazs/lazysh/pull/2693))

  <details><summary>Details</summary>

  The Linux x64 Debian package and AppImage include the native terminal when the release kill switch is on. X11 sessions continue to use xterm.js.

  </details>
- fix(bench): compare Android terminal streams only when their grids and bytes match ([#2595](https://github.com/mihazs/lazysh/pull/2595))

  <details><summary>Details</summary>

  The xterm benchmark can replay the native arm’s grid from a same-run receipt. The runner and comparator verify the fixture hashes and dimensions for W2–W4.

  </details>
- fix(terminal): stop display-scale monitoring when an xterm.js session closes ([#2621](https://github.com/mihazs/lazysh/pull/2621))
- feat(terminal): include the native terminal engine in Windows installers ([#2693](https://github.com/mihazs/lazysh/pull/2693))

  <details><summary>Details</summary>

  Windows x64 installers include the native engine when the release kill switch is on.

  </details>
- fix(android): honor Private keyboard in the native terminal ([#2691](https://github.com/mihazs/lazysh/pull/2691))

  <details><summary>Details</summary>

  The existing preference now applies to the Android terminal editor when it takes focus.

  </details>
- fix(android): preserve native terminal hardware keyboard right-Alt characters ([#2691](https://github.com/mihazs/lazysh/pull/2691))
- feat(terminal): honor Linux desktop accessibility in the terminal ([#2651](https://github.com/mihazs/lazysh/pull/2651))

  <details><summary>Details</summary>

  When AT-SPI reports accessibility enabled, new sessions use xterm.js with screen-reader announcements on.

  </details>
- fix(terminal): select native terminal words and rows on double and triple click ([#2703](https://github.com/mihazs/lazysh/pull/2703))
- fix(android): keep native keyboard commits ahead of toolbar keys ([#2691](https://github.com/mihazs/lazysh/pull/2691))

  <details><summary>Details</summary>

  Toolbar Enter waits for text already committed by the Android keyboard. An armed Ctrl or Alt modifier applies to that earlier text first.

  </details>
- fix(terminal): respect named keys from remapped and virtual keyboards ([#2717](https://github.com/mihazs/lazysh/pull/2717))
- fix(bench): require a render timing for every short-output burst ([#2603](https://github.com/mihazs/lazysh/pull/2603))
- test(herdr): isolate real integration fixtures on private sockets ([#2660](https://github.com/mihazs/lazysh/pull/2660))
- fix(android): restore inline shell history suggestions with SwiftKey in native terminals ([#2691](https://github.com/mihazs/lazysh/pull/2691))

  <details><summary>Details</summary>

  The native terminal identifies its text field to Android in the same way as the WebView terminal. SwiftKey can send the first typed character to the shell without requiring Private keyboard mode.

  </details>
- fix(android): keep the keyboard from replacing native terminal commands on Enter ([#2691](https://github.com/mihazs/lazysh/pull/2691))

  <details><summary>Details</summary>

  The native terminal now asks Android keyboards to avoid automatically correcting commands. Shell-provided inline history suggestions remain available.

  </details>

## 1.102.1

### Patch Changes

- fix(bench): require complete Android engine comparison measurements ([#2598](https://github.com/mihazs/lazysh/pull/2598))

  <details><summary>Details</summary>

  Incomplete workload pairs cannot produce a passing verdict.

  </details>

## 1.102.0

### Minor Changes

- feat(usage): enable agent background quota collection by default ([#2533](https://github.com/mihazs/lazysh/pull/2533))

  <details><summary>Details</summary>

  Managed companion setup provisions a supported user timer. Hosts can still disable collection or forbid provider quota reads.

  </details>
- feat(agents): show the current Claude Code and Codex goals in Agent View ([#2549](https://github.com/mihazs/lazysh/pull/2549))

  <details><summary>Details</summary>

  The goal and status follow the live session while reading its conversation. Codex also reports its recorded budget and elapsed time.

  </details>

### Patch Changes

- feat(terminal): apply cursor style and blink from the first native frame ([#2527](https://github.com/mihazs/lazysh/pull/2527))

  <details><summary>Details</summary>

  Native sessions keep a program-selected cursor until the program resets it.

  </details>
- test(android): allow WebView rounding in keyboard viewport checks ([#2645](https://github.com/mihazs/lazysh/pull/2645))

  <details><summary>Details</summary>

  The instrumented check accepts numeric jitter at a visible edge and still rejects actual clipping.

  </details>
- feat(terminal): add an opt-in Direct3D 12 terminal surface on Windows ([#2650](https://github.com/mihazs/lazysh/pull/2650))
- docs(readme): add a 40-second walk-through of the app with zoom transitions to the top of the README ([#2513](https://github.com/mihazs/lazysh/pull/2513))
- test(android): verify native SSH output, input and multi-session lifecycle on the emulator ([#2609](https://github.com/mihazs/lazysh/pull/2609))
- test(android): verify native terminal Unicode glyphs stay in their cells ([#2507](https://github.com/mihazs/lazysh/pull/2507))
- test(terminal): isolate the native scrollback budget checks ([#2658](https://github.com/mihazs/lazysh/pull/2658))

  <details><summary>Details</summary>

  The renderer notification test releases its core, and the budget checks count only their own terminal sessions.

  </details>
- test(terminal): verify Android returns new sessions to xterm.js with the native engine disabled ([#2641](https://github.com/mihazs/lazysh/pull/2641))
- test(android): verify the native tmux viewport after clipboard consent ([#2684](https://github.com/mihazs/lazysh/pull/2684))
- fix(bench): measure Android xterm streams through the final render ([#2600](https://github.com/mihazs/lazysh/pull/2600))
- feat(terminal): host native terminal rendering in feature-enabled macOS builds ([#2647](https://github.com/mihazs/lazysh/pull/2647))

  <details><summary>Details</summary>

  The macOS app can attach a Metal renderer beneath WKWebView. Platform acceptance will verify live composition and input before any default change.

  </details>
- fix(android): clear native terminal input after Enter and avoid duplicate preedit text ([#2649](https://github.com/mihazs/lazysh/pull/2649))
- fix(android): hide the native terminal keyboard when scrolling down to the live screen ([#2563](https://github.com/mihazs/lazysh/pull/2563))
- test(desktop): make the singleton directory smoke test submit the correct shell command ([#2640](https://github.com/mihazs/lazysh/pull/2640))
- fix(bench): read Android refresh rate from the active display mode ([#2631](https://github.com/mihazs/lazysh/pull/2631))
- fix(bench): exclude interrupted Android counter windows from engine comparisons ([#2586](https://github.com/mihazs/lazysh/pull/2586))

  <details><summary>Details</summary>

  Guest CPU, idle and frame counters are omitted when a counted process exits during the window. Independent throughput and latency samples remain available.

  </details>
- fix(terminal): keep composer actions visible on compact phones ([#2646](https://github.com/mihazs/lazysh/pull/2646))

  <details><summary>Details</summary>

  The terminal composer wraps its actions when they cannot fit on one row, keeping Send, Insert, and attachment controls inside the screen while the software keyboard is open.

  </details>
- test(terminal): verify the Linux native-engine kill switch in the app ([#2648](https://github.com/mihazs/lazysh/pull/2648))

  <details><summary>Details</summary>

  The release-profile GUI acceptance case checks that the build-time switch disables Native and a real local terminal still uses xterm.js.

  </details>
- test(android): verify rmux SSH fixtures alongside tmux ([#2577](https://github.com/mihazs/lazysh/pull/2577))

  <details><summary>Details</summary>

  Run the owned Android tmux job's host cases against the pinned rmux 0.10.0 release as well as tmux: the owned fixture serves a two-window rmux session, and the SSH detach and reattach, the control-client teardown through the server and the stalled-client retirement are checked for both. The job installs the checksum-verified rmux release for them.

  </details>
- test(android): verify the return from system notification settings ([#2642](https://github.com/mihazs/lazysh/pull/2642))

  <details><summary>Details</summary>

  Android SSH acceptance checks that Back closes system settings, returns to Preferences, and leaves the existing SSH session usable.

  </details>
- fix(ci): run Android native tmux acceptance with its SSH fixture ([#2684](https://github.com/mihazs/lazysh/pull/2684))
- fix(android): keep native terminal keyboard edits on the active input connection ([#2655](https://github.com/mihazs/lazysh/pull/2655))

  <details><summary>Details</summary>

  Keep the keyboard's text snapshot in sync after a batch, reject edits from retired connections, and apply Android's explicit text corrections to the native terminal editor. Backspace stays visible when SwiftKey reopens the last word for composition.

  </details>

## 1.101.5

### Patch Changes

- fix(bench): connect the terminal benchmark to the Android WebView ([#2593](https://github.com/mihazs/lazysh/pull/2593))

  <details><summary>Details</summary>

  The benchmark connects without browser-only defaults and releases its ADB debugger forward when it exits.

  </details>
- fix(terminal): wake the native renderer for output arriving during attachment ([#2623](https://github.com/mihazs/lazysh/pull/2623))
- fix(bench): preserve the Android native idle benchmark result during teardown ([#2632](https://github.com/mihazs/lazysh/pull/2632))

## 1.101.4

### Patch Changes

- test(android): verify rendered xterm SSH echoes through the packaged app ([#2608](https://github.com/mihazs/lazysh/pull/2608))
- fix(android): report Waydroid instrumentation results before app teardown ([#2601](https://github.com/mihazs/lazysh/pull/2601))

## 1.101.3

### Patch Changes

- fix(bench): verify adapter writes in the Android xterm baseline ([#2589](https://github.com/mihazs/lazysh/pull/2589))

  <details><summary>Details</summary>

  The comparison driver now selects the app adapter and rejects results from the direct-write path.

  </details>
- fix(terminal): keep the terminal usable in short landscape windows ([#2551](https://github.com/mihazs/lazysh/pull/2551))

  <details><summary>Details</summary>

  Long session labels stay on one line and the status footer gives its space to the terminal.

  </details>
- fix(android): apply imported fonts in the native terminal ([#2579](https://github.com/mihazs/lazysh/pull/2579))

## 1.101.2

### Patch Changes

- fix(android): start the Google build on ARM64 translated by the Android emulator ([#2583](https://github.com/mihazs/lazysh/pull/2583))

## 1.101.1

### Patch Changes

- fix(android): keep the native terminal active after reconnecting from a recreated Activity ([#2556](https://github.com/mihazs/lazysh/pull/2556))

  <details><summary>Details</summary>

  Fresh native sessions use the replacement renderer's current access lease for surface and keyboard requests.

  </details>

## 1.101.0

### Minor Changes

- feat(settings): consolidate workspace settings shortcuts under Preferences

  <details><summary>Details</summary>

  Open the default multiplexer and remote push settings from Preferences.

  </details>
- feat(agents): soften the Agent View composer with frosted glass ([#2548](https://github.com/mihazs/lazysh/pull/2548))

  <details><summary>Details</summary>

  The message box uses a translucent surface and a quieter border. Higher contrast and reduced transparency use a solid surface.

  </details>
- feat(agents): read Senpi session records

  <details><summary>Details</summary>

  Discover Senpi histories from its agent directory and read their messages and tool results in recorded Chat and Usage.

  </details>

### Patch Changes

- feat(terminal): report custom bold colour support on the native engine
- fix(android): keep native terminal typing working after switching workspace views
- fix(agents): keep agent questions in the conversation flow ([#2572](https://github.com/mihazs/lazysh/pull/2572))

  <details><summary>Details</summary>

  Questions appear in order as a single item in the Agent view, with answer controls and the terminal option together.

  </details>
- fix(terminal): render color emoji from the Android system font in native terminals

## 1.100.3

### Patch Changes

- fix(terminal): open the soft keyboard on the native terminal, let page fields keep it and make the toolbar modifiers work ([#2495](https://github.com/mihazs/lazysh/pull/2495))

  <details><summary>Details</summary>

  On a session using the native terminal engine, the soft keyboard now opens when the terminal takes focus or receives a plain tap (the request waits until Android has made the terminal's keyboard editor the active one), a field of the page (the agent composer, a dialog, the search box) takes the keys instead of the terminal while it has focus, and the terminal gets them back when it asks again. The keyboard editor also tells keyboards such as SwiftKey the text around the caret up front. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  The toolbar's Ctrl, Alt and Shift buttons now work on the native terminal: they apply to the next character the soft keyboard types, as with xterm.js. Every toolbar key writes the same bytes as the xterm.js pane does, alone and under each modifier.

  </details>

## 1.100.2

### Patch Changes

- feat(terminal): the History lines setting reaches a native session that is already open

  <details><summary>Details</summary>

  Changing History lines in Settings now changes how many rows an open native terminal keeps, as it already did for xterm.js. A smaller number drops the oldest rows at once.

  </details>

## 1.100.1

### Patch Changes

- docs(terminal): add the feature parity matrix between the native engine and xterm.js ([#2508](https://github.com/mihazs/lazysh/pull/2508))

  <details><summary>Details</summary>

  Every terminal feature of the app is listed with the test that proves it on the native engine or the issue that closes the gap.

  </details>

## 1.100.0

### Minor Changes

- feat(terminal): Shift-drag selects under mouse tracking and a drag scrolls at the edge on the native engine ([#2510](https://github.com/mihazs/lazysh/pull/2510))

  <details><summary>Details</summary>

  On the native terminal engine, holding Shift while dragging with a mouse now selects text even while a program (tmux, vim) tracks the mouse, and a drag held past the top or bottom of the terminal keeps scrolling and extending the selection, as on xterm.js.

  </details>

## 1.99.0

### Minor Changes

- feat(terminal): the status bar names the terminal engine in use next to xterm-256color ([#2494](https://github.com/mihazs/lazysh/pull/2494))

  <details><summary>Details</summary>

  The bar under the terminal now reads, for example, "Native · xterm-256color" or "xterm.js · xterm-256color", and follows the session when it falls back to xterm.js or you choose "Switch this session to xterm.js". English, Portuguese and Spanish.

  </details>

### Patch Changes

- fix(terminal): the composer's Send and Insert submit and clear the draft on the native engine ([#2497](https://github.com/mihazs/lazysh/pull/2497))

  <details><summary>Details</summary>

  On the native terminal engine, Send pasted the text but never pressed Enter and left the draft in the composer. Send now pastes and presses Enter, Insert pastes, and both clear the draft, as on xterm.js.

  </details>

## 1.98.6

### Patch Changes

- fix(agent): accept Windows profile paths when setting up agent hooks on a Windows device ([#2477](https://github.com/mihazs/lazysh/pull/2477))

  <details><summary>Details</summary>

  Fixes #2473. Hook setup refused every provider profile that was not a POSIX path, so a Windows user who passed an absolute profile such as `C:\Users\me\.claude` or a UNC share got "Select an absolute existing provider profile" before the companion could answer. The profile path is now checked with the rules of the host that reads it: Windows drive and UNC paths on this device when it runs Windows (outside WSL), POSIX paths everywhere else. Device namespaces, `.` and `..` segments, control characters and alternate data streams are still refused, and SSH hosts and Unix devices behave as before.

  </details>

## 1.98.5

### Patch Changes

- docs(readme): show real screenshots and demo clips of the app captured on Waydroid ([#2480](https://github.com/mihazs/lazysh/pull/2480))

## 1.98.4

### Patch Changes

- feat(terminal): draw the fonts you imported in Preferences with the native terminal engine ([#2456](https://github.com/mihazs/lazysh/pull/2456))

  <details><summary>Details</summary>

  A font imported in Preferences, as the terminal font or as the CJK fallback, is now drawn by the native terminal engine as it is by xterm.js: the app receives the font's bytes once, draws with them ahead of the device's fonts, and a CJK font draws only the CJK characters, so Latin text keeps your terminal font. Choosing another font, or removing one, redraws open native sessions. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>

## 1.98.3

### Patch Changes

- feat(terminal): Size a native terminal's columns and rows to its pane, so the remote program draws for the screen it has ([#2458](https://github.com/mihazs/lazysh/pull/2458))

  <details><summary>Details</summary>

  Closes #2397, part of #1327. A native terminal pane, which is opt-in (Settings, Terminal engine), opened at 80 x 24 and stayed there, whatever the pane's size, a rotation, the soft keyboard, a pinch or a font change. It now holds the whole cells its pane fits at the renderer's cell size, asks the transport for that grid (the core and the remote PTY follow) and fits again when the pane, the font size or the display density changes. The new `native_terminal_surface_cell` command answers the renderer's cell so the page and the renderer share one rule. A pane that is not a whole number of cells has a margin at its right and bottom. Mosh's canonical resize on native is still its own slice, and the default engine is unchanged.

  </details>
- docs(readme): describe lazysh as a released app with current platforms and features, not a development preview ([#2470](https://github.com/mihazs/lazysh/pull/2470))
- fix(terminal): say why a native terminal cannot draw and move to xterm.js instead of showing a blank pane ([#2460](https://github.com/mihazs/lazysh/pull/2460))

  <details><summary>Details</summary>

  Part of #2457. On Android the native engine could place its pane and then show nothing, with no sign of why (a renderer that could not draw on the surface left only the pane's background). The shell now reports, with the surface's state, whether the renderer drew on it and the reason when it did not; the page reports that reason and the session moves to xterm.js, as it does for a surface the shell cannot place. Every stage of the renderer's way to a first frame is also written to logcat under the tag `lazysh-native`. The native engine is still opt-in (Settings, Terminal engine).

  </details>
- fix(voice): import a Whisper model on Android, where hard links in app storage are refused ([#2469](https://github.com/mihazs/lazysh/pull/2469))

  <details><summary>Details</summary>

  Fixes #2468. Importing a model published it with an exclusive hard link, which Android's storage policy refuses with "Permission denied", so every import ended with "Cannot publish model; destination may already exist". The link is still tried first; when it is refused for permission, the model is copied into a file created exclusively, so an existing model is still never replaced. The message of any other failure now ends with the system error.

  </details>

## 1.98.2

### Patch Changes

- fix(companion): never run a symbolic link in the managed directory as the local companion on macOS ([#2451](https://github.com/mihazs/lazysh/pull/2451))

  <details><summary>Details</summary>

  Refs #2450. The local companion lookup trusts a managed copy only when it is the user's own file, not a link, writable by nobody else, but it checked the owner and the write bits and never the file type. A link has mode 0777 on Linux, which the write check rejected by accident, and 0755 on macOS, which it accepted, so a link there could make the app run another file as its companion. A link is now refused by its type on every platform. No default changes.

  </details>
- feat(terminal): send mouse clicks, drags and taps to mouse-tracking programs on the native terminal ([#2447](https://github.com/mihazs/lazysh/pull/2447))

  <details><summary>Details</summary>

  On a session using the native terminal engine, a program that tracks the mouse (for example `vim` or `htop` with mouse mode) now receives a mouse's button presses, drag motion and releases, and a finger's quick tap as clicks, in addition to wheel scrolling. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>

## 1.98.1

### Patch Changes

- feat(terminal): Draw a native terminal with the user's theme, font, bold colours and cursor, and change them live ([#2395](https://github.com/mihazs/lazysh/pull/2395))

  <details><summary>Details</summary>

  Closes #2380, part of #1327. A native terminal pane, which is opt-in (Settings, Terminal engine), now follows Settings: the theme and palette, the font family and size (a pinch included), bold text in the bright colours or a custom bold colour, and the cursor's style and blink reach its renderer when they change, instead of the fixed 14 px monospace in the default theme. The new `native_terminal_surface_look` command carries them. A program that sets its own cursor (vim's block in normal mode) keeps it until it gives it back, as under xterm.js. The grid does not follow the pane's size yet, and imported fonts are not drawn. The default engine is unchanged.

  </details>

## 1.98.0

### Minor Changes

- feat(files): play video and audio in an isolated frame ([#1892](https://github.com/mihazs/lazysh/pull/1892))

  <details><summary>Details</summary>

  Files now plays video and audio in a frame with no script rights and no access to the app or its native bridge. The native reader checks the file's type from its first bytes and refuses a mislabeled, oversized (over 8 MiB) or linked file. A PDF is opened in the device's PDF viewer instead of drawn in the app. On Linux the preview needs GStreamer's audio plugins and says so when they are missing. Changed default: the content security policy allows `data:` in `media-src`.

  </details>
- feat(rmux): discover, attach and use rmux sessions with the tmux tools ([#1863](https://github.com/mihazs/lazysh/pull/1863))

  <details><summary>Details</summary>

  Sessions lists rmux next to tmux, Herdr and Zellij, browses a labelled rmux server (tree, new session, rename, windows, panes, split, zoom), attaches it as a terminal, restores it and opens it from `--mux rmux[:LABEL]`. rmux is admitted from `rmux capabilities --json` and probed with `-N`, so discovery never starts a daemon; it is Limited until Jump To and confirmed Chat input are verified on a real rmux. No defaults changed: tmux commands, defaults and saved workspaces are unchanged.

  </details>
- feat(herdr): follow a Herdr server live and send blocked or done agents to the inbox ([#1876](https://github.com/mihazs/lazysh/pull/1876))

  <details><summary>Details</summary>

  Read a Herdr server's changes from the host companion's `herdr-events` stream while a Herdr view is shown, instead of every 5 seconds, with a polling fallback and a note saying which mode is active (English, Portuguese, Spanish), and turn a Herdr agent that becomes blocked or done into an inbox event with the Herdr pane identity and no command text, deduplicated against the same transition reported by a hook.

  </details>

### Patch Changes

- test(android): drive the Share dialog against a real share service over TLS ([#1920](https://github.com/mihazs/lazysh/pull/1920))

  <details><summary>Details</summary>

  An owned Android runtime case for the optional sharing service (#994, #1738): through the real Share dialog it saves the service origin and management token, uploads an image, lists it in the history, loads and decodes its thumbnail, copies its expiring link and deletes it behind the native confirmation, while the host serves the repository's own `lazysh-share` binary over TLS behind a throwaway root and checks the service's stored bytes, the link and the deletion after each step. Debug builds of the app gain one test-only trust anchor, read from the `LAZYSH_TEST_SHARE_ROOT_PEM` environment variable; release builds compile it out and trust the public roots only, so shipped behaviour is unchanged.

  </details>
- fix(rmux): start sessions, windows and panes in a directory whose name has format or style markers ([#1863](https://github.com/mihazs/lazysh/pull/1863))

  <details><summary>Details</summary>

  The path is encoded as a literal rmux format. tmux behavior and defaults are unchanged.

  </details>
- ci(windows): run the tmux, Zellij and Herdr cases from a Windows client against a Linux host ([#1935](https://github.com/mihazs/lazysh/pull/1935))

  <details><summary>Details</summary>

  Refs #1747, part of #1138. The new `native-windows-linux-host` job (pushes to `main` only, non-blocking until its first `main` pass) starts an Ubuntu WSL 2 host on windows-latest with an unprivileged OpenSSH server, tmux, the pinned Zellij 0.45.1 and the same-run stock Herdr, and runs four external-host cases of the Rust client natively on Windows: version and support discovery, and, per multiplexer, attach, tree and actions. The cases take the host from `LAZYSH_TEST_EXTERNAL_SSH_*` environment variables, so they also run on Linux against `.github/scripts/external-linux-host.sh`. Test and CI only; no defaults change.

  </details>

## 1.97.11

### Patch Changes

- fix(terminal): redraw a native terminal's surface after a scroll or resize ([#2406](https://github.com/mihazs/lazysh/pull/2406))

  <details><summary>Details</summary>

  Part of #1327. The native engine's renderer was only woken by output from the program, so scrolling a native terminal back through its history, returning to the bottom or changing its grid moved the core's viewport but left the drawn surface as it was until the program printed again. A scroll or resize a reader asks for now wakes the renderer like a screen change does. The native engine is still opt-in (Settings, Terminal engine).

  </details>
- feat(terminal): paste into a native terminal session on Android from the keyboard or a hardware keyboard ([#2403](https://github.com/mihazs/lazysh/pull/2403))

  <details><summary>Details</summary>

  On a session using the native terminal engine, the keyboard's clipboard strip, Shift+Insert and Ctrl+Shift+V now paste the clipboard as one paste, so a program that enabled bracketed paste receives it as such, instead of the text arriving as typed. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>

## 1.97.10

### Patch Changes

- fix(tmux): stop Jump To and Chat input from crashing your tmux server when another client connects ([#2398](https://github.com/mihazs/lazysh/pull/2398))

  <details><summary>Details</summary>

  tmux 3.4 to 3.7c kill the whole server (SIGSEGV, every session lost) when a format walks the clients while a new client has connected but not yet sent its terminal name, and the guards behind Jump To, the display admission and Chat input walked them. The guards now read a client's terminal only after tmux reports that client's session and process, so a command run from another terminal at the same moment no longer takes the server down.

  </details>
- fix(android): stop the app freezing when the screen is recreated ([#2420](https://github.com/mihazs/lazysh/pull/2420))

  <details><summary>Details</summary>

  Rotating the device or changing the theme could hang the app with an "not responding" dialog while the web view still had queued updates. The queue between the app and the web view no longer has a size limit that the main thread could wait on forever.

  </details>
- feat(android): Keep the native terminal engine off while TalkBack or another screen reader is on ([#2392](https://github.com/mihazs/lazysh/pull/2392))

  <details><summary>Details</summary>

  Part of #1329. A new terminal session on Android uses xterm.js, and Settings shows Native as turned off with the reason, while Android reports a screen reader: touch exploration (TalkBack) or an enabled service that speaks or brailles the screen. This used to depend on the in-app Screen reader announcements preference alone. Settings asks again when you return to the app. A session that is already open keeps its engine. Only an explicit Native choice reaches the native engine today, so nothing changes for Auto or xterm.js.

  </details>

## 1.97.9

### Patch Changes

- feat(terminal): open links with a tap on the native terminal engine ([#2393](https://github.com/mihazs/lazysh/pull/2393))

  <details><summary>Details</summary>

  A tap or click on a URL, an OSC 8 hyperlink or a file path in the native terminal engine now asks the engine what is under it and opens it through the same confirmation as xterm.js: a web address is offered to Open or Copy, and a path is opened only when the host confirms the file. A hold still selects, a drag still scrolls or selects, and a program that tracks the mouse keeps its clicks. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>
- feat(terminal): Start on xterm.js when a native session cannot start, and move a native session to xterm.js ([#2386](https://github.com/mihazs/lazysh/pull/2386))

  <details><summary>Details</summary>

  Part of #1342 and #2092. Only an explicit Native choice reaches the native engine today, and nothing changes for Auto or xterm.js. A native session that fails to start now begins on xterm.js and the engine line says why; the failure is remembered on the device, so Auto keeps away from the native engine until lazysh is updated, and choosing Native in Settings tries it again. A native session has a new Workspace tools action, "Switch this session to xterm.js", which carries the screen, cursor and modes over (scrollback is not carried over); a session whose surface cannot be placed switches on its own.

  Not tried on an Android device.

  </details>
- fix(ssh): recover the host-tools connection of Mosh and Eternal Terminal sessions automatically ([#2013](https://github.com/mihazs/lazysh/pull/2013))

  <details><summary>Details</summary>

  Active Mosh and Eternal Terminal sessions now restore their command-only SSH connection when it closes, without replaying interrupted commands. This changes the default recovery behavior; jump hosts, agent forwarding, biometric and unsaved credentials still need manual recovery.

  </details>
- test(ime): commit CJK through a real IBus into the WebKitGTK terminal and the Chat composer ([#1919](https://github.com/mihazs/lazysh/pull/1919))

  <details><summary>Details</summary>

  Add a Linux native GUI case for desktop input methods (#1734, slice 3 of #982): an owned IBus daemon with its Pinyin engine runs under the owned Xvfb display, real X key events type `nihao` and Space into the WebKitGTK terminal, and the owned SSH receiver must hold exactly the committed `你好` bytes once. The same input method then fills the Chat composer draft. The Linux GUI job installs `ibus`, `ibus-gtk3`, `ibus-libpinyin` and `xdotool`. Test infrastructure only; the app is unchanged.

  </details>

## 1.97.8

### Patch Changes

- feat(terminal): let the Android WebView show a native terminal's surface while one is placed ([#2384](https://github.com/mihazs/lazysh/pull/2384))

  <details><summary>Details</summary>

  Part of #1327. On Android the native terminal draws on a surface below the WebView, which painted its own opaque background over it. The WebView is now transparent while at least one native pane is placed and opaque again when none is, so a native pane's surface shows through where the page paints nothing and the page's overlays stay above it. An xterm.js session never places a surface, so nothing changes for it. The native engine is still opt-in (Settings, Terminal engine) and Auto never selects it.

  </details>

## 1.97.7

### Patch Changes

- fix(voice): release the local Parakeet cache lock when its owner closes ([#2012](https://github.com/mihazs/lazysh/pull/2012))

  <details><summary>Details</summary>

  A child process that inherited the lock's descriptor no longer keeps the cache unavailable after its owner exits (#2009).

  </details>
- fix(hooks): read the companion store for hook readiness without creating, changing or deleting its files ([#1944](https://github.com/mihazs/lazysh/pull/1944))

  <details><summary>Details</summary>

  `lazysh-agent hooks status` now opens the event store through a read-only SQLite file system layer, so a status read can no longer create the write-ahead index or delete the log of an empty database, even if another process removes a file while it reads. An unreadable store still reports `notChecked`.

  </details>
- fix(ios): answer a slow Simulator boot, shutdown or reboot as requested instead of DeviceTimeout ([#2002](https://github.com/mihazs/lazysh/pull/2002))

  <details><summary>Details</summary>

  Answer an iOS Simulator boot, shutdown or reboot that `simctl` is still carrying out after ten seconds as requested instead of `DeviceTimeout`, report a reboot whose shutdown is still running as `shutting_down`, report slow iOS discovery as a warning after one retry, and show a note for each answer in the Devices panel. Changed response shape: an iOS reboot can answer `status: "shutting_down"`.

  </details>
- feat(terminal): Report a terminal problem from Settings, the Workspace tools engine line and the engine notice ([#2389](https://github.com/mihazs/lazysh/pull/2389))

  <details><summary>Details</summary>

  Part of #2092. A new "Report a terminal problem" action opens the lazysh issue form in your browser, prefilled with the terminal engine, your Settings choice, the reasons the app recorded for them and the app version. lazysh sends nothing itself: the browser opens the page and you decide whether to submit. Available in English, Portuguese and Spanish.

  </details>

## 1.97.6

### Patch Changes

- feat(terminal): run a Mosh session on the native terminal engine and let the server decide its size ([#2391](https://github.com/mihazs/lazysh/pull/2391))

  <details><summary>Details</summary>

  A Mosh session on the native terminal engine now follows the server's display frames, so the grid is the size Mosh reports and the size of your pane is a request to the server, as on xterm.js. Before this, a Mosh session could not start on the native engine and Auto fell back to SSH. A frame the engine cannot apply ends the session instead of drawing a wrong screen. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>

## 1.97.5

### Patch Changes

- feat(terminal): clear the selection when you type on the native terminal ([#2375](https://github.com/mihazs/lazysh/pull/2375))

  <details><summary>Details</summary>

  On a session using the native terminal engine, typing, pasting or pressing a key now clears the selection, as it does with xterm.js. The selection handles and the Copy and Select all actions work over the native engine the same way. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>

## 1.97.4

### Patch Changes

- feat(terminal): Hand a native terminal session's transport back to the WebView without losing bytes ([#2229](https://github.com/mihazs/lazysh/pull/2229))

  <details><summary>Details</summary>

  Part of #1342. With the optional `native-terminal` feature the app has two new commands: `terminal_core_ansi_snapshot` answers with the visible screen, cursor and modes of a native session as bytes a fresh terminal replays, and `terminal_core_release` re-routes the session's output to a new WebView Channel at a chunk boundary and answers with that snapshot, so every byte is applied once and in order. Scrollback is not carried over. Nothing calls the commands yet, so terminal behaviour and defaults do not change.

  </details>

## 1.97.3

No changes in this release.

## 1.97.2

### Patch Changes

- feat(terminal): send wheel reports to mouse-tracking programs on the native terminal ([#2370](https://github.com/mihazs/lazysh/pull/2370))

  <details><summary>Details</summary>

  A finger or wheel scroll over a program that tracks the mouse (for example `less` or `vim` with mouse mode) now sends it wheel reports from the native terminal engine instead of doing nothing, as xterm.js does. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>

## 1.97.1

### Patch Changes

- fix(herdr): choosing a space, tab or agent waits for a terminal input already in progress ([#2338](https://github.com/mihazs/lazysh/pull/2338))

  <details><summary>Details</summary>

  Tapping a row in the Herdr Spaces or Agents list while a terminal input was being delivered failed with "Herdr terminal input is already in progress" and the focus did not move. The change now waits for that input to finish (up to 10 s) before moving the view; a turn that never ends still reports the busy message.

  </details>
- feat(terminal): type into a native terminal session on Android ([#2339](https://github.com/mihazs/lazysh/pull/2339))

  <details><summary>Details</summary>

  On a build where the native terminal engine is selected, the Android keyboard's editor is created with the session's surface: committed text, special keys and modifiers reach the core once and in order, and the text an input method is still composing is drawn at the cursor until it is committed. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

  </details>

## 1.97.0

### Minor Changes

- feat(usage): let a host forbid account quota reads ([#1823](https://github.com/mihazs/lazysh/pull/1823))

  <details><summary>Details</summary>

  Let a host forbid account quota reads (#1588, slice of #18). `lazysh-agent usage-collection show` and `usage-collection update --expected-revision R --account-quota-enabled true|false` read and change a new `usage-collection.json` policy beside `settings.json`. With the switch off, `lazysh-agent account-usage` answers a new `disabled` state with no report before it opens a credential, starts a helper or contacts a provider, and the app shows that the host does not allow account usage reads, in English, Portuguese and Spanish, with no percentage. The default is on, so nothing changes for existing hosts; an unreadable policy fails the read closed.

  </details>
- feat(android): native terminal engine selectable in release builds ([#2353](https://github.com/mihazs/lazysh/pull/2353))

  <details><summary>Details</summary>

  Release builds no longer refuse the native terminal surface: Settings > Terminal engine can select Native when the device probe passes. Auto still uses xterm.js, so the default terminal is unchanged, and a build made with `LAZYSH_NATIVE_TERMINAL=off` still refuses it.

  </details>
- feat(notifications): receive remote agent-attention notifications on the desktop ([#1811](https://github.com/mihazs/lazysh/pull/1811))

  <details><summary>Details</summary>

  Receive the relay's remote needs-attention events on the desktop app, from your own Gotify server: an opt-in receiver in Preferences that shows one generic desktop notification per new event while the app runs, with pause and removal.

  </details>
- feat(onboarding): add an animated tour that explains the session gestures on phones ([#1802](https://github.com/mihazs/lazysh/pull/1802))

  <details><summary>Details</summary>

  The first time you open a connected session on a phone, a short tour opens with one step for each edge swipe (the left edge opens the side menu, the bottom edge opens the bottom menu, the right edge switches to the Agent view of a remote session and back) and one for the rule that swipes stay off while you type or edit text, with **Skip**, **Next**, **Done** and progress dots. It is drawn with CSS and SVG, with no video or image file, and loads on first use.

  It opens once per device and again only when a later version changes a gesture, waits while you type, never delays connecting, and never opens on desktop, on the connection list, over another dialog, in screen-reader mode or when every swipe is switched off. A step for a swipe you switched off, or for the side menu while the top bar is on, says where to change that. The steps describe the shipped gestures: the side menu is the full-screen page that does not resize the terminal, Back closes it and the bottom menu, and each working step says how deep the strip is that the swipe starts in (**Swipe zone width**, 40 dp by default, 16 to 96 dp).

  Replay it from **Preferences → Gestures** (under Help, with the same text as plain captions) or **Gesture tour** on the **Connections** tab of the side menu. With reduce motion on, it shows still pictures with an arrow for each swipe. It follows your **Gesture style**: with the handles of Android gesture navigation the finger starts at the handle, and **Gesture style: Off** counts as every swipe switched off. Available in English, Brazilian Portuguese and Spanish. No defaults change.

  </details>
- feat(agents): answer OpenCode permissions and questions through its local service ([#1841](https://github.com/mihazs/lazysh/pull/1841))

  <details><summary>Details</summary>

  Answer OpenCode permission requests and question forms, and stop a turn, from the Agent view through OpenCode's local background service, with the exact request checked again before every answer.

  </details>
- feat(devices): show Devices in a local session for the Android SDK on this computer ([#1858](https://github.com/mihazs/lazysh/pull/1858))

  <details><summary>Details</summary>

  Show Devices in a local session when an Android SDK `adb` (or, on macOS, `xcrun`) is found on this computer. The device commands and the Android and iOS video preview run the host companion as argv on this device, without SSH or a shell, and stop it and the tools it started when the preview stops, the session closes or the app locks. SSH sessions and defaults are unchanged.

  </details>
- feat(usage): add host switches for simulator streaming and port scanning in their own host-features.json ([#1813](https://github.com/mihazs/lazysh/pull/1813))

  <details><summary>Details</summary>

  Add host feature switches in their own `host-features.json`: `lazysh-agent settings features show|update` controls whether `devices ... stream` is allowed (it fails with `SimulatorStreamingDisabled` before any SDK process) and whether the app's port scanning is allowed; the Preview panel reads the port-scan switch before every discovery and says when the host turned it off, and Host companion settings offers both switches with a conflict-safe save. `settings.json` is unchanged, so an older companion keeps working. Changed default: the Preview panel now remembers the HTTP check and the automatic refresh for each saved host instead of resetting them on every visit.

  </details>
- feat(usage): show the host usage collector on the usage page ([#1823](https://github.com/mihazs/lazysh/pull/1823))

  <details><summary>Details</summary>

  Show the host's background usage collector on the usage page of a remote session (#1588): whether it is on, its timer, the last run and the age of every recorded sample against the host's clock, with unknown and stale labels, in English, Portuguese and Spanish. Read only; an older companion shows an update message.

  </details>

### Patch Changes

- feat(agents): let the Agent view take the whole window, with one tap back ([#2325](https://github.com/mihazs/lazysh/pull/2325))

  <details><summary>Details</summary>

  A new Full window option in the Agent view options menu hides the app header, session tabs and footer so the conversation and composer fill the screen, below the status bar and above the navigation bar. The terminal keeps running underneath. The choice is remembered on this device, and Back leaves full window before it leaves the Agent view.

  </details>
- ci(android): keep the app's thread dump and ANR traces and the tmux server's own log for a failed Android run ([#2346](https://github.com/mihazs/lazysh/pull/2346))

  <details><summary>Details</summary>

  A blocked case or a tmux server that exits uncleanly left no trace of where it stopped. A failed run now captures the app's thread dump and ANR traces into the system diagnostics, and the tmux fixture's server logs into the tmux results. CI only. No user-visible behaviour changes.

  </details>
- test(android): wait until the staged QR fixture's MediaStore row stops changing before the picker opens ([#2342](https://github.com/mihazs/lazysh/pull/2342))

  <details><summary>Details</summary>

  The QR picker case failed intermittently with "The QR image could not be decoded": the page's own read of the chosen file rejected with NotReadableError, which Chromium raises when a file's size or modification time changed after it was chosen, and MediaProvider rewrites a published file's row after it leaves pending. The case now waits for the row to stay unchanged first, and a failure still reports the page's read and decode outcomes. Test only. No user-visible behaviour changes.

  A case that blocks now fails after 7 minutes (runner argument `timeout_msec`, was 15), because once one case wedges the app every later case waits out its own limit.

  If the page's read of the chosen image is refused once with NotReadableError, which Chromium raises when the file changed after it was chosen, the case chooses the image again once and still requires the decoded preview.

  </details>

## 1.96.0

### Minor Changes

- feat(multiplexers): close, rename and resize tmux panes and close sessions from the Workspaces panel ([#1990](https://github.com/mihazs/lazysh/pull/1990))

  <details><summary>Details</summary>

  Each pane row shows its size and title and gains Rename, four divider arrows and Close, and each session gains Close session. Closing asks first with a confirmation that names the pane or session and sends one exact-id command only when confirmed. tmux reuses `$0` and `%0` after a server restart, so these four actions carry the identity of the tmux server the list was read from and tmux refuses them on a replaced server instead of acting on its same-numbered pane (#2044). No defaults change.

  </details>
- feat: Show Codex's permission requests in the Agent view dock on tmux ([#1965](https://github.com/mihazs/lazysh/pull/1965))

  <details><summary>Details</summary>

  The dock lists a `PermissionRequest` hook request of the Codex agent in the pane, for the session and pane its report names, and answers it with Allow, Deny or Deny with a message, re-checking the agent, session and pane right before the decision is sent. A Codex request lists no suggested permission updates. Nothing changes unless the Codex approval hook fragment is installed.

  </details>
- feat(zellij): reattach saved Zellij sessions on reconnect and restore without creating or resurrecting them ([#1978](https://github.com/mihazs/lazysh/pull/1978))

  <details><summary>Details</summary>

  Changed default: a lost Zellij tab now reconnects to the same session and **Restore previous workspace** reopens saved Zellij sessions, as it does for tmux and Herdr (#1145, part of #1138); before, restore skipped Zellij and a reconnect gave a plain host shell. The reattach runs `zellij attach <name>` without `--create` after the full session listing shows the name with a running server, so a session that no longer exists (a host restart, a kill) or that is only a serialized exited session fails with a message instead of starting an empty or resurrected one (#2047). Zellij has no attach that refuses to resurrect, so a session that exits between the listing and the attach can still be resurrected. Attaching from Sessions still creates a new session.

  </details>
- feat(zellij): Jump To lists the tabs of the attached session with one current row ([#1980](https://github.com/mihazs/lazysh/pull/1980))

  <details><summary>Details</summary>

  A terminal attached to a Zellij 0.45.1 session now offers **Jump To** with the session's tabs, numbered from 1; choosing a tab switches to it by its stable id (`go-to-tab-by-id`), in the same list, accordion and grid layouts as tmux (#1145, part of #1138). Zellij cannot address a client from the command line, so exactly one **Current** row shows and a jump is allowed only while this terminal is the one client attached to the session (#2046); with another client attached the tabs are listed without a current row and without a jump, because the jump could move that client instead. Zellij 0.44.x, which the version gate marks without the `tree` capability, shows no Jump To. Panes are not destinations.

  </details>

### Patch Changes

- feat(agents): switch between live agents from the Agent view header in one tap ([#2324](https://github.com/mihazs/lazysh/pull/2324))

  <details><summary>Details</summary>

  Under Herdr the Agent view header shows the current agent with its status and opens a list of the live agents with their state. One tap, or Ctrl/Cmd+Shift+L, switches: the terminal follows that agent's pane and its composer shows.

  </details>
- build: Build libghostty-vt against the iPhoneOS and iPhoneSimulator SDKs and test the terminal core for iOS in a… ([#2139](https://github.com/mihazs/lazysh/pull/2139))

  <details><summary>Details</summary>

  Build libghostty-vt against the iPhoneOS and iPhoneSimulator SDKs and test the terminal core for iOS in a new report-only `terminal-ios` CI job on pushes to `main`: the runtime's tests are linked for `aarch64-apple-ios` and every test runs inside a booted iOS simulator for `aarch64-apple-ios-sim`, so a break that only shows on iOS no longer waits for a native surface to be written. The core is not wired into the app yet: no behaviour changes for users.

  </details>
- feat(android): draw the native session on the surface host through a JNI renderer client ([#2275](https://github.com/mihazs/lazysh/pull/2275))

  <details><summary>Details</summary>

  The Android surface host now hands each surface to the Rust renderer host through JNI, which draws the session's native core with wgpu and re-attaches it from a snapshot after stop and start, falling back to the pane background when it cannot draw. Only builds with the native terminal feature have the renderer; nothing selects the native engine yet, so terminal behaviour and defaults do not change.

  </details>
- refactor(terminal): reuse one native surface look for the Linux and Android hosts ([#2356](https://github.com/mihazs/lazysh/pull/2356))

  <details><summary>Details</summary>

  The Linux surface host and the platform-neutral pane bookkeeping each built the same font and theme; both now use one function. No behaviour change.

  </details>
- feat(browser): add the address bar, tab list and navigation controls to the host browser prototype ([#1993](https://github.com/mihazs/lazysh/pull/1993))

  <details><summary>Details</summary>

  Add the host browser's address bar, tab list, back, forward, reload and stop, page dialogs and denied-download and file-chooser notices as client components, driven in the developer-only prototype viewer and covered by a real-Chromium test. Typed addresses open only `http`, `https` and `about:blank`; the controls are not in the app until the host browser view ships and change no default.

  </details>

## 1.95.7

### Patch Changes

- feat(terminal): run a session on the native data path when the registry picks native ([#2274](https://github.com/mihazs/lazysh/pull/2274))

  <details><summary>Details</summary>

  When the terminal engine registry selects native, the session's transport (SSH, Eternal Terminal, multiplexer attach or local terminal) now starts on the native core's own channel, so its output is parsed in Rust and never passes through JavaScript, no output credit is returned from the WebView, and closing the session closes the core. A Mosh session is not supported on native yet. Native stays off by default (it is never picked automatically), so nothing changes unless Settings, Terminal engine is set to Native on a build that has the core.

  </details>
- build(android): compile and package the native terminal engine in the Google release APK ([#2317](https://github.com/mihazs/lazysh/pull/2317))

  <details><summary>Details</summary>

  The Google arm64 release APK is now built with the `native-terminal` feature, so the native terminal engine (libghostty-vt and the wgpu renderer) ships inside it. Nothing changes for users yet: release builds still refuse the native surface and Auto keeps using xterm.js, so the default terminal is the same.

  </details>

## 1.95.6

### Patch Changes

- test(android): retry the Zellij fixture's tab readback when the command fails ([#2320](https://github.com/mihazs/lazysh/pull/2320))

  <details><summary>Details</summary>

  The first readback after the session starts could exit 1 under load and fail the whole case. A failing command is now retried like an unreadable answer; one that keeps failing still surfaces its own error. Test only. No user-visible behaviour changes.

  </details>

## 1.95.5

### Patch Changes

- fix(agents): choosing another agent in the Agent view now focuses its terminal pane and shows its composer ([#2301](https://github.com/mihazs/lazysh/pull/2301))

  <details><summary>Details</summary>

  Switching agent from the Agent view's live list moves the Herdr focus to that agent's pane, so the terminal follows and the composer for the newly shown agent appears instead of "Not this pane". Picking an agent or session in the left menu while the Agent view is shown keeps the Agent view open.

  </details>

## 1.95.4

### Patch Changes

- build(ci): provision Zig and the Ghostty archives through one composite action ([#2307](https://github.com/mihazs/lazysh/pull/2307))

  <details><summary>Details</summary>

  The checksum-verified Zig 0.16.0 and the admitted libghostty-vt archives are set up by a single `ghostty-zig` composite action instead of copied workflow steps, so the Android release build can use the same provisioning. CI behaviour is unchanged and nothing changes for users.

  </details>

## 1.95.3

### Patch Changes

- test(android): collapse the notification shade and system dialogs before a case and when the window loses focus ([#2310](https://github.com/mihazs/lazysh/pull/2310))

  <details><summary>Details</summary>

  Back sent while the notification shade was still expanding left it open, so the app window never regained focus and every later owned SSH case failed with "Native workspace not ready". The cases now collapse the shade through the shell. Test only. No user-visible behaviour changes.

  An instrumented case that blocks now fails after 15 minutes (runner argument `timeout_msec`) instead of holding the job until its 75 minute limit.

  </details>

## 1.95.2

### Patch Changes

- feat(terminal): add a build-time kill switch that keeps every session on xterm.js ([#2154](https://github.com/mihazs/lazysh/pull/2154))

  <details><summary>Details</summary>

  A build made with `LAZYSH_NATIVE_TERMINAL=off` (read by the client build and by the Tauri build script, so one variable sets both) never selects, probes or creates the native backend whatever the saved engine choice or the developer override says, records `disabled in this build` as the reason with its translation in English, Brazilian Portuguese and Spanish, leaves Native out of the list the Settings choice will show, and leaves the native core out of the app even when it is compiled in. Any other value than `on` or `off` fails the build. Part of #1342 and #1302. No default changes: release builds do not set the variable, so nothing changes for users.

  </details>

## 1.95.1

### Patch Changes

- test(android): make the QR fixture the only image the Photo Picker can list ([#2305](https://github.com/mihazs/lazysh/pull/2305))

  <details><summary>Details</summary>

  The Photo Picker's order put another image first on most runs, so the QR case failed to decode it. The case now removes the other indexed images before staging its fixture. Test only. No user-visible behaviour changes.

  </details>

## 1.95.0

### Minor Changes

- feat(terminal): hide the gesture indicator lines by default and add a setting to show them ([#2303](https://github.com/mihazs/lazysh/pull/2303))

  <details><summary>Details</summary>

  The thin lines that mark the edge-gesture handles are now hidden. The handles and gestures work as before; turn on Settings > Input > Terminal touch gestures > Show gesture lines to draw them again.

  </details>

### Patch Changes

- fix(terminal): Long-press a URL selects and copies the whole address, however it wraps ([#2295](https://github.com/mihazs/lazysh/pull/2295))

  <details><summary>Details</summary>

  A URL that wraps over several terminal rows, or that an agent prints hard-wrapped inside a box, was copied cut at the row end or with line breaks, borders and spaces in it, so the pasted address was broken. Long-pressing any part of a URL now selects all of it and Copy puts exactly the URL on the clipboard.

  </details>

## 1.94.0

### Minor Changes

- feat(multiplexers): read the pane's scrollback from tmux, Zellij and Herdr in the Sessions panel ([#1994](https://github.com/mihazs/lazysh/pull/1994))

  <details><summary>Details</summary>

  Read the scrollback of the pane you are viewing from the multiplexer on the host. A new **Pane history** section in the Sessions panel of an attached tmux, Zellij or Herdr terminal fetches the history from the multiplexer itself (tmux `capture-pane`, Zellij `dump-screen --full`, Herdr `pane read`), so it no longer depends on the terminal's own buffer or on tmux copy mode, and shows it read-only with a line search and **Copy these lines**. It keeps the newest 20,000 lines or 2 MiB and says when older output was left out; Herdr serves at most its newest 1,000 lines. New command `multiplexer_history`; the capability record's `history` entry is missing for Zellij older than 0.45 and for Herdr outside 0.9.3 to 0.9.5. No defaults change.

  </details>

## 1.93.9

### Patch Changes

- feat(terminal): select text with the pointer on the native terminal adapter ([#2291](https://github.com/mihazs/lazysh/pull/2291))

  <details><summary>Details</summary>

  A mouse drag, a double click (word), a triple click (line), shift-click and a touch long press now select on the native adapter's anchor. The native engine stays opt-in; xterm.js remains the default.

  </details>

## 1.93.8

### Patch Changes

- test(android): pick the QR fixture first in the Photo Picker and tap the Chat composer where it is not covered ([#2286](https://github.com/mihazs/lazysh/pull/2286))

  <details><summary>Details</summary>

  The QR picker case could choose another image, so the page failed to decode it, and the Chat composer CJK step tapped the centre of a composer that the phone's key bar covered. Test only. No user-visible behaviour changes.

  </details>

## 1.93.7

### Patch Changes

- fix(zellij): list no sessions as an empty list instead of a command error ([#1979](https://github.com/mihazs/lazysh/pull/1979))

  <details><summary>Details</summary>

  Fix **Sessions** showing a command error for a host that has Zellij but no session (#1145). Zellij prints "No active zellij sessions found." and exits 1 when none is left, which lazysh read as a failure; the list now says "No running zellij sessions." and offers to create one. The same listing, which also names exited sessions Zellij can resurrect, is used before a saved Zellij entry attaches. Any other failure, such as Zellij missing from the host, is still an error.

  </details>

## 1.93.6

### Patch Changes

- test(android): read the system clipboard after Copy of a terminal selection ([#1989](https://github.com/mihazs/lazysh/pull/1989))

  <details><summary>Details</summary>

  Add an Android instrumentation case that long-presses a word in an owned SSH terminal, taps Copy in the selection actions and reads the system `ClipboardManager`, which must hold exactly that word and must not hold it before Copy. Test coverage only; no app behaviour changes.

  </details>

## 1.93.5

### Patch Changes

- feat(terminal): Take the word under a touch and select all from the native core ([#2287](https://github.com/mihazs/lazysh/pull/2287))

  <details><summary>Details</summary>

  Part of #1334. The native adapter asks the core for the word under a cell and for the whole buffer, so a double tap or Select all covers wrapped lines, wide characters and scrollback outside the adapter's window of rows. No released build can select the native engine, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.

  </details>

## 1.93.4

### Patch Changes

- test(android): prove the stock Herdr display restores only on click after a force-stop and relaunch ([#1976](https://github.com/mihazs/lazysh/pull/1976))

  <details><summary>Details</summary>

  Verify through the real Android app that a force-stopped and relaunched app offers "Restore previous workspace" only on click and then reattaches the same stock Herdr display with the saved credential. The owned stock Herdr job runs it as two instrumentation processes with a host force-stop between them and checks the receiver's bytes are the ones typed before it.

  </details>
- test(android): prove the tmux pane restores only on click after a force-stop and relaunch ([#1976](https://github.com/mihazs/lazysh/pull/1976))

  <details><summary>Details</summary>

  Verify through the real Android app that a force-stopped and relaunched app offers "Restore previous workspace" only on click and then reattaches the same tmux pane with the saved credential. The owned tmux job runs it as two instrumentation processes with a host force-stop between them.

  </details>

## 1.93.3

### Patch Changes

- fix(agent-view): keep Send, Stage and Stop usable while a touch keyboard holds an open composition ([#1982](https://github.com/mihazs/lazysh/pull/1982))

  <details><summary>Details</summary>

  Fix the Agent view's Send and Stop buttons staying disabled while a touch keyboard keeps the last word of the draft as an open composition (#1840). Seen on an Android 13 WebView (Waydroid, LatinIME) in 3 of about 12 runs: after a paste the field got `compositionstart` and `compositionupdate` but never `compositionend`, so both buttons were disabled with the draft intact and no message. The buttons now stay enabled; tapping Send, Stage in terminal or Stop first leaves the field, which ends the composition as a tap elsewhere does, then acts on the committed draft once. Enter on a hardware keyboard is still ignored while composing. Not yet checked on a physical phone with Gboard or SwiftKey, so #1840 stays open for that check; no defaults change.

  </details>

## 1.93.2

### Patch Changes

- feat(terminal): Serve selection text, search, word and line lookups from the native core and draw the selection ([#2228](https://github.com/mihazs/lazysh/pull/2228))

  <details><summary>Details</summary>

  Part of #1320 and #1302. The app has a command for each question about a native terminal's text (selected text, search, the word at a cell, the line at a row, the whole buffer and the screen) and one that hands the selection to the session, where the renderer host draws its visible part. The native adapter asks the core for the selected text and for the find box's search, so both cover the whole scrollback, wrapped lines and wide characters; OSC 52 writes reach the consent panel through the core's policy with the same 64 KiB bound. No released build can select the native engine, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.

  </details>

## 1.93.1

### Patch Changes

- test(terminal): run the native core test on Waydroid with an owned SSH fixture, thaw the guest and record failure details ([#2282](https://github.com/mihazs/lazysh/pull/2282))

## 1.93.0

### Minor Changes

- feat(notifications): add the nested-agent and unlocked-desktop switches to the host settings panel ([#1972](https://github.com/mihazs/lazysh/pull/1972))

  <details><summary>Details</summary>

  Add the two notification switches to the host settings panel: **Do not notify for nested agents** and **Do not notify while this desktop is unlocked**, in their own form with their own revision and **Save notification switches** button, so saving them never changes the three host switches. Both are off by default; nothing changes until you turn one on. They read and save the companion's `settings notifications` setting and appear only for a companion that answers it; an older companion shows an update message. The panel says that the unlocked-desktop switch works on Linux hosts only (any other host always notifies) and that the nested-agent switch relies on process ancestry on Linux and macOS and on `LAZYSH_PARENT_SESSION_ID` on every host. The strings are in English, Portuguese (Brazil) and Spanish.

  </details>

### Patch Changes

- feat(agents): send a dialog's keys only after the host reads the pane again and finds that dialog once ([#1968](https://github.com/mihazs/lazysh/pull/1968))

  <details><summary>Details</summary>

  Answer an agent's list dialog from the Agent view only after the host reads the pane again: each arrow, Enter and dialog Cancel now carries the rows of the dialog the card was read from, and the app sends no key unless the pane, captured right before it, still shows exactly that dialog once. A dialog answered at the terminal first, replaced by another prompt in the same pane, drawn twice or gone gets nothing and the card says the dialog changed; the connection stays usable. The fresh capture is tmux's: a pane followed through Herdr or Zellij is answered after their own destination check, as before.

  </details>
- test(zellij): drive the Zellij shortcut panel against a real session in the Linux GUI ([#1991](https://github.com/mihazs/lazysh/pull/1991))

  <details><summary>Details</summary>

  Add a Linux native GUI case that attaches a real Zellij 0.45.1 session over owned OpenSSH, drives the Zellij shortcut panel (create tab, previous and next tab, quick tab) and asserts each tab change on the host, and checks that a Zellij-attached tab offers no Jump To. The SSH test fixture gained a pinned-Zellij option and the native Linux CI job installs the pinned Zellij before the GUI step. Test infrastructure only; no product change.

  </details>
- test(android): choose the QR fixture in the Photo Picker that API 36 opens for image inputs ([#2276](https://github.com/mihazs/lazysh/pull/2276))

  <details><summary>Details</summary>

  The QR picker case looked for the fixture by file name, but an image input opens the Photo Picker, which names no file. The case now takes the newest tile. Test only. No user-visible behaviour changes.

  </details>

## 1.92.3

### Patch Changes

- fix(agents): show what the agent said in a long turn and fill the Agent view with earlier messages ([#2261](https://github.com/mihazs/lazysh/pull/2261))

  <details><summary>Details</summary>

  The Agent view folded everything between a prompt and its closing answer into one row, so a session that worked for hours on one prompt was two rows ("Thought for…", "Ran 83 commands") and loading earlier messages only made the count larger. What the agent says between its tool calls is now shown as messages, with the work between them folded. When the newest page does not fill the view, earlier pages are read until it does, and the view stays at the newest message.

  </details>

## 1.92.2

### Patch Changes

- test(terminal): record the first Waydroid lane run of the native core, which stops at the missing owned SSH fixture ([#2278](https://github.com/mihazs/lazysh/pull/2278))

## 1.92.1

### Patch Changes

- ci(android): upload the x86_64 debug and androidTest APKs for the Waydroid lane ([#2277](https://github.com/mihazs/lazysh/pull/2277))

  <details><summary>Details</summary>

  The `native-android-terminal-core` job now uploads `lazysh-android-debug-x86_64` (7 days) with the x86_64 debug APK and the instrumentation APK it already builds, so the Waydroid lane can install them with `--apk`. Nothing changes for users or in what the job builds.

  </details>
- feat(linux): draw a native terminal session on the Wayland subsurface with wgpu, native builds only ([#2272](https://github.com/mihazs/lazysh/pull/2272))

  <details><summary>Details</summary>

  In builds with the `native-terminal` feature, which no release enables, a session that has a native core is drawn on its Wayland subsurface by the renderer host: GDK's display and the subsurface go to wgpu as raw handles, and the swapchain follows the pane's anchor and the window's scale. Released builds are unchanged: the terminal stays xterm.js.

  </details>

## 1.92.0

### Minor Changes

- feat(settings): add the Terminal engine control with Auto, Native and xterm.js to Settings ([#2197](https://github.com/mihazs/lazysh/pull/2197))

  <details><summary>Details</summary>

  Settings, Terminal and accessibility, now has a Terminal engine choice on every platform (#2092, part of #1302): Auto, Native or xterm.js, in English, Brazilian Portuguese and Spanish, reachable with the keyboard like the other choices there. It sets the engine of sessions you open from now on; a session that is already open keeps its engine. The choice is stored on this device only and is never part of encrypted sync. Native is never hidden: while the engine registry refuses it (this platform has no native surface yet or its probe fails, or a screen reader is active and the native engine cannot be read by it) Native is disabled and Settings shows the registry's reason beside it. No release build passes the native probe yet, so Native is disabled everywhere, Auto still uses xterm.js and nothing changes for users; no default changes.

  </details>

### Patch Changes

- feat(terminal): add the typed-input editor for native terminal sessions on desktop and iOS ([#2161](https://github.com/mihazs/lazysh/pull/2161))

  <details><summary>Details</summary>

  First slice of #1334: a hidden text field in the terminal's container that takes keys, input-method composition and paste. Keys go to the core as DOM-shaped key inputs after the platform rules for Option and AltGr; Shift+PageUp and Shift+PageDown scroll the history by a page and are not sent to the program, as with xterm.js; composition shows its preedit at the cursor and commits once whichever order the browser fires its events in; a paste is bracketed for a program that asked for it. Android keeps its native input connection and gets no editor. No release build selects the native terminal, so xterm.js stays the default and nothing changes for users.

  </details>
- feat(terminal): find web addresses, file paths and hyperlinks in the shared terminal core ([#2198](https://github.com/mihazs/lazysh/pull/2198))

  <details><summary>Details</summary>

  Part of #1320 and #1302. The shared Rust terminal core can now find the web addresses (URLs) and host file paths on a row of its screen or scrollback, including those a program wrapped over several rows or broke at a box border, and read the hyperlinks (OSC 8) an application draws. On 33 shared screens it returns the same addresses, paths, line and column numbers and cell ranges as the existing xterm.js link code. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.

  </details>
- test(android): run the real terminal core inside the app on the CI emulator ([#2147](https://github.com/mihazs/lazysh/pull/2147))

  <details><summary>Details</summary>

  A new `native-android-terminal-core` job builds the app with the optional `native-terminal` feature for arm64 (compiled and linked) and x86_64 and prints the size of each library, and an instrumentation case opens a core through the renderer's IPC, connects to an owned OpenSSH and reads back the shell's output with `terminal_core_text` on the CI emulator. The same harness runs against the Waydroid guest once its session can start. The feature stays off in every release build, so the app, its settings and its defaults are unchanged and nothing changes for users.

  </details>
- test(ntfy): record what the Android app did with each pushed challenge when confirmation times out ([#1966](https://github.com/mihazs/lazysh/pull/1966))

  <details><summary>Details</summary>

  Count in memory what the Android app does with each pushed ntfy challenge message and retain only those closed counts in the failure receipt when the unchanged 15-second challenge confirmation fails. This separates a message the distributor never delivered from one the app dropped; it is diagnostic evidence, not a confirmation or delivery fix.

  </details>
- feat(terminal): give the native core the app's colours and the Mosh canonical-frame mode at session open ([#2160](https://github.com/mihazs/lazysh/pull/2160))

  <details><summary>Details</summary>

  Give the native terminal core the app's colours and the Mosh canonical-frame mode when a session opens: `terminal_core_open` takes an optional config with the app's terminal theme and `canonicalFrames`, and `terminal_core_theme` changes the colours of a running session, so a program that asks the core for its colours hears the theme the user chose and a theme change answers the next query. The client's bridge passes the theme when it opens a core and sends a changed theme. Nothing registers the native engine yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.

  </details>

## 1.91.4

### Patch Changes

- feat(linux): place a native terminal surface below the web view on Wayland, in builds with the native terminal only ([#2262](https://github.com/mihazs/lazysh/pull/2262))

  <details><summary>Details</summary>

  Builds with the `native-terminal` feature, which no release enables, get a Linux surface host: the three surface commands place a Wayland subsurface of the app window below a transparent web view at the pane's anchor, and the device probe refuses native on X11 and Xwayland with the display named. The surface shows the pane background; no renderer draws on it yet. Released builds are unchanged: their window stays opaque and the terminal stays xterm.js.

  </details>

## 1.91.3

### Patch Changes

- test(terminal): stop the daemons a program test starts when the test ends ([#2269](https://github.com/mihazs/lazysh/pull/2269))

## 1.91.2

### Patch Changes

- ci(checks): skip the OSC 52 clipboard step when its Playwright install was skipped ([#2247](https://github.com/mihazs/lazysh/pull/2247))

  <details><summary>Details</summary>

  In the `native-linux-runtimes` job the OSC 52 clipboard step ran after any earlier failure, but the Playwright install steps before it did not, so it failed with "Executable doesn't exist" and added a misleading second failure to the job. It now runs only when the Chromium install succeeded. An earlier failure still fails the job. CI only; the app is unchanged.

  </details>
- feat(accessibility): mirror a native terminal session's rows for a screen reader while Screen reader mode is on ([#2241](https://github.com/mihazs/lazysh/pull/2241))

  <details><summary>Details</summary>

  A session on the native engine has no text a screen reader can reach, so while Screen reader mode is on the terminal pane now mirrors its visible rows into a hidden list with a polite, bounded log of new output, and the session reports itself accessible only while that mirror is mounted. Nothing changes for users in this release: a session started with Screen reader mode on still gets xterm.js, native stays a developer-only choice, and no default changes.

  </details>
- test(android): choose the theme QR image in the real system file picker and check its decoded preview ([#1931](https://github.com/mihazs/lazysh/pull/1931))

  <details><summary>Details</summary>

  Select the owned theme QR PNG through the real Android system file picker from the QR image fallback input and verify the decoded preview appears without applying preferences. Test and documentation only. No user-visible behaviour changes.

  </details>
- feat(herdr): keep the managed Herdr build from replacing itself with a stock release ([#1934](https://github.com/mihazs/lazysh/pull/1934))

  <details><summary>Details</summary>

  In the optional `lazysh-managed` guarded Herdr build, `herdr update`, the self-update behind `herdr channel set` and the background update check refuse or never run, with the reason that updates arrive only through lazysh. The Herdr native job proves on the real built binary that none of them downloads or replaces anything. Default Herdr builds and every shipped default are unchanged.

  </details>
- feat(terminal): Draw real text in the native terminal renderer, with font fallback and correct cell widths ([#2224](https://github.com/mihazs/lazysh/pull/2224))

  <details><summary>Details</summary>

  Closes #1325, part of #1302. The wgpu renderer of the native terminal engine now draws glyphs from fonts instead of placeholder patterns: each grapheme cluster is shaped on its own with `swash` (pure Rust), takes the first family of the font list that covers it (a color face for emoji) and is fitted to the one or two cells the terminal core gave it, so CJK, combining marks, ZWJ emoji, flags and keycaps do not move the grid. Bold and italic use the family's own faces and are synthesized when it has none; color emoji have their own atlas. With the optional `native-terminal` feature the renderer host draws with the fonts installed on the machine for the Preferences font list and size (Android and Linux font directories), the platform's monospace font for `monospace`, one CJK and one emoji font, and a bundled subset of DejaVu Sans Mono when nothing else is installed. Fonts imported in Preferences are not drawn by the native engine yet (#2223). Nothing attaches the host and no released build enables the feature, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.

  </details>
- ci(herdr): build the managed Herdr as a release-profile executable and state its libc floor ([#1932](https://github.com/mihazs/lazysh/pull/1932))

  <details><summary>Details</summary>

  The Herdr native job builds the optional managed Herdr derivative as a release-profile Linux x86-64 executable, runs the owned real-server acceptance against those exact bytes, fails when the executable needs a glibc above the documented 2.35 floor, and retains it with a receipt binding the source commit, original manifest digest, feature set, toolchains and SHA-256. Nothing is published and no platform support is claimed yet.

  </details>

## 1.91.1

### Patch Changes

- change: Probe whether a native surface can sit below the transparent web view on macOS (#1333) ([#2152](https://github.com/mihazs/lazysh/pull/2152))

  <details><summary>Details</summary>

  Probe whether a native surface can sit below the transparent web view on macOS (#1333): a standalone test host builds the real tao and wry window, puts a `CAMetalLayer` view below the `WKWebView` inside wry's `WryWebViewParent`, and a macOS CI job reads the window back from the window server to judge placement, DOM overlap, resize and recreate at 1x and 2x. Test infrastructure only; the app is unchanged and xterm.js stays the terminal on macOS.

  </details>
- build: Build and test the shared terminal core and its wgpu renderer on Windows (#1332, part of #1302) ([#2127](https://github.com/mihazs/lazysh/pull/2127))

  <details><summary>Details</summary>

  Build and test the shared terminal core and its wgpu renderer on Windows (#1332, part of #1302): a `terminal-windows` CI job on `windows-latest` compiles libghostty-vt with Zig 0.16.0 for `x86_64-pc-windows-msvc` against the runner's MSVC and Windows SDK headers (`LIBGHOSTTY_VT_WINDOWS_LIBC`), runs the runtime crate's tests, and runs the renderer crate's tests on Direct3D 12 with the WARP software adapter. Build and CI only; the app does not use the core yet, no Windows surface exists, and xterm.js stays the only engine.

  </details>

## 1.91.0

### Minor Changes

- feat(hooks): install, update and remove Kimi Code 2.4 approval hooks from Agent hook setup ([#1947](https://github.com/mihazs/lazysh/pull/1947))

  <details><summary>Details</summary>

  **Agent hook setup** lists Kimi Code (`KIMI_CODE_HOME`, otherwise `~/.kimi-code`) and installs three `[[hooks]]` entries (`PermissionRequest`, `PermissionResult`, `SessionEnd`, five seconds) as an owned block at the very end of the profile's existing `config.toml`. Every earlier byte, including comments, secrets, CRLF line endings, foreign hooks and the file mode, is kept; a UTF-8 BOM is refused unchanged because Kimi Code 2.4.1 rejects it. The result is validated as TOML before it is written, a missing `config.toml` is refused instead of created, and update or remove act only on that exact end-of-file block (an edit after it, a moved block or an inline `hooks` setting is a conflict, never a rewrite). It needs the updated host companion: the app asks for discovery schema 4 first and falls back to 3 and 2 for older companions, which keep Kimi manual, as do the legacy Kimi CLI 1.52 profile and custom config paths. No default changes. A one-off run of the official Kimi Code 2.4.1 `kimi doctor` accepted the result; macOS, Windows and a real authenticated Kimi session were not exercised.

  </details>
- feat(herdr): add the explicit install and removal of the optional managed Herdr over SSH ([#1941](https://github.com/mihazs/lazysh/pull/1941))

  <details><summary>Details</summary>

  A collapsed **Managed Herdr on this host** section in the Multiplexer workspaces panel with **Install** and **Remove**. Install uploads the verified release file for the host's own platform, has the host check its size, digest and CPU and refuse a stale plan, an unsafe destination or an executable that does not run, and publishes it as `<data>/lazysh/herdr/lazysh-herdr` by one rename; removal deletes only that file. The system Herdr, its configuration, running servers and sessions are never touched. The release set lists no managed Herdr yet, so the install stops with a clear message until it is published; no release or platform support is claimed.

  </details>
- feat(hooks): list the seven readiness steps of an agent in the Agent hook setup panel ([#1945](https://github.com/mihazs/lazysh/pull/1945))

  <details><summary>Details</summary>

  List seven readiness steps in the Agent hook setup panel after Inspect setup (companion, hook files, provider reload, provider trust, lifecycle event received on this host, pane, remote delivery), in English, Portuguese and Spanish. Configured hooks with no recorded event show a hint; an older companion's status reads as not checked.

  </details>

### Patch Changes

- feat(herdr): run every native Herdr call on the one Herdr a connection captured, nothing changes for users yet ([#1942](https://github.com/mihazs/lazysh/pull/1942))

  <details><summary>Details</summary>

  Make every native Herdr call run one Herdr that the connection captured once: the host's own `herdr` or the optional managed derivative at its fixed path `~/.local/libexec/lazysh-herdr/herdr`. Discovery, the session list, the tree and its actions, workspace creation, SSH and Mosh attachment, the guard's capability check and RPCs, and the display's owning actor all use the captured choice; a different second choice is refused, a missing or untrusted managed file never falls back to the host's own Herdr, and the choice is a closed name, never a path or command. Nothing installs the managed Herdr and the app offers no choice yet, so behaviour and defaults are unchanged.

  </details>
- change: Refuse a companion release response when its version differs from the requested update version ([#1948](https://github.com/mihazs/lazysh/pull/1948))
- test: Verify theme import by QR image file and by an OS `lazysh://` link in the Linux native GUI suite ([#1890](https://github.com/mihazs/lazysh/pull/1890))

  <details><summary>Details</summary>

  No user-visible behaviour changes.

  </details>
- test(android): cover pinch zoom and two-finger window swipes on a real tmux session ([#1887](https://github.com/mihazs/lazysh/pull/1887))

  <details><summary>Details</summary>

  Extend the Android tmux acceptance case with real two-finger gestures: a pinch out and a pinch in on the attached tmux display zoom and unzoom the pane the split added, and a two-finger swipe left and right select the next and the previous window. The host reads the active window and `#{window_zoomed_flag}` back from the tmux server and requires them to change in exactly that order. Test-only; no behaviour changes.

  </details>
- change: Generate and check the redistribution notice inventory of the optional managed Herdr derivative in the Herdr… ([#1936](https://github.com/mihazs/lazysh/pull/1936))

  <details><summary>Details</summary>

  Generate and check the redistribution notice inventory of the optional managed Herdr derivative in the Herdr native job: every Cargo package and Zig package the Linux x86-64 managed build resolves, with version, source URL, license and license texts, the modified upstream files with their change notices, the original manifest digest and the lazysh files with their licenses. The job fails when a package has no recorded license, a license nobody reviewed, or no license text, and retains `notices.json` and `NOTICES.txt` as a CI artifact. The audit result is recorded in `PROVENANCE.md`. Nothing is published and no platform support is claimed.

  </details>
- test(herdr): accept the managed Herdr beside a stock server of the same session name ([#1937](https://github.com/mihazs/lazysh/pull/1937))

  <details><summary>Details</summary>

  Accept the managed Herdr derivative beside an unchanged stock server in the Herdr native job: a stock and a managed server of the same session name share one `HOME` and set of XDG roots, the stock server's process, sockets, configuration and workload stay exactly as they were, everything the managed server adds sits in its own `lazysh-herdr` directory, its pane children keep `HOME`, every XDG root and the provider profile, and only the managed executable advertises guarded attachment. The owned acceptance can now run on an executable named by `LAZYSH_TEST_HERDR_MANAGED`, so a retained or downloaded release asset can be accepted instead of a rebuild. Nothing is published, no install or removal is added and no platform support is claimed yet.

  </details>
- test(desktop): verify the Linux keep-awake control through the real app and an owned portal server ([#1958](https://github.com/mihazs/lazysh/pull/1958))

  <details><summary>Details</summary>

  Verify the Linux desktop keep-awake control through the real app: the Agent board's request to the desktop portal, its closing on window focus loss, on leaving the board and on turning the control off, and the error shown without a portal. Test and documentation only. No user-visible behaviour changes.

  </details>
- test(android): deny the Attachment Photo camera permission through the real system sheet ([#1928](https://github.com/mihazs/lazysh/pull/1928))

  <details><summary>Details</summary>

  The owned Mosh attachment case now denies the camera permission and verifies no camera opens, the draft is unchanged and the ordinary file chooser still opens. Test and documentation only. No user-visible behaviour changes.

  </details>
- test(android): sample the glass chrome material in the Android WebView ([#1893](https://github.com/mihazs/lazysh/pull/1893))

  <details><summary>Details</summary>

  Adds an Android runtime case that samples the glass chrome material in the Android WebView (#1723): for the Workspace tools dialog and Preferences it reads the computed `backdrop-filter` and translucent background and the conditions under which they fall back to opaque, then lays a black and white underlay beneath the dialog and measures the device screenshot across its edge, so a blur or translucency that the WebView declares but does not composite fails it. Test infrastructure only; the app is unchanged.

  </details>

## 1.90.0

### Minor Changes

- feat: Add the app's bridge to the host browser relay ([#1886](https://github.com/mihazs/lazysh/pull/1886))

  <details><summary>Details</summary>

  Add the app's bridge to the host browser relay: six Tauri commands (`host_browser_start`, `host_browser_next`, `host_browser_ack`, `host_browser_pause`, `host_browser_resume`, `host_browser_stop`) run `lazysh-agent host-browser serve` on one SSH exec channel and hand the viewer its frames as bytes, one pull at a time. A browser stops, and its channel closes, on stop, lock, a dropped connection and the end of the session; one runs per session and two per app. A companion without the relay, or with the host browser switch off, is named and never retried, and nothing about a page is written to a log or to storage. Nothing in the app calls the commands yet: the viewer ships in the next slice of the same feature.

  </details>

### Patch Changes

- feat(terminal): check the device's GPU before the native terminal engine is offered ([#2221](https://github.com/mihazs/lazysh/pull/2221))

  <details><summary>Details</summary>

  The app asks the renderer for a graphics adapter before a session may use the native
  engine. A device with only a software rasterizer, with no adapter, or whose driver
  takes longer than 2 seconds to answer keeps xterm.js, and the engine line says why.
  No release build includes the native engine yet, so nothing changes for users.
  Changed defaults: none.

  </details>
- fix(release): List changes from every package in the release notes, not only the client's ([#2232](https://github.com/mihazs/lazysh/pull/2232))

  <details><summary>Details</summary>

  The GitHub release notes and the release section of the root `CHANGELOG.md` were built from the client's changelog alone, so a change whose fragment named another package, such as the companion, was missing from them. They now take the version's entries from every `@lazysh/*` package changelog and list a change that names several packages once. Releases already published are not rewritten. No application behaviour and no defaults change.

  </details>

## 1.89.1

### Patch Changes

- test(android): cover tmux copy mode and copying a line in the Android tmux acceptance case ([#1881](https://github.com/mihazs/lazysh/pull/1881))

  <details><summary>Details</summary>

  Extend the Android tmux acceptance case: through the real UI it now enters copy mode from the tmux prefix shortcut, selects and copies the pane's marker line with native keys, and requires the line to reach the system clipboard only after a real tap on Allow in the terminal's clipboard request. The host checks that the pane entered and left copy mode and that tmux's own buffer is that line. Test-only; no behaviour changes.

  </details>

## 1.89.0

### Minor Changes

- feat(zellij): open the Zellij pane that raised an agent notification ([#1872](https://github.com/mihazs/lazysh/pull/1872))

  <details><summary>Details</summary>

  Opening an inbox row, tapping a desktop notification or choosing **Open session** for an agent that ran in a Zellij pane now also focuses that pane, and the tab that holds it, in the Zellij session your terminal is attached to, so the Agent view follows that agent and not another one in the session (#1690, part of #1146). A pane of another Zellij session, or of another multiplexer, is left alone, and a pane that has gone still opens the session. No defaults change.

  </details>
- feat(tmux): list the panes of every tmux window in Jump To and move to the exact pane you choose. ([#1875](https://github.com/mihazs/lazysh/pull/1875))
- feat(zellij): rename and close sessions and panes, and move pane dividers, from the Workspaces panel ([#1870](https://github.com/mihazs/lazysh/pull/1870))

  <details><summary>Details</summary>

  Rename and close Zellij sessions and panes, and move pane dividers, from the Workspaces panel on Zellij 0.45.1: **Control Zellij** lists the session's panes and gains Rename pane, four divider arrows and Close pane for each, and Rename Zellij session and Close Zellij session for the session. Closing asks first with a confirmation that names the pane or session and sends one exact action only when confirmed. No defaults change.

  </details>

### Patch Changes

- test(multiplexers): verify that a copy in tmux, Zellij and Herdr reaches the device clipboard ([#1874](https://github.com/mihazs/lazysh/pull/1874))

  <details><summary>Details</summary>

  Verifies that text copied in tmux, Zellij and Herdr reaches the device clipboard through the OSC 52 consent prompt (#1699, part of #1147), and documents the option each multiplexer needs. No behavior or default change. `native-linux-runtimes` now drives real tmux, Zellij 0.45.1 and stock Herdr clients in the terminal pane, and Windows runs the unit tests of the client's OSC 52 handler.

  </details>

## 1.88.0

### Minor Changes

- feat(companion): run the companion on Windows hosts reached over OpenSSH ([#1903](https://github.com/mihazs/lazysh/pull/1903))

  <details><summary>Details</summary>

  Run the companion on Windows hosts reached over OpenSSH (#1725, part of #490). A host whose POSIX probe exits non-zero is now asked a second, PowerShell probe (`powershell.exe -EncodedCommand`) that reports its architecture, SID and local application data directory, and every companion command is sent to it as one encoded PowerShell line that `cmd.exe`, Windows PowerShell and POSIX quoting pass unchanged. Arguments Windows PowerShell 5.1 cannot pass faithfully are refused. Hosts that answer the POSIX probe are unchanged; installation, hook setup and the Herdr lookup stay Unix-only. Changed default: a host whose POSIX probe fails also gets the Windows probe.

  </details>
- feat(desktop): run Files and Diff inside a WSL target on Windows ([#1921](https://github.com/mihazs/lazysh/pull/1921))

  <details><summary>Details</summary>

  Run **Files** and **Diff** inside a WSL target on Windows (#1745, part of #1135). A WSL session runs Git and every other host command as `wsl.exe -d <distro> --cd ~ -e <argv>` (argv, no shell string, the same deadline, output bound and process-tree cleanup as a native command) and reads and lists files through `\\wsl.localhost\<distro>\`. Only a Linux path, a `\\wsl.localhost\<distro>\` path of the same distribution or a Windows drive path (translated with `wslpath`) is accepted; other UNC hosts, other distributions, device paths and `..` escapes are refused. A distribution reports **Files** and **Diff** once `git` starts inside it. Native Windows, Linux and macOS targets are unchanged.

  </details>
- feat(desktop): choose PowerShell, Git Bash or a WSL distribution for a local terminal on Windows ([#1921](https://github.com/mihazs/lazysh/pull/1921))

  <details><summary>Details</summary>

  Choose PowerShell 7, Windows PowerShell, Git Bash or a WSL distribution for a local terminal on Windows. The target list is detected natively, the app sends only the chosen id, an id that is not installed is refused, and a session saves its target for workspace restore. The default shell is unchanged. WSL targets open the distribution's login shell.

  </details>
- feat(agents): add an opt-in "All hosts" scope to the Agents board ([#1915](https://github.com/mihazs/lazysh/pull/1915))

  <details><summary>Details</summary>

  Part of #1743 and #991. With two or more saved hosts connected, a "This host / All hosts" switch appears above the board; "This host" stays the default and the per-connection board is unchanged. "All hosts" reads the reported activity of every connected host and groups it by state, then host, then project. Each host is read through its own connection every five seconds while the board is shown (up to 32 hosts, four reads at a time; sessions of one saved host count once), and a host that cannot answer shows its own error row while the others stay. A row opens that host's connection, like an inbox notification. Archive and Restore stay on each host's own board under its own key: the merged board only hides what that board archived. Nothing changes on the host or on disk and no default changes.

  </details>

### Patch Changes

- test(android): cover the Device panel against the owned emulator over owned OpenSSH ([#1895](https://github.com/mihazs/lazysh/pull/1895))

  <details><summary>Details</summary>

  Adds an owned Android runtime case for the Device panel (#1730, #19): through the real UI over owned OpenSSH with the current `lazysh-agent` and the job's Android SDK, it finds the owned emulator as running, checks the controls its capabilities offer and shows a decoded capture of the emulator's own screen. It never presses reboot, shutdown or boot, since the emulator under test runs the app; the lifecycle half stays a documented limit. Test infrastructure only; the app is unchanged.

  </details>
- test(share): verify the share thumbnail fetch against the real share service ([#1918](https://github.com/mihazs/lazysh/pull/1918))

  <details><summary>Details</summary>

  A desktop test uploads a PNG to the real service router behind a throwaway-certificate TLS front, fetches it back through the client's thumbnail download, decodes it to a preview with the original dimensions, and sees the fetch refused once the share is deleted (#994, #1738). Test infrastructure only; the app is unchanged.

  </details>
- feat(desktop): attach native Zellij and Herdr sessions on Windows through the ConPTY ([#1926](https://github.com/mihazs/lazysh/pull/1926))

  <details><summary>Details</summary>

  Let `local_connect` attach a native Zellij or Herdr session on Windows through the ConPTY. The program is found on the `PATH` before the PTY starts, trying each directory in order with the name plus the `PATHEXT` extensions a process can be started from (`.com` and `.exe`; a batch file never resolves), and a program that is not installed is named in the error. tmux has no native Windows build, so a tmux entry is still refused there. The interface does not offer the choice yet, and attaching on Linux and macOS behaves as before.

  </details>
- feat(multiplexers): run the guarded Herdr input in local terminals ([#1922](https://github.com/mihazs/lazysh/pull/1922))

  <details><summary>Details</summary>

  Run the guarded Herdr input in local terminals: a local `herdr` that admits the guard is attached with `--guarded-attach`, its private first frame is taken off the PTY before any byte reaches the terminal, the ticket is claimed through a one-shot `herdr api guarded` child, and the same guard actor then serves `herdr_chat` for `local:` ids over the same receipts, budgets and access leases as SSH. A claim that fails closes the terminal and never falls back to an ordinary attach. The interface does not offer the local attach yet, and SSH Herdr behaves as before.

  </details>
- test(android): record cancelled pointer sequences when diagnosing the native chooser ([#1927](https://github.com/mihazs/lazysh/pull/1927))

  <details><summary>Details</summary>

  Record cancelled pointer sequences when diagnosing the Android native chooser.

  </details>
- test(android): verify the saved tmux create-if-missing default through the real host editor ([#1927](https://github.com/mihazs/lazysh/pull/1927))

  <details><summary>Details</summary>

  Verify the saved tmux create-if-missing default on Android: a second host whose Default multiplexer is tmux creates and attaches a session the server lacks through the real host editor and connect flow, and connecting again attaches the same session. Test and documentation only. No user-visible behaviour changes.

  </details>

## 1.87.1

### Patch Changes

- feat(terminal): Add the renderer host that draws a native terminal session on a platform surface ([#2219](https://github.com/mihazs/lazysh/pull/2219))

  <details><summary>Details</summary>

  Part of #2215 and #1302. With the optional `native-terminal` feature the app has a renderer host: it draws a core session's frames with the wgpu renderer only when something changed, suspends, survives a lost surface or GPU device, and draws the selection, composing text and the theme and font of the preferences. The renderer can present on a window given as raw handles. Nothing calls the host yet and no released build enables the feature, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.

  </details>

## 1.87.0

### Minor Changes

- feat(terminal): add the one-time notice that the terminal engine changed and where to switch back ([#2211](https://github.com/mihazs/lazysh/pull/2211))

  <details><summary>Details</summary>

  When the terminal engine that Automatic selects on this device differs from the one the device last used by default, the app shows a notice above the session tabs: "The terminal engine changed on this platform. Switch back in Settings, Terminal engine." It has an Open Settings button and a Dismiss button, stays until one of them is pressed and then does not return. It is not shown on a fresh install or to anyone who chose an engine in Settings, and that choice is not reset. In English, Brazilian Portuguese and Spanish. No default changes in this release: sessions still use xterm.js, so the notice does not appear yet.

  </details>

### Patch Changes

- fix(release): publish releases again by admitting the Google Android APK that carries the Parakeet runtime ([#2213](https://github.com/mihazs/lazysh/pull/2213))

  <details><summary>Details</summary>

  Every release after 1.83.1 stopped in the Android packaging step: the Google APK, which
  now links the Parakeet speech runtime, is 51.6 MiB and the release size guard allowed
  47 MiB. Its ceiling is now 78 MiB, 1.5 times the measured size. The FOSS APK keeps its
  47 MiB ceiling, and the guard still refuses a missing, linked, empty or oversized
  package. Changed defaults: none.

  </details>

## 1.86.0

### Minor Changes

- feat(client): name the companion a local session runs in the Agents setup ([#1852](https://github.com/mihazs/lazysh/pull/1852))

  <details><summary>Details</summary>

  Name the companion a local session runs (#1667, part of #1132). The Agents setup of a local session shows **Bundled**, **Managed copy** or **On PATH**, from the new `tools.companionSource` that `local_capability` reports for the default target (`null` when no companion resolved). A local session without `lazysh-agent` now says to put it beside the app, install a managed copy or add it to the PATH. No defaults change.

  </details>
- feat(agents): show a Copilot CLI, Kimi CLI or Droid session's records in the Agent view, labelled as partial ([#1846](https://github.com/mihazs/lazysh/pull/1846))

  <details><summary>Details</summary>

  A GitHub Copilot CLI, Kimi CLI or Droid pane that reports a session now shows that session's records in the Agent view: read-only, under a partial label, with the hook state in the header and Show terminal. The companion's `discover` names `sessionId` for these three adapters (additive). Agents the view cannot read (Pi, OMP, Hermes, Cursor, Amp, Grok Build) now say that the view shows only their last reported state instead of pointing at a setting that cannot fix it. No defaults change. Refs #1658, #1125.

  </details>
- feat(herdr): choose a list, accordion or grid layout for the Herdr Spaces tree ([#1835](https://github.com/mihazs/lazysh/pull/1835))

  <details><summary>Details</summary>

  Choose a list, accordion or grid layout for the Herdr Spaces tree, with the same remembered preference as tmux Jump To. The list shows every space open, the accordion opens only the focused space (any space still opens by hand) and the grid sets spaces side by side as cards when the sidebar is wide enough for two. Choosing a layout also changes the other multiplexer panels, and a layout chosen there is now the one Spaces opens in.

  </details>
- feat(client): show This device on the Agents board, transcripts, usage reports and inbox ([#1852](https://github.com/mihazs/lazysh/pull/1852))

  <details><summary>Details</summary>

  Show the Agents board, transcripts, usage reports, approvals and notification inbox for a local session (#1667, part of #1132). Local sessions share one host key, `local:default`, and the label **This device**, so their reports group, archive and notify like a saved host's, and every local tab on the target is polled once. The views appear when the local target reports the companion (`tools.companion`); a target without it hides them and the session details say that `lazysh-agent` was not found on this device. The companion panel offers no SSH install for a local session, and hook discovery and setup reach the local companion. Remote sessions, saved hosts and their polling are unchanged; no default changes.

  </details>
- feat(herdr): close, rename and resize Herdr panes and close Herdr workspaces from the Workspaces panel ([#1869](https://github.com/mihazs/lazysh/pull/1869))

  <details><summary>Details</summary>

  Each pane row shows its label and gains Rename, four divider arrows and Close, and each workspace gains Close. Closing asks first with a confirmation that names the pane or workspace and sends one exact-id command only when confirmed. A workspace that still has linked worktree workspaces is refused by Herdr and lazysh never closes the group. No defaults change.

  </details>
- feat(agents): follow a Grok Build session in the Agent view ([#1845](https://github.com/mihazs/lazysh/pull/1845))

  <details><summary>Details</summary>

  With the updated host companion, print the opted-in hook fragment (`lazysh-agent grok-config --reported-history`), review it and save it as `~/.grok/hooks/lazysh.json`: a Grok Build hook then reports the session id, the pane it ran in and the path of its session log (`updates.jsonl`), and the Agent view of that tmux pane shows the conversation (turns, thinking, tool calls with their output and status, the plan card) and the state (working, done, failed, waiting for an approval), polling the log about every two seconds, with the guarded send. The Claude Code hooks reach Grok Build too (it runs `~/.claude/settings.json`), so a report that carries Grok's own input is now shown as **Grok Build**, not as a Claude Code session. Nothing is guessed from processes or from the newest file of a folder: a report without a log path binds nothing, a sub-agent's events are ignored, and two different paths for one session stay unusable. Questions and approvals stay in the terminal; the view says so and holds the draft, and it offers Grok Build no Stop key and no `@` or `/` suggestions because no key was checked on a real Grok Build. The same terminal notice now also appears when Gemini CLI or OpenCode waits for an approval or a plan decision, which the view cannot answer. A session past 10,000 log records or 16 MiB shows the reader's error and leaves the terminal. Verified with synthetic fixtures built from the pinned official source and the real executable on Linux; no Grok Build binary or account was available, so a run against a real agent is still open on #1842. No defaults change.

  </details>

### Patch Changes

- change: Add an Android emulator case on the pinned Zellij 0.45.1… ([#1837](https://github.com/mihazs/lazysh/pull/1837))

  <details><summary>Details</summary>

  Add an Android emulator case on the pinned Zellij 0.45.1 (new `native-android-zellij` job, `bun run test:android-zellij`): through the packaged UI the app discovers Zellij, lists the one owned session, attaches it, switches to Tab 2 and Tab 1 from the Zellij controls, detaches by closing the tab and reattaches it, while the host reads the session's active tab back with `zellij action list-tabs --json` and checks that both command panes started exactly once. The SSH test fixture gained a pinned-Zellij option. Test-only; no behaviour changes.

  </details>
- test(agents): run the Agent view native GUI cases against an agent in a real guarded Herdr pane ([#1839](https://github.com/mihazs/lazysh/pull/1839))

  <details><summary>Details</summary>

  Run the Agent view's mid-turn Terminal, Agent, Terminal round trip, a prompt sent from the Agent view and a prompt typed in the terminal through the real native GUI against a stand-in agent in a real guarded Herdr pane, with the same cases the tmux pane already runs. Test and fixture only: the application is unchanged.

  </details>
- change: Extend the Android tmux acceptance case ([#1838](https://github.com/mihazs/lazysh/pull/1838))

  <details><summary>Details</summary>

  Extend the Android tmux acceptance case: it now opens a synthetic transcript through the real companion, stages a draft in Chat, and sends it with the explicit Choose, Confirm and Send steps to the pane the attached tmux display shows, and the host reads that pane back by id to require the draft there once and nowhere else, with no extra display client. Test-only; no behaviour changes.

  </details>
- test(agents): run the Agent view native GUI cases against a reporting agent in a real tmux pane ([#1839](https://github.com/mihazs/lazysh/pull/1839))

  <details><summary>Details</summary>

  Run the Agent view's mid-turn Terminal, Agent, Terminal round trip, a prompt sent from the Agent view and a prompt typed in the terminal through the real native GUI against a hook-reporting stand-in agent in a real tmux pane. Test and fixture only: the application is unchanged.

  </details>
- test(android): verify the client environment flag sends LC_TERMINAL to an AcceptEnv LC_* host ([#1830](https://github.com/mihazs/lazysh/pull/1830))

  <details><summary>Details</summary>

  Through the real Android app, the optional client environment flag is saved with a host and sends `LC_TERMINAL=lazysh` to an OpenSSH server that accepts `LC_*`, while a host without the flag does not. The owned SSH test fixture can now start an sshd with `AcceptEnv LANG LC_*`.

  </details>
- test(herdr): assert live Herdr agent states and the current marker on Android and the Linux GUI ([#1833](https://github.com/mihazs/lazysh/pull/1833))

  <details><summary>Details</summary>

  The Android shared-navigation case requires each Agents row to render its real Working or Needs attention state and checks the current space, tab and pane before every Spaces switch. A new Linux GUI case moves the live agent from Unknown to Working to Needs attention and moves the real server focus from the Spaces tree. Test coverage only; no product change.

  </details>

## 1.85.1

### Patch Changes

- build(terminal): Compile the wgpu renderer into the app with the optional native-terminal feature ([#2205](https://github.com/mihazs/lazysh/pull/2205))

  <details><summary>Details</summary>

  Part of #2201 and #1302. The app now depends on `lazysh-terminal-renderer-wgpu` by path, only with the `native-terminal` feature, and the root `Cargo.lock` pins wgpu 30.0.2 and the 37 other crates it brings. Build-only: nothing in the app calls the renderer yet, the feature stays off in every released build, default builds compile no wgpu (the `native-terminal-bridge` job checks that) and xterm.js stays the only engine a user can run.

  </details>

## 1.85.0

### Minor Changes

- feat(terminal): show which terminal engine the current session uses and why ([#2202](https://github.com/mihazs/lazysh/pull/2202))

  <details><summary>Details</summary>

  The Connections page of Workspace tools and Settings, Terminal and accessibility, now say which engine draws the current session and why the app chose it: automatically, in Settings, by the developer override, or, when xterm.js stands in for the native engine, the reason the native engine was refused (a screen reader is active, or the engine cannot run in this build). In English, Brazilian Portuguese and Spanish. No default changes: sessions still use xterm.js.

  </details>

## 1.84.0

### Minor Changes

- feat(voice): offer the local Parakeet engine in the Google build of the Android app ([#1819](https://github.com/mihazs/lazysh/pull/1819))

  <details><summary>Details</summary>

  Voice on a phone can now select Parakeet next to Whisper, for arm64-v8a and x86_64: pinned ONNX Runtime and sherpa-onnx, the model in the app's private storage, and a free-space check (about 1.6 GB) before it is downloaded or prepared. The F-Droid build does not include it. No defaults change: Whisper stays the default and nothing downloads Parakeet until you choose it.

  </details>
- feat(voice): offer the Parakeet local dictation engine on Windows x86_64 ([#1825](https://github.com/mihazs/lazysh/pull/1825))

  <details><summary>Details</summary>

  Whisper stays the default; Parakeet needs an explicit model download, as on Linux, and its model files live in a private folder that only the current user, the administrators and the system can reach.

  </details>

### Patch Changes

- test: Prove local Whisper on Android with the real engine ([#1806](https://github.com/mihazs/lazysh/pull/1806))

  <details><summary>Details</summary>

  Prove local Whisper on Android with the real engine: the emulator job imports the pinned English model through the Voice import commands, transcribes the public JFK sample with the bundled whisper.cpp and removes the model again. The Linux runtime job and the Android job now take their speech fixtures from one pinned download script.

  </details>
- feat(companion): explain where the host companion is installed and what is verified before it starts ([#1787](https://github.com/mihazs/lazysh/pull/1787))

  <details><summary>Details</summary>

  Agents now says where the companion goes, what the host verifies and that nothing changes until the button is pressed. An unsupported host architecture is covered by an owned OpenSSH test (both routes refuse it before anything is fetched or written). Installation behaviour is unchanged.

  </details>
- test(android): prove upload recovery after the SSH control stream closes on the owned emulator ([#1785](https://github.com/mihazs/lazysh/pull/1785))

  <details><summary>Details</summary>

  Extend the Android Mosh attachment acceptance case: the owned device now reaches its SSH daemon through the owned relay, the host closes only the app's SSH stream (server-attributed) while the Mosh daemon stays alive, and the real UI shows the closed-control upload error with its Reconnect uploads action, restores uploads by manual authentication without an automatic upload or a second terminal, and then uploads the exact bytes by a separate explicit Upload (a repeated Upload leaves the file untouched). Test-only; no behaviour changes.

  </details>
- change: Add an owned Android emulator case for encrypted sync (#1540, child of #17) ([#1804](https://github.com/mihazs/lazysh/pull/1804))

  <details><summary>Details</summary>

  Add an owned Android emulator case for encrypted sync (#1540, child of #17): through the real Sync panel it enrolls against an owned HTTPS WebDAV server, shows the recovery key again from the native credential store after a restart, checks that nothing is uploaded before the explicit action and that credentials stay off, uploads settings as age ciphertext, then enrolls a reset install with the recovery key and previews and applies the saved host list. Owned emulator builds trust one extra root for `127.0.0.1` through the `sync-tls-acceptance` Cargo feature; published builds do not compile it, and production sync still requires HTTPS with the web PKI roots. Test infrastructure only.

  </details>
- test(agents): stop the dialog picker's digit-key test from timing out at random in CI ([#2207](https://github.com/mihazs/lazysh/pull/2207))

  <details><summary>Details</summary>

  The test pressed the digit as soon as the option was enabled, which could be
  before the picker began listening for keys on a busy runner; the key was then
  lost and the test waited out its 5 s limit. It now runs the 400 ms safety delay
  on fake timers inside `act()`, so the listener is attached before the key is
  pressed. Its assertions are unchanged, and the app's behaviour does not change.

  </details>
- change: Add two Linux native GUI cases for the command palette and Files over a real SSH session ([#1788](https://github.com/mihazs/lazysh/pull/1788))

  <details><summary>Details</summary>

  Add two Linux native GUI cases for the command palette and Files over a real SSH session: the palette opens with Ctrl+Shift+P from the focused terminal and with Ctrl+K elsewhere and runs the Files tool, the Terminal tool and End connection from the keyboard, and Files shows Markdown, a PNG and an SVG read over SFTP without running their content (#993). Test-only; no behavior change.

  </details>
- feat(agent): add `lazysh-agent review status` and `review diff` to the host companion ([#1803](https://github.com/mihazs/lazysh/pull/1803))

  <details><summary>Details</summary>

  Add `lazysh-agent review status` and `review diff` to the host companion: the Diff view's changed files and one file's patch from a terminal on the host, as plain text or one JSON line, read-only and under the app's size bounds, with its help in English, Brazilian Portuguese and Spanish. The app and the companion now build their Git review commands in one shared module; the app's behavior does not change.

  </details>
- change: Add the owned Windows OpenSSH server the Windows GUI SSH case will connect to, and a hosted Windows check… ([#1826](https://github.com/mihazs/lazysh/pull/1826))

  <details><summary>Details</summary>

  Add the owned Windows OpenSSH server the Windows GUI SSH case will connect to, and a hosted Windows check that proves it with the real `ssh.exe`: a second `sshd` run by the job user on a fresh loopback port with one throwaway key, accepting only that key, offering the fingerprint the application must show, and leaving the machine's own `sshd` service and every other file untouched. Test infrastructure only; the application, its defaults and the release artifacts are unchanged.

  </details>
- fix: Fix Android Appium CI task selection so the regression suite runs ([#1804](https://github.com/mihazs/lazysh/pull/1804))

## 1.83.1

### Patch Changes

- feat(terminal): register the native backend behind a probe that no release build passes ([#2164](https://github.com/mihazs/lazysh/pull/2164))

  <details><summary>Details</summary>

  Register the native terminal backend in the engine registry behind a probe, the developer override and recorded reasons (#1309, part of #1302). The new `terminal_core_available` command says whether this build has the native core compiled in and a platform host to draw it on (Android only so far); the Native choice and the developer override `lazysh.terminal.backend=native` select the native engine only when it says yes, and otherwise the session uses xterm.js and records the reason. Auto still picks xterm.js, and a screen reader still refuses the native engine. No release build passes the probe, so nothing changes for users; no default changes.

  </details>
- test(terminal): Hold Herdr's navigation-cell detection to both terminal backends ([#2189](https://github.com/mihazs/lazysh/pull/2189))

  <details><summary>Details</summary>

  Part of #1318 and #1302. `herdrNavigationCells.test.ts` now runs each case over the xterm.js adapter and over the native terminal adapter on the stand-in core, on the same bytes, so the right-trimmed, bounded window of rows the native adapter reads gives the same switch-button, switcher and on-screen answers as xterm.js. Test-only: no behaviour, engine or default changes, and xterm.js stays the only registered engine.

  </details>

## 1.83.0

### Patch Changes

- fix: Fix the triple tap gesture never running on a touch screen, and execute triple tap and the desktop session… ([#1777](https://github.com/mihazs/lazysh/pull/1777))

  <details><summary>Details</summary>

  Fix the triple tap gesture never running on a touch screen, and execute triple tap and the desktop session shortcuts in Playwright.

  </details>
- change: Fold the optional hints of the Zellij quick tabs, the Host devices panel, the Preview panel's automatic… ([#1786](https://github.com/mihazs/lazysh/pull/1786))

  <details><summary>Details</summary>

  Fold the optional hints of the Zellij quick tabs, the Host devices panel, the Preview panel's automatic refresh and the Dictation panel behind one closed 44 px line each: **About tab shortcuts**, **About device tools**, **About automatic refresh**, **About dictation**, **About Whisper models** and **About Parakeet**, in English, Brazilian Portuguese and Spanish. The always-visible explanatory text drops from 151, 152, 242 and 135 characters to 19, 18, 23 and 15, and from 212 and 146 characters to 116 and 64 for the Whisper and Parakeet engines. What stays visible: the Preview note that a preview uses the SSH connection, each on-device engine's "audio stays on this device" line (with the Hugging Face download source and the trusted-file advice for Whisper) and the Dictation delivery warning that Auto-send presses Enter and can run commands. No settings or defaults change.

  </details>

## 1.82.1

### Patch Changes

- ci(release): retry release Android builds when a Gradle dependency download fails ([#2185](https://github.com/mihazs/lazysh/pull/2185))

  <details><summary>Details</summary>

  The release source build and the Android artifact job rerun their Gradle build, up to five
  attempts 1, 3, 6 and 10 minutes apart, when Gradle reports a failed dependency download (a Maven
  registry 429 or 5xx, a dropped connection, a truncated POM or a missing group:artifact lookup).
  The Android project's buildSrc also falls back to Maven Central when the plugin portal reports its
  Kotlin classpath missing. Compile, test, lint and dependency-verification failures are never
  retried, and no dependency cache or refresh is added, so release dependencies are still
  downloaded and verified every time.

  </details>

## 1.82.0

### Minor Changes

- feat(herdr): collapse completed agent groups by default ([#1772](https://github.com/mihazs/lazysh/pull/1772))

  <details><summary>Details</summary>

  Completed live Herdr agents are collapsed under Done by default, leaving other statuses visible. Expand Done to see its agents; searching temporarily reveals matching groups and refreshes retain your choice. Changed default: the Done group of live Herdr agents starts collapsed; it was expanded before.

  </details>
- feat(devices): touch an Android device on its video preview ([#1773](https://github.com/mihazs/lazysh/pull/1773))

  <details><summary>Details</summary>

  With **Enable device input** ticked, a tap or swipe on the video is mapped to the display's pixel size that **Verify Android video tools** reports and sent with that size to the host companion (`lazysh-agent devices android tap` and `swipe`). The companion reads the display size again and refuses the gesture with `DeviceDimensionsChanged` when it changed (a rotation or resize) or the point is outside it, so a gesture never lands on the wrong point; the refusal also stops the video. A 180-degree rotation that keeps the size is not detected. Needs the updated host companion; an older one keeps the video view-only. A real Waydroid Android 13 guest accepted and refused gestures as described; the published CI emulator has not run the new case yet. Changed default: the Android video preview is no longer always view-only.

  </details>
- feat(desktop): bundle lazysh-agent with the Linux and Windows packages and prove it in the release ([#1855](https://github.com/mihazs/lazysh/pull/1855))

  <details><summary>Details</summary>

  Ship the matching `lazysh-agent` companion with every desktop package and prove it in the release checks (#1666, part of #1132). The Linux Debian package (`/usr/bin/lazysh-agent`) and AppImage and the Windows installer (`lazysh-agent.exe` beside the app) now carry the very companion the release's companion job built and verified for that platform, so a fresh install has a local companion where the local arm looks first (beside the app, then the managed copy, then the `PATH`, unchanged). The desktop release builds download that artifact, bind its receipt to the commit and version, and stage it through a Tauri `bundle.externalBin` entry used by release builds only. The release job unpacks each package and refuses to publish one whose companion is missing, not executable or different from the published one; the installer acceptance also checks it after the install and after the same-version repair. The AppImage copy is compared with its `RUNPATH` section rewritten by linuxdeploy ignored. The installers grow by one companion executable (about 11 MB). No defaults change; remote companion resolution and installation are unchanged, and macOS packages, which stay deferred, have the check in place but unexercised.

  </details>

### Patch Changes

- fix(account-usage): stop a stalled Windows credential store from holding the Cline quota check ([#1778](https://github.com/mihazs/lazysh/pull/1778))

  <details><summary>Details</summary>

  The Cline store is now read on its own thread with a 3 second deadline: a file on an unreachable share or a cloud placeholder that never finishes downloading is reported as "not signed in" instead of keeping the collection waiting, Windows is asked to cancel the pending read, and at most four such reads can be left behind. The opened file must also be a disk file, so a path replaced by a pipe or device is refused. Cancellation is best effort: it bounds how long the check waits and how many threads it can strand, not the Windows request itself. Linux and macOS are unchanged. Following the Cline profile environment variables on Windows is tracked in #1748 and stays unavailable. No defaults change.

  </details>
- test(android): let the owned tmux fixture forward a DCS-wrapped OSC 52 to its attached client ([#1807](https://github.com/mihazs/lazysh/pull/1807))

  <details><summary>Details</summary>

  The pinned server starts with `allow-passthrough on` (tmux 3.3 or later is now required) and the beta window is an interactive shell, so a test can print the sequence there. A host test attaches a real client and sees the unwrapped request. Test fixture only; no app behaviour changes (#1546).

  </details>

## 1.81.0

### Minor Changes

- feat(herdr): mark the Spaces row this device's own guarded client shows as current ([#1783](https://github.com/mihazs/lazysh/pull/1783))

  <details><summary>Details</summary>

  Issue #591. Stock Herdr only reports the server's shared focus, which another connection can move, so the marker still follows that focus there. With the optional guarded Herdr host attached, the attached client reports its own workspace, tab and pane, and Spaces marks those instead, but only when the report names the server being read; while a Chat turn holds the guard the last reading is kept, and without the guard the marker returns to the shared focus. Needs a guarded Herdr host; it is built from the repository and not distributed yet (#1522). Real two-client acceptance on a device is not part of this change. No defaults change.

  </details>
- feat(devices): inspect and act on an Android device's screen elements from the device controls ([#1774](https://github.com/mihazs/lazysh/pull/1774))

  <details><summary>Details</summary>

  Issue #19. **Inspect screen elements** lists what Android's accessibility service reports on the foreground screen (label, class, resource id, bounds and actionable flags, at most 300), and **Tap** and **Long press** act on one element: the host companion (`lazysh-agent devices android ui tree` and `ui act`) re-reads the screen, finds the one enabled element with that identity and touches the centre of its bounds, or fails without touching anything when none matches. The buttons need **Enable device input**. No scrolling, text entry or iOS accessibility yet. Needs the updated host companion. No defaults change.

  </details>

### Patch Changes

- test(terminal): Run the terminal adapter contract suite against the real core in CI and fail on an untested capability ([#2169](https://github.com/mihazs/lazysh/pull/2169))

  <details><summary>Details</summary>

  Part of #1305 and #1302. A test-only JSON-RPC process over stdio in the terminal runtime crate (`examples/control_stdio.rs`) calls the same session, doorbell and control-plane functions as the app's `terminal_core_*` commands, and the `herdr-native` CI job, which has Zig and Bun, runs the unchanged contract suite over it through the native terminal adapter. A guard now fails when a backend claims a capability that no passing test case verifies, and every backend registered in `terminalBackends.ts` must pass the suite and the cases of each capability it declares. No behaviour changes: the app, the terminal engines and every default are untouched, and xterm.js stays the only registered engine.

  </details>
- fix(client): show the Herdr New workspace and New worktree flow as a full-screen page on phones ([#1776](https://github.com/mihazs/lazysh/pull/1776))

  <details><summary>Details</summary>

  Issue #588. The flow is a long form with a command review and a result, but it opened as a bottom sheet that left the form and its **Cancel** / **Review commands** buttons squeezed under a partial-height card. On a phone window (up to 600 px wide) it now fills the screen under a header whose Close button stays visible while the form scrolls, including at short heights and with the keyboard open; Back, Escape, the explicit command review and the wait for the host to finish are unchanged. Larger windows keep the same centred dialog. No default changes.

  </details>

## 1.80.4

### Patch Changes

- docs(changelog): Write release notes as New, Improved and Fixed lists with one linked line per change ([#2165](https://github.com/mihazs/lazysh/pull/2165))

  <details><summary>Details</summary>

  Each release's notes on GitHub and in `CHANGELOG.md` are now generated from the changeset fragments: a fragment's first line is `type(scope): headline`, the rest is collapsed details, and the notes group the lines as New, Improved, Fixed, Documentation and Under the hood with a link to the pull request. They no longer carry commit hashes, dependency-update lines or repeated "Also included" blocks; the versions that were prepared but never published are listed in one line. Root `CHANGELOG.md` now has a section per release, and its earlier hand-written log is grouped under "Development history". A separate `[Unreleased]` entry is no longer required. No application behaviour and no defaults change.

  </details>

## 1.80.3

### Patch Changes

- 931483b: Teach the shared Rust terminal core to answer what text is under a selection (a range of cells, a word, a line, the whole buffer or the visible screen), to find text in the screen and scrollback, and to apply the clipboard consent limits (64 KiB, valid UTF-8, never partial) to the clipboard writes a terminal program makes with OSC 52, with the same results as the xterm.js engine on shared fixtures that cover wide and combining characters and wrapped lines. Five differences in what OSC 52 offers the user (a write to `s`, `cs` or `ccc` is no longer offered, an unknown target letter is, an empty write is not) are recorded next to the fixture and registered as open, and the primary-only write is settled because the existing policy rejects it too. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- @lazysh/account-usage@1.80.3
  - @lazysh/common@1.80.3
  - @lazysh/display-idle@1.80.3
  - @lazysh/et-transport@1.80.3
  - @lazysh/mosh-transport@1.80.3

## 1.80.2

### Patch Changes

- d173b72: Run the Linux native surface composition probe in CI: a new `native-linux-surface` job builds `packages/terminal-runtime/prototypes/linux-surface` and runs its checks under a headless sway compositor (pixels read back with grim) for `wl_shm` and a wgpu Vulkan swapchain on lavapipe at scale 1 and 2, and on Xvfb for X11, asserting exact anchor pixels, overlap, resize and recreate. CI and prototype only; no behaviour changes.
- 5cdafc7: Keep the Playwright e2e fixtures out of the `src` type-check that the release source build runs. The terminal backend selection and `onAdapter` now live in a Playwright-free module under `src`, so the F-Droid build, which removes `playwright-core`, type-checks again; the terminal e2e specs behave as before. Internal build fix: no behaviour changes for users.
- 578289d: Build the client with Bun (`bun build/build.ts`: Bun transpiles the TypeScript and bundles it, with code splitting) instead of `tsc -b && vite build`, so the build is much faster and a type error in a test or an e2e fixture can no longer fail a release source build. `tsc -b` now only type-checks, in `client:check`, which `checks` and the main verdict still run. Vite stays the dev server and the Vitest and Playwright runtime. Build tooling only; the app's behaviour does not change.
- @lazysh/account-usage@1.80.2
  - @lazysh/common@1.80.2
  - @lazysh/display-idle@1.80.2
  - @lazysh/et-transport@1.80.2
  - @lazysh/mosh-transport@1.80.2

## 1.80.1

### Patch Changes

- e331eae: Add a Windows composition probe for the native terminal engine (#1332, part of #1302): a standalone tao and wry program under `packages/terminal-runtime/prototypes/windows-surface` and a `windows-surface-probe` workflow that opens the real window and WebView2 page on a `windows-latest` runner, stacks a child window below the transparent web view (GDI-painted and as a Direct3D 12 swapchain) and above it with the page's overlay cut out of it, reads its own window back with `PrintWindow` and a screen copy, and writes what it saw. On the hosted runner a Direct3D 12 child below the transparent WebView2 shows through exactly, with an opaque or a transparent tao window; the job fails if that stops holding. Nothing in the app, its terminal engine or its defaults changes: Windows keeps xterm.js and Auto resolves to xterm.js there.
- ed94471: Add the client's bridge over the native terminal core's commands: it opens a core, hands the transport the Channel the core's reports arrive on, pulls the screen's state at most once per 16 ms however much output arrives, sends typed text and pastes, drops input while the app is locked and wakes the core again after the unlock. Nothing registers the native engine yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
- @lazysh/account-usage@1.80.1
  - @lazysh/common@1.80.1
  - @lazysh/display-idle@1.80.1
  - @lazysh/et-transport@1.80.1
  - @lazysh/mosh-transport@1.80.1

## 1.80.0

### Minor Changes

- 1772589: Add the Host browser switch to host settings: a separate row, off by default, that reads and saves the companion's `settings host-browser` setting with its own revision, and asks once per host on this device, naming what the browser can reach, before it is turned on. The confirmation stays on the device and never enters the encrypted sync. A companion without the command shows the row as unavailable with an update message. The browser view itself ships with the Chrome viewer.

### Patch Changes

- b522053: Build libghostty-vt against the Apple SDK and run the terminal core's and the wgpu renderer's tests on `macos-latest` (aarch64-apple-darwin, the renderer on Metal) in a new report-only `terminal-macos` CI job on pushes to `main`, so a break that only shows on macOS no longer waits for a native surface to be written. The first hosted run found that a macOS build of libghostty-vt sends no ESC prefix for Alt unless told Option is Alt, so the core now says so on every key encode; two tests that assumed a non-Apple host were fixed. The core is not wired into the app yet: no behaviour changes for users.
- 62e9f7f: Add the native terminal core's control-plane commands and event stream: state, scrolling, sizing and a bounded window of row text, never cell data, plus a change doorbell and the program's title, bell, directory and clipboard reports on the session's Channel. Nothing creates a native session yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
- ea11422: Compact the scrollback of native terminal sessions nobody is looking at (#1338): a session with no view attached that has received nothing for two seconds has its history compressed by libghostty-vt in small steps on an idle worker, and it is restored on access. On one desktop host a full session went from about 4 MiB to about 0.5 MiB resident and ten sessions from about 40 MiB to about 8 MiB when nine were idle, with the history unchanged. The native core is not the default engine: xterm.js stays the default, and no setting or default changes.
- @lazysh/account-usage@1.80.0
  - @lazysh/common@1.80.0
  - @lazysh/display-idle@1.80.0
  - @lazysh/et-transport@1.80.0
  - @lazysh/mosh-transport@1.80.0

## 1.79.7

### Patch Changes

- 173aa0d: Run the six named terminal end-to-end specs per terminal backend (#1703): `LAZYSH_E2E_TERMINAL_BACKEND=xterm|native bun run test:e2e:terminal` sets the developer override before the page loads and `onAdapter` fails the spec when the terminal on screen is another backend, so a silent fallback cannot pass as the requested engine. CI runs the xterm arm and a native arm that is reported skipped, with the backend registry's reason, until the native backend is registered. Test code and CI only; no product behaviour changes.
- @lazysh/account-usage@1.79.7
  - @lazysh/common@1.79.7
  - @lazysh/display-idle@1.79.7
  - @lazysh/et-transport@1.79.7
  - @lazysh/mosh-transport@1.79.7

## 1.79.6

### Patch Changes

- 5d29b1a: Fix the owned Android SSH parity job on its CI emulator (#1737): the Files and preview cases connected on the Auto transport, which starts a real mosh-server on their command-running sshds and failed intermittently with "Mosh connection ended before startup completed". Both cases now choose SSH in the Add Host dialog. Test infrastructure only; the app is unchanged.
- 6d90b09: Teach the wgpu renderer of the native terminal engine to blink the cursor from one shared timer (no timer at all while blink is off or the cursor is hidden), pace frames to the display refresh, follow a display scale change, and recover from a lost GPU device from the core's state with the same pixels. It is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying the native engine behind an explicit opt-in.
- @lazysh/account-usage@1.79.6
  - @lazysh/common@1.79.6
  - @lazysh/display-idle@1.79.6
  - @lazysh/et-transport@1.79.6
  - @lazysh/mosh-transport@1.79.6

## 1.79.5

### Patch Changes

- b0e1608: Run the native terminal core's performance gate (`terminal-perf`) on pull requests that touch `packages/terminal-runtime`, `packages/terminal-renderer-wgpu` or the vendored ghostty-vt binding, not only on pushes to `main`, so a regression in parse-to-frame cost, allocations, scrollback rows, memory per session or renderer upload volume shows on the pull request that causes it (#2141, part of #1302). The job keeps its injected-slowdown and injected-allocation self-checks and stays report-only, because making it a required check is a repository ruleset change. CI only; the app, its terminal engine and its defaults are unchanged.
- 08a6272: Add the program workloads of the terminal benchmark suite (W5 vim, W6 tmux and Zellij, W7 Mosh resize and reconnect, W8 agent screens and streaming, W11 background, resume and surface recreation): renderer-neutral replayable workloads built from the recorded captures, an xterm.js page runner and Playwright spec that can also drive an Android WebView on the Waydroid lane, and a native core example that replays the same bytes against the same screens. Test and documentation only; no behaviour changes.
- @lazysh/account-usage@1.79.5
  - @lazysh/common@1.79.5
  - @lazysh/display-idle@1.79.5
  - @lazysh/et-transport@1.79.5
  - @lazysh/mosh-transport@1.79.5

## 1.79.4

### Patch Changes

- 46786ee: Remember a per-device terminal engine choice (Auto, Native or xterm.js) and record, for every new session, which engine it got and why, with the reasons in English, Brazilian Portuguese and Spanish (#2092, first slice, part of #1302). New sessions ask the registry for the saved choice, the developer override still wins, and an open session keeps its engine. The choice is never part of encrypted sync. There is no Settings control yet and only xterm.js is registered, so every choice runs xterm.js and nothing changes for users; no default changes.
- 76f1473: Mount a native terminal session through its anchor: the terminal pane attaches a native adapter to its container, places the Android native surface on it through the anchor tracker and takes it down when the pane is hidden or ends, and while a surface is shown every ancestor of the container stops painting its background so the surface below the page is visible, with the composer and other overlays above it. An xterm.js pane is unchanged. No backend registration gives a session a native terminal and release builds refuse the surface commands, so xterm.js stays the only engine and the default and nothing changes for users.
- @lazysh/account-usage@1.79.4
  - @lazysh/common@1.79.4
  - @lazysh/display-idle@1.79.4
  - @lazysh/et-transport@1.79.4
  - @lazysh/mosh-transport@1.79.4

## 1.79.3

### Patch Changes

- ec4ad0f: Add the iOS native surface composition proof of concept: a standalone simulator host stacks an `MTKView` below a transparent `WKWebView` and an XCUITest in the iOS simulator job reads placement, DOM overlap, touch routing, scrolling, keyboard resize, safe areas, rotation and lifecycle from the composited pixels. Test-only; the app, its web view and its capabilities are unchanged.
- @lazysh/account-usage@1.79.3
  - @lazysh/common@1.79.3
  - @lazysh/display-idle@1.79.3
  - @lazysh/et-transport@1.79.3
  - @lazysh/mosh-transport@1.79.3

## 1.79.2

### Patch Changes

- 02c6e90: Add the Waydroid lane harness for the native terminal engine's Android acceptance (`apps/client/bench/waydroid-lane.sh` and its runbook): it starts or attaches to a headless Waydroid session, installs APKs, runs named instrumentation classes and benchmark commands, tears down and writes an evidence JSON with the guest's environment and the accepted-risk block, and it refuses to run, or to skip, with its own exit code. Test and documentation only; no behaviour changes.
- @lazysh/account-usage@1.79.2
  - @lazysh/common@1.79.2
  - @lazysh/display-idle@1.79.2
  - @lazysh/et-transport@1.79.2
  - @lazysh/mosh-transport@1.79.2

## 1.79.1

### Patch Changes

- 74d15b8: Add the page side of the developer-only Android native terminal surface: a tracker that keeps the surface on a DOM element through layout, scroll, zoom and transitions, with at most one placement command in flight, no work while the page is idle, and the surface taken down when the element has no box, the shell refuses, or tracking stops. Nothing in the app creates a tracker yet and release builds refuse the commands, so xterm.js stays the only engine and the default and nothing changes for users.
- 0b79706: Settle every open difference between the shared Rust terminal core and xterm.js (#1314, slice 1314b, part of #1302): each entry of the divergence registry now carries a recorded decision and the test that pins it, and tmux, vim, bash, Herdr, Claude Code, Codex and OpenCode run on a pty with the core as their terminal in the core's own tests. The review approves the core's Unicode 11 and later widths (emoji, ZWJ and skin-tone sequences take two cells), the standard Alt+arrow encodings, the Kitty keyboard reports Codex and Herdr ask for, libghostty-vt's device attributes, the OSC 52 selection filter and reflow on resize, and moves Shift+PageUp routing to #1334. The core is not wired into the app and xterm.js stays the only engine and the default, so nothing changes for users; the release notes of the Android default (#2094) must call out the widths, the Alt+arrow form, reflow and the dropped primary-selection writes.
- @lazysh/account-usage@1.79.1
  - @lazysh/common@1.79.1
  - @lazysh/display-idle@1.79.1
  - @lazysh/et-transport@1.79.1
  - @lazysh/mosh-transport@1.79.1

## 1.79.0

### Patch Changes

- 51fd7f4: Compile the app's native terminal bridge with the `native-terminal` feature in CI and run its real-core tests (the local PTY, the 100-session churn, the core's input encoding and the transport cases) in a new `native-terminal-bridge` job, so a change to the terminal core crate that breaks the bridge fails on its pull request instead of reaching `main` unnoticed (#1620). The 100-session churn test now waits for the core to finish parsing a session's last output instead of reading the screen the moment the PTY closes, which failed on a loaded host.
- 3d71ef8: Refuse to stage or publish a release package that is more than 1.5 times the size measured on v1.62.0, and record the measured sizes of every published package in the release documentation. Release tooling only; installed applications do not change.
- 20cc3da: Record which tmux or rmux server a hook's pane belongs to. A pane id such as `%7` is unique only inside one server, so a report from `tmux -L work` and one from the default server could carry the same id; the companion now adds `paneServer` (`tmux:work`, `rmux:default`) read from the `TMUX` or `RMUX` socket path, the Agents panel's report details show it, and a socket given with `-S` records none. The field is optional in the snapshot, so an older companion or client works unchanged.
- @lazysh/account-usage@1.79.0
  - @lazysh/common@1.79.0
  - @lazysh/display-idle@1.79.0
  - @lazysh/et-transport@1.79.0
  - @lazysh/mosh-transport@1.79.0

## 1.78.2

### Patch Changes

- 2005943: Extend the Android tmux acceptance case: it now splits a window's pane top/bottom and zooms and unzooms the new pane from the Sessions panel (the tmux client's display is the witness, also after a detach and reattach), and the host checks that the original pane process is untouched. Test-only; no behaviour changes.
- @lazysh/account-usage@1.78.2
  - @lazysh/common@1.78.2
  - @lazysh/display-idle@1.78.2
  - @lazysh/et-transport@1.78.2
  - @lazysh/mosh-transport@1.78.2

## 1.78.1

### Patch Changes

- e163639: Let the native terminal bridge receive the text a soft keyboard or an IME committed (#1791, part of #1328): a `text` event reaches the terminal verbatim, whatever keyboard protocol or bracketed paste the program enabled. The core is not wired into the app, so nothing changes for users: xterm.js stays the only engine and no setting or default changes.
- 2355d62: Extend the Android shared Herdr navigation case: it now drives the Sessions panel's Herdr browser to create a workspace, rename it, split its pane down and zoom it, and the host reads the workspace back from Herdr (label, directory, two panes and the zoom flag) while the navigation receivers stay at zero bytes. Test-only; no behaviour changes.
- 08ac1dd: Teach the shared Rust terminal core to answer the colour queries programs send to pick a light or dark scheme (default foreground, background and cursor with `OSC 10`, `11` and `12`, and the palette with `OSC 4`) from a theme in its configuration, with the replies xterm.js gives (#1314). The core is not wired into the app and xterm.js stays the only engine and the default, so nothing changes for users; this removes one recorded difference before a native engine can be offered as an opt-in.
- @lazysh/account-usage@1.78.1
  - @lazysh/common@1.78.1
  - @lazysh/display-idle@1.78.1
  - @lazysh/et-transport@1.78.1
  - @lazysh/mosh-transport@1.78.1

## 1.78.0

### Minor Changes

- 3911078: Attach files and open previews of development servers from a local desktop session.
- 0eb9271: Add Check for updates to the Host companion installation panel and run the host's own `lazysh-agent update` command when available.

### Patch Changes

- f64ec4c: Verify the Agent board in the Linux desktop app with real companion hook events: one row per session in Needs you, Working and Done, grouped by project and host, a pending approval listed above the board and answered from it. Test and documentation only. No user-visible behaviour changes.
- 7da1e6b: Read terminal state through the TerminalAdapter in the terminal end-to-end specs (#1703): a new Playwright fixture (`e2e/fixtures/terminalState.ts`) takes rows, viewport, selection, geometry and the input element from the adapter of the terminal on screen, and `terminal-ime`, `terminal-swiftkey`, `terminal-selection`, `terminal-clipboard`, `herdr-switch-tap` and `mosh-resize` use it instead of xterm's `.xterm-*` DOM. Test code only; no product behaviour changes, and the specs keep every assertion and pass unchanged on xterm.js at the desktop and phone viewports.
- @lazysh/account-usage@1.78.0
  - @lazysh/common@1.78.0
  - @lazysh/display-idle@1.78.0
  - @lazysh/et-transport@1.78.0
  - @lazysh/mosh-transport@1.78.0

## 1.77.2

### Patch Changes

- 7fd3f2a: Add the host browser's input as client components, driven in the developer-only prototype viewer and covered by a real-Chromium test: a Control switch that is off at every start and sends nothing while off, tap, double tap, long press, drag, Select, pinch with Zoom page, and the phone keyboard with composition, accents, emoji and key chords. Not in the app until the host browser view ships; no default changes.
- @lazysh/account-usage@1.77.2
  - @lazysh/common@1.77.2
  - @lazysh/display-idle@1.77.2
  - @lazysh/et-transport@1.77.2
  - @lazysh/mosh-transport@1.77.2

## 1.77.1

### Patch Changes

- b377e2e: Let the native multiplexer commands (tmux, Herdr and Zellij discovery, session lists, tmux and Zellij actions and the Zellij tab list) run against a local desktop session as argument lists, with a Rust `PATH` lookup and an owner-checked `~/.local/bin` fallback for Herdr. The interface still hides these views for local sessions, and SSH sessions behave as before.
- 9254cea: Build the shared terminal runtime for Android arm64 and x86_64 (#2098, part of #1312 and #1302): the Herdr binding's build script maps `aarch64-linux-android` and `x86_64-linux-android` to the Zig targets of libghostty-vt, and CI checks and links the runtime for both ABIs with the pinned NDK. Build and CI only; nothing runs on Android, the app does not use the runtime yet, and xterm.js stays the only engine.
- @lazysh/account-usage@1.77.1
  - @lazysh/common@1.77.1
  - @lazysh/display-idle@1.77.1
  - @lazysh/et-transport@1.77.1
  - @lazysh/mosh-transport@1.77.1

## 1.77.0

### Minor Changes

- b4b60b0: Start an agent in a new Git worktree, or in a chosen folder, from the Agent view's empty state.

### Patch Changes

- 8fb356d: Add the tmux and Zellij launch primitive (#1141): a confirmed plan that checks the agent, optionally creates a Git worktree and starts the agent's literal argv in a new tmux window or Zellij pane of the attached session, returning the new pane's ID. Backend only: nothing in the app calls it yet, and no defaults change.
- cb119e8: Add the keyboard side of an Android native terminal surface for developer builds: an app-owned `InputConnection` that holds composing text on the device, turns autocorrect and prediction edits into the shortest edit on the host and never replays an edit it cannot follow, and forwards hardware keys as key identities for the shared core to encode. Nothing in the app creates it yet, so xterm.js stays the only engine and the default and nothing changes for users; this is groundwork for the Android native-engine opt-in.
- @lazysh/account-usage@1.77.0
  - @lazysh/common@1.77.0
  - @lazysh/display-idle@1.77.0
  - @lazysh/et-transport@1.77.0
  - @lazysh/mosh-transport@1.77.0

## 1.76.0

### Minor Changes

- 0f9abbf: Check a sign-in hint against the host's listeners. A new native command asks the host which process listens on the port a sign-in command printed (the host companion's `lazysh-agent listeners`, or `ss` and `lsof` for a companion that predates it) and tells whether the listener started within two minutes before or half a minute after the hint, is older, is another user's, or is not there; `confirmHint` turns a series of answers into one confirmation, counting a listener that appeared after the port was empty. Nothing is tunnelled and no screen uses it yet.

### Patch Changes

- @lazysh/account-usage@1.76.0
  - @lazysh/common@1.76.0
  - @lazysh/display-idle@1.76.0
  - @lazysh/et-transport@1.76.0
  - @lazysh/mosh-transport@1.76.0

## 1.75.1

### Patch Changes

- 7514d76: Verify through the real Android app that Mosh runs the configured server path on the configured single-port UDP range, with the host confirming the UDP port the owned mosh-server holds.
- 7514d76: Verify through the real Android app that Auto falls back to the trusted SSH terminal and reports why Mosh and Eternal Terminal were skipped, and that forced Eternal Terminal reaches an owned `etserver`. The official ET 7.0.0 fixture build now lives in one script shared by the Linux runtime and Android SSH parity jobs.
- @lazysh/account-usage@1.75.1
  - @lazysh/common@1.75.1
  - @lazysh/display-idle@1.75.1
  - @lazysh/et-transport@1.75.1
  - @lazysh/mosh-transport@1.75.1

## 1.75.0

### Minor Changes

- 57e0866: Show the last response's context for Claude Code in the Usage view and the recorded context remaining (window minus the last response) where the transcript records a window; unknown stays unknown.

### Patch Changes

- dd08c7c: Add a performance regression gate for the native terminal core to CI (#1341): a separate, non-required job (pushes to `main` only) runs the core's parse, frame, allocation, scrollback and memory metrics against limits and fails when one regresses, and proves on every run that it fails on an injected slowdown and on injected allocations. Nothing in the app changes: xterm.js stays the only terminal engine and the default, and no setting or default changes.
- 71cad89: Prepare screen-reader access for a native terminal surface: a hidden, bounded mirror of the visible rows with a polite announcement log, and a rule that a session read with a screen reader never gets a terminal engine that cannot reach one. xterm.js stays the only engine and nothing offers another one yet, so terminal behaviour and defaults do not change.
- @lazysh/account-usage@1.75.0
  - @lazysh/common@1.75.0
  - @lazysh/display-idle@1.75.0
  - @lazysh/et-transport@1.75.0
  - @lazysh/mosh-transport@1.75.0

## 1.74.0

### Minor Changes

- f2eaf0d: Add the sign-in tunnel engine: a loopback listener on the host CLI's callback port that forwards one checked browser request per connection to the host over the session's SSH connection, with a request guard, per-host consent policy, caps and a one-shot lifetime. Groundwork for automatic SSO sign-in from the device (#1504); nothing in the app starts a tunnel yet.

### Patch Changes

- 2fdde45: Record the cold start of the WebAssembly build of the terminal core against xterm.js in Node, as measured evidence for the terminal engine decision (#1323). Benchmark script and raw results only: the terminal engine is unchanged, xterm.js with its DOM renderer stays the only engine and the default, and no setting or default changes.
- @lazysh/account-usage@1.74.0
  - @lazysh/common@1.74.0
  - @lazysh/display-idle@1.74.0
  - @lazysh/et-transport@1.74.0
  - @lazysh/mosh-transport@1.74.0

## 1.73.1

### Patch Changes

- bd84bc4: Add the native terminal engine's adapter (control plane only) and make it pass the terminal adapter contract suite against a stand-in core. Nothing selects it yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
- eac00bf: Keep the Android startup cover over a rendering WebView until its first frame is painted, so the app no longer flashes the page's earlier placeholder frame after the cover leaves. The WebView stays inert behind the cover, the cover keeps its logo instead of showing the lock controls while it waits, and a 300 ms limit keeps the app from ever staying covered.
- @lazysh/account-usage@1.73.1
  - @lazysh/common@1.73.1
  - @lazysh/display-idle@1.73.1
  - @lazysh/et-transport@1.73.1
  - @lazysh/mosh-transport@1.73.1

## 1.73.0

### Minor Changes

- abd2014: Answer a Claude Code agent's permission requests and questions from the Agent view under Herdr, as on tmux. For the agent of the focused Herdr pane the approval dock decides the hook request (matched by session id, because a Herdr hook has no tmux pane) and the open question is answered with the keys a person presses, through Herdr's own `agent send-keys`, on a stock or a guarded host.
- abd2014: Answer the list dialogs of Claude Code and Codex from the Agent view under Herdr, as on tmux: the `/model` and `/resume` pickers, the trust prompt, the plan decision and Codex's approval prompt. The Agent view reads the followed agent's pane through Herdr (`agent read`), shows the dialog as a card, and answers with the arrows and Enter a person presses through Herdr's own `agent send-keys`, reading the highlight back before Enter. The agent's report names what it waits for, so a permission request or a question keeps its own card. The header of a blocked Herdr agent now says what it waits for and since when. A typed free-text answer to a question under Herdr now picks the free-text row and goes to the pane as one literal line and its Enter.
- abd2014: Answer the questions and dialogs of the agent followed in a Zellij pane from the Agent view, as on tmux and Herdr. The host reads the agent's own pane (`zellij action dump-screen --pane-id`, new read-only command `zellij_agent_screen`) because the terminal shows Zellij's composite screen, the dialog card shows the list dialog that is open (`/model`, `/resume`, the trust prompt, the plan decision, Codex's approval prompt), and a tap sends the arrows and Enter a person presses with Zellij's own `send-keys`, which writes an arrow for the cursor-key mode of that pane, after reading the highlight back. A Claude Code question is answered with its option's digit, or a typed line and its Enter, through the same input. The host proves the pane runs the agent before every key.

### Patch Changes

- d6b93c0: Split the 2,500-line `App.test.tsx` client suite into ten per-area files that share one harness, so vitest runs them in parallel and no single file holds the client check's critical path. Test-only: no application behaviour changes.
- @lazysh/account-usage@1.73.0
  - @lazysh/common@1.73.0
  - @lazysh/display-idle@1.73.0
  - @lazysh/et-transport@1.73.0
  - @lazysh/mosh-transport@1.73.0

## 1.72.0

### Patch Changes

- 17ebbc2: Keep the Usage view's intro text behind a disclosure and show its recorded-usage panel again.
- 2320cc2: Bind a remote approval to the exact Zellij or Herdr pane its hook runs in: the request carries `zellij:<session>:<pane>` or `herdr:<session>:<pane id>` in its hash and decision, and any other pane, session or multiplexer is refused.
- 5962a51: Add a developer-only native terminal surface host to the Android app: a `SurfaceView` stacked below the page that a native terminal engine will draw on, placed from a DOM element and kept across stop and start and Activity recreation. Release builds refuse every command and nothing in the app calls it yet, so xterm.js stays the only engine and the default and nothing changes for users; this is groundwork for the Android native-engine opt-in.
- 9dddd58: Map the History lines setting to the byte budget of the native terminal core, so the core keeps at least that many rows of plain, coloured and syntax-highlighted output at any width instead of a fixed number of bytes that held 5,300 rows at 80 columns and 2,200 at 200. `terminal_core_open` now takes the setting in lines. The native core is not reachable from the app yet and xterm.js stays the only engine, so terminal behaviour does not change and no defaults change.
- @lazysh/account-usage@1.72.0
  - @lazysh/common@1.72.0
  - @lazysh/display-idle@1.72.0
  - @lazysh/et-transport@1.72.0
  - @lazysh/mosh-transport@1.72.0

## 1.71.0

### Minor Changes

- 9e0b1c3: Redesign the work rows of the Agent view: tool calls, thinking, folded activity and sub-agents as quiet tonal rows with a status mark and a chevron, the plan as a checklist whose chip fills as steps finish, and borderless question and failure cards.
- 9e0b1c3: Redesign the Agent view message box: a rounded field that grows with the text, round 44 px controls, a Send button that shows when a message is being delivered, and Commands and Files chips that insert / and @ for touch keyboards.
- 9e0b1c3: Redesign the frame of the Agent view: a two-line header with state and chips, a floating Jump to latest button, a typing-dots working line, an empty state, tinted errors and a compact layout for short windows.
- 9e0b1c3: Redesign how the Agent view reads a conversation: a compact prompt bubble, the answer as plain text in a centred column, code blocks with a language label, Copy code and syntax colours, GitHub-flavoured Markdown tables, restyled quotes, and the time a message was sent on a tap.

### Patch Changes

- 366455d: Check the native terminal core's data path against real servers in CI: a real OpenSSH server, the official mosh-server and the official Eternal Terminal server. A deterministic workload through a real PTY reaches a core byte-exact and in order (Mosh: its final screen arrives) with at most one credit window queued and no output message on the WebView channel. No user-visible change: the native terminal engine is not exposed in settings yet and xterm.js stays the only terminal.
- fcca240: Fix the toolbar paste key on the Linux desktop app: the window now has page clipboard access, so WebKitGTK allows the clipboard read instead of showing "Clipboard access was unavailable".
- @lazysh/account-usage@1.71.0
  - @lazysh/common@1.71.0
  - @lazysh/display-idle@1.71.0
  - @lazysh/et-transport@1.71.0
  - @lazysh/mosh-transport@1.71.0

## 1.70.0

### Minor Changes

- d64fc31: Stream an OpenCode session into the Agent view instead of polling it. `lazysh-agent transcript-watch` now takes `--agent opencode --path DATABASE --database-session ID` and watches the database together with its write-ahead log, where OpenCode's newest rows sit until a checkpoint, so a reply that grows or a tool result that lands reaches the view within a second. The view opens the same live channel for an OpenCode pane as for Claude Code and Codex, and falls back to polling when the host companion is older.
- a7c46e9: Detect sign-in callbacks in terminal output. When a command on the host (`aws sso login`, `codex login`, `gcloud auth login`, `wrangler login`, `terraform login`, `vault login -method=oidc` and similar) prints an authorize URL whose `redirect_uri` is `http://localhost:PORT`, the native output path now notices it, also while the WebView is suspended, and announces a sign-in hint (port, callback path, identity provider host, whether the URL carries a PKCE challenge) to the app. Colours, hyperlinks, a URL the program wrapped and any chunking of the output are handled; dev-server addresses, redirects to public hosts, ports below 1024 and URLs over 4096 bytes are ignored, and no query value (`code`, `state`) is ever kept. Nothing is tunnelled or opened yet: the hint is only reported.

### Patch Changes

- 31a2337: Require a regression test or a stated reason on every `fix(...)` pull request: an AGENTS.md rule, a "Regression test" section in the pull request template and the bug template, and a `regression-test` check that also lists the Appium regression specs by issue. Workflow only; no product change.
- fb49d1a: Compare the native terminal engine with xterm.js: 91 replayable screens (colours, cursor, editing, Unicode, alternate screen, modes, paste, resize, captures of vim, less, tmux, Claude Code, Codex, OpenCode, Zellij and Herdr, and the six captured Mosh frames), 75 key presses and 130 mouse reports run through xterm.js 5.5.0 and through the Rust core, with 28 differences recorded and explained. The comparison also fixed a defect in the core's mouse reporting: under any-event tracking a resting pointer sent a report for every pointer event in one cell, where xterm.js sends one. The core is not wired in as an engine you can choose yet, so nothing changes in the app; xterm.js stays the terminal engine.
- @lazysh/account-usage@1.70.0
  - @lazysh/common@1.70.0
  - @lazysh/display-idle@1.70.0
  - @lazysh/et-transport@1.70.0
  - @lazysh/mosh-transport@1.70.0

## 1.69.0

### Minor Changes

- 9bccde7: Let the host companion update itself to this app's version. Every command the app runs on a Linux or macOS host now carries the app's version in `LAZYSH_APP_VERSION` (companions that do not know it ignore it). When a companion that is older than the app updates itself, the Agents panel shows one non-blocking line, "Updating the host companion to X…", then the new version, and views that were waiting for a newer companion (the live conversation stream) ask again at once. Host companion settings gain **Companion updates** (Update automatically, Only tell me, Never) for a companion that has `lazysh-agent auto-update`. English, Brazilian Portuguese and Spanish.

### Patch Changes

- 5484ebb: Fix typing stopping in the terminal with the SwiftKey keyboard until Backspace was pressed (#1505): the terminal now notices that Android's WebView dropped a composition the keyboard erased whole, instead of waiting for an end that never comes and holding back every key after it.
- @lazysh/account-usage@1.69.0
  - @lazysh/common@1.69.0
  - @lazysh/display-idle@1.69.0
  - @lazysh/et-transport@1.69.0
  - @lazysh/mosh-transport@1.69.0

## 1.68.3

### Patch Changes

- e49e9b7: Keep the host adb server's own log (`adb-server-log.txt`, last 1 MiB) in the Android runtime artifact when a job fails, so an interrupted emulator transport records why the server dropped it (`connection terminated: <reason>`). Test infrastructure only; no product change.
- 910aef8: Run the companion's exact pane focus against a real stock Herdr server in the desktop acceptance: a live pane without focus becomes the only focused pane and its tab becomes the focused tab. Test coverage only; no product change.
- 8f2a455: Make the client's unit tests compile on Windows again: the ConPTY lifecycle test called `desktop::connect` without the `attach` argument added with local multiplexer attach, so no Windows step that builds the client library tests could run (#1905). Test-only; no user-visible change.
- @lazysh/account-usage@1.68.3
  - @lazysh/common@1.68.3
  - @lazysh/display-idle@1.68.3
  - @lazysh/et-transport@1.68.3
  - @lazysh/mosh-transport@1.68.3

## 1.68.2

### Patch Changes

- 8f2308a: Pin the Android tmux acceptance case's host readback for the window rename: a real-tmux test requires it to refuse a rename that reached an original window and an original pane that was replaced, and the parity matrix records that the create, rename and close step ran green on `main`. Test and documentation only; no behaviour changes.
- 24e0b21: Make the installed Windows GUI check blocking. It passed in a `main` run (run 43790076928, push of `b5668f94`, `native-desktop (windows-latest)`: the identity, `--host` and `--dir` scenarios, `3 pass`, `0 fail`), which was the condition for removing `continue-on-error` from its workflow step, so a failure of the installed application's window, saved-host dialog or singleton delivery on Windows now fails the job instead of being reported as a success. Test-only; the application is unchanged.
- @lazysh/account-usage@1.68.2
  - @lazysh/common@1.68.2
  - @lazysh/display-idle@1.68.2
  - @lazysh/et-transport@1.68.2
  - @lazysh/mosh-transport@1.68.2

## 1.68.1

### Patch Changes

- d998491: Retry a briefly busy local companion executable during version checks (#1923).
- d998491: For ordinary sessions, continue the Auto transport fallback sequence when a Mosh startup fails, instead of refusing with "Mosh connection ended before startup completed": the startup error the Mosh or Eternal Terminal worker reports now wins over the cancel that follows it. Once a Mosh multiplexer entry has been started, a failed startup retains its explicit non-fallback error.
- d998491: Keep changed terminal dialogs disabled until their safety delay has elapsed, reject stale option descriptions or pane checks, and keep pending answers from being re-enabled by older responses.
- @lazysh/account-usage@1.68.1
  - @lazysh/common@1.68.1
  - @lazysh/display-idle@1.68.1
  - @lazysh/et-transport@1.68.1
  - @lazysh/mosh-transport@1.68.1

## 1.68.0

### Minor Changes

- 8881a6b: Open and page through larger Codex conversations using a bounded full-history index.

### Patch Changes

- 8881a6b: Fix Android Appium CI task selection so the regression suite runs.
- 8881a6b: Fix the owned Android SSH parity job on the Ubuntu 22.04 CI runner (#1737): its host-side check of the Files fixture read the SFTP listing as OpenSSH 10 prints it (path-prefixed names) and found nothing in OpenSSH 8.9's bare names, so the job failed after the emulator cases had passed. The listing now accepts both. Test infrastructure only; the app is unchanged.
- 8881a6b: Open a conversation whose workflow has no summary file instead of refusing the page.
- 8881a6b: Show a clear notice when a Herdr agent conversation exceeds its supported size.
- 8881a6b: Accept the compaction line of a Codex conversation in the Agent view instead of refusing the page.
- @lazysh/account-usage@1.68.0
  - @lazysh/common@1.68.0
  - @lazysh/display-idle@1.68.0
  - @lazysh/et-transport@1.68.0
  - @lazysh/mosh-transport@1.68.0

## 1.67.1

### Patch Changes

- deedfe4: Mark the Agent board and remote-approval rows of the parity matrix that the real companion hook cases already proved on `main` (desktop owned OpenSSH, Android companion install) as verified, and list what remains. Documentation only. No user-visible behaviour changes.
- @lazysh/account-usage@1.67.1
  - @lazysh/common@1.67.1
  - @lazysh/display-idle@1.67.1
  - @lazysh/et-transport@1.67.1
  - @lazysh/mosh-transport@1.67.1

## 1.67.0

### Patch Changes

- 93d2e86: Add an Android instrumentation case that observes the operating system after a remote OSC 52 request is allowed (the system clipboard) and after Open in browser is tapped on a terminal link (an `ACTION_VIEW` intent for that URL). Test coverage only; no app behaviour changes.
- f25f379: Mark the Windows installed-application cases that passed in a `main` run (run 43790076928: identity, saved-host dialog, singleton `--host` and `--dir` delivery) in the parity matrix, and list what remains for the Windows GUI (the authenticated SSH terminal and saved-host add, edit, delete and persist). Documentation only. No user-visible behaviour changes.
- @lazysh/account-usage@1.67.0
  - @lazysh/common@1.67.0
  - @lazysh/display-idle@1.67.0
  - @lazysh/et-transport@1.67.0
  - @lazysh/mosh-transport@1.67.0

## 1.66.1

### Patch Changes

- @lazysh/account-usage@1.66.1
  - @lazysh/common@1.66.1
  - @lazysh/display-idle@1.66.1
  - @lazysh/et-transport@1.66.1
  - @lazysh/mosh-transport@1.66.1

## 1.66.0

### Minor Changes

- 1d41c8a: Answer the questions Codex asks from the Agent view. When Codex opens a `request_user_input` question on tmux, the dialog card above the message box shows the question, its place among the questions (`Question 1/2`) and the options with Codex's highlight, and a tap moves the highlight with the arrow keys, reads it back and presses Enter, as a person would. Codex then shows its next question as its own card. It works at a phone's width, where Codex wraps the question, both columns of an option and the footer. The card offers no **Cancel the dialog** for a question, because Esc interrupts Codex's turn there; the notes box (Tab) stays in the terminal and shows the banner that the agent waits there.

### Patch Changes

- ec3b23d: Make the installed Windows GUI check able to pass on a hosted runner, and drive saved hosts and singleton delivery through it. Its composite action carried a `timeout-minutes` key the runner refuses, so the action failed to load on `main` and the `continue-on-error` step reported success without executing a case; the bound now sits on the workflow step and a test rejects any composite step key the runner does not accept. Once it ran, every session failed with `DevToolsActivePort file doesn't exist`: the runner is elevated, and an elevated WebView2 host ignores the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable EdgeDriver uses to open the debugging port, so the case now adds, and afterwards removes, the one machine policy entry that reaches `lazysh.exe`. The case runs as a scaffold with two more scenarios: a secondary `--host` launch is handed to the original window with its manual dialog intact and opens the selected saved host with zero connections, and a secondary `--dir` launch opens a local terminal whose shell reports that directory after real key presses. Test-only; the application is unchanged.
- 58c0db1: Record whether a native terminal surface can sit next to the app's web view on Linux (#1331, part of #1302): a prototype and its measurements on Wayland and X11, kept outside the app. Nothing changes for users: xterm.js stays the only engine and no setting or default changes.
- 2852a3b: Verify on the Android companion case that a report older than the seven-day retention is absent from the Agent board, and preflight the host script that ages it. Test and documentation only. No user-visible behaviour changes.
- 243fdd7: Compose CJK text through the real Android input method into the Chat composer in the owned emulator case: preedit updates, one commit, Stage in terminal and the terminal's Send, with the original receiver checked for the word once. Test and documentation only. No user-visible behaviour changes.
- bbd9ebe: Verify through the real Android app that a cut SSH route shows the lost-connection banner, that automatic retries are refused while it is down, that the banner closes and the same tmux pane returns when the route comes back with saved credentials, and that Close ends the session without reconnecting. The owned tmux job runs it against a relay the host can cut.
- 3dc7786: Open the Codex conversations the companion used to refuse in the Agent view: a record of any length up to the file bound is read and its text cut with a note, and a conversation over the size bound is reported as too large and no longer retried.
- 92d35cf: Measure the native terminal core against xterm.js on the exact bytes of the recorded terminal baseline (#1303, part of #1302): the benchmark workloads W2, W3 and W4 can now be written to files and parsed by both engines, and on one desktop host the core parses them 1.6 to 7.7 times faster than xterm.js's `write()` at the parse stage, with the final screens equal to the baseline's. Measurement and documentation only: the terminal engine is unchanged, xterm.js stays the only engine and the default, and no setting or default changes.
- 768d258: Record what a running Chrome does when it is asked to be controlled, and specify the separate screen that would attach to a user's normal browser (#1697, part of #1258). Measured on Chromium 157 with a headed browser on a virtual display and throwaway profiles: ticking "Allow remote debugging" at `chrome://inspect` opens a loopback WebSocket that answers no HTTP discovery request and holds every connection, even one with a wrong browser id, until a dialog on the host's screen is answered, with no timeout; every new connection needs its own click; and the phone cannot answer it, because the dialog is browser UI that the protocol neither lists, shows nor receives input for. The setting survives restarts, and an approved connection reaches cookies and every tab, so the relay's closed list is what protects them. Google Chrome 144, the debug flag on Google Chrome's default profile and a real display were not tried. Documentation only: nothing changes in the app, no screen is built, and the host browser stays off by default.
- c5167a9: Fix the Windows companion test run: the Codex session history test built its rollout path with a multi-segment join, so its expected path mixed `/` and `\` and never equalled the listing's path, and `native-desktop (windows-latest)` kept failing on `main` at the companion storage step. The fixture now joins one component at a time. Test-only; the history listing itself is unchanged.
- @lazysh/account-usage@1.66.0
  - @lazysh/common@1.66.0
  - @lazysh/display-idle@1.66.0
  - @lazysh/et-transport@1.66.0
  - @lazysh/mosh-transport@1.66.0

## 1.65.0

### Patch Changes

- 8170c44: Add an owned Android runtime case for Files and repository review over OpenSSH (#994, #1737): through the real UI it browses a host directory over SFTP, reads a text file and meets the not-UTF-8 and over-1-MiB refusals, then opens a Git repository and checks modified, staged and untracked entries, their diffs, a binary diff refusal, the history list, a historical commit's tree and file, and that leaving the review and returning reopens the remembered revision and file. The owned sshd gains an opt-in SFTP subsystem for this. Test infrastructure only; the app is unchanged.
- 390837c: Cancel an active Android QR camera capture in the owned emulator case and verify the camera is released and a late frame never previews. Test and documentation only. No user-visible behaviour changes.
- a6449cd: Make the tree-sample CPU test deterministic: its burner no longer spends more system time on clock reads than the 300 ms of user time it is meant to burn, which made the required `client` check fail on loaded runners. Test-only; no behaviour changes.
- bb02d69: Add a Chromium test for the two SwiftKey inputs that arrive as key events rather than text edits: Backspace over an empty terminal editor and Enter must each put exactly one byte on the wire (#1215). Test-only; no behavior change.
- e9489ff: Accept the slash Windows and browsers add after the host of a `lazysh://theme` link, so a theme link opened from Windows is offered for review instead of being dropped.
- @lazysh/account-usage@1.65.0
  - @lazysh/common@1.65.0
  - @lazysh/display-idle@1.65.0
  - @lazysh/et-transport@1.65.0
  - @lazysh/mosh-transport@1.65.0

## 1.64.2

### Patch Changes

- @lazysh/account-usage@1.64.2
  - @lazysh/common@1.64.2
  - @lazysh/display-idle@1.64.2
  - @lazysh/et-transport@1.64.2
  - @lazysh/mosh-transport@1.64.2

## 1.64.1

### Patch Changes

- e004398: Add an owned Android runtime case for browser previews over OpenSSH (#994, #1736): through the real UI it discovers an owned host listener with a one-port allowlist, opens it, checks that the WebView's iframe and a device loopback request both reach the host listener through the forward and that sshd opened a direct-tcpip channel to it, then closes the preview and ends the session and checks that the device loopback port refuses each time. Test infrastructure only; the app is unchanged.
- @lazysh/account-usage@1.64.1
  - @lazysh/common@1.64.1
  - @lazysh/display-idle@1.64.1
  - @lazysh/et-transport@1.64.1
  - @lazysh/mosh-transport@1.64.1

## 1.64.0

### Patch Changes

- 3b0b81d: Extend the Android tmux acceptance case: through the real UI it now creates a window and renames it from the Workspaces panel, then closes it from the tab strip with a held finger, the menu's Close and the confirmation, and the host checks that its own tmux tree showed each name in order and then only the original windows. Test-only; no behaviour changes.
- 28dfed6: Bind local agent hooks to a lasting copy of the bundled companion (#1666, part of #1132). Hook setup (status, install and remove) in a local session now first places an owner-only copy of the `lazysh-agent` beside the app in the managed directory (`<data>/lazysh/companion/`), written to a new file and renamed into place, and runs from there, so the hooks it writes keep working after the app exits; an AppImage runs the bundled companion from a mount that disappears with the app. A managed copy that is the user's own and at least as new as the bundled version is kept; an older or unsafe one is replaced. Discovery and every other command keep running the bundled companion, a companion found at the managed path or on the `PATH` is used as it is, and Windows (template-only hook setup) is unchanged. No defaults change, and nothing ships a bundled companion yet, so nothing changes for an install today.
- @lazysh/account-usage@1.64.0
  - @lazysh/common@1.64.0
  - @lazysh/display-idle@1.64.0
  - @lazysh/et-transport@1.64.0
  - @lazysh/mosh-transport@1.64.0

## 1.63.0

### Minor Changes

- a12aac2: Read Gemini CLI conversations in the Agent view.
- ea81e09: Show a Grok Build plan as the shared plan card in its conversation view: with the updated host companion, a Grok ACP `plan` update is one plan card with its steps and their state instead of a block of labeled text.
- b72e4a4: Keep a visible outline on the selected browser preview element.
- d71576e: Open a sign-in page on the device that runs lazysh: new `open_auth_url` and `inspect_auth_url` commands. A phone opens the page in an in-app browser tab (Chrome Custom Tabs on Android, `SFSafariViewController` on iOS) so lazysh stays in front; a desktop opens the system browser. A page whose redirect points at the device's own `localhost:PORT` opens only after something listens on that port. Android 10 and later cannot start a page from the background, so a request that arrives while another app is in front becomes a notification that opens the page when tapped. Nothing calls the commands yet: the consent banner and the tunnel engine arrive in later changes of the sign-in tunnel work (#1504).
- c68f90c: Change a Claude Code session's model from the Agent view on tmux: Switch model (/model) in the options sends one guarded /model and the agent's own model list opens as a card above the message box when the view can read it, else in the terminal.
- 744e3bb: Update the host companion on the host instead of downloading it on the phone. **Install companion** and **Update companion** now send the host a pin (version, size and SHA-256 verified from the release metadata) and the host downloads, verifies, self-tests and installs the companion itself; the phone fetches only the small metadata. Changed default: the phone's connection to GitHub is no longer used for the transfer.
- bd87796: Close tabs from the native tab strip and rename Zellij tabs: a long press on a Herdr tab, a Zellij tab or a tmux window opens a Rename and Close menu, and Close asks first with a confirmation that names the tab. The only tab is never offered for closing. Changed default: a long press on a tab that can be renamed opens this menu instead of going straight to the rename prompt.
- 29766ae: Open the pane that raised an agent notification. Opening an inbox row or tapping a desktop notification for an agent that ran in a tmux pane now also selects that pane (and brings its window forward) in the tmux terminal you are attached to, so the Agent view follows that agent and not another one in the session.

### Patch Changes

- 4539a49: Fix tapping a host file path printed in the terminal doing nothing on a touch screen: a tap now reads the path under the finger, asks the host whether the file exists and opens its sheet, as a mouse click does.
- 8582e9a: Verify through the Linux desktop application that Auto falls back to the trusted SSH terminal and reports why Mosh and Eternal Terminal were skipped.
- 8429ebb: Prove non-English local dictation with real inference: the multilingual tiny Whisper model transcribes a committed Brazilian Portuguese public sample with an explicit language and with automatic detection, and the English-only model refuses the language before decoding. The Linux runtime job downloads both pinned models and runs the case.
- 550c9a7: Add a source-linked desktop keyboard quick reference to the shortcuts guide. Documentation only: no behavior change.
- 164c590: Hold the Agent view message box while the agent has a dialog open, so a sent message and its Enter never answer the dialog by accident.
- 8a35538: Prepare keyboard parity for a native terminal engine on macOS, Windows and Linux: a key mapping that sends characters typed with Option or AltGr as characters, Option as Meta as Meta, and Option+Left and Option+Right as word movement on macOS, checked against what xterm.js sends on each platform. xterm.js stays the only engine and nothing offers another one yet, so terminal behaviour and defaults do not change.
- a4a98df: Teach the shared Rust terminal core to apply Mosh display frames as a top-anchored resize without reflow. The core is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
- 8be0b13: Record how the xterm.js WebGL renderer addon behaves at the phone grid, under a WebGL context loss and in an Android System WebView, as measured evidence for the terminal engine decision (#1323). Measurement and documentation only: the terminal engine is unchanged, xterm.js with its DOM renderer stays the only engine and the default, and no setting or default changes.
- a4eb5ba: Send what the shared Rust terminal core encodes, keys, mouse reports, bracketed paste, focus events and its answers to terminal queries, to the SSH, Mosh, Eternal Terminal or local terminal as bytes, under the same access checks as typed input. The core is not wired to a renderer or offered as a setting, and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
- 5b99189: Let `local_connect` attach a tmux, Herdr or Zellij session on this device from a typed entry that becomes an argument list for the terminal's PTY, and bind tmux navigation to the attached terminal: the tmux, Herdr and server bindings move into one `Bindings` struct that SSH and local sessions share, and the tmux control client runs over any byte stream, here the pipes of a local `tmux -C attach-session` child. `tmux_jump` and `tmux_jump_snapshot` accept local session ids. The interface does not offer the choice yet, and SSH sessions behave as before.
- 6513740: Run the host companion commands in local sessions. The Agents board, approvals, transcripts, usage and history reads, companion settings, hook setup and notification checks now resolve a `local:` session through the host context and run `lazysh-agent` as argv on this device (beside the app, then the managed copy, then the `PATH`), without SSH or a shell. The interface still hides these views for local sessions; no default changes.
- 2e56fd9: Stop the Appium device run at once, with a non-zero exit and the holder's pid and age, when the device lock is still held after the wait (`LAZYSH_E2E_LOCK_TIMEOUT_S`, default 600 seconds), instead of starting workers that fail on missing hosts. Test infrastructure only; no product change.
- 0018e28: Measure the terminal adapter's write path against writing to xterm.js directly, and record which terminal engine slices have shipped. No terminal behaviour or default changes; xterm.js stays the only engine.
- e372f1d: Re-tap the ntfy notification permission Allow button during the Android native acceptance while the same owned prompt stays visible, so a dropped first tap no longer fails the F-Droid ntfy job.
- 3b3d62f: Serve the terminal session that has a view attached ahead of background sessions in the native terminal core's worker queue, with a bounded share for the background ones (#1339). With nine other sessions streaming, the time from a chunk arriving to the screen update being ready fell from about 100 to 320 microseconds to about 17 (plain text) and from about 1 to 2.4 milliseconds to about 0.16 (CJK and emoji) at the median on one desktop host. Nothing in the app uses the native core yet: xterm.js stays the only terminal engine and the default, and no setting or default changes.
- 5e71291: Record the four-multiplexer capability checklist with its CI evidence and the exact Windows-client limitation in the parity matrix, refresh the tmux, Herdr, Zellij and Jump navigation references, and document the supported versions and degraded capabilities in Durable workspaces. Documentation only; no behaviour or default changes.
- 499f8ca: Prove the dictation auto-send payloads against a real PTY: dictated text without Enter stays an unsubmitted line in an owned local terminal, a lone Enter submits it, and text plus Enter in one write runs as a command.
- e3990c0: Add the Appium smoke journeys for the Android app (terminal input and output, toolbar pages, side menu, disconnect and reconnect, Agent view of an owned Herdr host) and the `session-view-terminal`, `session-view-agent`, `toolbar-page-dot-*`, `agent-view` and `herdr-agent-row` test ids they use. The test ids are inert attributes; no behaviour of the app changes.
- 1cf33d2: Add the wgpu renderer of the native terminal engine as its own crate: a glyph atlas of fixed size with least-recently-used eviction, dirty-row batching, and no frame submitted while the screen is unchanged, checked pixel for pixel against the CPU reference renderer. It is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
- 3882807: Add a fictional, clearly labelled bug report example to the support guide, showing how to mark a check that was not run. Documentation only: no behavior change.
- 83d201b: Make the optional Herdr native CI build reuse hash-verified Zig package downloads and retry transient Ghostty dependency download failures, so a dropped connection no longer fails the job before its acceptance tests.
- c1bce22: Record the first runtime capture of the Android native launch (#582). On a Waydroid guest, a cold start and a restore after process death show a brief text placeholder between the branded cover and the workspace; warm start is clean. Documentation only: no behavior change, and the physical-device sequence is still unverified.
- ad6866a: Give the account-usage Cline store probe test hosted-runner headroom and report the stage a stalled probe stopped at. No user-visible behaviour changes.
- c536ddb: Extend the Android recreation test with the private keyboard command and with the activity that the file exchange and background session plugins read after the activity is recreated, so a plugin that keeps the first activity fails the instrumented run (#1462). Test-only; no behavior change.
- 60edade: Record how the wgpu terminal renderer prototype behaves on its OpenGL and OpenGL ES backends compared with Vulkan on the same GPU, as measured evidence for the terminal engine decision (#1323). Measurement and documentation only: the terminal engine is unchanged, xterm.js with its DOM renderer stays the only engine and the default, and no setting or default changes.
- 934c054: Teach the shared Rust terminal core to read the text of any rows of its screen and scrollback, optionally one column span, and to report where the visible rows sit in the buffer, with the same results as the xterm.js engine on a shared set of screens. This is what Herdr's phone navigation needs to find its switch button. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- 4e99f9d: Keep the evidence of a stalled iOS host-form input in the hosted acceptance run: the workspace UI test times each tap and typed value, prints a bounded `LAZYSH_INPUT_STALL` line and retains a whole-screen screenshot when one blocks for 10 s or more, and retains a screenshot beside the typing observations when a typing-settle wait fails. Test-only; the app, the input, the assertions and the deadlines are unchanged.
- c8e4108: Teach the shared Rust terminal core to bring a reader who scrolled back into history to the live screen when typing or pasting is accepted, like xterm.js's `scrollOnUserInput`, so the reply to a key pressed from scrollback (a toolbar Enter confirming an agent menu) is never left out of view. The core is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
- 1c525ca: Refresh the Agent view parity reference and the per-agent table of the specification with what has shipped and what stays in the terminal. Documentation only: no behavior change.
- fd834d4: Add a Playwright rendering test for mixed Latin and CJK terminal rows: it selects a CJK fallback font through the font store, writes wide characters into a real xterm and checks the buffer cell widths and the rendered glyph columns. Test-only; the terminal itself is unchanged.
- a669d49: Run the Appium device suite on the API 36 emulator in CI (report-only): a path-filtered `native-android-appium` job with tier, quarantine and shard selection, one fresh-session retry per spec file with a flaky-spec job summary, JUnit and failure artifacts, a never-gating quarantine job and a nightly run. Test infrastructure only; no product change.
- 842454b: Fix the Windows companion test run: the Agent view history tests used POSIX-only folders that Windows rejects as relative, so `native-desktop (windows-latest)` failed on `main`. They now use a drive-qualified folder and Claude Code's `C--` project directory name on Windows. Test-only; the history listing itself is unchanged.
- 7e28620: Add a hosted Windows check that installs the packaged NSIS application, drives its real WebView2 window through the pinned `tauri-driver` 2.1.0 and the official Microsoft EdgeDriver that matches the installed runtime, verifies the installed image, native window and bundled About version and source revision, bounds shutdown, and uninstalls cleanly. Test infrastructure only; the application, its defaults and the release artifacts are unchanged.
- ba4cd22: Add a Linux desktop runtime measurement (cold start, startup CPU, idle CPU and memory of the built app) and record its first results. No user-visible behaviour changes.
- 8b92e7e: Test that the browser preview port filter and the remembered repository-review file survive a page reload (#994), and promote the desktop parity rows for untracked status, listener discovery and repository history that the green `native-linux-runtimes` run on `main` now proves. Test and documentation only; the app is unchanged.
- 5d09290: Cover Whisper model removal with a real-file Rust case: only the named model is deleted, a running transcription, a path outside the model directory and a missing model are refused, and the freed slot accepts a new import under the three-model limit.
- e537bc6: Keep the Google ntfy acceptance job on the Google APK it built instead of replacing it with the FOSS build before the native checks.
- f06bd55: Add a community glossary that defines SSH host, host-key fingerprint, terminal, host-side multiplexer, optional companion and recorded agent activity, and a community guides index that links it. Documentation only: no behavior change.
- c770443: Give the Appium device suite its owned SSH, Herdr and tmux hosts (forwarded to the guest with `adb reverse`), app install, reset and permission helpers, the connect-an-owned-host flow and deterministic data, and add the `host-transport` and `host-key-fingerprint` test ids to the host editor and the host key review.
- 2d5fbac: Give the optional guarded Herdr derivative an opt-in `lazysh-managed` build with its own fixed `lazysh-herdr` application namespace, so a managed server never shares configuration, sockets, state or logs with a stock Herdr on the same host, and prove it with real servers in the Herdr native job.
- 027ccd2: Run the real tmux clipboard browser cases in the client CI job instead of skipping them.
- Updated dependencies [272304e]
  - @lazysh/common@1.63.0
  - @lazysh/et-transport@1.63.0
  - @lazysh/account-usage@1.63.0
  - @lazysh/display-idle@1.63.0
  - @lazysh/mosh-transport@1.63.0

## 1.62.0

### Minor Changes

- 163c258: Stop a running background task from the Agent view by asking the agent to end it with its TaskStop tool.

### Patch Changes

- e0d72ec: Route the terminal pane's selection, search, paste, links, Herdr navigation, IME and Mosh resize handling through a terminal-engine adapter. xterm.js stays the only engine and the default; behaviour does not change. This is the groundwork for trying a second terminal engine behind an explicit opt-in.
- @lazysh/account-usage@1.62.0
  - @lazysh/common@1.62.0
  - @lazysh/display-idle@1.62.0
  - @lazysh/et-transport@1.62.0
  - @lazysh/mosh-transport@1.62.0

## 1.61.0

### Minor Changes

- d729225: Add a native tab strip above the terminal for Herdr, Zellij and tmux tabs, with a Herdr workspace switcher, agent state dots, a **+** for new tabs, long-press rename for Herdr tabs and workspaces and tmux windows, and a Show tab strip setting (Auto, Always, Never). On phones it is on by default for a multiplexer session with more than one tab.

### Patch Changes

- 8c374b7: Fix the Agent view prompt bubble covering the reply under it while the agent works, and show pasted text as a compact block instead of raw `pasted_content` tags.
- @lazysh/account-usage@1.61.0
  - @lazysh/common@1.61.0
  - @lazysh/display-idle@1.61.0
  - @lazysh/et-transport@1.61.0
  - @lazysh/mosh-transport@1.61.0

## 1.60.0

### Minor Changes

- 39bf577: Follow an OpenCode session in the Agent view on tmux and send to it: the pane's session is bound through OpenCode's database via the host companion and read like a Claude Code or Codex conversation, every prompt is written as one paste and Enter (OpenCode drops a short prompt written as a burst of keys), and Stop presses Escape twice with a short pause. The header shows the model, context in use and folder of the OpenCode session, read by the updated host companion.

### Patch Changes

- @lazysh/account-usage@1.60.0
  - @lazysh/common@1.60.0
  - @lazysh/display-idle@1.60.0
  - @lazysh/et-transport@1.60.0
  - @lazysh/mosh-transport@1.60.0

## 1.59.0

### Minor Changes

- 6d4fb75: Add a read-only **Session info** sheet to the Agent view options for Claude Code: the MCP servers and whether they connected, the skills, agent types and instruction files the session loaded, from a new `session.info` object of the conversation page.

### Patch Changes

- @lazysh/account-usage@1.59.0
  - @lazysh/common@1.59.0
  - @lazysh/display-idle@1.59.0
  - @lazysh/et-transport@1.59.0
  - @lazysh/mosh-transport@1.59.0

## 1.58.0

### Minor Changes

- 3939ff7: Answer Codex's approval prompt and its list dialogs (/model, /permissions, /review) from the Agent view with the keys a person presses, after reading the highlight back.

### Patch Changes

- @lazysh/account-usage@1.58.0
  - @lazysh/common@1.58.0
  - @lazysh/display-idle@1.58.0
  - @lazysh/et-transport@1.58.0
  - @lazysh/mosh-transport@1.58.0

## 1.57.0

### Minor Changes

- 5dfb34f: List OpenCode sub-agents in the Agent view's background-work panel, and read the OpenCode 2.2 conversation database that keeps parts inline.
- 5dfb34f: Report Codex sub-agents as background work so the Agent view lists them.

### Patch Changes

- 31be2b1: Add the Appium and WebdriverIO device regression suite scaffold for the Android app: pinned runner and driver, a device lock that restores window size, density, navigation mode, IME, animations, rotation and permissions, WebView context helpers, failure artifacts and a first smoke spec that reaches the empty home.
- @lazysh/account-usage@1.57.0
  - @lazysh/common@1.57.0
  - @lazysh/display-idle@1.57.0
  - @lazysh/et-transport@1.57.0
  - @lazysh/mosh-transport@1.57.0

## 1.56.1

### Patch Changes

- bedb030: Open the Agent view faster: ask the host for its Unix identity once per connection instead of before every companion command, read independent things together (the host's reports and the pane; the Herdr pane check and the conversation), and check the bound report once after the first read instead of before and after it. For a hook-bound tmux conversation the first message needs 4 SSH execs in a row instead of 14.
- @lazysh/account-usage@1.56.1
  - @lazysh/common@1.56.1
  - @lazysh/display-idle@1.56.1
  - @lazysh/et-transport@1.56.1
  - @lazysh/mosh-transport@1.56.1

## 1.56.0

### Minor Changes

- 00c3e7d: Fold the thinking of each turn into one timed **Thought for N s** row in the Agent view.
- 00c3e7d: Show Claude Code goal, plan-mode, recap and hook-failure records and Codex goal and compaction records as compact event lines in the Agent view.
- 87bb9c3: Say in the Agent view when a Claude permission request was answered in the terminal first, and send nothing for a tap on a request the host no longer lists.
- 87bb9c3: Offer the permission updates Claude Code suggests (allow and remember a rule, switch mode, add folders) in the approval card and the Agent view, each behind a confirmation that shows the exact rule and where it is kept, and let a denial carry a message the agent reads.

### Patch Changes

- 6650427: Fix Back leaving the app and the phone gestures losing the system gesture zones after Android recreates the app's window (a navigation-style switch, for example). The Back handler and the gesture plugin are rebound to the new window, and the launcher icon, keyboard, file and background-session plugins act on it too.
- @lazysh/account-usage@1.56.0
  - @lazysh/common@1.56.0
  - @lazysh/display-idle@1.56.0
  - @lazysh/et-transport@1.56.0
  - @lazysh/mosh-transport@1.56.0

## 1.55.0

### Minor Changes

- b4506f1: Add per-message and per-code-block copy, conversation search that opens folded tool rows, and a Conversation only choice to the Agent view.

### Patch Changes

- @lazysh/account-usage@1.55.0
  - @lazysh/common@1.55.0
  - @lazysh/display-idle@1.55.0
  - @lazysh/et-transport@1.55.0
  - @lazysh/mosh-transport@1.55.0

## 1.54.1

### Patch Changes

- cfdff22: Render the HTML that agents write and people paste in the Agent view through a strict sanitized allow-list instead of showing it as escaped text.
- 2740b7b: Add the Agent view load benchmark: a seeded Claude Code transcript generator, pages recorded from the real companion, a production-bundle benchmark page with a modelled SSH host and CPU throttling, and `docs/reference/agent-view-performance.md` with the measured baseline. No behaviour of the app changes.
- @lazysh/account-usage@1.54.1
  - @lazysh/common@1.54.1
  - @lazysh/display-idle@1.54.1
  - @lazysh/et-transport@1.54.1
  - @lazysh/mosh-transport@1.54.1

## 1.54.0

### Minor Changes

- e74bd92: List the earlier Claude Code and Codex sessions of a folder in the Agent view and open one read-only, with a **Resume in the terminal** action that stages the agent's own resume command for review, through a new `lazysh-agent history` companion command and `agent_history` app command.
- 95224be: Open a Claude Code sub-agent's own conversation from the Agent view, read from its files under the session directory.
- 95224be: Show Claude Code dynamic workflows in the Agent view as a live progress tree: the companion reads each run's summary and journal files, the view draws its phases with each agent's state, tokens and tool calls, and opens any agent's own conversation.

### Patch Changes

- @lazysh/account-usage@1.54.0
  - @lazysh/common@1.54.0
  - @lazysh/display-idle@1.54.0
  - @lazysh/et-transport@1.54.0
  - @lazysh/mosh-transport@1.54.0

## 1.53.0

### Minor Changes

- 9d0da93: Answer the list dialogs Claude Code opens (`/model`, `/resume`, `/rewind`, the folder trust prompt, the plan decision) from the Agent view on a tmux session: the dialog is read from the pane's terminal screen, shown as a card, and a choice is sent as arrow keys, a read-back and Enter through a new bounded `pick` input of the confirmed terminal input.

### Patch Changes

- @lazysh/account-usage@1.53.0
  - @lazysh/common@1.53.0
  - @lazysh/display-idle@1.53.0
  - @lazysh/et-transport@1.53.0
  - @lazysh/mosh-transport@1.53.0

## 1.52.0

### Minor Changes

- fc4e7e8: Show each tool call of the Agent view as one card with its result and each file edit as a diff card.

### Patch Changes

- @lazysh/account-usage@1.52.0
  - @lazysh/common@1.52.0
  - @lazysh/display-idle@1.52.0
  - @lazysh/et-transport@1.52.0
  - @lazysh/mosh-transport@1.52.0

## 1.51.0

### Minor Changes

- 7374c3b: Fix the phone gestures colliding with Android and Samsung One UI navigation gestures. On Android gesture navigation each gesture now starts from a visible handle placed from the live system gesture zones instead of the screen edge, edge swipes remain as an optional Gesture style (and as the default with three-button navigation), and a Test gestures page shows the zones. A swipe also starts in a band just beyond the system's Back and Home zones (inset + 4 dp up to inset + the zone width), so it does not compete with the system's edge gestures. Changed defaults: handles and bands instead of edge swipes on gesture navigation, and the edge zone width defaults to 40 dp (was 24) with a 96 dp maximum (was 48).
- 78ae7c6: Show the working state, elapsed time, turn tokens and running tool on one line above the Agent view composer.
- 587b2c7: Send from the Agent view to an agent that runs in a Zellij pane. The updated companion reports the Zellij session and pane of an agent's hooks, the Agent view of a terminal attached to that session follows (or lists) the agents that name one of its panes, and Send and Stop write to that exact pane through Zellij's own commands, only while it still runs the agent. Needs Zellij 0.45.1 or newer.

### Patch Changes

- 03c8b6d: Changed default: the toolbar page indicator is hidden until you change page, then fades in as three dots for two seconds inside the toolbar's bottom padding.
- @lazysh/account-usage@1.51.0
  - @lazysh/common@1.51.0
  - @lazysh/display-idle@1.51.0
  - @lazysh/et-transport@1.51.0
  - @lazysh/mosh-transport@1.51.0

## 1.50.0

### Minor Changes

- 9d7fb30: Show a failed Claude Code API call (usage limit, unreachable API, refused request) as an error card that says what to do next, from the recorded `isApiErrorMessage` assistant record.

### Patch Changes

- 54776ce: On phones, the side menu is now the one full-screen navigation page (hosts, Workspaces, Agents) instead of a separate partial-width Menu drawer; its tabs read Agents, Workspaces, Connections and a connected remote session opens on Agents instead of Connections.
- b7e63b5: Fix the client build after two merged Agent view changes both defined the permission-mode strings.
- a594aa6: Keep **Load earlier messages** available in the Agent view when live updates push the oldest loaded messages out of its 400-message window, instead of showing a false **Start of the session** marker, and prove that loading an older page keeps the line being read in place while a live update arrives.
- @lazysh/account-usage@1.50.0
  - @lazysh/common@1.50.0
  - @lazysh/display-idle@1.50.0
  - @lazysh/et-transport@1.50.0
  - @lazysh/mosh-transport@1.50.0

## 1.49.0

### Minor Changes

- b2a9d62: Switch Claude Code's permission mode from the Agent view on tmux: a new button sends one guarded Shift+Tab per tap and names the mode the terminal's own status line showed afterwards.
- deef2a8: Add a Floating composer view as a per-device option next to Docked: a small movable, collapsible panel over the terminal that keeps the terminal grid and toolbar in place and sits above the soft keyboard, with Send, Insert, attachments and the draft.
- 4f882e7: Show the agent's model, permission mode, context left, git branch and worktree in the Agent view header, from a new additive `session` object of the Claude Code and Codex conversation pages and watch frames.
- ecaf908: Open, view, download or copy a host file path printed in the terminal: absolute, `~/` and `./` paths (and relative ones once the shell reports its directory with OSC 7), with `:line:col`, become links only when the host confirms the file exists.

### Patch Changes

- b2a9d62: Allow the stock Herdr send command of the Agent view composer in the app capability, so a send on a stock Herdr host is no longer refused by the app before it reaches the host.
- @lazysh/account-usage@1.49.0
  - @lazysh/common@1.49.0
  - @lazysh/display-idle@1.49.0
  - @lazysh/et-transport@1.49.0
  - @lazysh/mosh-transport@1.49.0

## 1.48.0

### Minor Changes

- 16c4800: Read the Agent view's background work (sub-agents, background commands, monitors, workflows) from the host companion so the panel covers the whole conversation, shows a shell or monitor's output and flags launches with no recorded end as not confirmed.

### Patch Changes

- c191de9: Fix the Agent view composer on a stock Herdr host: Send now goes through Herdr's own agent prompt command to the followed agent's exact pane, and a failed send shows one compact notice that keeps the draft.
- @lazysh/account-usage@1.48.0
  - @lazysh/common@1.48.0
  - @lazysh/display-idle@1.48.0
  - @lazysh/et-transport@1.48.0
  - @lazysh/mosh-transport@1.48.0

## 1.47.0

### Minor Changes

- 4a816a8: Paste, drop or pick files in the Agent view composer as numbered `[Image #n]` / `[File #n]` tokens that expand to the uploaded host paths on send.
- fb9d5b7: Pin the latest plan or todo list of the agent above the composer in the Agent view as one chip with progress and the current step, expanding to the full list.
- 4a816a8: Send prompts of up to 64 KiB from the Agent view composer on tmux as one bounded, guarded paste.

### Patch Changes

- @lazysh/account-usage@1.47.0
  - @lazysh/common@1.47.0
  - @lazysh/display-idle@1.47.0
  - @lazysh/et-transport@1.47.0
  - @lazysh/mosh-transport@1.47.0

## 1.46.0

### Minor Changes

- f6e5dbb: Add a Show/Hide keyboard button for touch devices: one tap focuses the terminal input and asks Android for its keyboard, the next hides it without sending input, and the icon follows the real keyboard, including a system back dismissal. The toolbar keyboard key shares the same toggle.
- 52592f7: On phones in a connected session the top bar and the hamburger are gone: a swipe from the left edge opens a side menu that holds everything the top bar offered, and the terminal gains the freed height.
- 6ebb3d8: Show the PNG and JPEG images a user attached as a bounded preview control in the Agent view bubble, for Claude Code and (new in the companion) Codex conversations.

### Patch Changes

- @lazysh/account-usage@1.46.0
  - @lazysh/common@1.46.0
  - @lazysh/display-idle@1.46.0
  - @lazysh/et-transport@1.46.0
  - @lazysh/mosh-transport@1.46.0

## 1.45.0

### Minor Changes

- 268c2da: The status bar's usage item follows the agent in the current pane (Claude Code shows Claude, Codex shows Codex, and so on), falls back to the chosen default account when no agent is detected, and can be pinned to one account or hidden in Preferences. Changed default: it follows the agent instead of showing one fixed account.
- e88a7d1: Show a compact background-work panel above the Agent view composer for Claude Code: counts of running shells, monitors, sub-agents and workflows, a list for each counter, and a tree of sub-agents and workflows with elapsed time and tokens.

### Patch Changes

- @lazysh/account-usage@1.45.0
  - @lazysh/common@1.45.0
  - @lazysh/display-idle@1.45.0
  - @lazysh/et-transport@1.45.0
  - @lazysh/mosh-transport@1.45.0

## 1.44.0

### Minor Changes

- b76c8c7: Open or download the selected file from Files: Open with, Download and (Android) Share, with SFTP streaming, progress and cancel, confirmation for symbolic links and files over 50 MiB, no silent overwrite, and no system open of programs or scripts.
- cf8a0bf: Answer the open Claude Code question (single or multi-select, several questions, or typed text) from the Agent view on a tmux session, through a new bounded dialog-answer input of the confirmed terminal input.

### Patch Changes

- d770c55: Fix the agent job's moon base revision on pushes to main, which resolved to an empty ref and failed the job. Pull requests are unchanged.
- @lazysh/account-usage@1.44.0
  - @lazysh/common@1.44.0
  - @lazysh/display-idle@1.44.0
  - @lazysh/et-transport@1.44.0
  - @lazysh/mosh-transport@1.44.0

## 1.43.0

### Minor Changes

- e8d624f: Add the phone bottom menu opened by swiping up from the bottom edge, with composer and toolbar show/hide.
- f94c597: Add `@` file and folder completion to the Agent view composer, listing only paths below the folder the agent works in.
- 2eecf76: Switch between the terminal and the Agent view with a swipe on a phone in a connected session: swipe from the right edge toward the left to show the Agent view, and while it is shown swipe from the centre toward the right to return to the terminal. The two views slide as one page that follows the finger and settles on release; a short or interrupted swipe leaves the view unchanged. The swipe never starts while typing or editing text, nor inside horizontally scrollable content such as code blocks, diffs and tables. The Terminal | Agent buttons stay, and the choice is still remembered per saved host and multiplexer target.

### Patch Changes

- @lazysh/account-usage@1.43.0
  - @lazysh/common@1.43.0
  - @lazysh/display-idle@1.43.0
  - @lazysh/et-transport@1.43.0
  - @lazysh/mosh-transport@1.43.0

## 1.42.0

### Minor Changes

- d356489: Read the whole session in the Agent view: scroll up to load earlier messages without losing your place, Jump to start for the first message, read forward again from there, with at most 400 messages held at a time. Needs the new host companion; an older one keeps the latest messages and asks you to update.

### Patch Changes

- @lazysh/account-usage@1.42.0
  - @lazysh/common@1.42.0
  - @lazysh/display-idle@1.42.0
  - @lazysh/et-transport@1.42.0
  - @lazysh/mosh-transport@1.42.0

## 1.41.0

### Minor Changes

- 81297de: Add a slash-command palette, prompt-mode chips, prompt history, send receipts with Retry and a two-press Request stop to the Agent view composer.

### Patch Changes

- 739e91c: Run the workspace build, check, lint, test and acceptance tasks with moon instead of Turborepo. The `bun run` task names, the CI job names and the published artifacts are unchanged.
- @lazysh/account-usage@1.41.0
  - @lazysh/common@1.41.0
  - @lazysh/display-idle@1.41.0
  - @lazysh/et-transport@1.41.0
  - @lazysh/mosh-transport@1.41.0

## 1.40.0

### Minor Changes

- 65eaa38: Show the prompts typed while Claude Code works as read-only Queued cards in the Agent view, from a new bounded `queued` list in the companion's Claude conversation page and transcript-watch frames.

### Patch Changes

- @lazysh/account-usage@1.40.0
  - @lazysh/common@1.40.0
  - @lazysh/display-idle@1.40.0
  - @lazysh/et-transport@1.40.0
  - @lazysh/mosh-transport@1.40.0

## 1.39.0

### Minor Changes

- 68631cf: Add an Android-only Private keyboard in the terminal setting (off by default, saved on this device only) for keyboards that drop or change typed characters: while the terminal has focus, the keyboard is asked for private typing with no learning and no suggestions, so predictive text, autocorrect and swipe typing stop working there.

### Patch Changes

- e98336b: Fix the Herdr switch button disappearing while scrolling or with the keyboard open: Herdr sessions now show a switch button in the session header, outside the scrolling terminal, that opens Herdr Spaces.
- @lazysh/account-usage@1.39.0
  - @lazysh/common@1.39.0
  - @lazysh/display-idle@1.39.0
  - @lazysh/et-transport@1.39.0
  - @lazysh/mosh-transport@1.39.0

## 1.38.0

### Minor Changes

- 2a5bcf8: Bring the message box back to the Agent view as an always-present composer that binds itself to the terminal pane of the followed agent, so sending needs no Choose and Confirm steps.
- 6f7cd9e: Answer Claude Code permission requests from the Agent view: the pane agent's pending request appears above the conversation and Allow or Deny sends the hash-bound approval decision after the pane is re-verified.

### Patch Changes

- @lazysh/account-usage@1.38.0
  - @lazysh/common@1.38.0
  - @lazysh/display-idle@1.38.0
  - @lazysh/et-transport@1.38.0
  - @lazysh/mosh-transport@1.38.0

## 1.37.0

### Minor Changes

- 20f02cc: Name what an agent waits for (approval, question, plan decision or unknown) and since when: the companion records it from hook payloads, and the Agent view shows it in its header and session list, lists waiting sessions first and opens from a needs-you notification.

### Patch Changes

- b628dd7: Fix terminal URLs that wrap over several rows: soft-wrapped and conservatively detected hard-wrapped URLs (including inside boxed TUIs) are tapped as one whole address, trailing punctuation and unbalanced closing brackets are trimmed, OSC 8 hyperlinks use the same Open in browser / Copy URL confirmation and win over detection.
- @lazysh/account-usage@1.37.0
  - @lazysh/common@1.37.0
  - @lazysh/display-idle@1.37.0
  - @lazysh/et-transport@1.37.0
  - @lazysh/mosh-transport@1.37.0

## 1.36.0

### Minor Changes

- 5f13c20: Add an Arrows toolbar component that draws the four arrow keys as one inverted-T cluster in the toolbar's two rows, placeable as one chip in the toolbar editor and included in the default layout, and send the unmodified cursor keys as application cursor keys (ESC O A) while a program has that mode on. Changed default: the default toolbar's four separate arrow keys are now the Arrows component; saved layouts keep their separate arrow keys.
- e792eaa: Add an Insert button next to Send in the terminal composer: Send puts the draft on the input line and presses Enter, Insert puts it there without Enter (same bracketed-paste delivery), Ctrl+Enter sends and Ctrl+Shift+Enter inserts, and a failed write keeps the draft and the composer open.
- 0148fc9: The Agent view follows the agent of the current pane: under Herdr it opens the focused pane's conversation by itself and re-links when focus or the agent changes, lists the live agents when the pane has none, and offers Start Claude Code, Start Codex and the Herdr launcher when nothing runs. Changed default: it opens the current pane's chat instead of the last pick.

### Patch Changes

- 848a370: Add a developer-only prototype of the host browser: a hidden companion command that starts a throwaway Chrome-family browser on the host and a viewer page that only the Vite development server serves, with a real-browser CI test and a protocol-client unit test. It is off by default, absent from release builds and changes no default.
- f37cb2d: Fix moving between Herdr terminals opening the Android soft keyboard and shrinking the terminal: on touch screens no navigation focuses a terminal input any more, and a keyboard that is already open passes to the terminal you move to without closing.
- @lazysh/account-usage@1.36.0
  - @lazysh/common@1.36.0
  - @lazysh/display-idle@1.36.0
  - @lazysh/et-transport@1.36.0
  - @lazysh/mosh-transport@1.36.0

## 1.35.0

### Minor Changes

- 91e6abf: Add the edge-swipe gesture engine for phone sessions: swipes that start in a thin edge zone follow the finger and settle, and never run while you type, select text or scroll. The side menu, bottom menu and view-switch gestures build on it.

### Patch Changes

- 2870a04: Fix Backspace and word corrections from the phone keyboard (reported with SwiftKey) being skipped after a toolbar key or a mouse report: Backspace over typed text now always reaches the terminal, and wheel scrolling in a mouse-tracking program no longer ends the keyboard edit record.
- @lazysh/account-usage@1.35.0
  - @lazysh/common@1.35.0
  - @lazysh/display-idle@1.35.0
  - @lazysh/et-transport@1.35.0
  - @lazysh/mosh-transport@1.35.0

## 1.34.0

### Minor Changes

- d5a8ca9: Update the Agent view in real time. A bound Claude Code or Codex conversation now streams over one host companion channel (`lazysh-agent transcript-watch`) instead of a full page read every 2 seconds: new messages, a reply that grows and a tool result that lands on an older turn change their card in place, without a page replace or a jump of the reading position. The thread shows Agent is working or waiting from the recorded turn state, polls every 2 seconds with a note when the stream cannot open, marks the thread stale while it reconnects, and asks you to update an older host companion.

### Patch Changes

- d455f37: Restore sliding between the toolbar pages in the compact terminal toolbar without making it taller: swipe sideways, or use the page indicator, between the keys, a Tools page with Find and Copy, and a Snippets page with saved snippets and chords. Changed default: the More keys key is removed and the default toolbar's second row gains an enter key in its place; saved layouts keep every key.
- @lazysh/account-usage@1.34.0
  - @lazysh/common@1.34.0
  - @lazysh/display-idle@1.34.0
  - @lazysh/et-transport@1.34.0
  - @lazysh/mosh-transport@1.34.0

## 1.33.4

### Patch Changes

- a653d76: Fix the Files view not resolving paths that start with `~`: `~`, `~/x`, `$HOME/x` and `${HOME}/x` now expand to the SSH user's home as reported by the host's SFTP server, the resolved absolute path is shown, and `~otheruser` is refused with a clear message.
- @lazysh/account-usage@1.33.4
  - @lazysh/common@1.33.4
  - @lazysh/display-idle@1.33.4
  - @lazysh/et-transport@1.33.4
  - @lazysh/mosh-transport@1.33.4

## 1.33.3

### Patch Changes

- 7f16dce: Fix the Agent view header spending a third of a phone screen on chrome: the header, Back and Enter buttons and unverified notices are one compact row with an options button, token counters leave the message flow, harness-injected records such as task notifications show as compact event lines instead of raw tags in a user bubble, and the composer is one line with a visible Stage in terminal button.
- @lazysh/account-usage@1.33.3
  - @lazysh/common@1.33.3
  - @lazysh/display-idle@1.33.3
  - @lazysh/et-transport@1.33.3
  - @lazysh/mosh-transport@1.33.3

## 1.33.2

### Patch Changes

- f8c530b: Make the terminal fill all the free screen area: no margin above it, no side gutter, and one or two more columns of text on a phone, so it sits edge to edge like other mobile SSH clients.
- @lazysh/account-usage@1.33.2
  - @lazysh/common@1.33.2
  - @lazysh/display-idle@1.33.2
  - @lazysh/et-transport@1.33.2
  - @lazysh/mosh-transport@1.33.2

## 1.33.1

### Patch Changes

- 59b5cf0: Resize Mosh sessions for the soft keyboard so responsive programs can redraw their prompts above it.
- @lazysh/account-usage@1.33.1
  - @lazysh/common@1.33.1
  - @lazysh/display-idle@1.33.1
  - @lazysh/et-transport@1.33.1
  - @lazysh/mosh-transport@1.33.1

## 1.33.0

### Minor Changes

- d837a6b: Let you resize the terminal toolbar with a Toolbar key height slider (28 to 56 px, default 32 px) in Preferences, saved on this device and applied live.

### Patch Changes

- @lazysh/account-usage@1.33.0
  - @lazysh/common@1.33.0
  - @lazysh/display-idle@1.33.0
  - @lazysh/et-transport@1.33.0
  - @lazysh/mosh-transport@1.33.0

## 1.32.0

### Minor Changes

- fc027c4: Make the terminal toolbar a compact, fixed grid of equal-width keys like other mobile SSH clients: no sliding pages, 32 px keys, a status bar that yields its height on a short phone window, and a More keys list for Find, Copy and saved snippets and chords. Changed default: two rows of nine keys with the arrows in an inverted T; saved layouts keep every key.

### Patch Changes

- @lazysh/account-usage@1.32.0
  - @lazysh/common@1.32.0
  - @lazysh/display-idle@1.32.0
  - @lazysh/et-transport@1.32.0
  - @lazysh/mosh-transport@1.32.0

## 1.31.2

### Patch Changes

- 8be56c4: Make Android notification settings reachable after notification permission is denied, and ask for the permission after the first session opens instead of during its connection.
- @lazysh/account-usage@1.31.2
  - @lazysh/common@1.31.2
  - @lazysh/display-idle@1.31.2
  - @lazysh/et-transport@1.31.2
  - @lazysh/mosh-transport@1.31.2

## 1.31.1

### Patch Changes

- ad04578: Keep the verified stable tag and GitHub release writable when other workflow changes merge while a release builds.
- @lazysh/account-usage@1.31.1
  - @lazysh/common@1.31.1
  - @lazysh/display-idle@1.31.1
  - @lazysh/et-transport@1.31.1
  - @lazysh/mosh-transport@1.31.1

## 1.31.0

### Minor Changes

- 4a8f4b3: Browse this device's files and review its Git repositories from a local desktop session.

### Patch Changes

- 4c075b5: Fix finger scrolling in Herdr sessions whose host cannot serve guarded history, which showed Unavailable on every swipe.
- 7a1168b: Fix Chat's View choice snapping back to Recorded messages in WebKit apps after switching Agent to Codex, and run the native Chat recorded-conversation and card cases on Linux and Android.
- @lazysh/account-usage@1.31.0
  - @lazysh/common@1.31.0
  - @lazysh/display-idle@1.31.0
  - @lazysh/et-transport@1.31.0
  - @lazysh/mosh-transport@1.31.0

## 1.30.5

### Patch Changes

- a738e6f: List only live Herdr agents in Agent view, open the selected agent's conversation as native chat, and say so when the host companion must be updated.
- @lazysh/account-usage@1.30.5
  - @lazysh/common@1.30.5
  - @lazysh/display-idle@1.30.5
  - @lazysh/et-transport@1.30.5
  - @lazysh/mosh-transport@1.30.5

## 1.30.4

### Patch Changes

- a0b0603: Dismiss a boot-time system error dialog on the Android CI emulator before native acceptance starts, so the app window keeps focus.
- @lazysh/account-usage@1.30.4
  - @lazysh/common@1.30.4
  - @lazysh/display-idle@1.30.4
  - @lazysh/et-transport@1.30.4
  - @lazysh/mosh-transport@1.30.4

## 1.30.3

### Patch Changes

- c2aa152: Print the failed case, its message and first app frame when Android CI instrumentation fails, and name the failing touch-receipt flags of the D-pad acceptance.
- @lazysh/account-usage@1.30.3
  - @lazysh/common@1.30.3
  - @lazysh/display-idle@1.30.3
  - @lazysh/et-transport@1.30.3
  - @lazysh/mosh-transport@1.30.3

## 1.30.2

### Patch Changes

- 933719e: Fix finger scrolling in Herdr sessions on hosts without the guarded Herdr build, which showed Unavailable on every swipe.
- @lazysh/account-usage@1.30.2
  - @lazysh/common@1.30.2
  - @lazysh/display-idle@1.30.2
  - @lazysh/et-transport@1.30.2
  - @lazysh/mosh-transport@1.30.2

## 1.30.1

### Patch Changes

- dc223b5: Show app language choices as a checked list.
- @lazysh/account-usage@1.30.1
  - @lazysh/common@1.30.1
  - @lazysh/display-idle@1.30.1
  - @lazysh/et-transport@1.30.1
  - @lazysh/mosh-transport@1.30.1

## 1.30.0

### Minor Changes

- f39e536: Show each detected multiplexer's version with a Supported or Limited badge, hide Jump To on tmux older than 3.4, import synced hosts whose default multiplexer kind is unknown, and report non-POSIX host shells explicitly.

### Patch Changes

- @lazysh/account-usage@1.30.0
  - @lazysh/common@1.30.0
  - @lazysh/display-idle@1.30.0
  - @lazysh/et-transport@1.30.0
  - @lazysh/mosh-transport@1.30.0

## 1.29.3

### Patch Changes

- 0e794d4: Use a segmented cursor-shape picker in terminal preferences.
- @lazysh/account-usage@1.29.3
  - @lazysh/common@1.29.3
  - @lazysh/display-idle@1.29.3
  - @lazysh/et-transport@1.29.3
  - @lazysh/mosh-transport@1.29.3

## 1.29.2

### Patch Changes

- 020ce44: Wait for a free SSH channel opening instead of failing extra preview connections, so discovery marks every HTTP listener and pages with many requests load through a forward.
- @lazysh/account-usage@1.29.2
  - @lazysh/common@1.29.2
  - @lazysh/display-idle@1.29.2
  - @lazysh/et-transport@1.29.2
  - @lazysh/mosh-transport@1.29.2

## 1.29.1

### Patch Changes

- 0b0f52e: Detect attached Herdr agents in Agent view and keep finger scrolling separate from agent question input.
- @lazysh/account-usage@1.29.1
  - @lazysh/common@1.29.1
  - @lazysh/display-idle@1.29.1
  - @lazysh/et-transport@1.29.1
  - @lazysh/mosh-transport@1.29.1

## 1.29.0

### Minor Changes

- 2b1358f: Toggle the Agent view with a keyboard shortcut.

### Patch Changes

- @lazysh/account-usage@1.29.0
  - @lazysh/common@1.29.0
  - @lazysh/display-idle@1.29.0
  - @lazysh/et-transport@1.29.0
  - @lazysh/mosh-transport@1.29.0

## 1.28.2

### Patch Changes

- c3798f6: Organize guides, reference and explanations for easier navigation.
- @lazysh/account-usage@1.28.2
  - @lazysh/common@1.28.2
  - @lazysh/display-idle@1.28.2
  - @lazysh/et-transport@1.28.2
  - @lazysh/mosh-transport@1.28.2

## 1.28.1

### Patch Changes

- 0958675: Pin the Parakeet model archive the publisher re-uploaded on 2026-11-07, verify all four extracted files, and report a replaced archive clearly.
- @lazysh/account-usage@1.28.1
  - @lazysh/common@1.28.1
  - @lazysh/display-idle@1.28.1
  - @lazysh/et-transport@1.28.1
  - @lazysh/mosh-transport@1.28.1

## 1.28.0

### Minor Changes

- 94b17c9: Switch a session between its terminal and a live Agent view, with Both side by side on wide desktop layouts; Codex hooks can report their conversation for automatic binding.

### Patch Changes

- @lazysh/account-usage@1.28.0
  - @lazysh/common@1.28.0
  - @lazysh/display-idle@1.28.0
  - @lazysh/et-transport@1.28.0
  - @lazysh/mosh-transport@1.28.0

## 1.27.1

### Patch Changes

- ac467c1: Support Herdr 0.9.3 through 0.9.5, and explain a Herdr workspace, tab or pane that was closed on the host instead of showing Herdr's raw error.
- @lazysh/account-usage@1.27.1
  - @lazysh/common@1.27.1
  - @lazysh/display-idle@1.27.1
  - @lazysh/et-transport@1.27.1
  - @lazysh/mosh-transport@1.27.1

## 1.27.0

### Minor Changes

- 6f06a27: Group agent board reports by project on the connected host, and archive reports on this device until the agent reports again or the report ages out.

### Patch Changes

- @lazysh/account-usage@1.27.0
  - @lazysh/common@1.27.0
  - @lazysh/display-idle@1.27.0
  - @lazysh/et-transport@1.27.0
  - @lazysh/mosh-transport@1.27.0

## 1.26.1

### Patch Changes

- 395dde1: Keep a wheel or trackpad scroll that lands in the same frame as new terminal output: the terminal now moves to the history the scroll reached instead of staying on the live screen.
- @lazysh/account-usage@1.26.1
  - @lazysh/common@1.26.1
  - @lazysh/display-idle@1.26.1
  - @lazysh/et-transport@1.26.1
  - @lazysh/mosh-transport@1.26.1

## 1.26.0

### Minor Changes

- aea6aab: Save attachments to a private, uniquely named file under the host's `/tmp` by default instead of the login directory; an explicit destination path still saves there.

### Patch Changes

- @lazysh/account-usage@1.26.0
  - @lazysh/common@1.26.0
  - @lazysh/display-idle@1.26.0
  - @lazysh/et-transport@1.26.0
  - @lazysh/mosh-transport@1.26.0

## 1.25.1

### Patch Changes

- bcec7e8: Keep the Android soft keyboard closed after tapping a Herdr workspace, tab or pane switch, also on wide layouts such as a phone in landscape or a tablet; tapping the terminal or the keyboard toolbar key still opens it.
- @lazysh/account-usage@1.25.1
  - @lazysh/common@1.25.1
  - @lazysh/display-idle@1.25.1
  - @lazysh/et-transport@1.25.1
  - @lazysh/mosh-transport@1.25.1

## 1.25.0

### Minor Changes

- a89a721: Deliver relay events through an Apprise API stateful key with `--destination-format apprise`, optional proxy Bearer token, repeatable `--apprise-tag`, and finite `partial` and `rejected` receipts that the host companion also accepts on replay; push setup help now names the relay destinations and links the relay guide.

### Patch Changes

- 5dd1d1d: Detach the tmux navigation control client cleanly before closing its SSH channel or transport. On tmux older than 3.8, closing the transport while tmux still had output queued for that client left the client, and therefore the tmux server, running forever after lazysh disconnected. lazysh now ends control mode first, waits up to 500 ms for tmux to confirm, and only then closes the channel.
- 0ebee54: Keep the newest Mosh output and the cursor line on screen when the soft keyboard opens: the remote screen keeps its rows and the terminal pans to the cursor instead of shrinking.
- @lazysh/account-usage@1.25.0
  - @lazysh/common@1.25.0
  - @lazysh/display-idle@1.25.0
  - @lazysh/et-transport@1.25.0
  - @lazysh/mosh-transport@1.25.0

## 1.24.0

### Minor Changes

- e508487: Add Ctrl/Cmd+Shift+A and Ctrl/Cmd+Shift+W, gesture actions and toolbar keys that open Agents and Workspaces and return to the terminal; plain-terminal two-finger swipes up and down now open them by default.
- 1eb11f5: Detect lost SSH, Mosh and ET connections, retry automatically with saved credentials and backoff, reattach tmux or Herdr on success, and close the session when the lost-connection banner is dismissed.

### Patch Changes

- @lazysh/account-usage@1.24.0
  - @lazysh/common@1.24.0
  - @lazysh/display-idle@1.24.0
  - @lazysh/et-transport@1.24.0
  - @lazysh/mosh-transport@1.24.0

## 1.23.0

### Minor Changes

- 1bd1e51: Rebuild Preferences as a grouped settings list with section headers, value previews, sub-pages, action rows for related surfaces and a settings search.

### Patch Changes

- @lazysh/account-usage@1.23.0
  - @lazysh/common@1.23.0
  - @lazysh/display-idle@1.23.0
  - @lazysh/et-transport@1.23.0
  - @lazysh/mosh-transport@1.23.0

## 1.22.0

### Minor Changes

- 201c558: Show Workspace tools as swipeable, labelled carousel pages that size to the page in view and remember the last page across reconnects and restarts.

### Patch Changes

- @lazysh/account-usage@1.22.0
  - @lazysh/common@1.22.0
  - @lazysh/display-idle@1.22.0
  - @lazysh/et-transport@1.22.0
  - @lazysh/mosh-transport@1.22.0

## 1.21.0

### Minor Changes

- ae09622: Redesign the app chrome as subtle borderless controls with glass surfaces and a restrained accent that replaces the default cyan.
- b79a85b: Show images and files attached from the terminal composer as numbered inline `[Image #n]` and `[File #n]` chips that delete atomically and expand to the uploaded paths on send.

### Patch Changes

- @lazysh/account-usage@1.21.0
  - @lazysh/common@1.21.0
  - @lazysh/display-idle@1.21.0
  - @lazysh/et-transport@1.21.0
  - @lazysh/mosh-transport@1.21.0

## 1.20.0

### Minor Changes

- fcd7063: Split the terminal toolbar into a Tools page and a Snippets page that slide horizontally, with page indicators, overscroll-to-next-page and a remembered last page.

### Patch Changes

- @lazysh/account-usage@1.20.0
  - @lazysh/common@1.20.0
  - @lazysh/display-idle@1.20.0
  - @lazysh/et-transport@1.20.0
  - @lazysh/mosh-transport@1.20.0

## 1.19.0

### Minor Changes

- 1695c0c: Declutter the Herdr Spaces tree: compact space cards with one status summary, tabs and panes one indentation step in, single-line rows with `~` paths, pane counts on collapsed tabs and space actions in an overflow or long-press menu.
- 4bb1b92: Show an ongoing Android notification with the active session count while lazysh keeps terminal sessions running in the background; tapping it returns to the workspace, and it is removed after the last session ends. Android 13+ asks for notification permission once on the first session.

### Patch Changes

- @lazysh/account-usage@1.19.0
  - @lazysh/common@1.19.0
  - @lazysh/display-idle@1.19.0
  - @lazysh/et-transport@1.19.0
  - @lazysh/mosh-transport@1.19.0

## 1.18.2

### Patch Changes

- 942bb91: Keep finger scrolling responsive after a pause in history while the on-screen keyboard holds a word in composition, including full-screen agents with mouse reporting, and stop a toolbar key that sends the composed word from blocking later drags and long-presses.
- @lazysh/account-usage@1.18.2
  - @lazysh/common@1.18.2
  - @lazysh/display-idle@1.18.2
  - @lazysh/et-transport@1.18.2
  - @lazysh/mosh-transport@1.18.2

## 1.18.1

### Patch Changes

- 4fa31f0: Keep the phone Preferences heading and its Close button on screen after adding toolbar keys from Available keys.
- @lazysh/account-usage@1.18.1
  - @lazysh/common@1.18.1
  - @lazysh/display-idle@1.18.1
  - @lazysh/et-transport@1.18.1
  - @lazysh/mosh-transport@1.18.1

## 1.18.0

### Minor Changes

- 9b63d05: Add a pinch that zooms the multiplexer pane, short and long header pulls, long-press toolbar key actions and level-aware gesture defaults for tmux, Herdr, Zellij and plain terminals.

### Patch Changes

- @lazysh/account-usage@1.18.0
  - @lazysh/common@1.18.0
  - @lazysh/display-idle@1.18.0
  - @lazysh/et-transport@1.18.0
  - @lazysh/mosh-transport@1.18.0

## 1.17.1

### Patch Changes

- 46c4f00: Find the documented per-user Herdr installation on supported Unix hosts while preserving command PATH precedence.
- @lazysh/account-usage@1.17.1
  - @lazysh/common@1.17.1
  - @lazysh/display-idle@1.17.1
  - @lazysh/et-transport@1.17.1
  - @lazysh/mosh-transport@1.17.1

## 1.17.0

### Minor Changes

- 8c15fb0: Redesign the phone-first surfaces: agent lists with status rings, collapsible status sections and tags shared with the agent inbox, compact host rows, a floating tab bar, grouped settings lists and a true-black default theme.

### Patch Changes

- 2f4a19d: Keep the software keyboard's editor connection when arming a terminal toolbar modifier.
- @lazysh/account-usage@1.17.0
  - @lazysh/common@1.17.0
  - @lazysh/display-idle@1.17.0
  - @lazysh/et-transport@1.17.0
  - @lazysh/mosh-transport@1.17.0

## 1.16.0

### Minor Changes

- c671436: Read theme JSON or share codes from the Android clipboard through the native clipboard path, with validation and an explicit preview, and add the Amber Android launcher icon through launcher aliases that keep the running workspace open.
  
  Updating an existing Android install changes the launcher component from `.MainActivity` to `.LauncherDefault`, so some launchers may move or drop a home-screen icon pinned under the previous version.

### Patch Changes

- 16c8b45: Return the terminal to the live screen after toolbar keys and chord buttons, as keyboard input does.
- @lazysh/account-usage@1.16.0
  - @lazysh/common@1.16.0
  - @lazysh/display-idle@1.16.0
  - @lazysh/et-transport@1.16.0
  - @lazysh/mosh-transport@1.16.0

## 1.15.0

### Minor Changes

- af98930: Create Herdr workspaces and Git worktrees from Spaces, optionally starting a detected agent in the new workspace's first pane after the user reviews the exact remote commands.
- 75166b8: Add opt-in keyboard dismissal when scrolling past the bottom of local terminal history, preserving remote scrolling and requiring positively idle input.

### Patch Changes

- dc18c14: Show focused mobile agent activity details with contextual Back and list-position restoration.
- e054793: Fix Android biometric-protected credentials failing to save or unlock after a successful fingerprint, and the biometric resume lock stalling on its second prompt.
- @lazysh/account-usage@1.15.0
  - @lazysh/common@1.15.0
  - @lazysh/display-idle@1.15.0
  - @lazysh/et-transport@1.15.0
  - @lazysh/mosh-transport@1.15.0

## 1.14.0

### Minor Changes

- 61371ba: Add terminal text selection with touch handles, edge auto-scroll through local history for multi-screen selections, and floating Copy, Select all and Copy screen actions; raw buffer text is copied.

### Patch Changes

- 31a5fc0: Keep the opened Chat transcript reader, its reading position and unsent draft when returning from the terminal or another session view. Following pauses while hidden, confirmed terminal destinations are still released on leaving, and reported-history readers still retire.
- 7ad3229: Find the owned Android recorded Conversation Refresh control by its accessible name, matching the icon-only Refresh button, so the Refresh observation reaches the real control instead of finding no text-labelled button. This test-only repair keeps the single-button, enabled, started-then-settled and exact-message assertions and does not change application behavior.
- @lazysh/account-usage@1.14.0
  - @lazysh/common@1.14.0
  - @lazysh/display-idle@1.14.0
  - @lazysh/et-transport@1.14.0
  - @lazysh/mosh-transport@1.14.0

## 1.13.0

### Minor Changes

- 2dd690e: Arrange terminal toolbar keys by drag and drop, with keyboard and single-tap alternatives, and lay the toolbar out in one to three rows. The default stays one row with the same keys, and older clients read multi-row toolbars as one row.
- 6c02544: Redesign pending approval cards and the agent inbox: approvals show the agent and tool, project and request age, the full tool input, a live expiry countdown, a side-by-side Deny/Allow pair and a project/session/pane summary; the inbox groups events into foldable Needs you, Working and Done sections with status rings, relative times and icon actions, and moves monitoring controls into a collapsible settings group.
- 2b4841e: Show a live Herdr agent's lifecycle state when Herdr reports Unknown, as Herdr 0.9.3 does for an idle Codex prompt. If the pane's Herdr-reported session ID is unique among live panes and matches exactly one companion report from the same connection, the pane shows Working, Needs attention or Done. Herdr's own states take precedence, workspace and tab summaries stay Herdr's, and a pane without an exact match stays Unknown.
- 4b44d33: Extend the Ctrl/Cmd+K palette into a keyboard-operable command palette over hosts, open sessions, workspace tools and application actions, also opened by Ctrl/Cmd+Shift+P from a focused terminal. Files previews PNG, JPEG, GIF and WebP images up to 2 MiB, shows SVG only as an image from a blob URL so its scripts never run, and renders Markdown through the Chat renderer without raw HTML, links or remote images.
- 3c65f15: Redesign the terminal composer as a full-height sheet over the unchanged terminal and make its primary Send action paste the draft, then press Enter once. A new Input preference, on by default, restores paste-only behavior when turned off.

### Patch Changes

- 9164118: Fully reveal each owned Android native select inside its scroll panel before the unchanged centre hit-test and native tap, so a recorded-source selector left partly clipped under the context navigation by an earlier keyboard scroll is no longer tapped through the navigation. This test-only repair keeps every geometry, ownership and chooser assertion and does not change application behavior.
- @lazysh/account-usage@1.13.0
  - @lazysh/common@1.13.0
  - @lazysh/display-idle@1.13.0
  - @lazysh/et-transport@1.13.0
  - @lazysh/mosh-transport@1.13.0

## 1.12.0

### Minor Changes

- abe7b15: Import SSH private keys from a file, reject public-key files with a specific error at inspection and connection, and document host-key pin custody.
- 62fe53b: Add an opt-in per-host option that asks the SSH server to set `LC_TERMINAL=lazysh` for new SSH terminals and multiplexer attachments. It is off by default, needs the server's `AcceptEnv` to admit `LC_TERMINAL`, and is not sent by Mosh or ET sessions.
- 86e89e4: Show plan, question and turn-state cards in native Chat. The companion projects recorded Claude Code `TodoWrite`, `AskUserQuestion` and `ExitPlanMode` calls, Codex `update_plan`, `request_user_input` and plan-mode items, and OpenCode `todowrite` and `question` parts into display-only cards. Conversation views for Claude Code, Codex and OpenCode V1 report a working, waiting, idle or stopped turn derived from recorded lifecycle records; anything else stays unknown. Question cards list the options and send the user to the terminal to answer, because Chat cannot choose options in an agent prompt. Existing tool cards, cursors and prompt targets are unchanged.

### Patch Changes

- 8826db9: Make recorded conversation draft controls compact and show attachments in a focused mobile view while retaining explicit staging, upload and confirmed-input behavior.
- b765278: Add support, security and code-of-conduct policies and a first-contribution walkthrough without changing runtime behavior.
- 7dab9a5: Admit each owned Android Mosh resize acceptance phase only after its observation stays unchanged, so a Mosh frame drawn before Herdr repaints or an intermediate keyboard layout no longer becomes the phase baseline. This test-only repair keeps every original resize, keyboard-crossing and guarded Herdr Chat receiver assertion and does not change terminal behavior.
- 9c5fa30: Display provider-reported prepaid spend-cap percentages without estimating unknown quotas or changing uncapped balances.
- f86dd1a: Keep a terminal reader in history while output streams and across width, height and Mosh viewport resizes, and keep bottom-following Mosh sessions following after the viewport grows.
- 19998d0: Reduce workspace clutter around the session manager action.
- Updated dependencies [5406843]
- Updated dependencies [816f09b]
  - @lazysh/account-usage@1.12.0
  - @lazysh/common@1.12.0
  - @lazysh/display-idle@1.12.0
  - @lazysh/et-transport@1.12.0
  - @lazysh/mosh-transport@1.12.0

## 1.11.0

### Minor Changes

- aa1e2f3: Add explicitly selected OpenCode recorded conversations with current projection refresh and unchanged confirmed terminal input boundaries.

### Patch Changes

- 24123ed: Never pause terminal typing when a keyboard edit cannot be sent safely; skip that edit and show a fading, non-blocking review notice instead.
- cd197f9: Preserve terminal Enter input delivered as an input-only line break, including the explicit toolbar Shift modifier.
- f05a3ce: Preserve owned terminal corrections delivered as paired keyless composition-text input events.
- @lazysh/account-usage@1.11.0
  - @lazysh/common@1.11.0
  - @lazysh/display-idle@1.11.0
  - @lazysh/et-transport@1.11.0
  - @lazysh/mosh-transport@1.11.0

## 1.10.4

### Patch Changes

- 8e3f647: Keep the visible scrollback line anchored when the terminal height changes.
  Keep validated forward deletions synchronized with subsequent terminal input without changing the deferred composition fallback.
  Preserve zero-code Process corrections and order subsequent hardware keypresses without duplicate input.
- 1ebc76a: Reclaim unused host .NET and Haskell toolchains before Google ntfy APK and system-image provisioning, preserving the active Android SDK/NDK and native acceptance gates.
- @lazysh/account-usage@1.10.4
  - @lazysh/common@1.10.4
  - @lazysh/display-idle@1.10.4
  - @lazysh/et-transport@1.10.4
  - @lazysh/mosh-transport@1.10.4

## 1.10.3

### Patch Changes

- 8ac0833: Replace competing workspace navigation layers with focused Workspaces and Agents destinations, compact session context and contextual desktop tools. Preserve the compact phone terminal, mounted sessions and input authority while refining branded glass navigation and readable work-state rows.
- ba14491: Bound the ntfy Android CI fixture userdata partition to 4 GiB so emulator startup fits hosted runner disk space.
- 0465ecb: Measure the existing synthetic Windows companion writer phases after native acceptance, including failed owners, while retaining mandatory acceptance and release receipt gates.
- @lazysh/account-usage@1.10.3
  - @lazysh/common@1.10.3
  - @lazysh/display-idle@1.10.3
  - @lazysh/et-transport@1.10.3
  - @lazysh/mosh-transport@1.10.3

## 1.10.2

### Patch Changes

- a706336: Preserve validated owned ASCII edits across Android IME fallback transactions without replaying the previous text or losing multi-character deletion. Retain input ownership, cancellation and unsupported-edit review.
- 20fa847: Keep Mosh repaint geometry synchronized with each complete server frame so keyboard, composer and viewport resizes do not duplicate the screen into local scrollback. Preserve existing history cells without reflow; narrow views can clip old history until widened.
- @lazysh/account-usage@1.10.2
  - @lazysh/common@1.10.2
  - @lazysh/display-idle@1.10.2
  - @lazysh/et-transport@1.10.2
  - @lazysh/mosh-transport@1.10.2

## 1.10.1

### Patch Changes

- e05e4a2: Make terminal composition compact, put uploaded attachment paths before secondary tools, guide notification setup, and separate live agents from reported activity while keeping pending approvals reachable.
- 3207d0c: Keep custom theme text readable on translucent navigation and short sheets by increasing backing opacity only when the palette needs it. Preserve bundled glass and solid reduced-transparency/forced-colors rendering.
- @lazysh/account-usage@1.10.1
  - @lazysh/common@1.10.1
  - @lazysh/display-idle@1.10.1
  - @lazysh/et-transport@1.10.1
  - @lazysh/mosh-transport@1.10.1

## 1.10.0

### Minor Changes

- f1d7feb: Add a recorded Codex Conversation reader with mode-aware turn replay, bounded protected fork/revert prefixes, explicit refresh and opt-in Follow. Records remains the default; recorded history does not establish a live agent or authorize requests.

### Patch Changes

- @lazysh/account-usage@1.10.0
  - @lazysh/common@1.10.0
  - @lazysh/display-idle@1.10.0
  - @lazysh/et-transport@1.10.0
  - @lazysh/mosh-transport@1.10.0

## 1.9.11

### Patch Changes

- f164bfc: Retain one closed, passive native finger-landing observation to distinguish terminal geometry and hit-target failures without changing gesture admission, deadlines or scrolling behavior.
- @lazysh/account-usage@1.9.11
  - @lazysh/common@1.9.11
  - @lazysh/display-idle@1.9.11
  - @lazysh/et-transport@1.9.11
  - @lazysh/mosh-transport@1.9.11

## 1.9.10

### Patch Changes

- b7aeb55: Extend owned Android SSH acceptance to verify toolbar Shift one-shot and pending-composition toggling, modified Enter, and momentary key appearance against the exact receiver stream.
- 9869796: Prevent the browser touch default only on admitted expanded D-pad direction gestures, preserving ordinary clicks, corner shortcuts and accessibility controls. Native Android long-press and IME behavior remain subject to the original acceptance case.
- f39cd05: Retain only closed native registration and enrollment phases after an unchanged ntfy challenge-confirmation failure. Preserve the original failure, deadlines and privacy guards; this is diagnostic evidence, not a confirmation or delivery fix.
- @lazysh/account-usage@1.9.10
  - @lazysh/common@1.9.10
  - @lazysh/display-idle@1.9.10
  - @lazysh/et-transport@1.9.10
  - @lazysh/mosh-transport@1.9.10

## 1.9.9

### Patch Changes

- 657ee0b: Qualify standalone Android Mosh interoperability independently from guarded client UI acceptance while preserving their existing deadlines and assertions.
- @lazysh/account-usage@1.9.9
  - @lazysh/common@1.9.9
  - @lazysh/display-idle@1.9.9
  - @lazysh/et-transport@1.9.9
  - @lazysh/mosh-transport@1.9.9

## 1.9.8

### Patch Changes

- 38bba29: Make toolbar Shift one-shot after the next key while retaining Shift throughout an already-held arrow or D-pad gesture. Allow turning Shift off without committing pending IME text; preserve explicit Control and Alt locks.
- @lazysh/account-usage@1.9.8
  - @lazysh/common@1.9.8
  - @lazysh/display-idle@1.9.8
  - @lazysh/et-transport@1.9.8
  - @lazysh/mosh-transport@1.9.8

## 1.9.7

### Patch Changes

- c525664: Add bounded passive native D-pad IME/geometry and final context-menu observations for Android acceptance diagnostics. This does not qualify or change D-pad behavior.
- 0c12b4c: Keep locale workflow acceptance aligned with compact native status recovery while preserving the visible case-sensitive untranslated reason.
- 82bfca4: Keep mobile Workspaces focused on Spaces with compact selected-session context and an explicit connected-session disclosure. Preserve the expanded desktop list, session selection and navigation state.
- @lazysh/account-usage@1.9.7
  - @lazysh/common@1.9.7
  - @lazysh/display-idle@1.9.7
  - @lazysh/et-transport@1.9.7
  - @lazysh/mosh-transport@1.9.7

## 1.9.6

### Patch Changes

- 9d70b38: Exercise repeated short Android finger drags and a continuous held drag against the existing owned Herdr receiver in the packaged native acceptance owner.
- 5b621d3: Retain bounded passive finger-scroll geometry and wheel metadata, plus closed owned-host history failure stages, without changing native gesture verdicts or input routing.
- b2574a4: Add native Linux acceptance for an isolated GTK reduced-motion preference, preserved keyboard focus and the original local terminal.
- 455bb4f: Retain bounded, closed native IME switch and terminal-tap ordering observations after editor admission fails, without changing input state, acceptance guards or deadlines.
- f8d9836: Retain only the HTTP status when release tag creation fails, preserving private response data and all publication guards.
- 9af806c: Preserve short finger-scroll distance across admitted gestures in the same active terminal while matching normal scrollback, mouse-report and alternate-buffer wheel semantics.
- @lazysh/account-usage@1.9.6
  - @lazysh/common@1.9.6
  - @lazysh/display-idle@1.9.6
  - @lazysh/et-transport@1.9.6
  - @lazysh/mosh-transport@1.9.6

## 1.9.5

### Patch Changes

- a539963: Add native Linux acceptance for public appearance settings, rendered text contrast, keyboard category navigation and focus restoration while preserving the original local terminal.

  Keep unavailable icon settings compact with explicit recovery, and prevent sidebar mode labels from breaking mid-word across narrow and enlarged-text layouts.
- 822ae17: Route vertical finger drags with selected terminal text through xterm’s ordinary wheel handling, including mouse-tracking multiplexers.
- @lazysh/account-usage@1.9.5
  - @lazysh/common@1.9.5
  - @lazysh/display-idle@1.9.5
  - @lazysh/et-transport@1.9.5
  - @lazysh/mosh-transport@1.9.5

## 1.9.4

### Patch Changes

- @lazysh/account-usage@1.9.4
  - @lazysh/common@1.9.4
  - @lazysh/display-idle@1.9.4
  - @lazysh/et-transport@1.9.4
  - @lazysh/mosh-transport@1.9.4

## 1.9.3

### Patch Changes

- 50b1569: Preserve slow sub-row finger movement in normal terminal scrollback without changing gesture sensitivity or mouse-report routing.
- @lazysh/account-usage@1.9.3
  - @lazysh/common@1.9.3
  - @lazysh/display-idle@1.9.3
  - @lazysh/et-transport@1.9.3
  - @lazysh/mosh-transport@1.9.3

## 1.9.2

### Patch Changes

- 0bc9cc4: Retain closed terminal review, ended-session, modal and pane-display context when Android IME editor admission fails.
- 42c2134: Suppress browser context menus on expanded D-pad controls while preserving their normal terminal input.
- 7dadc4e: Bind native companion installation acceptance to the installer panel rather than the shared hook styling class; retain strict action and outcome checks.
- e3e0e63: Dispatch complete Google/FOSS ntfy native-acceptance commands through the pinned emulator runner without changing provider guards or deadlines.
- e0f7115: Retain closed failure-only observations when owned native SSH control prompts fail admission, preserving the original deadline and failure.
- @lazysh/account-usage@1.9.2
  - @lazysh/common@1.9.2
  - @lazysh/display-idle@1.9.2
  - @lazysh/et-transport@1.9.2
  - @lazysh/mosh-transport@1.9.2

## 1.9.1

### Patch Changes

- dce0ea9: Retain bounded focus, viewport, touch-action and context-menu evidence in Android D-pad failure diagnostics without changing input behavior.
- @lazysh/account-usage@1.9.1
  - @lazysh/common@1.9.1
  - @lazysh/display-idle@1.9.1
  - @lazysh/et-transport@1.9.1
  - @lazysh/mosh-transport@1.9.1

## 1.9.0

### Minor Changes

- eb37ec3: Offer Firebase-free UnifiedPush enrollment and authenticated event display in Google Android builds with explicit provider selection, and add opt-in Gotify delivery through the self-hosted notification relay.

### Patch Changes

- 86ef821: Make Android protected-receiver changed-read checks deterministic by restoring the original fixture size before each observation.
- e9c15fc: Align browser acceptance with dedicated Preferences screens and settle pointer hover transitions before checking attachment control styling.
- fb3388c: Persist the selected Android push provider before explicit controls so late Firebase cleanup markers cannot change the chosen transport after restart.
- @lazysh/account-usage@1.9.0
  - @lazysh/common@1.9.0
  - @lazysh/display-idle@1.9.0
  - @lazysh/et-transport@1.9.0
  - @lazysh/mosh-transport@1.9.0

## 1.8.4

### Patch Changes

- b6487ee: Add bounded passive pointer/capture and rendered-direction evidence to Android D-pad acceptance without changing production input or gesture budgets.
- e882bae: Retain a closed failure-only summary of cached completed native Window dispatch events and relative timings without changing Android D-pad input or acceptance budgets.
- 3ea1476: Navigate Preferences through focused category screens, simplify workspace and agent chrome, and refine accessible glass and motion treatments.
- af07d0f: Identify failed Herdr host teardown stages using closed post-stop observations and preserve the original test failure when cleanup also fails.
- f77f54f: Retain a bounded failure-only comparison of the owned Android IME receiver wire without exporting input or changing runtime assertions.
- 05e9410: Keep owned Android autocomplete corrections editable when the keyboard leaves its caret inside the composing range.
- 8ee297e: Preserve a previously admitted raw SSH fixture receiver's normal exit between process-identity observations while retaining replacement, live ownership and exact-byte checks.
- cd99c29: Admit vertically dominant terminal finger drags and preserve coalesced native scroll distance before finger lift.
- 1330e4c: Preserve physical and toolbar Shift+Enter as a modified Enter key so agent terminals can insert a newline without ordinary Enter submission.
- @lazysh/account-usage@1.8.4
  - @lazysh/common@1.8.4
  - @lazysh/display-idle@1.8.4
  - @lazysh/et-transport@1.8.4
  - @lazysh/mosh-transport@1.8.4

## 1.8.3

### Patch Changes

- 408e4a8: Retain closed failure-local D-pad phase and last validated receiver counts in Android native acceptance without changing gestures, budgets or input behavior.
- 2d4bab7: Use a minimum-sized standard Space for the house-owned Android test IME and cover its real framework measurement without changing packaged terminal input behavior.
- 1eda85b: Calibrate the ntfy acceptance release-assembly build allowance from two to four minutes after a measured two-worker build exceeded two minutes, preserving APK/trust checks, native assertions and outer test limits.
- 1e05652: Align the opt-in Android raw SSH receiver fixture with the existing bounded UI-host lifetime while preserving ordinary SSH and Mosh lifetimes and all input acceptance deadlines.
- eb70476: Give each owned SSH/SFTP fixture launch a private host-trust file so concurrent clients cannot rewrite another client's pin, preserving strict verification and cleanup.
- @lazysh/account-usage@1.8.3
  - @lazysh/common@1.8.3
  - @lazysh/display-idle@1.8.3
  - @lazysh/et-transport@1.8.3
  - @lazysh/mosh-transport@1.8.3

## 1.8.2

### Patch Changes

- 17ce060: Remeasure the Android native D-pad target after its initial keyboard-opening tap, preserving owned-window injection and exact receiver-byte acceptance.
- 1d4c8c5: Retain closed owned-tool failure observations and explicit validated native-receipt progress in ntfy acceptance failures, without changing process cleanup, deadlines or trust checks.
- 99422b0: Use the visible workspace Preferences action in Android D-pad acceptance and retain closed failure-only IME editor-clause diagnostics without changing input or acceptance behavior.
- @lazysh/account-usage@1.8.2
  - @lazysh/common@1.8.2
  - @lazysh/display-idle@1.8.2
  - @lazysh/et-transport@1.8.2
  - @lazysh/mosh-transport@1.8.2

## 1.8.1

### Patch Changes

- d36533a: Retain fixed test-only startup stage breadcrumbs when owned Mosh multiplexer acceptance fails, without changing connection errors or runtime behavior.
- f9150ac: Forward the pinned disposable Secret Service executable through the native GUI Turbo task and give Android raw-input acceptance fixtures an owned SSH root, preserving strict environment filtering and receiver ownership checks.
- 14597f5: Retain one closed distributor UI snapshot only after the native ntfy trust-topic flow fails, preserving the original navigation timing, action, deadline and failure.
- @lazysh/account-usage@1.8.1
  - @lazysh/common@1.8.1
  - @lazysh/display-idle@1.8.1
  - @lazysh/et-transport@1.8.1
  - @lazysh/mosh-transport@1.8.1

## 1.8.0

### Minor Changes

- 35722cf: Add held-pointer panning and paced arrow repeats to the expanded terminal D-pad, preserving single taps and stopping input on interruption or session replacement.

### Patch Changes

- @lazysh/account-usage@1.8.0
  - @lazysh/common@1.8.0
  - @lazysh/display-idle@1.8.0
  - @lazysh/et-transport@1.8.0
  - @lazysh/mosh-transport@1.8.0

## 1.7.8

### Patch Changes

- d015653: Prepare and independently verify a bounded positive-offset clock state only in the attested disposable Android ntfy fixture, restoring automatic time after verified app-state teardown.
- @lazysh/account-usage@1.7.8
  - @lazysh/common@1.7.8
  - @lazysh/display-idle@1.7.8
  - @lazysh/et-transport@1.7.8
  - @lazysh/mosh-transport@1.7.8

## 1.7.7

### Patch Changes

- 019bc6a: Add an owned Android packaged-terminal SSH checkpoint for fixed native IME correction/repeat transactions and stale InputConnection rejection; physical keyboard qualification remains separate.
- @lazysh/account-usage@1.7.7
  - @lazysh/common@1.7.7
  - @lazysh/display-idle@1.7.7
  - @lazysh/et-transport@1.7.7
  - @lazysh/mosh-transport@1.7.7

## 1.7.6

### Patch Changes

- 85195e3: Record closed native companion action-readiness diagnostics without changing install/reuse acceptance or its deadlines.
- @lazysh/account-usage@1.7.6
  - @lazysh/common@1.7.6
  - @lazysh/display-idle@1.7.6
  - @lazysh/et-transport@1.7.6
  - @lazysh/mosh-transport@1.7.6

## 1.7.5

### Patch Changes

- efb451e: Organize documentation around guided learning, task guides, reference and explanation, with a first SSH session and preserved security and platform limits.
- @lazysh/account-usage@1.7.5
  - @lazysh/common@1.7.5
  - @lazysh/display-idle@1.7.5
  - @lazysh/et-transport@1.7.5
  - @lazysh/mosh-transport@1.7.5

## 1.7.4

### Patch Changes

- c398f06: Verify session-first Workspaces, explicit Herdr setup disclosure and retained terminal navigation through the real Linux native app and owned SSH servers.
- @lazysh/account-usage@1.7.4
  - @lazysh/common@1.7.4
  - @lazysh/display-idle@1.7.4
  - @lazysh/et-transport@1.7.4
  - @lazysh/mosh-transport@1.7.4

## 1.7.3

### Patch Changes

- 2e41ca2: Prioritize existing app sessions in Workspaces, disclose healthy Herdr server setup, and refine compact themed navigation while preserving shared-focus warnings and session identity.
- a95d903: Prevent delayed terminal controls from taking focus away from an open credential dialog.
- @lazysh/account-usage@1.7.3
  - @lazysh/common@1.7.3
  - @lazysh/display-idle@1.7.3
  - @lazysh/et-transport@1.7.3
  - @lazysh/mosh-transport@1.7.3

## 1.7.2

### Patch Changes

- f9b908e: Add an owned Linux native GUI saved-credential reconnect checkpoint using a disposable Secret Service, with explicit trust/save/reconnect/forget and private-process cleanup.
- @lazysh/account-usage@1.7.2
  - @lazysh/common@1.7.2
  - @lazysh/display-idle@1.7.2
  - @lazysh/et-transport@1.7.2
  - @lazysh/mosh-transport@1.7.2

## 1.7.1

### Patch Changes

- 45c8b2f: Follow the visible Appearance disclosure before native iOS app-icon acceptance. Preserve actual icon confirmation, readback, restoration and existing wait limits.
- 222c1e2: Retain bounded host/device clock comparison diagnostics in owned Android ntfy acceptance receipts without changing notification admission or clock settings.
- @lazysh/account-usage@1.7.1
  - @lazysh/common@1.7.1
  - @lazysh/display-idle@1.7.1
  - @lazysh/et-transport@1.7.1
  - @lazysh/mosh-transport@1.7.1

## 1.7.0

### Minor Changes

- bcc7feb: Add opt-in V3 managed Amp system-plugin setup with protected ownership, shadow-aware removal and bounded V2 metadata compatibility.

### Patch Changes

- b988e84: Qualify manual Android Mosh attachment uploads with a valid image spanning multiple chunks and an unchanged pre-existing destination. This checkpoint does not establish closed-control recovery, file-picker/camera or Samsung device compatibility.
- @lazysh/account-usage@1.7.0
  - @lazysh/common@1.7.0
  - @lazysh/display-idle@1.7.0
  - @lazysh/et-transport@1.7.0
  - @lazysh/mosh-transport@1.7.0

## 1.6.0

### Minor Changes

- aad0990: Add opt-in version-2 hook discovery and inspected, profile-scoped Copilot hook setup while preserving version-1 compatibility, foreign settings and provider trust.

### Patch Changes

- b6c3bd3: Keep a held touch scroll on the stable terminal screen when output redraws its text spans. Preserve screen-reader mode and desktop hit testing.
- b6c3bd3: Normalize mouse-tracking touch scroll by finger travel instead of event frequency, retaining partial distance, original targeting and bounded wheel batches until the gesture ends. Keep the outer terminal canvas anchored during keyboard-sized resize and input visibility requests. Plain terminal history and physical wheel behavior remain unchanged.
- @lazysh/account-usage@1.6.0
  - @lazysh/common@1.6.0
  - @lazysh/display-idle@1.6.0
  - @lazysh/et-transport@1.6.0
  - @lazysh/mosh-transport@1.6.0

## 1.5.5

### Patch Changes

- da17fde: Qualify closing one SSH relay stream through its owned server subtree for Android upload-recovery testing. Refuse stale, missing or ambiguous server attribution and preserve the original Mosh UDP daemon. Android recovery UI acceptance remains separate.
- @lazysh/account-usage@1.5.5
  - @lazysh/common@1.5.5
  - @lazysh/display-idle@1.5.5
  - @lazysh/et-transport@1.5.5
  - @lazysh/mosh-transport@1.5.5

## 1.5.4

### Patch Changes

- @lazysh/account-usage@1.5.4
  - @lazysh/common@1.5.4
  - @lazysh/display-idle@1.5.4
  - @lazysh/et-transport@1.5.4
  - @lazysh/mosh-transport@1.5.4

## 1.5.3

### Patch Changes

- cd969ee: Correct native Android fixture Setup-state reads and whole-value clipboard replacement, and retain bounded visual-readiness observations without changing gesture or transport acceptance.
- @lazysh/account-usage@1.5.3
  - @lazysh/common@1.5.3
  - @lazysh/display-idle@1.5.3
  - @lazysh/et-transport@1.5.3
  - @lazysh/mosh-transport@1.5.3

## 1.5.2

### Patch Changes

- 11187d3: Refine mobile connected navigation with full-width agent/workspace views, compact accessible Herdr actions and progressive activity details while preserving terminal and session behavior.
- @lazysh/account-usage@1.5.2
  - @lazysh/common@1.5.2
  - @lazysh/display-idle@1.5.2
  - @lazysh/et-transport@1.5.2
  - @lazysh/mosh-transport@1.5.2

## 1.5.1

### Patch Changes

- @lazysh/account-usage@1.5.1
  - @lazysh/common@1.5.1
  - @lazysh/display-idle@1.5.1
  - @lazysh/et-transport@1.5.1
  - @lazysh/mosh-transport@1.5.1

## 1.5.0

### Minor Changes

- f0b0b94: Show optional read-only Herdr reported-session details with same-connection companion matches and explicit unverified/shared-reference labels. Path references remain private; input and Chat authority are unchanged.
- 8db8a98: Detect installed host agents and known profile locations before explicit hook setup. Let users select a target while preserving inspected installation plans, manual profile selection and provider trust decisions. Discovery never installs hooks or creates missing profiles.
- afc27ec: Add explicit managed Cline root lifecycle plugin setup and profile discovery. Preserve existing plugin restrictions and require inspected install/remove plans; configuration does not establish live reporting.

### Patch Changes

- 9f2c42f: Make reported agent activity reachable from the top of the Agents drawer without changing readers or navigation state.
- 8811c8a: Retain the mobile Agents drawer reading position when returning from a tool without changing navigation or provider state.
- a422338: Reveal the current Agents Setup through its visible public button before native keep-awake acceptance toggles the checkbox. Preserve the ownership checks, deadlines and strict gesture oracle; this test precondition repair does not establish Android gesture acceptance.
- b190865: Correct download and public roadmap guidance, and document Obtainium as the preferred Android installation method with explicit APK flavor selection and verification limits.
- @lazysh/account-usage@1.5.0
  - @lazysh/common@1.5.0
  - @lazysh/display-idle@1.5.0
  - @lazysh/et-transport@1.5.0
  - @lazysh/mosh-transport@1.5.0

## 1.4.2

### Patch Changes

- cf4b9f3: Qualify compact settings and workspace navigation through visible browser acceptance preconditions while retaining existing locale, display ownership, QR privacy and stale dictation assertions.
- 8d7a15d: Show concise provider-specific verification guidance after inspected hook configuration without changing trust, loading or reporting status.
- 0844aa3: Keep Workspace tools short by default with explicit session-tool, connection and application disclosures, preserving existing guarded actions and touch targets.
- @lazysh/account-usage@1.4.2
  - @lazysh/common@1.4.2
  - @lazysh/display-idle@1.4.2
  - @lazysh/et-transport@1.4.2
  - @lazysh/mosh-transport@1.4.2

## 1.4.1

### Patch Changes

- 137bb78: Keep the native branded cover until the current renderer acknowledges its workspace commit when app lock is disabled, including after recreation. Preserve native unlock controls for confirmed locks. Physical-device launch-frame qualification remains pending.
- 4c31c91: Return from usage and workspace tools to their opening context without replacing the terminal session, and dismiss local overlays before Android Back navigates.
- 16460c7: Open the existing hook inspection workflow directly from empty Activity without automatically installing hooks or asserting live reporting.
- 08210fc: Prioritize agents over optional setup in healthy workspaces, retaining visible repairs and pending approvals.
- 8bc9f45: Collapse healthy selected Herdr setup even when other servers are available. Preserve explicit alternate selection and automatic setup for missing or unhealthy selections.
- fb2b45d: Refine frosted navigation and short action sheets using the active theme colors. Keep long forms and terminal output opaque and preserve reduced-transparency and forced-color fallbacks.
- 8d9f8b7: Publish the Android workspace UX critique and fresh Moshi/Termish benchmark, with inspected screenshots, issue links and observable redesign acceptance criteria. This research checkpoint does not claim the reported UX or agent-activity failures are fixed.
- dd2c945: Retain the one native notification-permission action budget separately from later menu queries and record only the first measured expiry operation, without changing deadlines, input or permissions.
- c9265d1: Start Preferences at a compact category list without focusing text input, preserving settings drafts and operations.
- 8fb1c57: Collapse saved-host connection options and focus credentials or Connect without opening advanced Mosh fields.
- a928587: Distinguish terminal input queue saturation from channel closure and add bounded, content-free caller/ownership diagnostics. This improves diagnosis; it does not claim the Android navigation failure is fixed.
- @lazysh/account-usage@1.4.1
  - @lazysh/common@1.4.1
  - @lazysh/display-idle@1.4.1
  - @lazysh/et-transport@1.4.1
  - @lazysh/mosh-transport@1.4.1

## 1.4.0

### Minor Changes

- 54796e0: Browse Herdr spaces and live agent panes from workspace navigation. Reuse or explicitly attach the exact server display, then use stock shared workspace/tab focus or the companion's exact shell/agent pane focus. Disclose shared focus and require fresh Chat confirmation after navigation.
- 730cb2a: Add explicit inspected-plan lifecycle hook setup for Claude Code, Codex and OpenCode, with an SSH-connected Agents setup flow and companion CLI.

  Preserve foreign profile values and ordinary file mode/group metadata, refuse unhandled ACLs or ownership conflicts, and keep configured state distinct from trust and live reporting. Managed writes initially support qualified Linux filesystems; other platforms retain preview-only capability.
- 7218f34: Add inspected-profile managed Droid hooks for an already-existing standalone hooks.json, including the connected Agents selector.

  Preserve foreign groups and fallback policy; refuse absent configuration rather than shadowing settings/legacy declarations. No automatic trust changes, fresh-profile migration or native Droid lifecycle claim.
- 7477209: Extend explicit inspected-profile lifecycle hook setup to Gemini CLI and Cursor CLI, including the SSH-connected Agents setup selector.

  Preserve Gemini millisecond deadlines and disable flags, Cursor version-1/fail-open observer semantics, foreign policy and the existing retained filesystem transaction. Other managed providers, macOS writes and actual provider-trusted reporting remain separate gaps.
- 8b5770c: Enter the saved named multiplexer through Mosh without forcing SSH, retain exact transport and attachment restoration intent, and preserve native display admission before exposing the connection.

### Patch Changes

- bc6c84d: Recover built-in account quotas from empty external reports and offer companion setup when a remote usage command is missing or outdated.
- b42a598: Fence Android and desktop IME composition completion and Enter against replay; apply owned trailing ASCII corrections without enabling private keyboard mode. Flush preedit before toolbar modifier changes. Complete the Android terminal no-autocorrect policy with autocomplete off; Compose hints remain unchanged. Preserve upstream handling for unsupported replacement spans pending remote editor compatibility.
- 6026586: Show branded Android startup content until the native access policy is known.
- b3d7262: Keep Android system bar icons readable over the native navy background.
- ad7e576: Reduce repeated mobile guidance and compact unavailable Apple status without hiding active sharing controls or safety limits.
- fd3a0aa: Free the terminal control row and prevent composer action overlap; give long mobile dialogs a fullscreen layout while preserving trust, authentication and dismissal protections.
- 34d9ba1: Compact and align the workspace restore notice, retaining restoration limitations in an accessible details disclosure and preserving explicit restore and dismissal behavior.
- 19e9da2: Verify companion files with a fixed, bounded window of SFTP reads while retaining ordered full-file hashing, legal partial-read handling, explicit EOF and metadata checks. Preserve existing time limits, conservative residue warnings and deletion guards; closed cleanup stage/reason observations distinguish incomplete cleanup from installation outcomes.
- f573077: Classify failed companion installer tag rechecks without exposing request or response text or changing verification rules.
- c0eaf57: Keep a continuous terminal touch drag routed to its original pane until the finger lifts or the gesture is cancelled.
- 693d31d: Keep Herdr navigation and agent reports reachable within one scrollable drawer on short screens.
- 1af65c3: Display structured native terminal error messages and preserve localized failures instead of rendering `[object Object]`.
- c6871fd: Clear sticky touch hover from momentary terminal keys while retaining intentional modifiers, held-key feedback, fine-pointer hover and accessible keyboard focus.
- 975d88e: Hold unsupported terminal IME corrections for bounded inline review and explicit copy without replaying text, guessing erase units or submitting deferred Enter. Preserve Compose drafts and clear local context at session/access lifecycle boundaries.
- Updated dependencies [bc6c84d]
  - @lazysh/account-usage@1.4.0
  - @lazysh/common@1.4.0
  - @lazysh/display-idle@1.4.0
  - @lazysh/et-transport@1.4.0
  - @lazysh/mosh-transport@1.4.0

## 1.3.3

### Patch Changes

- 7ea9c70: Accept Herdr encoded public identifiers so valid live agents are not rejected.
- @lazysh/account-usage@1.3.3
  - @lazysh/common@1.3.3
  - @lazysh/display-idle@1.3.3
  - @lazysh/et-transport@1.3.3
  - @lazysh/mosh-transport@1.3.3

## 1.3.2

### Patch Changes

- 5fd13cf: Retain closed last-poll selector counts and timing for public Android APK readiness failures without adding accessibility queries or changing acceptance actions and deadlines.
- @lazysh/account-usage@1.3.2
  - @lazysh/common@1.3.2
  - @lazysh/display-idle@1.3.2
  - @lazysh/et-transport@1.3.2
  - @lazysh/mosh-transport@1.3.2

## 1.3.1

### Patch Changes

- 9b7be20: Start live agent discovery on the attached Herdr session while preserving explicit server selection and refusing to substitute an absent attached target.
- @lazysh/account-usage@1.3.1
  - @lazysh/common@1.3.1
  - @lazysh/display-idle@1.3.1
  - @lazysh/et-transport@1.3.1
  - @lazysh/mosh-transport@1.3.1

## 1.3.0

### Minor Changes

- e5a32d9: Keep Android terminal sessions active while switching apps, with worker-owned background execution and paused renderer output deadlines.
- 9565f8a: Add compact AI account quotas and built-in host collectors when ai-usagebar is unavailable, keeping credentials on the session machine.
- 6c2657a: Keep Agents results, counts and empty states stable during periodic refreshes. Preserve read failures until a replacement completes; a failed live read clears its rows and count. This fixes polling flicker without claiming that the reported missing Herdr agents are resolved.
  
  Preserve whether a Herdr snapshot supplies live agent metadata. Show an explicit compatibility warning instead of a healthy zero-agent count when that metadata is missing; legacy Sessions trees remain supported.
  
  Add explicit host-tools SSH recovery for eligible Mosh sessions with a closed command connection. Authenticate for the original verified host while keeping the terminal and the independent upload connection; no authentication runs automatically.
- 54197d2: Open the current host's Default multiplexer setting directly from More, with the selector focused. Saving keeps the running terminal and saved transport preference intact; the named default applies to future connections.
  
  Select Use saved credentials by default when the native vault confirms they are available. Preserve explicit manual authentication choices and credentials entered before the availability check finishes; connecting remains explicit and secrets stay in the native vault.
  
  Expand terminal keys with Shift, Alt/AltGr, attachment, function/navigation/symbol keys, modifier locking and repeat. Preserve custom layouts and migrate the old default row. Make Compose and terminal-key visibility branded icon buttons and reduce terminal side padding.

### Patch Changes

- e92681c: Preserve the file-transfer closure warning and its partial-file guidance when uploads need reauthentication. Distinguish host-tools SSH closure so Agents only offers command recovery for the correct connection purpose; quota reads continue to classify a closed command connection as disconnected.
- Updated dependencies [9565f8a]
  - @lazysh/account-usage@1.3.0
  - @lazysh/common@1.3.0
  - @lazysh/display-idle@1.3.0
  - @lazysh/et-transport@1.3.0
  - @lazysh/mosh-transport@1.3.0

## 1.2.0

### Minor Changes

- 87aca79: Install or update the published host companion from the existing SSH connection, including when it is missing, with verified transfer, explicit progress and conservative uncertain outcomes. Prefer a valid managed Unix executable while preserving legacy PATH behavior when absent; installation and host permission changes remain explicit.

### Patch Changes

- @lazysh/common@1.2.0
  - @lazysh/display-idle@1.2.0
  - @lazysh/et-transport@1.2.0
  - @lazysh/mosh-transport@1.2.0

## 1.1.7

### Patch Changes

- b835cbd: Show live Herdr-reported Codex and other agent panes even when companion lifecycle reports are empty or unavailable, with explicit server selection and distinct live statuses.
- @lazysh/common@1.1.7
  - @lazysh/display-idle@1.1.7
  - @lazysh/et-transport@1.1.7
  - @lazysh/mosh-transport@1.1.7

## 1.1.6

### Patch Changes

- efa13fd: Enable terminal touch scrolling in Herdr and other full-screen apps, and give active phone terminals one compact header with secondary controls in More.
- @lazysh/common@1.1.6
  - @lazysh/display-idle@1.1.6
  - @lazysh/et-transport@1.1.6
  - @lazysh/mosh-transport@1.1.6

## 1.1.5

### Patch Changes

- Updated dependencies [3c1171d]
  - @lazysh/mosh-transport@1.1.5
  - @lazysh/common@1.1.5
  - @lazysh/display-idle@1.1.5
  - @lazysh/et-transport@1.1.5

## 1.1.4

### Patch Changes

- 9fd91c6: Use protected foreground Android clipboard reads for explicit terminal text paste and PNG/JPEG attachment preview, preserving literal paste and separate manual upload.
- @lazysh/common@1.1.4
  - @lazysh/display-idle@1.1.4
  - @lazysh/et-transport@1.1.4
  - @lazysh/mosh-transport@1.1.4

## 1.1.3

### Patch Changes

- 6e6c9cd: Fix mobile settings, checkbox and attachment layout and expose existing per-host multiplexer preferences.
- @lazysh/common@1.1.3
  - @lazysh/display-idle@1.1.3
  - @lazysh/et-transport@1.1.3
  - @lazysh/mosh-transport@1.1.3

## 1.1.2

### Patch Changes

- 8e3b293: Grant the local native app access to the existing upload recovery and host companion settings commands, preserving unlock, verified-host, authentication and settings revision guards. Other windows and remote pages remain denied.
- @lazysh/common@1.1.2
  - @lazysh/display-idle@1.1.2
  - @lazysh/et-transport@1.1.2
  - @lazysh/mosh-transport@1.1.2

## 1.1.1

### Patch Changes

- 81f0e63: Add bounded failure-only diagnostics for the already captured fresh-SSH tmux control client: fenced ancestry to the owned SSH daemon and closed descriptor-kind categories. Product behavior, acceptance predicates and retirement deadlines remain unchanged; the hosted teardown cause remains unproven until actual evidence is captured.
- cafea79: Retain bounded driver stage entry/exit progress on failed published Android APK qualification commands without changing public APK bytes, UI operations, deadlines or success requirements.
- 2739871: Observe the existing Windows concurrent Store initialization case with bounded, closed storage phases before the unchanged native host harness. Raw output is not published, the original failure remains primary, and storage behavior, write semantics and wait budgets remain unchanged pending actual phase evidence.
- @lazysh/common@1.1.1
  - @lazysh/display-idle@1.1.1
  - @lazysh/et-transport@1.1.1
  - @lazysh/mosh-transport@1.1.1

## 1.1.0

### Minor Changes

- 0ad69a5: Add explicit same-tab upload recovery for direct Mosh sessions using the original verified host and existing saved/manual SSH authentication. Preserve attachment drafts, terminal/output identity, access leases, exclusive creation and upload limits; never save credentials, start a new terminal or automatically retry an upload. Other SSH tools retain their original connection.

### Patch Changes

- b63304b: Style native file-picker buttons with the active lazysh theme and minimum 44px touch targets.
- @lazysh/common@1.1.0
  - @lazysh/display-idle@1.1.0
  - @lazysh/et-transport@1.1.0
  - @lazysh/mosh-transport@1.1.0

## 1.0.2

### Patch Changes

- 496025f: Prevent mobile session toolbar labels and icons from overlapping by keeping complete buttons in a horizontally scrollable row.
- ea2426d: Explain a positively closed SSH attachment-transfer connection instead of showing a generic channel-send error. Direct users to the existing verified saved-host connection flow while preserving a live Mosh tab, partial-file warnings, upload limits and exclusive file creation. Automatic in-place SSH reauthentication remains separate work.
- @lazysh/common@1.0.2
  - @lazysh/display-idle@1.0.2
  - @lazysh/et-transport@1.0.2
  - @lazysh/mosh-transport@1.0.2

## 1.0.1

### Patch Changes

- e1b0208: Require a published, verified GitHub version for every completed milestone, including internal milestones, and clarify version preparation versus publication.

  Remove unused desktop browser archive tooling before Android source scans, and allow an exact-source retry of unpublished 1.0.0 with every build, scan, artifact and tag check preserved.
- c02f548: Restore the owned tmux shutdown discriminator's receipt assertion so its stopped-client/resume proof runs to completion. Product retirement guards and deadlines remain unchanged; this does not resolve the separate hosted fresh-SSH teardown failure.
- @lazysh/common@1.0.1
  - @lazysh/display-idle@1.0.1
  - @lazysh/et-transport@1.0.1
  - @lazysh/mosh-transport@1.0.1

## 1.0.0

### Major Changes

- f5e61f1: Accept only lazysh theme share codes and raw JSON, and remove vendor-identifying repository references.

### Minor Changes

- 3651a8c: Add optional per-host default multiplexer and named-session SSH direct entry while preserving saved transport and explicit launch behavior.
- f5e61f1: Add a localized named/function-key picker to shared shortcut editors with independent drafts and existing validated bindings.
- 8fe533a: Add separate opt-in private Android UnifiedPush event notification display with confirmed device binding and durable bounded replay admission. Existing enrollment alone leaves display off.
- 726ace1: Add persistent connected-workspace sidebar navigation, suspended hidden agent owners and a guarded tmux picker that adopts each returned native snapshot.
- ac60385: Add client-side reported-agent search, status filters and selected-report context while preserving explicit host actions and reported-only identity semantics.
- 1de657d: Refresh reported agent activity every five seconds while its board is visible and the app is in the foreground, preserving manual refresh and existing host permissions.
- 49a2d4a: Support warm desktop directory launches with caller-relative paths and one-shot guarded admission.

### Patch Changes

- 7968d3d: Fit the Android WebView to system bars, display cutouts and docked keyboard insets so the terminal resizes and special keys stay visible.
- 0b9b2b9: Refresh the default app appearance with lazysh brand colors, restrained glass surfaces, and consistent controls while retaining saved and terminal theme choices.
- 9520102: Publish the current version explicitly and preserve future verified version releases without superseding older in-flight builds.
- f5e9d70: Enable verified Android, Linux and Windows GitHub releases after Changesets version merges; defer Apple and official F-Droid inclusion.
- 5f3857a: Prepare Android, Linux and Windows release artifacts while Apple releases are deferred.
- 3fbb8c7: Fail closed on unsupported tmux client/session loops before enabling navigation or guarded Chat input, and require exactly one matching original client per action. Older servers retain ordinary terminal access.
- 698ed5e: Show the canonical lazysh logo on the welcome screen instead of the placeholder terminal illustration.
- f5cdace: Require native Windows NSIS install, same-version repair with preserved owned data, and uninstall acceptance before staging release bytes.
- 196fc79: Fix Windows release packaging validation of native workspace path separators.
- @lazysh/common@1.0.0
  - @lazysh/display-idle@1.0.0
  - @lazysh/et-transport@1.0.0
  - @lazysh/mosh-transport@1.0.0

## 0.23.0

### Minor Changes

- 3dc44f4: Prepare verified cross-platform installer artifacts, release notes, checksums and installation guidance.

### Patch Changes

- @lazysh/common@0.23.0
  - @lazysh/display-idle@0.23.0
  - @lazysh/et-transport@0.23.0
  - @lazysh/mosh-transport@0.23.0

## 0.22.0

### Patch Changes

- @lazysh/common@0.22.0
  - @lazysh/display-idle@0.22.0
  - @lazysh/et-transport@0.22.0
  - @lazysh/mosh-transport@0.22.0

## 0.21.0

### Minor Changes

- a8c7fba: Add Zellij tab 1–20 quick access through existing typed native actions while preserving drafts and original session/access ownership.

### Patch Changes

- @lazysh/common@0.21.0
  - @lazysh/display-idle@0.21.0
  - @lazysh/et-transport@0.21.0
  - @lazysh/mosh-transport@0.21.0

## 0.20.0

### Minor Changes

- 5a4cef4: Add explicit pinned Noto Sans Mono CJK SC download into existing local font storage, with integrity checks, cancellation and a narrowly scoped asset CSP. No automatic download or font selection.

### Patch Changes

- @lazysh/common@0.20.0
  - @lazysh/display-idle@0.20.0
  - @lazysh/et-transport@0.20.0
  - @lazysh/mosh-transport@0.20.0

## 0.19.0

### Minor Changes

- 1b5a350: Add explicit editable comments to numbered before/after diff lines, preserving observed staged/unstaged and rename context until the user stages a prompt draft.
- 65a81e4: Add an explicit action to paste a completed uploaded path into its original terminal without Enter, preserving terminal bracketed-paste mode and the editable prompt.

### Patch Changes

- @lazysh/common@0.19.0
  - @lazysh/display-idle@0.19.0
  - @lazysh/et-transport@0.19.0
  - @lazysh/mosh-transport@0.19.0

## 0.18.0

### Minor Changes

- 75b5460: Add opt-in five-second listener refresh scoped to the visible Preview panel, preserving explicit HTTP checks and preview opening.

### Patch Changes

- @lazysh/common@0.18.0
  - @lazysh/display-idle@0.18.0
  - @lazysh/et-transport@0.18.0
  - @lazysh/mosh-transport@0.18.0

## 0.17.2

### Patch Changes

- b1b4f3b: Use the selected terminal font in repository side-by-side diffs without reloading the review or changing its contents.
- cc8d477: Refresh agent-board display metadata on native main-window focus without polling or retrying failed acquisition.
- @lazysh/common@0.17.2
  - @lazysh/display-idle@0.17.2
  - @lazysh/et-transport@0.17.2
  - @lazysh/mosh-transport@0.17.2

## 0.17.1

### Patch Changes

- cf917f9: Remove the twelve-entry shortcut and snippet cap, retain all valid saved entries, and keep snippet drafts when device storage refuses a save.
- @lazysh/common@0.17.1
  - @lazysh/display-idle@0.17.1
  - @lazysh/et-transport@0.17.1
  - @lazysh/mosh-transport@0.17.1

## 0.17.0

### Minor Changes

- 5a1d420: Show a bounded server-reported Next.js hint during explicit preview HTTP discovery without changing its default or waiting for additional headers.

### Patch Changes

- e6c0e65: Catalogue the static Next.js preview hint label without changing discovery or its displayed brand.
- @lazysh/common@0.17.0
  - @lazysh/display-idle@0.17.0
  - @lazysh/et-transport@0.17.0
  - @lazysh/mosh-transport@0.17.0

## 0.16.0

### Minor Changes

- 2f1963a: Introduce the original Bed Mode lazysh identity, a full transparent SVG brand kit, and matching web, Android, iOS, and desktop launcher assets.

### Patch Changes

- 07f0eba: Use the approved Bed Mode mark as the decorative sidebar symbol without duplicating the app name for assistive technology.
- @lazysh/common@0.16.0
  - @lazysh/display-idle@0.16.0
  - @lazysh/et-transport@0.16.0
  - @lazysh/mosh-transport@0.16.0

## 0.15.0

### Minor Changes

- 9c8d067: Add opt-in F-Droid UnifiedPush distributor registration with truthful registration-only status and local revocation. Incoming messages remain ignored until a separate authenticated delivery integration is verified.

### Patch Changes

- e234a24: Use the interface catalog for the Cloud speech-engine option prefix while preserving validated backend identifiers and locale-stable draft/metadata behavior.
- @lazysh/common@0.15.0
  - @lazysh/display-idle@0.15.0
  - @lazysh/et-transport@0.15.0
  - @lazysh/mosh-transport@0.15.0

## 0.14.0

### Minor Changes

- 59252bd: Add an optional operator-selected self-hosted whisper.cpp relay backend while preserving OpenAI defaults, device consent and bounded transcription admission.

### Patch Changes

- @lazysh/common@0.14.0
  - @lazysh/display-idle@0.14.0
  - @lazysh/et-transport@0.14.0
  - @lazysh/mosh-transport@0.14.0

## 0.13.0

### Minor Changes

- 1f890f6: Add an explicit F-Droid Android variant without Google remote push dependencies. Local inbox notifications remain available; normal Android Firebase and iOS APNs builds retain their behavior.

### Patch Changes

- @lazysh/common@0.13.0
  - @lazysh/display-idle@0.13.0
  - @lazysh/et-transport@0.13.0
  - @lazysh/mosh-transport@0.13.0

## 0.12.2

### Patch Changes

- 1da4cad: Add English Android listing descriptions with development-preview and host-dependency limits, without claiming F-Droid publication or changing application behavior.
- @lazysh/common@0.12.2
  - @lazysh/display-idle@0.12.2
  - @lazysh/et-transport@0.12.2
  - @lazysh/mosh-transport@0.12.2

## 0.12.1

### Patch Changes

- 04d4085: Expose synchronized Android version metadata and reject ambiguous or out-of-range release version codes.
- @lazysh/common@0.12.1
  - @lazysh/display-idle@0.12.1
  - @lazysh/et-transport@0.12.1
  - @lazysh/mosh-transport@0.12.1

## 0.12.0

### Minor Changes

- fb625df: Add opt-in syntax highlighting to Remote Files text previews while preserving exact plain text, keyboard scrolling and existing SFTP reads. Keep syntax nodes tied to the current source across refreshes.

### Patch Changes

- @lazysh/common@0.12.0
  - @lazysh/display-idle@0.12.0
  - @lazysh/et-transport@0.12.0
  - @lazysh/mosh-transport@0.12.0

## 0.11.0

### Minor Changes

- 87e923a: Compose review dictation with the latest editable draft without losing concurrent edits. Preserve bounded drafts, per-clip history and separate clip-only direct delivery.

### Patch Changes

- @lazysh/common@0.11.0
  - @lazysh/display-idle@0.11.0
  - @lazysh/et-transport@0.11.0
  - @lazysh/mosh-transport@0.11.0

## 0.10.1

### Patch Changes

- 3ec508c: Preserve explicit Pi tool-result error booleans in recorded chat and reuse the recorded-error badge without inferring live state or changing other adapters.
- @lazysh/common@0.10.1
  - @lazysh/display-idle@0.10.1
  - @lazysh/et-transport@0.10.1
  - @lazysh/mosh-transport@0.10.1

## 0.10.0

### Minor Changes

- 491a8b9: Add uploaded host-local attachment paths explicitly to an existing Chat draft without automatic send or clipboard effects.

### Patch Changes

- @lazysh/common@0.10.0
  - @lazysh/display-idle@0.10.0
  - @lazysh/et-transport@0.10.0
  - @lazysh/mosh-transport@0.10.0

## 0.9.1

### Patch Changes

- 1f4aa2b: Translate retained access-status and unlock failures when the interface language changes without repeating native access work or changing access policy.
- @lazysh/common@0.9.1
  - @lazysh/display-idle@0.9.1
  - @lazysh/et-transport@0.9.1
  - @lazysh/mosh-transport@0.9.1

## 0.9.0

### Minor Changes

- ee9c0a9: Add explicit confirmed Chat input for original guarded Herdr terminals with candidate cleanup, preserved transcript/session authority and manual fallback.

### Patch Changes

- @lazysh/common@0.9.0
  - @lazysh/display-idle@0.9.0
  - @lazysh/et-transport@0.9.0
  - @lazysh/mosh-transport@0.9.0

## 0.8.0

### Minor Changes

- 0a66ded: Add native guarded Herdr attachment and access-bound terminal input prerequisites without enabling frontend controls.

### Patch Changes

- @lazysh/common@0.8.0
  - @lazysh/display-idle@0.8.0
  - @lazysh/et-transport@0.8.0
  - @lazysh/mosh-transport@0.8.0

## 0.7.1

### Patch Changes

- a73287a: Defer iOS status review registration until native plugin initialization completes, preserving existing readiness and privacy behavior.
- @lazysh/common@0.7.1
  - @lazysh/display-idle@0.7.1
  - @lazysh/et-transport@0.7.1
  - @lazysh/mosh-transport@0.7.1

## 0.7.0

### Minor Changes

- f852631: Accept one explicit saved-host or multiplexer request in an already-running desktop app, preserving current dialogs, original access receipts and normal authentication.

### Patch Changes

- @lazysh/common@0.7.0
  - @lazysh/display-idle@0.7.0
  - @lazysh/et-transport@0.7.0
  - @lazysh/mosh-transport@0.7.0

## 0.6.0

### Minor Changes

- 5791a6e: Extend explicitly chosen and confirmed tmux terminal input to all 17 native Chat readers, with immutable Hermes/OpenCode session selectors and unchanged Stage defaults.

### Patch Changes

- @lazysh/common@0.6.0
  - @lazysh/display-idle@0.6.0
  - @lazysh/et-transport@0.6.0
  - @lazysh/mosh-transport@0.6.0

## 0.5.0

### Minor Changes

- 9b9a761: Support explicitly confirmed multiline Chat terminal input and tabs through bounded native tmux paste without newline normalization. Stage remains default; bracketed paste depends on the terminal program, and interrupted input is never automatically resent.

### Patch Changes

- @lazysh/common@0.5.0
  - @lazysh/display-idle@0.5.0
  - @lazysh/et-transport@0.5.0
  - @lazysh/mosh-transport@0.5.0

## 0.4.0

### Minor Changes

- 0232b02: Add explicit Claude Chat Send and Request stop for a confirmed existing tmux
  terminal. Stage remains the default, unsupported drafts keep the terminal
  fallback, and uncertain input is never resent automatically.

### Patch Changes

- @lazysh/common@0.4.0
  - @lazysh/display-idle@0.4.0
  - @lazysh/et-transport@0.4.0
  - @lazysh/mosh-transport@0.4.0

## 0.3.0

### Minor Changes

- c997e5f: Add explicitly opted-in Claude reported-history metadata and a selected-row shortcut into Chat. Source files remain unread until Open transcript; reported history does not verify a running agent or enable direct Send/Stop. Existing capture, image and Follow defaults remain off.

### Patch Changes

- @lazysh/common@0.3.0
  - @lazysh/display-idle@0.3.0
  - @lazysh/et-transport@0.3.0
  - @lazysh/mosh-transport@0.3.0

## 0.2.1

### Patch Changes

- 0e21551: Keep retained transcript validation and read alerts in the current interface language without repeating reads or altering raw host diagnostics.
- @lazysh/common@0.2.1
  - @lazysh/display-idle@0.2.1
  - @lazysh/et-transport@0.2.1
  - @lazysh/mosh-transport@0.2.1

## 0.2.0

### Minor Changes

- 65bb97a: Add explicit bounded previews for recorded Codex user PNG/JPEG data-URL images in Records. Image inclusion remains off by default; file references and unsupported media stay inert.

### Patch Changes

- 3be70f8: Resolve native application versions from the synchronized client manifest so Android and Apple generators receive the product version instead of their missing-version defaults. Application identifiers, stored data and protocol schemas are unchanged.
- 284538b: Keep recorded-usage validation messages in the selected language after a locale change, without repeating requests or altering raw host diagnostics.
- b2600f0: Keep retained transcript-discovery validation alerts in the current language without repeating discovery or changing raw host diagnostics.
- e7c2c75: Track product versions and generated package changelogs through reviewed release pull requests, keeping Bun, Cargo and Tauri versions aligned. This does not publish binaries or packages, create tags, or change application defaults.
- @lazysh/common@0.2.0
  - @lazysh/display-idle@0.2.0
  - @lazysh/et-transport@0.2.0
  - @lazysh/mosh-transport@0.2.0
