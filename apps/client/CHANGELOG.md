# @lazysh/client

## 1.4.0

### Minor Changes

- 7218f34: Add inspected-profile managed Droid hooks for an already-existing standalone hooks.json, including the connected Agents selector.
  
  Preserve foreign groups and fallback policy; refuse absent configuration rather than shadowing settings/legacy declarations. No automatic trust changes, fresh-profile migration or native Droid lifecycle claim.
- 54796e0: Browse Herdr spaces and live agent panes from workspace navigation. Reuse or explicitly attach the exact server display, then use stock shared workspace/tab focus or the companion's exact shell/agent pane focus. Disclose shared focus and require fresh Chat confirmation after navigation.
- 730cb2a: Add explicit inspected-plan lifecycle hook setup for Claude Code, Codex and OpenCode, with an SSH-connected Agents setup flow and companion CLI.
  
  Preserve foreign profile values and ordinary file mode/group metadata, refuse unhandled ACLs or ownership conflicts, and keep configured state distinct from trust and live reporting. Managed writes initially support qualified Linux filesystems; other platforms retain preview-only capability.
- 7477209: Extend explicit inspected-profile lifecycle hook setup to Gemini CLI and Cursor CLI, including the SSH-connected Agents setup selector.
  
  Preserve Gemini millisecond deadlines and disable flags, Cursor version-1/fail-open observer semantics, foreign policy and the existing retained filesystem transaction. Other managed providers, macOS writes and actual provider-trusted reporting remain separate gaps.
- 8b5770c: Enter the saved named multiplexer through Mosh without forcing SSH, retain exact transport and attachment restoration intent, and preserve native display admission before exposing the connection.

### Patch Changes

- 19e9da2: Verify companion files with a fixed, bounded window of SFTP reads while retaining ordered full-file hashing, legal partial-read handling, explicit EOF and metadata checks. Preserve existing time limits, conservative residue warnings and deletion guards; closed cleanup stage/reason observations distinguish incomplete cleanup from installation outcomes.
- fd3a0aa: Free the terminal control row and prevent composer action overlap; give long mobile dialogs a fullscreen layout while preserving trust, authentication and dismissal protections.
- f573077: Classify failed companion installer tag rechecks without exposing request or response text or changing verification rules.
- ad7e576: Reduce repeated mobile guidance and compact unavailable Apple status without hiding active sharing controls or safety limits.
- bc6c84d: Recover built-in account quotas from empty external reports and offer companion setup when a remote usage command is missing or outdated.
- 693d31d: Keep Herdr navigation and agent reports reachable within one scrollable drawer on short screens.
- 34d9ba1: Compact and align the workspace restore notice, retaining restoration limitations in an accessible details disclosure and preserving explicit restore and dismissal behavior.
- b3d7262: Keep Android system bar icons readable over the native navy background.
- c0eaf57: Keep a continuous terminal touch drag routed to its original pane until the finger lifts or the gesture is cancelled.
- c6871fd: Clear sticky touch hover from momentary terminal keys while retaining intentional modifiers, held-key feedback, fine-pointer hover and accessible keyboard focus.
- 6026586: Show branded Android startup content until the native access policy is known.
- b42a598: Fence Android and desktop IME composition completion and Enter against replay; apply owned trailing ASCII corrections without enabling private keyboard mode. Flush preedit before toolbar modifier changes. Complete the Android terminal no-autocorrect policy with autocomplete off; Compose hints remain unchanged. Preserve upstream handling for unsupported replacement spans pending remote editor compatibility.
- 1af65c3: Display structured native terminal error messages and preserve localized failures instead of rendering `[object Object]`.
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
