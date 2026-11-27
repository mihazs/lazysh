# @lazysh/agent

## 1.102.3

No changes in this release.

## 1.102.2

### Patch Changes

- fix(notifications): start the enabled host relay sender automatically ([#2673](https://github.com/mihazs/lazysh/pull/2673))

  <details><summary>Details</summary>

  Agent reports restart an absent sender. Hosts that use an external supervisor can set `LAZYSH_RELAY_AUTOSTART=0`.

  </details>

## 1.102.1

No changes in this release.

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

- fix(agent): read complete browser relay command records ([#2591](https://github.com/mihazs/lazysh/pull/2591))

  <details><summary>Details</summary>

  The host-browser test fixture waits for each record's newline before parsing it.

  </details>

## 1.101.5

No changes in this release.

## 1.101.4

No changes in this release.

## 1.101.3

No changes in this release.

## 1.101.2

No changes in this release.

## 1.101.1

No changes in this release.

## 1.101.0

### Minor Changes

- feat(agents): read Senpi session records

  <details><summary>Details</summary>

  Discover Senpi histories from its agent directory and read their messages and tool results in recorded Chat and Usage.

  </details>

## 1.100.3

No changes in this release.

## 1.100.2

No changes in this release.

## 1.100.1

No changes in this release.

## 1.100.0

No changes in this release.

## 1.99.0

No changes in this release.

## 1.98.6

No changes in this release.

## 1.98.5

No changes in this release.

## 1.98.4

No changes in this release.

## 1.98.3

No changes in this release.

## 1.98.2

No changes in this release.

## 1.98.1

No changes in this release.

## 1.98.0

No changes in this release.

## 1.97.11

No changes in this release.

## 1.97.10

No changes in this release.

## 1.97.9

No changes in this release.

## 1.97.8

No changes in this release.

## 1.97.7

### Patch Changes

- feat(browser): keep the host browser relay's profile until Clear browser data ([#1995](https://github.com/mihazs/lazysh/pull/1995))

  <details><summary>Details</summary>

  Add `--keep-profile` to the hidden host browser relay (`lazysh-agent host-browser serve --keep-profile`): the session uses the one kept profile, leaves it for `host-browser --clear-data`, and is refused while another browser holds it. Without the option the relay stays ephemeral. Nothing is offered in the app yet; no defaults change.

  Updated companions coordinate stale profile recovery and clearing. Stop older companion sessions before using a kept profile or clearing browser data, as older versions do not participate in this coordination.

  The browser is now stopped with SIGTERM to its main process first, so what a page stored in the kept profile (`localStorage`) survives a prompt stop (#2045); only a browser that has not exited in three seconds has its whole process group killed.

  </details>
- feat(browser): fit the host browser relay's stream to the link with a quality ladder ([#1997](https://github.com/mihazs/lazysh/pull/1997))

  <details><summary>Details</summary>

  Fit the host browser relay's stream to the link and the device (`lazysh-agent host-browser serve`, hidden, off until the host browser switch is on): a quality ladder of four rungs (JPEG quality, frame size and every-nth-frame) that steps down within a second when the device acknowledges too few of the frames the page produces and up after ten seconds that fit, `quality {rung}` from the client to hold a rung (Data saver) or to adapt again with `auto`, `quality {rung, pinned}` to the client, every frame for two seconds after forwarded input, and `--idle-release SECONDS` (default 600) which ends a session whose view stayed hidden with `IdleReleased`. Nothing in the app sends or shows these yet.

  </details>
- fix(ios): answer a slow Simulator boot, shutdown or reboot as requested instead of DeviceTimeout ([#2002](https://github.com/mihazs/lazysh/pull/2002))

  <details><summary>Details</summary>

  Answer an iOS Simulator boot, shutdown or reboot that `simctl` is still carrying out after ten seconds as requested instead of `DeviceTimeout`, report a reboot whose shutdown is still running as `shutting_down`, report slow iOS discovery as a warning after one retry, and show a note for each answer in the Devices panel. Changed response shape: an iOS reboot can answer `status: "shutting_down"`.

  </details>
- feat(browser): carry navigation, tabs, dialogs and notices over the host browser relay ([#2001](https://github.com/mihazs/lazysh/pull/2001))

  <details><summary>Details</summary>

  Teach the host browser relay (`lazysh-agent host-browser serve`) navigation, tabs and a page's dialogs: `navigate`, `back`, `forward`, `reload`, `stop`, `tabs`, `activateTab`, `newTab`, `closeTab` and `answerDialog` become the browser's allow-listed calls, and the relay reports the tab list, the page's dialogs and a denied download or file chooser. An address that is not `http`, `https` or `about:blank`, a tab the browser does not have and an answer with no dialog open are refused and counted. The command is still hidden and nothing in the app sends these messages yet.

  </details>
- fix(herdr): on macOS the Herdr event stream ends cleanly when the Herdr server closes its socket ([#2402](https://github.com/mihazs/lazysh/pull/2402))

  <details><summary>Details</summary>

  On macOS the companion's Herdr event stream stopped with `Invalid argument` when the Herdr server closed the socket, instead of ending the stream so the Agent view resubscribes or falls back to polling. The read no longer fails when the platform refuses a timeout on a closed socket.

  </details>

## 1.97.6

No changes in this release.

## 1.97.5

No changes in this release.

## 1.97.4

No changes in this release.

## 1.97.3

### Patch Changes

- fix(agent): a loaded machine no longer makes the Agent view fail to read an OpenCode or Hermes conversation ([#2373](https://github.com/mihazs/lazysh/pull/2373))

  <details><summary>Details</summary>

  Reading an OpenCode or Hermes conversation from its SQLite database stops after a 2 second budget so a malformed database cannot run away. The budget counted elapsed time, so a companion that a busy or throttled machine left waiting for its turn was interrupted with `interrupted` even though the read was cheap. The budget now counts the CPU time the read uses: a stalled reader is never cut off, and a runaway query still is (as is one that exceeds the 10 million SQLite step cap, which is unchanged). On Windows the budget still counts elapsed time.

  </details>

## 1.97.2

No changes in this release.

## 1.97.1

No changes in this release.

## 1.97.0

### Minor Changes

- feat(usage): let a host forbid account quota reads ([#1823](https://github.com/mihazs/lazysh/pull/1823))

  <details><summary>Details</summary>

  Let a host forbid account quota reads (#1588, slice of #18). `lazysh-agent usage-collection show` and `usage-collection update --expected-revision R --account-quota-enabled true|false` read and change a new `usage-collection.json` policy beside `settings.json`. With the switch off, `lazysh-agent account-usage` answers a new `disabled` state with no report before it opens a credential, starts a helper or contacts a provider, and the app shows that the host does not allow account usage reads, in English, Portuguese and Spanish, with no percentage. The default is on, so nothing changes for existing hosts; an unreadable policy fails the read closed.

  </details>
- feat(usage): record account quota samples on an opt-in user-level timer ([#1823](https://github.com/mihazs/lazysh/pull/1823))

  <details><summary>Details</summary>

  Add the opt-in usage collector (#1588, slice of #18). `lazysh-agent usage-collector enable [--interval-minutes N]` installs a user-level timer (a systemd user timer, a launchd agent or a Scheduled Task, no sudo) that wakes `usage-collector run` every five minutes, and `disable` removes it. While it is on, a run records one bounded sample of the account quota report per interval (percentages, resets and staleness only: no plan, balance, credential, prompt or path) in `usage-samples.json`, at most 1000 samples, 7 days and 1 MiB. `status [--limit N]` shows the policy, the timer, the last run and the samples with the host's clock. It is off by default, nothing runs or is written while it is off, and it honors the account quota switch.

  </details>
- feat(agents): answer OpenCode permissions and questions through its local service ([#1841](https://github.com/mihazs/lazysh/pull/1841))

  <details><summary>Details</summary>

  Answer OpenCode permission requests and question forms, and stop a turn, from the Agent view through OpenCode's local background service, with the exact request checked again before every answer.

  </details>
- feat(usage): add host switches for simulator streaming and port scanning in their own host-features.json ([#1813](https://github.com/mihazs/lazysh/pull/1813))

  <details><summary>Details</summary>

  Add host feature switches in their own `host-features.json`: `lazysh-agent settings features show|update` controls whether `devices ... stream` is allowed (it fails with `SimulatorStreamingDisabled` before any SDK process) and whether the app's port scanning is allowed; the Preview panel reads the port-scan switch before every discovery and says when the host turned it off, and Host companion settings offers both switches with a conflict-safe save. `settings.json` is unchanged, so an older companion keeps working. Changed default: the Preview panel now remembers the HTTP check and the automatic refresh for each saved host instead of resetting them on every visit.

  </details>

## 1.96.0

### Minor Changes

- feat(hooks): manage OpenCode, Cline and Amp hook plugins on Windows hosts ([#1962](https://github.com/mihazs/lazysh/pull/1962))

  <details><summary>Details</summary>

  Set up the OpenCode, Cline and Amp hook plugins on Windows hosts: `lazysh-agent hooks status`, `install` and `remove` now work there for those three providers, with owner SID, DACL, reparse-point, hard-link and stream-name admission and a replacement-race-safe commit, instead of reporting managed setup unsupported. The other providers stay preview-only on Windows.

  </details>

### Patch Changes

- fix(agents): stop a Claude Code row waiting for approval after you reject its permission dialog ([#1955](https://github.com/mihazs/lazysh/pull/1955))

  <details><summary>Details</summary>

  Settle a Claude Code row that waits at a permission dialog the person rejected: Claude Code sends no hook for No or Esc, so `lazysh-agent snapshot` now reads the end of the session's conversation file and marks the row done ("Turn interrupted") when its last record is the interruption marker written after the wait began. A rejection older than the wait, or anything said after it, settles nothing, and a host whose snapshot cannot find the file keeps the previous behaviour.

  </details>

## 1.95.7

No changes in this release.

## 1.95.6

No changes in this release.

## 1.95.5

No changes in this release.

## 1.95.4

No changes in this release.

## 1.95.3

No changes in this release.

## 1.95.2

No changes in this release.

## 1.95.1

No changes in this release.

## 1.95.0

No changes in this release.

## 1.94.0

No changes in this release.

## 1.93.9

No changes in this release.

## 1.93.8

No changes in this release.

## 1.93.7

No changes in this release.

## 1.93.6

No changes in this release.

## 1.93.5

No changes in this release.

## 1.93.4

No changes in this release.

## 1.93.3

No changes in this release.

## 1.93.2

No changes in this release.

## 1.93.1

No changes in this release.

## 1.93.0

### Minor Changes

- feat(agents): map Grok Build sub-agent, background job and edit records to the work cards ([#1986](https://github.com/mihazs/lazysh/pull/1986))

  <details><summary>Details</summary>

  Read the sub-agents, background commands and monitors of a Grok Build session into the Agent view's background-work panel, and show a Grok Build edit as the shared diff card (#1847, follow-up of #1285). In the conversation view, `subagent_spawned` and `subagent_finished` become a sub-agent row and `task_backgrounded` and `task_completed` a command or monitor row, each with its recorded end; a launch with no end stays running, and a record of another shape changes nothing. A completed `edit` call whose output is exactly one ACP `diff` becomes an `edit` call carrying that diff, and any other shape stays an ordinary tool block. The shapes come from the official writer source the Grok fixtures pin, not from a live session. No defaults change.

  </details>
- feat(browser): stream the host's Firefox through WebDriver BiDi in the relay ([#1996](https://github.com/mihazs/lazysh/pull/1996))

  <details><summary>Details</summary>

  Teach the host browser relay (`lazysh-agent host-browser serve`) to stream Firefox 159 or newer over WebDriver BiDi: a private profile, `--no-remote`, a random loopback port used only by the relay (the exact `Host` Firefox requires and no `Origin`), polled and pipelined JPEG screenshots that skip repeats, the page's title and address as text, a closed allow-list for every BiDi command, and a session that is always ended and, when Firefox already holds one, replaced by a Firefox the relay starts. A headless Firefox started this way writes no download, and its profile blocks permission prompts and turns off telemetry and update checks. The command is hidden and the app has no viewer yet; input, tabs, navigation and the adaptive frame rate for Firefox follow the matching Chrome slices.

  </details>

### Patch Changes

- fix(agent): start the Android video preview on an idle screen of a guest that prints a warning line ([#1987](https://github.com/mihazs/lazysh/pull/1987))

  <details><summary>Details</summary>

  Fix the Android video preview never starting on an idle screen of a guest that prints a warning line before its screenshot, such as Waydroid: the screenshots that stand in for a video frame read the PNG without skipping that line, so each was dropped as an invalid image and the stream ended in `DeviceTimeout`. They now read it the way **Capture screen** does.

  </details>

## 1.92.3

No changes in this release.

## 1.92.2

No changes in this release.

## 1.92.1

No changes in this release.

## 1.92.0

No changes in this release.

## 1.91.4

### Patch Changes

- fix(agent): keep the transcript-watch heartbeat on time while the stream waits after a slow projection. ([#2248](https://github.com/mihazs/lazysh/pull/2248))

  <details><summary>Details</summary>

  After re-reading a very large transcript the stream waits three times as long as the read took before it checks the file again, and it sent no heartbeat during that wait. A read of a few seconds therefore left the channel silent for longer than the documented 5 seconds, and a longer one could reach the 20 seconds after which the app treats the stream as dead. Heartbeats are now sent every 5 seconds during the wait.

  </details>

## 1.91.3

No changes in this release.

## 1.91.2

No changes in this release.

## 1.91.1

No changes in this release.

## 1.91.0

### Minor Changes

- feat(hooks): set up agent hooks on macOS hosts from the app ([#1949](https://github.com/mihazs/lazysh/pull/1949))

  <details><summary>Details</summary>

  The host companion now writes managed hook configuration on macOS, with ACL, link and replacement-race checks, instead of reporting managed setup unsupported. No defaults change.

  </details>
- feat(hooks): install, update and remove Kimi Code 2.4 approval hooks from Agent hook setup ([#1947](https://github.com/mihazs/lazysh/pull/1947))

  <details><summary>Details</summary>

  **Agent hook setup** lists Kimi Code (`KIMI_CODE_HOME`, otherwise `~/.kimi-code`) and installs three `[[hooks]]` entries (`PermissionRequest`, `PermissionResult`, `SessionEnd`, five seconds) as an owned block at the very end of the profile's existing `config.toml`. Every earlier byte, including comments, secrets, CRLF line endings, foreign hooks and the file mode, is kept; a UTF-8 BOM is refused unchanged because Kimi Code 2.4.1 rejects it. The result is validated as TOML before it is written, a missing `config.toml` is refused instead of created, and update or remove act only on that exact end-of-file block (an edit after it, a moved block or an inline `hooks` setting is a conflict, never a rewrite). It needs the updated host companion: the app asks for discovery schema 4 first and falls back to 3 and 2 for older companions, which keep Kimi manual, as do the legacy Kimi CLI 1.52 profile and custom config paths. No default changes. A one-off run of the official Kimi Code 2.4.1 `kimi doctor` accepted the result; macOS, Windows and a real authenticated Kimi session were not exercised.

  </details>
- feat(hooks): report whether the host received an agent's events in `lazysh-agent hooks status` ([#1945](https://github.com/mihazs/lazysh/pull/1945))

  <details><summary>Details</summary>

  Add an additive `readiness` object to `lazysh-agent hooks status`: whether this host's companion store holds a lifecycle event of the selected agent and when the latest one arrived (read-only, never creating the store), with provider reload, provider trust, pane binding and remote delivery reported as `notChecked`. `reporting` and `trust` are unchanged.

  </details>
- feat: Update the host companion by itself when a newer lazysh app connects ([#1948](https://github.com/mihazs/lazysh/pull/1948))

  <details><summary>Details</summary>

  A companion that is older than the app that talks to it (the app says which version it is in `LAZYSH_APP_VERSION`, set on every command it runs), under the new `lazysh-agent auto-update` policy `install` (the default), starts one detached `lazysh-agent update --yes --version <the app's version>` in the background and replies to the request as usual, with an `update` field in `snapshot`. It never downgrades, defers when a recent active turn is reported or session state cannot be read, runs one update at a time and backs off after a failure. `lazysh-agent auto-update status` and `set --expected-revision R --policy off|notify|install` show and change the policy.

  </details>

### Patch Changes

- change: Refuse a companion release response when its version differs from the requested update version ([#1948](https://github.com/mihazs/lazysh/pull/1948))

## 1.90.0

No changes in this release.

## 1.89.1

No changes in this release.

## 1.89.0

### Minor Changes

- feat(companion): stream a Herdr server's agent-status changes with `lazysh-agent herdr-events` ([#1873](https://github.com/mihazs/lazysh/pull/1873))

  <details><summary>Details</summary>

  `lazysh-agent herdr-events --session NAME` is a long-lived stream of a Herdr server's agent-status changes over `events.subscribe` (frames `hello`, `status`, `changed`, `heartbeat`, `end` and `unsupported`). A frame names the pane, workspace, agent kind and directory and never a title, command or screen text; a Herdr that cannot stream is reported as `unsupported`. It ends when its input closes and starts nothing on the host. Nothing in the app reads it yet and no defaults change; an update of the host companion is needed to have the command.

  </details>

## 1.88.0

### Minor Changes

- feat(companion): admit the managed Windows companion namespace by owner, DACL and reparse point ([#1901](https://github.com/mihazs/lazysh/pull/1901))

  <details><summary>Details</summary>

  Admit the managed Windows companion namespace by owner, DACL and reparse point before `lazysh-agent update` and `installation` use it (#1724, part of #490). `%LOCALAPPDATA%\lazysh\companion` and `lazysh-agent.exe` are checked from the local application data folder down: a link, junction or other reparse point, a directory another account can change, an executable another account owns or can access, and an executable that is no regular file exit 27 (`unsafeInstallLocation`) from `update`, and fail `installation inspect` and `install` with `InstallUnsafeNamespace` or `InstallUnsafeFile`, before anything is created, run or replaced. On Windows, `installation inspect` now also reports the `destination` and the `existing` executable; Windows installation stays unsupported. Changed default: a Windows host whose managed namespace another account can change, which `update` used to accept, now exits 27 and has to be corrected by the user.

  </details>

### Patch Changes

- fix(ios): send taps, swipes and button presses to an iOS Simulator through idb ([#1912](https://github.com/mihazs/lazysh/pull/1912))

  <details><summary>Details</summary>

  idb 1.7.8 rejects a top-level `tap`, `swipe` or `button` (`invalid choice`) because they are `idb ui` subcommands, so no input ever reached a Simulator (#1731, part of #19). The optional idb controls now run `idb ui tap`, `idb ui swipe` and `idb ui button`.

  A real run on a hosted macOS runner (Xcode 26.6, an iOS 26.5 Simulator, idb 1.7.8) verified the companion identity in screen points, a continuous video preview, a tap at a point read from the Simulator's own accessibility frame, an edge swipe, Home and the hardware buttons, and shutdown and boot by UUID. The new non-required `ios-idb-acceptance` workflow repeats that run; the versions and limits are in [the device acceptance record](docs/reference/devices-acceptance.md#ios-simulator-idb-acceptance).

  `simctl shutdown` can outlast the companion's ten-second command limit (7 to 66 seconds, tracked in #1911), and `idb ui describe-all` fails on the home screen, so no iOS accessibility tree is added. Needs the updated host companion on the Mac. No defaults change.

  </details>

## 1.87.1

No changes in this release.

## 1.87.0

No changes in this release.

## 1.86.0

### Minor Changes

- feat(agents): show a Copilot CLI, Kimi CLI or Droid session's records in the Agent view, labelled as partial ([#1846](https://github.com/mihazs/lazysh/pull/1846))

  <details><summary>Details</summary>

  A GitHub Copilot CLI, Kimi CLI or Droid pane that reports a session now shows that session's records in the Agent view: read-only, under a partial label, with the hook state in the header and Show terminal. The companion's `discover` names `sessionId` for these three adapters (additive). Agents the view cannot read (Pi, OMP, Hermes, Cursor, Amp, Grok Build) now say that the view shows only their last reported state instead of pointing at a setting that cannot fix it. No defaults change. Refs #1658, #1125.

  </details>
- feat(agents): follow a Grok Build session in the Agent view ([#1845](https://github.com/mihazs/lazysh/pull/1845))

  <details><summary>Details</summary>

  With the updated host companion, print the opted-in hook fragment (`lazysh-agent grok-config --reported-history`), review it and save it as `~/.grok/hooks/lazysh.json`: a Grok Build hook then reports the session id, the pane it ran in and the path of its session log (`updates.jsonl`), and the Agent view of that tmux pane shows the conversation (turns, thinking, tool calls with their output and status, the plan card) and the state (working, done, failed, waiting for an approval), polling the log about every two seconds, with the guarded send. The Claude Code hooks reach Grok Build too (it runs `~/.claude/settings.json`), so a report that carries Grok's own input is now shown as **Grok Build**, not as a Claude Code session. Nothing is guessed from processes or from the newest file of a folder: a report without a log path binds nothing, a sub-agent's events are ignored, and two different paths for one session stay unusable. Questions and approvals stay in the terminal; the view says so and holds the draft, and it offers Grok Build no Stop key and no `@` or `/` suggestions because no key was checked on a real Grok Build. The same terminal notice now also appears when Gemini CLI or OpenCode waits for an approval or a plan decision, which the view cannot answer. A session past 10,000 log records or 16 MiB shows the reader's error and leaves the terminal. Verified with synthetic fixtures built from the pinned official source and the real executable on Linux; no Grok Build binary or account was available, so a run against a real agent is still open on #1842. No defaults change.

  </details>

## 1.85.1

No changes in this release.

## 1.85.0

No changes in this release.

## 1.84.0

### Minor Changes

- feat(agent): add `lazysh-agent review status` and `review diff` to the host companion ([#1803](https://github.com/mihazs/lazysh/pull/1803))

  <details><summary>Details</summary>

  Add `lazysh-agent review status` and `review diff` to the host companion: the Diff view's changed files and one file's patch from a terminal on the host, as plain text or one JSON line, read-only and under the app's size bounds, with its help in English, Brazilian Portuguese and Spanish. The app and the companion now build their Git review commands in one shared module; the app's behavior does not change.

  </details>
- feat(notifications): add opt-in switches that keep nested-agent and unlocked-desktop events off the relay ([#1820](https://github.com/mihazs/lazysh/pull/1820))

  <details><summary>Details</summary>

  `lazysh-agent settings notifications show|update` keeps events of an agent that another agent started, and events raised while the host's desktop is unlocked, out of the relay notification queue. Both switches default to off and live in their own `notification-policy.json`, so an older companion keeps reading `settings.json`. A nested agent's Claude permission request takes no approval while the first switch is on. Unlocked-desktop detection is Linux only; macOS and Windows always notify.

  </details>

## 1.83.1

No changes in this release.

## 1.83.0

### Minor Changes

- feat: Add `lazysh-agent herdr-pane-input --session NAME`, the host half of typing into one named pane of an… ([#1784](https://github.com/mihazs/lazysh/pull/1784))

  <details><summary>Details</summary>

  Add `lazysh-agent herdr-pane-input --session NAME`, the host half of typing into one named pane of an unchanged stock Herdr: JSON lines on stdin and stdout that pin the Herdr server process and refuse any other server at the same socket path.

  </details>

## 1.82.1

No changes in this release.

## 1.82.0

### Minor Changes

- feat(devices): touch an Android device on its video preview ([#1773](https://github.com/mihazs/lazysh/pull/1773))

  <details><summary>Details</summary>

  With **Enable device input** ticked, a tap or swipe on the video is mapped to the display's pixel size that **Verify Android video tools** reports and sent with that size to the host companion (`lazysh-agent devices android tap` and `swipe`). The companion reads the display size again and refuses the gesture with `DeviceDimensionsChanged` when it changed (a rotation or resize) or the point is outside it, so a gesture never lands on the wrong point; the refusal also stops the video. A 180-degree rotation that keeps the size is not detected. Needs the updated host companion; an older one keeps the video view-only. A real Waydroid Android 13 guest accepted and refused gestures as described; the published CI emulator has not run the new case yet. Changed default: the Android video preview is no longer always view-only.

  </details>

## 1.81.0

### Minor Changes

- feat(devices): inspect and act on an Android device's screen elements from the device controls ([#1774](https://github.com/mihazs/lazysh/pull/1774))

  <details><summary>Details</summary>

  Issue #19. **Inspect screen elements** lists what Android's accessibility service reports on the foreground screen (label, class, resource id, bounds and actionable flags, at most 300), and **Tap** and **Long press** act on one element: the host companion (`lazysh-agent devices android ui tree` and `ui act`) re-reads the screen, finds the one enabled element with that identity and touches the centre of its bounds, or fails without touching anything when none matches. The buttons need **Enable device input**. No scrolling, text entry or iOS accessibility yet. Needs the updated host companion. No defaults change.

  </details>

## 1.80.4

No changes in this release.

## 1.80.3

### Patch Changes

- @lazysh/account-usage@1.80.3
  - @lazysh/common@1.80.3
  - @lazysh/companion-release@1.80.3
  - @lazysh/notification-client@1.80.3

## 1.80.2

### Patch Changes

- @lazysh/account-usage@1.80.2
  - @lazysh/common@1.80.2
  - @lazysh/companion-release@1.80.2
  - @lazysh/notification-client@1.80.2

## 1.80.1

### Patch Changes

- @lazysh/account-usage@1.80.1
  - @lazysh/common@1.80.1
  - @lazysh/companion-release@1.80.1
  - @lazysh/notification-client@1.80.1

## 1.80.0

### Patch Changes

- @lazysh/account-usage@1.80.0
  - @lazysh/common@1.80.0
  - @lazysh/companion-release@1.80.0
  - @lazysh/notification-client@1.80.0

## 1.79.7

### Patch Changes

- @lazysh/account-usage@1.79.7
  - @lazysh/common@1.79.7
  - @lazysh/companion-release@1.79.7
  - @lazysh/notification-client@1.79.7

## 1.79.6

### Patch Changes

- @lazysh/account-usage@1.79.6
  - @lazysh/common@1.79.6
  - @lazysh/companion-release@1.79.6
  - @lazysh/notification-client@1.79.6

## 1.79.5

### Patch Changes

- @lazysh/account-usage@1.79.5
  - @lazysh/common@1.79.5
  - @lazysh/companion-release@1.79.5
  - @lazysh/notification-client@1.79.5

## 1.79.4

### Patch Changes

- @lazysh/account-usage@1.79.4
  - @lazysh/common@1.79.4
  - @lazysh/companion-release@1.79.4
  - @lazysh/notification-client@1.79.4

## 1.79.3

### Patch Changes

- @lazysh/account-usage@1.79.3
  - @lazysh/common@1.79.3
  - @lazysh/companion-release@1.79.3
  - @lazysh/notification-client@1.79.3

## 1.79.2

### Patch Changes

- @lazysh/account-usage@1.79.2
  - @lazysh/common@1.79.2
  - @lazysh/companion-release@1.79.2
  - @lazysh/notification-client@1.79.2

## 1.79.1

### Patch Changes

- @lazysh/account-usage@1.79.1
  - @lazysh/common@1.79.1
  - @lazysh/companion-release@1.79.1
  - @lazysh/notification-client@1.79.1

## 1.79.0

### Minor Changes

- 20cc3da: Record which tmux or rmux server a hook's pane belongs to. A pane id such as `%7` is unique only inside one server, so a report from `tmux -L work` and one from the default server could carry the same id; the companion now adds `paneServer` (`tmux:work`, `rmux:default`) read from the `TMUX` or `RMUX` socket path, the Agents panel's report details show it, and a socket given with `-S` records none. The field is optional in the snapshot, so an older companion or client works unchanged.

### Patch Changes

- 6bf377a: Stop the sixteen-writer storage burst cases from failing the Windows release build on a runner whose disk flushes are momentarily slow (#2114, same family as #36): each burst now waits for the temporary volume to commit fast enough for sixteen serialized durable writes, or fails explicitly after two minutes. Companion storage, `synchronous=FULL` durability and the three-second wait budget are unchanged, so nothing changes for users.
- @lazysh/account-usage@1.79.0
  - @lazysh/common@1.79.0
  - @lazysh/companion-release@1.79.0
  - @lazysh/notification-client@1.79.0

## 1.78.2

### Patch Changes

- @lazysh/account-usage@1.78.2
  - @lazysh/common@1.78.2
  - @lazysh/companion-release@1.78.2
  - @lazysh/notification-client@1.78.2

## 1.78.1

### Patch Changes

- @lazysh/account-usage@1.78.1
  - @lazysh/common@1.78.1
  - @lazysh/companion-release@1.78.1
  - @lazysh/notification-client@1.78.1

## 1.78.0

### Patch Changes

- @lazysh/account-usage@1.78.0
  - @lazysh/common@1.78.0
  - @lazysh/companion-release@1.78.0
  - @lazysh/notification-client@1.78.0

## 1.77.2

### Patch Changes

- @lazysh/account-usage@1.77.2
  - @lazysh/common@1.77.2
  - @lazysh/companion-release@1.77.2
  - @lazysh/notification-client@1.77.2

## 1.77.1

### Patch Changes

- @lazysh/account-usage@1.77.1
  - @lazysh/common@1.77.1
  - @lazysh/companion-release@1.77.1
  - @lazysh/notification-client@1.77.1

## 1.77.0

### Patch Changes

- @lazysh/account-usage@1.77.0
  - @lazysh/common@1.77.0
  - @lazysh/companion-release@1.77.0
  - @lazysh/notification-client@1.77.0

## 1.76.0

### Patch Changes

- @lazysh/account-usage@1.76.0
  - @lazysh/common@1.76.0
  - @lazysh/companion-release@1.76.0
  - @lazysh/notification-client@1.76.0

## 1.75.1

### Patch Changes

- @lazysh/account-usage@1.75.1
  - @lazysh/common@1.75.1
  - @lazysh/companion-release@1.75.1
  - @lazysh/notification-client@1.75.1

## 1.75.0

### Patch Changes

- @lazysh/account-usage@1.75.0
  - @lazysh/common@1.75.0
  - @lazysh/companion-release@1.75.0
  - @lazysh/notification-client@1.75.0

## 1.74.0

### Patch Changes

- @lazysh/account-usage@1.74.0
  - @lazysh/common@1.74.0
  - @lazysh/companion-release@1.74.0
  - @lazysh/notification-client@1.74.0

## 1.73.1

### Patch Changes

- @lazysh/account-usage@1.73.1
  - @lazysh/common@1.73.1
  - @lazysh/companion-release@1.73.1
  - @lazysh/notification-client@1.73.1

## 1.73.0

### Patch Changes

- @lazysh/account-usage@1.73.0
  - @lazysh/common@1.73.0
  - @lazysh/companion-release@1.73.0
  - @lazysh/notification-client@1.73.0

## 1.72.0

### Minor Changes

- 2320cc2: Bind a remote approval to the exact Zellij or Herdr pane its hook runs in: the request carries `zellij:<session>:<pane>` or `herdr:<session>:<pane id>` in its hash and decision, and any other pane, session or multiplexer is refused.

### Patch Changes

- @lazysh/account-usage@1.72.0
  - @lazysh/common@1.72.0
  - @lazysh/companion-release@1.72.0
  - @lazysh/notification-client@1.72.0

## 1.71.0

### Minor Changes

- cdb8721: Show an OpenCode compaction as an event line in the Agent view.

### Patch Changes

- @lazysh/account-usage@1.71.0
  - @lazysh/common@1.71.0
  - @lazysh/companion-release@1.71.0
  - @lazysh/notification-client@1.71.0

## 1.70.0

### Minor Changes

- d64fc31: Stream an OpenCode session into the Agent view instead of polling it. `lazysh-agent transcript-watch` now takes `--agent opencode --path DATABASE --database-session ID` and watches the database together with its write-ahead log, where OpenCode's newest rows sit until a checkpoint, so a reply that grows or a tool result that lands reaches the view within a second. The view opens the same live channel for an OpenCode pane as for Claude Code and Codex, and falls back to polling when the host companion is older.

### Patch Changes

- @lazysh/account-usage@1.70.0
  - @lazysh/common@1.70.0
  - @lazysh/companion-release@1.70.0
  - @lazysh/notification-client@1.70.0

## 1.69.0

### Patch Changes

- @lazysh/account-usage@1.69.0
  - @lazysh/common@1.69.0
  - @lazysh/companion-release@1.69.0
  - @lazysh/notification-client@1.69.0

## 1.68.3

### Patch Changes

- @lazysh/account-usage@1.68.3
  - @lazysh/common@1.68.3
  - @lazysh/companion-release@1.68.3
  - @lazysh/notification-client@1.68.3

## 1.68.2

### Patch Changes

- @lazysh/account-usage@1.68.2
  - @lazysh/common@1.68.2
  - @lazysh/companion-release@1.68.2
  - @lazysh/notification-client@1.68.2

## 1.68.1

### Patch Changes

- @lazysh/account-usage@1.68.1
  - @lazysh/common@1.68.1
  - @lazysh/companion-release@1.68.1
  - @lazysh/notification-client@1.68.1

## 1.68.0

### Minor Changes

- 8881a6b: Open and page through larger Codex conversations using a bounded full-history index.

### Patch Changes

- 8881a6b: Open a conversation whose workflow has no summary file instead of refusing the page.
- @lazysh/account-usage@1.68.0
  - @lazysh/common@1.68.0
  - @lazysh/companion-release@1.68.0
  - @lazysh/notification-client@1.68.0

## 1.67.1

### Patch Changes

- @lazysh/account-usage@1.67.1
  - @lazysh/common@1.67.1
  - @lazysh/companion-release@1.67.1
  - @lazysh/notification-client@1.67.1

## 1.67.0

### Minor Changes

- be619f7: Report the identity of a terminal lazysh starts: a hook that runs with `LAZYSH_TERMINAL` set to 32 lowercase hexadecimal characters records `lazysh:<id>` as its pane identity when neither `TMUX_PANE` nor Zellij's variables are set, so a later release can tie the Agent view of a terminal with no multiplexer to the agent that terminal started. A value of another shape is ignored and the hook still succeeds. Nothing exports the variable yet, so reports do not change.
- 0b93d52: Answer Copilot CLI's permission prompts remotely through Copilot's own `permissionRequest` hook decision. `lazysh-agent approval-request` and `approval-config` take `--agent copilot`; the request is the same immutable, hash-bound record as Claude Code's and Codex's, listed with `"agent":"copilot"`, and an allow or a deny with a message goes back at the top level of the hook's stdout, never as keys. Copilot runs this hook before its own rules, so every shell command and file edit that needs a permission check waits for you (including ones Copilot would run without asking), and an allow skips Copilot's deny rules. A request nobody answers gives no decision, so Copilot shows its own prompt in the terminal.

### Patch Changes

- ca8d976: Read long Grok Build sessions in the conversation view: the chunks of a streamed message are joined as they are read and count as one record, so a session of 50,000 chunk records opens instead of being refused at 10,000.
- 9bd5593: Record that Kimi Code 2.4.1 has no hook that can carry an Allow (hooks that print an allow on `PermissionRequest` and `PreToolUse` leave the prompt waiting; `PreToolUse` can only block), so a Kimi prompt stays in the terminal, with two new scenarios in the repeatable qualification run. No behavior change.
- fb610c5: Read long Gemini CLI sessions quickly and prove that a Gemini conversation pages with `--before`, `--after` and `--from-start` from its first message to its last.
- @lazysh/account-usage@1.67.0
  - @lazysh/common@1.67.0
  - @lazysh/companion-release@1.67.0
  - @lazysh/notification-client@1.67.0

## 1.66.1

### Patch Changes

- dd9725a: Build the Windows companion again: the host browser relay's stand-in for Windows (which has no pipe transport) returned a tuple while its caller expected the relay's pipe struct, so `lazysh-agent` did not compile for Windows and no release could be verified. One function signature now serves every platform, so the two cannot drift. Windows hosts still report the host browser as unsupported. The Android idle-frame tests no longer parse a frame that is still being written.
- @lazysh/account-usage@1.66.1
  - @lazysh/common@1.66.1
  - @lazysh/companion-release@1.66.1
  - @lazysh/notification-client@1.66.1

## 1.66.0

### Minor Changes

- 30d1569: Report a Kimi Code 2.4 root-agent approval request through `lazysh-agent ingest --agent kimi-code` and an opt-in `kimi-config --dialect kimi-code-2.4` fragment; the default Kimi printer is unchanged.

### Patch Changes

- 2814b5c: Read the `adb` feature list whether it is comma-separated or one feature per line, and start an Android screenshot at its PNG signature when the guest printed a warning line before it, and convert the decoded video to full range before the JPEG encoder, so `lazysh-agent devices` works on a device that `adb` 1.0.41 and the Waydroid guest describe that way and whose encoder tags limited-range video. A list without `shell_v2` and bytes with no PNG signature in the first KiB are still refused.
- 3ade46f: Teach the host browser relay (`lazysh-agent host-browser serve`) the Control switch and the input messages: `control {on}` turns Control on or off for the session (off at every start), and while it is on `pointer`, `wheel`, `pinch`, `key` and `text` become the browser's mouse, wheel, page-scale, key and insert-text calls, in the order sent, through the allow-list. While Control is off each input message is refused and counted, never forwarded. A value outside its bounds, a clipboard shortcut, an unknown field and a flood of more than 240 messages a second are refused with a counted reason. The command is still hidden and nothing in the app sends these messages yet.
- @lazysh/account-usage@1.66.0
  - @lazysh/common@1.66.0
  - @lazysh/companion-release@1.66.0
  - @lazysh/notification-client@1.66.0

## 1.65.0

### Minor Changes

- 734a13f: Add the host browser relay, `lazysh-agent host-browser serve`: on one SSH exec channel it starts a private, headless Chrome or Chromium with `--remote-debugging-pipe` (no port on the host), streams the page as length-prefixed JPEG frames with the page's title and address, paces them by the device's acknowledgements and pauses at the browser when the view is hidden. Every protocol command passes the allow-list, a client message outside the closed set is refused and counted, and the browser, its helpers and its profile end with the channel. It fails before it starts anything while the host browser switch (off by default) is off. The command is hidden and nothing in the app uses it yet: the viewer ships in a later slice of the same feature.

### Patch Changes

- 4a6290d: Show an idle Android screen in the video preview. The video stream sends a screenshot first, which counts as the first frame, and another whenever no video frame has come for a second (at most one a second), so an idle device no longer stops at the ten-second startup limit and the last frame of a change is replaced. Needs the updated host companion. No defaults change.
- @lazysh/account-usage@1.65.0
  - @lazysh/common@1.65.0
  - @lazysh/companion-release@1.65.0
  - @lazysh/notification-client@1.65.0

## 1.64.2

### Patch Changes

- 1cfbae9: Give the Windows companion an 8 MiB main-thread stack so `lazysh-agent update`, `update --dry-run` and `update --rollback` no longer crash with a stack overflow (exit 0xC00000FD) while they download, verify and replace the running companion.
- @lazysh/account-usage@1.64.2
  - @lazysh/common@1.64.2
  - @lazysh/companion-release@1.64.2
  - @lazysh/notification-client@1.64.2

## 1.64.1

### Patch Changes

- @lazysh/account-usage@1.64.1
  - @lazysh/common@1.64.1
  - @lazysh/companion-release@1.64.1
  - @lazysh/notification-client@1.64.1

## 1.64.0

### Minor Changes

- 4d0df4d: Add the host browser switch, off by default, in its own `host-browser.json` (`lazysh-agent settings host-browser show|update`), so that `settings.json` keeps the five fields a released client reads. The hidden browser launcher fails before it starts a process while the switch is off, keeps its profile in a private directory with a pid marker, removes it when it stops or at the next start after a crash, and offers `--keep-profile` and `host-browser --clear-data`.
- 6afbdeb: Focus a Herdr pane from the host companion on a Windows host: `lazysh-agent herdr-focus-pane` sends its single `pane.focus` request over the named pipe Herdr listens on instead of reporting the platform as unsupported, after validating the reported path.

### Patch Changes

- 4e3f098: Record the design for opt-in background usage collection and a host switch for account quota reads (ADR 0005, #1588). Documentation only: no behavior change.
- @lazysh/account-usage@1.64.0
  - @lazysh/common@1.64.0
  - @lazysh/companion-release@1.64.0
  - @lazysh/notification-client@1.64.0

## 1.63.0

### Minor Changes

- a12aac2: Read Gemini CLI conversations in the Agent view.
- ea81e09: Show a Grok Build plan as the shared plan card in its conversation view: with the updated host companion, a Grok ACP `plan` update is one plan card with its steps and their state instead of a block of labeled text.
- 9095894: Make `lazysh-agent update`, `update --dry-run` and `update --rollback` work on Windows: the running `lazysh-agent.exe` is renamed aside and the verified file placed under its name, with the previous copy kept for rollback.
- 936a012: Add `lazysh-agent update`, `update --dry-run` and `update --rollback` for Linux and macOS hosts: the host downloads the release itself, verifies its size and SHA-256 against the release metadata, self-tests the new binary, replaces the managed companion atomically and keeps the previous one for rollback.
- 6aa52f7: Add `lazysh-agent listeners [--port N]... [--json] [--watch]`, which lists the TCP listeners on loopback or a wildcard address with their owner process id, name, user and start time (Linux `/proc`, macOS and other Unix `lsof`, Windows `Get-NetTCPConnection`) and prints `listen` and `close` events with `--watch`. The app uses it to confirm that the `http://localhost:PORT` a sign-in command printed is served by the host's own process. It reads no arguments or environment and tunnels nothing.
- 9023f4d: Answer Codex's permission prompts remotely through Codex's own `PermissionRequest` hook decision. `lazysh-agent approval-request` and `approval-config` take `--agent codex`; the request is the same immutable, hash-bound record as Claude Code's, listed with `"agent":"codex"`, and an allow or a deny with a message goes back on the hook's stdout, never as keys. A request nobody answers gives no decision, so Codex shows its own prompt in the terminal.
- 5864e88: Add the opt-in host browser shim: `lazysh-agent browser-shim install|status|uninstall` and the `browser-open` and `browser-watch --protocol 1` commands, so a link a host program opens (`xdg-open`, `open`, `$BROWSER`, Python `webbrowser`) can be handed to the lazysh app over a companion channel and otherwise goes to the real opener unchanged. Off until installed; with the shim installed, tools that fall back to a device code when the host has no browser launcher start their browser flow instead.

### Patch Changes

- 3087124: Add the closed list of browser protocol methods and page addresses that the host browser relay may send (`host_browser::allow`): cookies and storage, script and DOM access, downloads and file choosers, permissions and the clipboard, and every address but `http`, `https` and `about:blank` are refused, as is any method that is not named. The hidden developer launcher applies the same address rule to its first page. Nothing changes for users: the relay that uses the list ships with the Chrome viewer.
- 7f4fe74: List in the agent-hook guide what each provider CLI was observed to do natively, including interactive Claude Code 2.1.322 and Codex 0.167.0 tool and permission runs, what no run has established and what needs an account. Documentation only: no behavior change.
- 194935f: Record Kimi Code 2.4.1 native hook loading, real turn, approval, interrupt, failure and sub-agent payloads from a repeatable network-less run against a synthetic endpoint, and document which events can and cannot identify the root agent. No behavior change.
- Updated dependencies [272304e]
  - @lazysh/common@1.63.0
  - @lazysh/companion-release@1.63.0
  - @lazysh/notification-client@1.63.0
  - @lazysh/account-usage@1.63.0

## 1.62.0

### Minor Changes

- a3ea715: Add `lazysh-agent update --check` and `--status`: the host companion asks GitHub's release metadata over HTTPS, verified against the release's own digests, whether a newer companion exists, with a JSON result and documented exit codes.

### Patch Changes

- @lazysh/account-usage@1.62.0
  - @lazysh/common@1.62.0
  - @lazysh/companion-release@1.62.0
  - @lazysh/notification-client@1.62.0

## 1.61.0

### Patch Changes

- @lazysh/account-usage@1.61.0
  - @lazysh/common@1.61.0
  - @lazysh/notification-client@1.61.0

## 1.60.0

### Patch Changes

- @lazysh/account-usage@1.60.0
  - @lazysh/common@1.60.0
  - @lazysh/notification-client@1.60.0

## 1.59.0

### Minor Changes

- 6d4fb75: Add a read-only **Session info** sheet to the Agent view options for Claude Code: the MCP servers and whether they connected, the skills, agent types and instruction files the session loaded, from a new `session.info` object of the conversation page.

### Patch Changes

- @lazysh/account-usage@1.59.0
  - @lazysh/common@1.59.0
  - @lazysh/notification-client@1.59.0

## 1.58.0

### Patch Changes

- @lazysh/account-usage@1.58.0
  - @lazysh/common@1.58.0
  - @lazysh/notification-client@1.58.0

## 1.57.0

### Minor Changes

- 5dfb34f: List OpenCode sub-agents in the Agent view's background-work panel, and read the OpenCode 2.2 conversation database that keeps parts inline.
- 5dfb34f: Report Codex sub-agents as background work so the Agent view lists them.

### Patch Changes

- @lazysh/account-usage@1.57.0
  - @lazysh/common@1.57.0
  - @lazysh/notification-client@1.57.0

## 1.56.1

### Patch Changes

- @lazysh/account-usage@1.56.1
  - @lazysh/common@1.56.1
  - @lazysh/notification-client@1.56.1

## 1.56.0

### Minor Changes

- 00c3e7d: Show Claude Code goal, plan-mode, recap and hook-failure records and Codex goal and compaction records as compact event lines in the Agent view.
- 87bb9c3: Offer the permission updates Claude Code suggests (allow and remember a rule, switch mode, add folders) in the approval card and the Agent view, each behind a confirmation that shows the exact rule and where it is kept, and let a denial carry a message the agent reads.

### Patch Changes

- @lazysh/account-usage@1.56.0
  - @lazysh/common@1.56.0
  - @lazysh/notification-client@1.56.0

## 1.55.0

### Patch Changes

- @lazysh/account-usage@1.55.0
  - @lazysh/common@1.55.0
  - @lazysh/notification-client@1.55.0

## 1.54.1

### Patch Changes

- @lazysh/account-usage@1.54.1
  - @lazysh/common@1.54.1
  - @lazysh/notification-client@1.54.1

## 1.54.0

### Minor Changes

- e74bd92: List the earlier Claude Code and Codex sessions of a folder in the Agent view and open one read-only, with a **Resume in the terminal** action that stages the agent's own resume command for review, through a new `lazysh-agent history` companion command and `agent_history` app command.
- 95224be: Open a Claude Code sub-agent's own conversation from the Agent view, read from its files under the session directory.
- 95224be: Show Claude Code dynamic workflows in the Agent view as a live progress tree: the companion reads each run's summary and journal files, the view draws its phases with each agent's state, tokens and tool calls, and opens any agent's own conversation.

### Patch Changes

- @lazysh/account-usage@1.54.0
  - @lazysh/common@1.54.0
  - @lazysh/notification-client@1.54.0

## 1.53.0

### Patch Changes

- @lazysh/account-usage@1.53.0
  - @lazysh/common@1.53.0
  - @lazysh/notification-client@1.53.0

## 1.52.0

### Minor Changes

- fc4e7e8: Report the files a Codex session changed as `apply_patch` calls with their outcome in the conversation view.

### Patch Changes

- @lazysh/account-usage@1.52.0
  - @lazysh/common@1.52.0
  - @lazysh/notification-client@1.52.0

## 1.51.0

### Minor Changes

- 587b2c7: Send from the Agent view to an agent that runs in a Zellij pane. The updated companion reports the Zellij session and pane of an agent's hooks, the Agent view of a terminal attached to that session follows (or lists) the agents that name one of its panes, and Send and Stop write to that exact pane through Zellij's own commands, only while it still runs the agent. Needs Zellij 0.45.1 or newer.

### Patch Changes

- @lazysh/account-usage@1.51.0
  - @lazysh/common@1.51.0
  - @lazysh/notification-client@1.51.0

## 1.50.0

### Minor Changes

- 9d7fb30: Show a failed Claude Code API call (usage limit, unreachable API, refused request) as an error card that says what to do next, from the recorded `isApiErrorMessage` assistant record.

### Patch Changes

- @lazysh/account-usage@1.50.0
  - @lazysh/common@1.50.0
  - @lazysh/notification-client@1.50.0

## 1.49.0

### Minor Changes

- 4f882e7: Show the agent's model, permission mode, context left, git branch and worktree in the Agent view header, from a new additive `session` object of the Claude Code and Codex conversation pages and watch frames.

### Patch Changes

- @lazysh/account-usage@1.49.0
  - @lazysh/common@1.49.0
  - @lazysh/notification-client@1.49.0

## 1.48.0

### Minor Changes

- 16c4800: Read the Agent view's background work (sub-agents, background commands, monitors, workflows) from the host companion so the panel covers the whole conversation, shows a shell or monitor's output and flags launches with no recorded end as not confirmed.

### Patch Changes

- @lazysh/account-usage@1.48.0
  - @lazysh/common@1.48.0
  - @lazysh/notification-client@1.48.0

## 1.47.0

### Patch Changes

- @lazysh/account-usage@1.47.0
  - @lazysh/common@1.47.0
  - @lazysh/notification-client@1.47.0

## 1.46.0

### Minor Changes

- 6ebb3d8: Show the PNG and JPEG images a user attached as a bounded preview control in the Agent view bubble, for Claude Code and (new in the companion) Codex conversations.

### Patch Changes

- @lazysh/account-usage@1.46.0
  - @lazysh/common@1.46.0
  - @lazysh/notification-client@1.46.0

## 1.45.0

### Patch Changes

- @lazysh/account-usage@1.45.0
  - @lazysh/common@1.45.0
  - @lazysh/notification-client@1.45.0

## 1.44.0

### Patch Changes

- @lazysh/account-usage@1.44.0
  - @lazysh/common@1.44.0
  - @lazysh/notification-client@1.44.0

## 1.43.0

### Patch Changes

- @lazysh/account-usage@1.43.0
  - @lazysh/common@1.43.0
  - @lazysh/notification-client@1.43.0

## 1.42.0

### Minor Changes

- d356489: Let `lazysh-agent transcript --view conversation` and `lazysh-agent herdr-conversation` read a session from its first message: `--before ID`, `--after ID` and `--from-start` cut the recorded branch at a message, pages report `hasNewer`, Claude Code conversations now continue across compactions, and sessions of more than 10,000 records are readable for Claude Code, Codex and OpenCode. Changed: a Claude Code conversation page now includes the messages before a compaction, above its summary.

### Patch Changes

- @lazysh/account-usage@1.42.0
  - @lazysh/common@1.42.0
  - @lazysh/notification-client@1.42.0

## 1.41.0

### Patch Changes

- @lazysh/account-usage@1.41.0
  - @lazysh/common@1.41.0
  - @lazysh/notification-client@1.41.0

## 1.40.0

### Minor Changes

- 65eaa38: Show the prompts typed while Claude Code works as read-only Queued cards in the Agent view, from a new bounded `queued` list in the companion's Claude conversation page and transcript-watch frames.

### Patch Changes

- @lazysh/account-usage@1.40.0
  - @lazysh/common@1.40.0
  - @lazysh/notification-client@1.40.0

## 1.39.0

### Patch Changes

- @lazysh/account-usage@1.39.0
  - @lazysh/common@1.39.0
  - @lazysh/notification-client@1.39.0

## 1.38.0

### Patch Changes

- @lazysh/account-usage@1.38.0
  - @lazysh/common@1.38.0
  - @lazysh/notification-client@1.38.0

## 1.37.0

### Minor Changes

- 20f02cc: Name what an agent waits for (approval, question, plan decision or unknown) and since when: the companion records it from hook payloads, and the Agent view shows it in its header and session list, lists waiting sessions first and opens from a needs-you notification.

### Patch Changes

- @lazysh/account-usage@1.37.0
  - @lazysh/common@1.37.0
  - @lazysh/notification-client@1.37.0

## 1.36.0

### Patch Changes

- 848a370: Add a developer-only prototype of the host browser: a hidden companion command that starts a throwaway Chrome-family browser on the host and a viewer page that only the Vite development server serves, with a real-browser CI test and a protocol-client unit test. It is off by default, absent from release builds and changes no default.
- @lazysh/account-usage@1.36.0
  - @lazysh/common@1.36.0
  - @lazysh/notification-client@1.36.0

## 1.35.0

### Patch Changes

- @lazysh/account-usage@1.35.0
  - @lazysh/common@1.35.0
  - @lazysh/notification-client@1.35.0

## 1.34.0

### Minor Changes

- 95968a2: Add the `lazysh-agent transcript-watch` companion command: one long-lived stream of upserts for a Claude Code or Codex conversation, checked every 250 ms on the host, for the Agent view's live updates.

### Patch Changes

- @lazysh/account-usage@1.34.0
  - @lazysh/common@1.34.0
  - @lazysh/notification-client@1.34.0

## 1.33.4

### Patch Changes

- @lazysh/account-usage@1.33.4
  - @lazysh/common@1.33.4
  - @lazysh/notification-client@1.33.4

## 1.33.3

### Patch Changes

- @lazysh/account-usage@1.33.3
  - @lazysh/common@1.33.3
  - @lazysh/notification-client@1.33.3

## 1.33.2

### Patch Changes

- @lazysh/account-usage@1.33.2
  - @lazysh/common@1.33.2
  - @lazysh/notification-client@1.33.2

## 1.33.1

### Patch Changes

- @lazysh/account-usage@1.33.1
  - @lazysh/common@1.33.1
  - @lazysh/notification-client@1.33.1

## 1.33.0

### Patch Changes

- @lazysh/account-usage@1.33.0
  - @lazysh/common@1.33.0
  - @lazysh/notification-client@1.33.0

## 1.32.0

### Patch Changes

- @lazysh/account-usage@1.32.0
  - @lazysh/common@1.32.0
  - @lazysh/notification-client@1.32.0

## 1.31.2

### Patch Changes

- @lazysh/account-usage@1.31.2
  - @lazysh/common@1.31.2
  - @lazysh/notification-client@1.31.2

## 1.31.1

### Patch Changes

- @lazysh/account-usage@1.31.1
  - @lazysh/common@1.31.1
  - @lazysh/notification-client@1.31.1

## 1.31.0

### Patch Changes

- @lazysh/account-usage@1.31.0
  - @lazysh/common@1.31.0
  - @lazysh/notification-client@1.31.0

## 1.30.5

### Patch Changes

- @lazysh/account-usage@1.30.5
  - @lazysh/common@1.30.5
  - @lazysh/notification-client@1.30.5

## 1.30.4

### Patch Changes

- @lazysh/account-usage@1.30.4
  - @lazysh/common@1.30.4
  - @lazysh/notification-client@1.30.4

## 1.30.3

### Patch Changes

- @lazysh/account-usage@1.30.3
  - @lazysh/common@1.30.3
  - @lazysh/notification-client@1.30.3

## 1.30.2

### Patch Changes

- @lazysh/account-usage@1.30.2
  - @lazysh/common@1.30.2
  - @lazysh/notification-client@1.30.2

## 1.30.1

### Patch Changes

- @lazysh/account-usage@1.30.1
  - @lazysh/common@1.30.1
  - @lazysh/notification-client@1.30.1

## 1.30.0

### Patch Changes

- @lazysh/account-usage@1.30.0
  - @lazysh/common@1.30.0
  - @lazysh/notification-client@1.30.0

## 1.29.3

### Patch Changes

- @lazysh/account-usage@1.29.3
  - @lazysh/common@1.29.3
  - @lazysh/notification-client@1.29.3

## 1.29.2

### Patch Changes

- @lazysh/account-usage@1.29.2
  - @lazysh/common@1.29.2
  - @lazysh/notification-client@1.29.2

## 1.29.1

### Patch Changes

- @lazysh/account-usage@1.29.1
  - @lazysh/common@1.29.1
  - @lazysh/notification-client@1.29.1

## 1.29.0

### Patch Changes

- @lazysh/account-usage@1.29.0
  - @lazysh/common@1.29.0
  - @lazysh/notification-client@1.29.0

## 1.28.2

### Patch Changes

- @lazysh/account-usage@1.28.2
  - @lazysh/common@1.28.2
  - @lazysh/notification-client@1.28.2

## 1.28.1

### Patch Changes

- @lazysh/account-usage@1.28.1
  - @lazysh/common@1.28.1
  - @lazysh/notification-client@1.28.1

## 1.28.0

### Minor Changes

- 94b17c9: Switch a session between its terminal and a live Agent view, with Both side by side on wide desktop layouts; Codex hooks can report their conversation for automatic binding.

### Patch Changes

- @lazysh/account-usage@1.28.0
  - @lazysh/common@1.28.0
  - @lazysh/notification-client@1.28.0

## 1.27.1

### Patch Changes

- ac467c1: Support Herdr 0.9.3 through 0.9.5, and explain a Herdr workspace, tab or pane that was closed on the host instead of showing Herdr's raw error.
- @lazysh/account-usage@1.27.1
  - @lazysh/common@1.27.1
  - @lazysh/notification-client@1.27.1

## 1.27.0

### Patch Changes

- @lazysh/account-usage@1.27.0
  - @lazysh/common@1.27.0
  - @lazysh/notification-client@1.27.0

## 1.26.1

### Patch Changes

- @lazysh/account-usage@1.26.1
  - @lazysh/common@1.26.1
  - @lazysh/notification-client@1.26.1

## 1.26.0

### Patch Changes

- @lazysh/account-usage@1.26.0
  - @lazysh/common@1.26.0
  - @lazysh/notification-client@1.26.0

## 1.25.1

### Patch Changes

- @lazysh/account-usage@1.25.1
  - @lazysh/common@1.25.1
  - @lazysh/notification-client@1.25.1

## 1.25.0

### Patch Changes

- Updated dependencies [a89a721]
  - @lazysh/notification-client@1.25.0
  - @lazysh/account-usage@1.25.0
  - @lazysh/common@1.25.0

## 1.24.0

### Patch Changes

- @lazysh/account-usage@1.24.0
  - @lazysh/common@1.24.0
  - @lazysh/notification-client@1.24.0

## 1.23.0

### Patch Changes

- @lazysh/account-usage@1.23.0
  - @lazysh/common@1.23.0
  - @lazysh/notification-client@1.23.0

## 1.22.0

### Patch Changes

- @lazysh/account-usage@1.22.0
  - @lazysh/common@1.22.0
  - @lazysh/notification-client@1.22.0

## 1.21.0

### Patch Changes

- @lazysh/account-usage@1.21.0
  - @lazysh/common@1.21.0
  - @lazysh/notification-client@1.21.0

## 1.20.0

### Patch Changes

- 4299001: Fix intermittent Windows release failures in the companion storage contention cases (SQLite code 5 at `ingest_begin`). Each sixteen-writer burst now runs alone instead of beside other companion runs in the same test process, and a Linux check replays the CLI suite beside a simulated slow shared volume. Companion storage, FULL durability and the 3-second wait budget are unchanged.
- @lazysh/account-usage@1.20.0
  - @lazysh/common@1.20.0
  - @lazysh/notification-client@1.20.0

## 1.19.0

### Patch Changes

- @lazysh/account-usage@1.19.0
  - @lazysh/common@1.19.0
  - @lazysh/notification-client@1.19.0

## 1.18.2

### Patch Changes

- @lazysh/account-usage@1.18.2
  - @lazysh/common@1.18.2
  - @lazysh/notification-client@1.18.2

## 1.18.1

### Patch Changes

- @lazysh/account-usage@1.18.1
  - @lazysh/common@1.18.1
  - @lazysh/notification-client@1.18.1

## 1.18.0

### Patch Changes

- @lazysh/account-usage@1.18.0
  - @lazysh/common@1.18.0
  - @lazysh/notification-client@1.18.0

## 1.17.1

### Patch Changes

- @lazysh/account-usage@1.17.1
  - @lazysh/common@1.17.1
  - @lazysh/notification-client@1.17.1

## 1.17.0

### Patch Changes

- @lazysh/account-usage@1.17.0
  - @lazysh/common@1.17.0
  - @lazysh/notification-client@1.17.0

## 1.16.0

### Patch Changes

- @lazysh/account-usage@1.16.0
  - @lazysh/common@1.16.0
  - @lazysh/notification-client@1.16.0

## 1.15.0

### Patch Changes

- @lazysh/account-usage@1.15.0
  - @lazysh/common@1.15.0
  - @lazysh/notification-client@1.15.0

## 1.14.0

### Patch Changes

- 5cead04: Fix companion hook events failing on Windows with SQLite code 5 when many hooks open the store at once. Opening an initialized store now holds the bootstrap lock shared, so warm opens no longer queue behind each other or behind durable commits; only creating or upgrading the store takes it exclusively. WAL mode, FULL durability, sidecar checks and the 3-second wait budget are unchanged.
- @lazysh/account-usage@1.14.0
  - @lazysh/common@1.14.0
  - @lazysh/notification-client@1.14.0

## 1.13.0

### Patch Changes

- @lazysh/account-usage@1.13.0
  - @lazysh/common@1.13.0
  - @lazysh/notification-client@1.13.0

## 1.12.0

### Minor Changes

- 86e89e4: Show plan, question and turn-state cards in native Chat. The companion projects recorded Claude Code `TodoWrite`, `AskUserQuestion` and `ExitPlanMode` calls, Codex `update_plan`, `request_user_input` and plan-mode items, and OpenCode `todowrite` and `question` parts into display-only cards. Conversation views for Claude Code, Codex and OpenCode V1 report a working, waiting, idle or stopped turn derived from recorded lifecycle records; anything else stays unknown. Question cards list the options and send the user to the terminal to answer, because Chat cannot choose options in an agent prompt. Existing tool cards, cursors and prompt targets are unchanged.

### Patch Changes

- Updated dependencies [5406843]
- Updated dependencies [816f09b]
  - @lazysh/account-usage@1.12.0
  - @lazysh/common@1.12.0
  - @lazysh/notification-client@1.12.0

## 1.11.0

### Minor Changes

- aa1e2f3: Add explicitly selected OpenCode recorded conversations with current projection refresh and unchanged confirmed terminal input boundaries.

### Patch Changes

- @lazysh/account-usage@1.11.0
  - @lazysh/common@1.11.0
  - @lazysh/notification-client@1.11.0

## 1.10.4

### Patch Changes

- @lazysh/account-usage@1.10.4
  - @lazysh/common@1.10.4
  - @lazysh/notification-client@1.10.4

## 1.10.3

### Patch Changes

- @lazysh/account-usage@1.10.3
  - @lazysh/common@1.10.3
  - @lazysh/notification-client@1.10.3

## 1.10.2

### Patch Changes

- @lazysh/account-usage@1.10.2
  - @lazysh/common@1.10.2
  - @lazysh/notification-client@1.10.2

## 1.10.1

### Patch Changes

- @lazysh/account-usage@1.10.1
  - @lazysh/common@1.10.1
  - @lazysh/notification-client@1.10.1

## 1.10.0

### Minor Changes

- f1d7feb: Add a recorded Codex Conversation reader with mode-aware turn replay, bounded protected fork/revert prefixes, explicit refresh and opt-in Follow. Records remains the default; recorded history does not establish a live agent or authorize requests.

### Patch Changes

- @lazysh/account-usage@1.10.0
  - @lazysh/common@1.10.0
  - @lazysh/notification-client@1.10.0

## 1.9.11

### Patch Changes

- @lazysh/account-usage@1.9.11
  - @lazysh/common@1.9.11
  - @lazysh/notification-client@1.9.11

## 1.9.10

### Patch Changes

- @lazysh/account-usage@1.9.10
  - @lazysh/common@1.9.10
  - @lazysh/notification-client@1.9.10

## 1.9.9

### Patch Changes

- @lazysh/account-usage@1.9.9
  - @lazysh/common@1.9.9
  - @lazysh/notification-client@1.9.9

## 1.9.8

### Patch Changes

- @lazysh/account-usage@1.9.8
  - @lazysh/common@1.9.8
  - @lazysh/notification-client@1.9.8

## 1.9.7

### Patch Changes

- @lazysh/account-usage@1.9.7
  - @lazysh/common@1.9.7
  - @lazysh/notification-client@1.9.7

## 1.9.6

### Patch Changes

- @lazysh/account-usage@1.9.6
  - @lazysh/common@1.9.6
  - @lazysh/notification-client@1.9.6

## 1.9.5

### Patch Changes

- @lazysh/account-usage@1.9.5
  - @lazysh/common@1.9.5
  - @lazysh/notification-client@1.9.5

## 1.9.4

### Patch Changes

- 0eb395e: Retain closed failure-only stages from the owned WAL crash-recovery fixture while preserving the original panic, child cleanup and storage acceptance limits.
- @lazysh/account-usage@1.9.4
  - @lazysh/common@1.9.4
  - @lazysh/notification-client@1.9.4

## 1.9.3

### Patch Changes

- @lazysh/account-usage@1.9.3
  - @lazysh/common@1.9.3
  - @lazysh/notification-client@1.9.3

## 1.9.2

### Patch Changes

- @lazysh/account-usage@1.9.2
  - @lazysh/common@1.9.2
  - @lazysh/notification-client@1.9.2

## 1.9.1

### Patch Changes

- @lazysh/account-usage@1.9.1
  - @lazysh/common@1.9.1
  - @lazysh/notification-client@1.9.1

## 1.9.0

### Patch Changes

- @lazysh/account-usage@1.9.0
  - @lazysh/common@1.9.0
  - @lazysh/notification-client@1.9.0

## 1.8.4

### Patch Changes

- @lazysh/account-usage@1.8.4
  - @lazysh/common@1.8.4
  - @lazysh/notification-client@1.8.4

## 1.8.3

### Patch Changes

- @lazysh/account-usage@1.8.3
  - @lazysh/common@1.8.3
  - @lazysh/notification-client@1.8.3

## 1.8.2

### Patch Changes

- 9ce9d81: Correlate opt-in concurrent-hook fixture SQL failure phases with their exact owned child workers without changing storage behavior or acceptance gates.
- @lazysh/account-usage@1.8.2
  - @lazysh/common@1.8.2
  - @lazysh/notification-client@1.8.2

## 1.8.1

### Patch Changes

- @lazysh/account-usage@1.8.1
  - @lazysh/common@1.8.1
  - @lazysh/notification-client@1.8.1

## 1.8.0

### Patch Changes

- @lazysh/account-usage@1.8.0
  - @lazysh/common@1.8.0
  - @lazysh/notification-client@1.8.0

## 1.7.8

### Patch Changes

- @lazysh/account-usage@1.7.8
  - @lazysh/common@1.7.8
  - @lazysh/notification-client@1.7.8

## 1.7.7

### Patch Changes

- @lazysh/account-usage@1.7.7
  - @lazysh/common@1.7.7
  - @lazysh/notification-client@1.7.7

## 1.7.6

### Patch Changes

- @lazysh/account-usage@1.7.6
  - @lazysh/common@1.7.6
  - @lazysh/notification-client@1.7.6

## 1.7.5

### Patch Changes

- @lazysh/account-usage@1.7.5
  - @lazysh/common@1.7.5
  - @lazysh/notification-client@1.7.5

## 1.7.4

### Patch Changes

- @lazysh/account-usage@1.7.4
  - @lazysh/common@1.7.4
  - @lazysh/notification-client@1.7.4

## 1.7.3

### Patch Changes

- @lazysh/account-usage@1.7.3
  - @lazysh/common@1.7.3
  - @lazysh/notification-client@1.7.3

## 1.7.2

### Patch Changes

- @lazysh/account-usage@1.7.2
  - @lazysh/common@1.7.2
  - @lazysh/notification-client@1.7.2

## 1.7.1

### Patch Changes

- @lazysh/account-usage@1.7.1
  - @lazysh/common@1.7.1
  - @lazysh/notification-client@1.7.1

## 1.7.0

### Minor Changes

- bcc7feb: Add opt-in V3 managed Amp system-plugin setup with protected ownership, shadow-aware removal and bounded V2 metadata compatibility.

### Patch Changes

- @lazysh/account-usage@1.7.0
  - @lazysh/common@1.7.0
  - @lazysh/notification-client@1.7.0

## 1.6.0

### Minor Changes

- aad0990: Add opt-in version-2 hook discovery and inspected, profile-scoped Copilot hook setup while preserving version-1 compatibility, foreign settings and provider trust.

### Patch Changes

- 99d1b8e: Avoid reporting a completed Amp turn from an initially idle thread. The updated manual plugin reports idle only after observing that thread running, and does not treat an error followed by idle as recovery. Replace previously copied Amp plugin files to receive this fix; existing historical reports are unchanged.
- @lazysh/account-usage@1.6.0
  - @lazysh/common@1.6.0
  - @lazysh/notification-client@1.6.0

## 1.5.5

### Patch Changes

- @lazysh/account-usage@1.5.5
  - @lazysh/common@1.5.5
  - @lazysh/notification-client@1.5.5

## 1.5.4

### Patch Changes

- 9bb174c: Finish Copilot child reports with a separate validated session identity while preserving parent state and shared-session completion guards.
- @lazysh/account-usage@1.5.4
  - @lazysh/common@1.5.4
  - @lazysh/notification-client@1.5.4

## 1.5.3

### Patch Changes

- b98d878: Document Linux Copilot CLI 1.0.105 manual-hook qualification for completed root turns and unanswered elicitation attention, including remaining runtime limits.
- @lazysh/account-usage@1.5.3
  - @lazysh/common@1.5.3
  - @lazysh/notification-client@1.5.3

## 1.5.2

### Patch Changes

- dbd55aa: Discover current and legacy Kimi profile metadata while retaining manual-only setup and the legacy 1.52 hook printer contract.
- @lazysh/account-usage@1.5.2
  - @lazysh/common@1.5.2
  - @lazysh/notification-client@1.5.2

## 1.5.1

### Patch Changes

- c630f74: Correct the packaged reporting skill to describe installed-agent discovery and managed Cline setup while preserving explicit selection, inspected plans and plugin policy.
- @lazysh/account-usage@1.5.1
  - @lazysh/common@1.5.1
  - @lazysh/notification-client@1.5.1

## 1.5.0

### Minor Changes

- 8db8a98: Detect installed host agents and known profile locations before explicit hook setup. Let users select a target while preserving inspected installation plans, manual profile selection and provider trust decisions. Discovery never installs hooks or creates missing profiles.
- afc27ec: Add explicit managed Cline root lifecycle plugin setup and profile discovery. Preserve existing plugin restrictions and require inspected install/remove plans; configuration does not establish live reporting.

### Patch Changes

- @lazysh/account-usage@1.5.0
  - @lazysh/common@1.5.0
  - @lazysh/notification-client@1.5.0

## 1.4.2

### Patch Changes

- @lazysh/account-usage@1.4.2
  - @lazysh/common@1.4.2
  - @lazysh/notification-client@1.4.2

## 1.4.1

### Patch Changes

- @lazysh/account-usage@1.4.1
  - @lazysh/common@1.4.1
  - @lazysh/notification-client@1.4.1

## 1.4.0

### Minor Changes

- 3674b0e: Add native Gemini CLI, Droid, Kimi CLI and GitHub Copilot CLI lifecycle reporting with print-only agent-specific configuration fragments.

  Kimi ignores unscoped Stop/StopFailure events to preserve parent state; its hook contract cannot identify per-turn completion.
- 564f7f9: Add a print-only Cline root lifecycle plugin with exact native run identities, bounded companion writes and disposal cleanup. Child runs, permission waits and managed installation remain unsupported; profiles and approval policy are unchanged.
- 54796e0: Browse Herdr spaces and live agent panes from workspace navigation. Reuse or explicitly attach the exact server display, then use stock shared workspace/tab focus or the companion's exact shell/agent pane focus. Disclose shared focus and require fresh Chat confirmation after navigation.
- 0be60d8: Package original host-setup and lifecycle-reporting skills with explicit preview,
  profile status, owned installation/update and removal commands. Preserve agent
  configuration and reject foreign or edited skills; no automatic installation.
- 730cb2a: Add explicit inspected-plan lifecycle hook setup for Claude Code, Codex and OpenCode, with an SSH-connected Agents setup flow and companion CLI.

  Preserve foreign profile values and ordinary file mode/group metadata, refuse unhandled ACLs or ownership conflicts, and keep configured state distinct from trust and live reporting. Managed writes initially support qualified Linux filesystems; other platforms retain preview-only capability.
- 7218f34: Add inspected-profile managed Droid hooks for an already-existing standalone hooks.json, including the connected Agents selector.

  Preserve foreign groups and fallback policy; refuse absent configuration rather than shadowing settings/legacy declarations. No automatic trust changes, fresh-profile migration or native Droid lifecycle claim.
- 7477209: Extend explicit inspected-profile lifecycle hook setup to Gemini CLI and Cursor CLI, including the SSH-connected Agents setup selector.

  Preserve Gemini millisecond deadlines and disable flags, Cursor version-1/fail-open observer semantics, foreign policy and the existing retained filesystem transaction. Other managed providers, macOS writes and actual provider-trusted reporting remain separate gaps.
- 672b24b: Add native Codex lifecycle ingestion and a bounded OpenCode lifecycle plugin with print-only configuration assets.
- e542d41: Add native Cursor activity/completion reporting, an Amp thread-state observer
  plugin and truthful host-wide Aider notification health. Print reviewed assets
  and arguments without changing profiles or permission policy. Aider callbacks
  have no session attribution or lifecycle states and never create session rows.

### Patch Changes

- bc6c84d: Recover built-in account quotas from empty external reports and offer companion setup when a remote usage command is missing or outdated.
- 4f4d872: Initialize companion schema tables and indexes in one deferred transaction, retaining full durability and existing storage wait budgets while rolling back partial schema creation on failure.
- 1cddb34: Support native OpenCode 2.2 and 1.19.5 loading from one reviewed lifecycle plugin asset, with bounded ordered delivery and cleanup on unload. Hook installation and trust remain explicit.
- Updated dependencies [bc6c84d]
  - @lazysh/account-usage@1.4.0
  - @lazysh/common@1.4.0
  - @lazysh/notification-client@1.4.0

## 1.3.3

### Patch Changes

- @lazysh/account-usage@1.3.3
  - @lazysh/common@1.3.3
  - @lazysh/notification-client@1.3.3

## 1.3.2

### Patch Changes

- @lazysh/account-usage@1.3.2
  - @lazysh/common@1.3.2
  - @lazysh/notification-client@1.3.2

## 1.3.1

### Patch Changes

- @lazysh/account-usage@1.3.1
  - @lazysh/common@1.3.1
  - @lazysh/notification-client@1.3.1

## 1.3.0

### Minor Changes

- 9565f8a: Add compact AI account quotas and built-in host collectors when ai-usagebar is unavailable, keeping credentials on the session machine.

### Patch Changes

- Updated dependencies [9565f8a]
  - @lazysh/account-usage@1.3.0
  - @lazysh/common@1.3.0
  - @lazysh/notification-client@1.3.0

## 1.2.0

### Patch Changes

- @lazysh/common@1.2.0
  - @lazysh/notification-client@1.2.0

## 1.1.7

### Patch Changes

- @lazysh/common@1.1.7
  - @lazysh/notification-client@1.1.7

## 1.1.6

### Patch Changes

- @lazysh/common@1.1.6
  - @lazysh/notification-client@1.1.6

## 1.1.5

### Patch Changes

- @lazysh/common@1.1.5
  - @lazysh/notification-client@1.1.5

## 1.1.4

### Patch Changes

- @lazysh/common@1.1.4
  - @lazysh/notification-client@1.1.4

## 1.1.3

### Patch Changes

- @lazysh/common@1.1.3
  - @lazysh/notification-client@1.1.3

## 1.1.2

### Patch Changes

- @lazysh/common@1.1.2
  - @lazysh/notification-client@1.1.2

## 1.1.1

### Patch Changes

- @lazysh/common@1.1.1
  - @lazysh/notification-client@1.1.1

## 1.1.0

### Patch Changes

- @lazysh/common@1.1.0
  - @lazysh/notification-client@1.1.0

## 1.0.2

### Patch Changes

- @lazysh/common@1.0.2
  - @lazysh/notification-client@1.0.2

## 1.0.1

### Patch Changes

- @lazysh/common@1.0.1
  - @lazysh/notification-client@1.0.1

## 1.0.0

### Minor Changes

- 58b3c9f: Add explicit preview-bound Unix companion installation with verified source bytes, a fixed private user namespace and kernel-locked atomic replacement. Windows installation remains explicitly unsupported; existing runtime and data defaults are unchanged.
- e61e477: Publish verified companion executables for Linux x64/ARM64, macOS Intel/ARM64 and Windows x64 in future complete releases, with native staged-byte CLI/storage acceptance and existing source-bound receipts. Existing companion behavior and storage defaults are unchanged.

### Patch Changes

- @lazysh/common@1.0.0
  - @lazysh/notification-client@1.0.0

## 0.23.0

### Patch Changes

- @lazysh/common@0.23.0
  - @lazysh/notification-client@0.23.0

## 0.22.0

### Patch Changes

- @lazysh/common@0.22.0
  - @lazysh/notification-client@0.22.0

## 0.21.0

### Patch Changes

- @lazysh/common@0.21.0
  - @lazysh/notification-client@0.21.0

## 0.20.0

### Patch Changes

- @lazysh/common@0.20.0
  - @lazysh/notification-client@0.20.0

## 0.19.0

### Patch Changes

- @lazysh/common@0.19.0
  - @lazysh/notification-client@0.19.0

## 0.18.0

### Patch Changes

- @lazysh/common@0.18.0
  - @lazysh/notification-client@0.18.0

## 0.17.2

### Patch Changes

- @lazysh/common@0.17.2
  - @lazysh/notification-client@0.17.2

## 0.17.1

### Patch Changes

- @lazysh/common@0.17.1
  - @lazysh/notification-client@0.17.1

## 0.17.0

### Patch Changes

- @lazysh/common@0.17.0
  - @lazysh/notification-client@0.17.0

## 0.16.0

### Patch Changes

- @lazysh/common@0.16.0
  - @lazysh/notification-client@0.16.0

## 0.15.0

### Patch Changes

- @lazysh/common@0.15.0
  - @lazysh/notification-client@0.15.0

## 0.14.0

### Patch Changes

- @lazysh/common@0.14.0
  - @lazysh/notification-client@0.14.0

## 0.13.0

### Patch Changes

- @lazysh/common@0.13.0
  - @lazysh/notification-client@0.13.0

## 0.12.2

### Patch Changes

- @lazysh/common@0.12.2
  - @lazysh/notification-client@0.12.2

## 0.12.1

### Patch Changes

- @lazysh/common@0.12.1
  - @lazysh/notification-client@0.12.1

## 0.12.0

### Patch Changes

- @lazysh/common@0.12.0
  - @lazysh/notification-client@0.12.0

## 0.11.0

### Patch Changes

- @lazysh/common@0.11.0
  - @lazysh/notification-client@0.11.0

## 0.10.1

### Patch Changes

- 3ec508c: Preserve explicit Pi tool-result error booleans in recorded chat and reuse the recorded-error badge without inferring live state or changing other adapters.
- @lazysh/common@0.10.1
  - @lazysh/notification-client@0.10.1

## 0.10.0

### Patch Changes

- @lazysh/common@0.10.0
  - @lazysh/notification-client@0.10.0

## 0.9.1

### Patch Changes

- @lazysh/common@0.9.1
  - @lazysh/notification-client@0.9.1

## 0.9.0

### Patch Changes

- @lazysh/common@0.9.0
  - @lazysh/notification-client@0.9.0

## 0.8.0

### Patch Changes

- @lazysh/common@0.8.0
  - @lazysh/notification-client@0.8.0

## 0.7.1

### Patch Changes

- @lazysh/common@0.7.1
  - @lazysh/notification-client@0.7.1

## 0.7.0

### Patch Changes

- @lazysh/common@0.7.0
  - @lazysh/notification-client@0.7.0

## 0.6.0

### Patch Changes

- @lazysh/common@0.6.0
  - @lazysh/notification-client@0.6.0

## 0.5.0

### Patch Changes

- @lazysh/common@0.5.0
  - @lazysh/notification-client@0.5.0

## 0.4.0

### Patch Changes

- @lazysh/common@0.4.0
  - @lazysh/notification-client@0.4.0

## 0.3.0

### Minor Changes

- c997e5f: Add explicitly opted-in Claude reported-history metadata and a selected-row shortcut into Chat. Source files remain unread until Open transcript; reported history does not verify a running agent or enable direct Send/Stop. Existing capture, image and Follow defaults remain off.

### Patch Changes

- @lazysh/common@0.3.0
  - @lazysh/notification-client@0.3.0

## 0.2.1

### Patch Changes

- @lazysh/common@0.2.1
  - @lazysh/notification-client@0.2.1

## 0.2.0

### Patch Changes

- @lazysh/common@0.2.0
  - @lazysh/notification-client@0.2.0
