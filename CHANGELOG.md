# Changelog

## [Unreleased]

- Classify failed companion installer tag rechecks with closed diagnostics while preserving localized errors, provenance verification and installation defaults.

- Add explicit managed Droid hook setup for an existing standalone `.factory/hooks.json`, including the connected Agents selector. Preserve foreign event groups and fallback/settings policy, bind the inspected absolute companion, and refuse missing files rather than shadowing legacy hooks. Fresh-profile migration and native Droid runtime qualification remain unsupported; no defaults or trust settings change.

- Display native terminal failure messages instead of `[object Object]`, preserving localized errors.

- Keep connected Herdr navigation and agent reports in one scrollable drawer so live rows remain reachable on short phone screens. Preserve the existing navigation, report readers and drafts when switching views.
- Initialize companion database tables and indexes in one deferred transaction, avoiding separate schema commits and rolling back partial initialization on failure. Preserve full synchronization, existing writer coexistence and storage wait budgets.

- Keep Android status and navigation icons light over the fixed navy native window background in both system appearances. Preserve keyboard and system insets and custom app/terminal themes.
- Add a print-only Cline runtime plugin for root run activity, completion/stopped and generic failure attention, using native run identities and a two-second companion writer deadline. Child runs, permission waits and managed Cline installation remain unsupported; existing profiles, approval policy and adapters are unchanged.

- Extend explicit managed hook setup to Gemini CLI and Cursor CLI through the companion and SSH-connected Agents view. Preserve Gemini's 5000 ms deadline and existing disable settings; retain Cursor's version-1 envelope, five-second fail-open observers and permission-hook exclusions. Existing foreign values/policy, filesystem checks and trust defaults remain unchanged; incompatible Cursor versions are refused.

- Support OpenCode 2.2 native plugin loading with the same reviewed hook asset used by OpenCode 1.19.5. Serialize companion writes, coalesce pending session states, bound queued sessions, and stop owned ingest processes when the plugin unloads. Hook installation remains explicit and does not alter agent trust or permissions.

- Honor a saved Mosh preference when entering a default tmux, Herdr or Zellij session. Auto entry tries Mosh and then SSH only for safe failures before entry dispatch; uncertain startup or guard admission never opens a replacement display. Keep the exact transport and attachment together for workspace restore (Zellij restore remains manual). SSH entry stays selectable; saved ET entry continues to use SSH. Native Mosh entry requires its private startup receipt, and tmux additionally requires a verified display binding. Guarded Herdr requires the positively advertised startup-FD extension; stock Herdr keeps ordinary display capabilities.

- Prevent Android and desktop terminal IME composition from replaying after Enter or a canceled input context, and apply owned trailing ASCII corrections as edits. Keep ordinary Unicode composition, hardware keys, paste and virtual modifiers; unsupported committed-text corrections are retained locally for explicit inline review/copy instead of guessed terminal erasure or replay. Pending Enter is not sent for an unapplied edit. Existing Compose drafts are preserved, oversized context cannot be copied, and review state is cleared when leaving the active unlocked session. Flush current preedit before toolbar modifier changes. Android terminals now request browser autocomplete off alongside their existing autocorrect-off policy; Compose hints are unchanged and no private keyboard mode is requested.

- Add explicit managed Claude Code, Codex and OpenCode hook setup from the Agents view or companion CLI on supported Linux filesystems. Inspect a selected existing profile before installing/updating or removing only lazysh-owned entries; preserve foreign values and ordinary permission/group metadata. Persisted executable paths require retained, non-writable, non-symlink namespaces, including support for read-only root-owned binary directories. No hooks or trust settings change automatically. macOS/Windows retain preview-only capability pending filesystem qualification.

- Add a dedicated Herdr Spaces hierarchy and live agent groups to workspace navigation, with one selected-server reader and search. Reuse a matching display or attach the selected server before validating the destination. Workspace and tab jumps use stock Herdr; exact shell and agent pane jumps use the updated companion. Focus is shared with other connections to that server. Navigation retires prior Chat confirmation, and server focus metadata is not presented as this client’s current selection. Connection defaults are unchanged.

- Pipeline companion verification through a fixed window of SFTP reads, preserving ordered full-file hashes, partial reads, EOF and metadata checks, existing time limits and conservative deletion guards. Retain closed cleanup stage/reason observations when completion is not verified; residue remains distinct from installation success.

- Add native Cursor CLI activity/completion hooks, an Amp thread-state observer plugin and aggregate Aider notification health. Print reviewed configuration/assets without changing profiles or approvals; Aider callbacks have no session identity or lifecycle states and never alter running session rows. Cursor permission waits and Kimi per-turn completion remain unsupported.

- Add native Gemini CLI, Droid, Kimi CLI and GitHub Copilot CLI lifecycle reporting with print-only configuration fragments. Preserve each agent's exact event semantics, hook-file envelope and timeout units; no agent profile or trust settings are changed. Ignore Kimi's unscoped Stop/StopFailure events because child souls share the parent session identity; Kimi turn completion remains unavailable through these callbacks.

- Keep continuous terminal touch scrolling targeted at the pane where the drag began, including Herdr. Moving across pane or header boundaries no longer redirects wheel reports mid-gesture; reversals keep scrolling and a new drag can select another pane.

- Move Compose and terminal-key visibility into compact header icon controls, and use accessible icon actions beside the draft composer without overlap. On phones, long settings and forms now fill the screen with a persistent close header; short choices remain sheets and desktop dialogs keep their existing size. Authentication, trust and dismissal behavior are unchanged.

- Show the lazysh logo during Android’s initial native access-policy check instead of briefly displaying an Unlock screen. Match the system launch background to the logo; retain the real lock screen, error recovery, secure cover and stale-unlock protections.

- Package original lazysh host-setup and agent-reporting skills with explicit preview, profile status, install/update and removal commands. Linux/macOS Claude and Codex profile writes require an exact inspected plan and preserve foreign skills, edits and agent configuration. No skills, hooks, services or provider settings change automatically; other platforms retain preview-only capability.

- Fall back to the built-in account-usage collectors when an optional external ai-usagebar returns no accounts, while preserving explicit provider disabling and cached error reports. Show a contextual companion install/update action for missing or outdated Unix companions instead of generic unavailability, and distinguish empty accounts in the compact usage button.

- Add native Codex lifecycle ingestion and an OpenCode lifecycle plugin alongside Claude Code hooks. Print configuration/assets without changing agent settings or trust; report working, attention and completed states without recording prompts, tool arguments or approval decisions.

- Align the workspace restore action with accessible 44px details and dismiss icons in one compact row. Keep the saved-credential and multiplexer restoration explanation available on demand; restore, dismissal and connection defaults are unchanged.

- Return momentary terminal keys to their resting appearance after touch release. Preserve intentional modifier locks, held-key feedback, mouse hover, keyboard focus outlines and custom theme colors; key dispatch and repeat behavior are unchanged.

- Shorten common attachment, transcript and preferences guidance while keeping safety limits visible. Show a compact capability notice for unavailable Apple status features; preserve sharing controls and privacy guidance after any sharing request.

- Detect live Herdr agents and accept exact workspace, tab and pane actions when their public IDs contain Herdr’s encoded letters, such as `wZ` and `w2E:pF`. Preserve target bounds, relationships and command quoting; connection and server-selection defaults are unchanged.

- Retain bounded last-poll selector counts and timing when public Android APK workspace readiness fails. Reuse existing accessibility queries without changing actions, readiness checks or deadlines; no cold-start cause or Google runtime qualification is inferred.

- Open live Agents on the current terminal's attached Herdr session when it is present in discovery, including hosts with several running sessions. An explicit server choice takes precedence; a missing attached session requires choosing a server instead of silently showing another one. Plain terminals retain their existing selection behavior.

- Permit an explicitly acknowledged repair source for unpublished 1.3.0 after its Windows companion acceptance failure. Rebuild every publication gate for that source; never replace a published tag or reuse the failed attempt's partial artifacts. Label the retained development changelog without implying every entry was added after version preparation.

- Preserve upload-specific SSH closure guidance, including partial-file warnings and Reconnect uploads. Distinguish closed host-tools connections so Agents only offers command recovery for that purpose.

- Keep Android terminal connections active while switching apps using a private foreground service and a generic ongoing notification. Backgrounded renderer output pauses without expiring the connection; the last native connection releases the service and wake lock. Held terminal keys stop while the app is hidden. Existing app-lock protections remain in place. Android system battery restrictions, Doze and force-stop can still interrupt connectivity.

- Add compact AI account quota and credit reports for Android remote hosts and desktop remote/local terminals. Prefer a compatible ai-usagebar installation and use built-in companion collectors when it is absent or unsupported; existing provider sign-ins stay on the session machine. Account usage refreshes while the terminal is visible. Standalone companions expose retained collector and adapter license notices through `lazysh-agent licenses`.

- Add explicit Reconnect host tools recovery for a Mosh session whose SSH command connection closed. Saved or manual credentials reauthenticate the original verified host without opening a terminal or changing upload-only recovery. Authentication remains user initiated.

- Distinguish Herdr snapshots without live agent metadata from a confirmed empty agent list. Agents shows an explicit capability warning while Sessions keeps legacy tree compatibility; upload-only SSH recovery continues to leave host command access unchanged.

- Keep live Herdr results, companion counts and empty states stable while Agents refreshes. Preserve a failed-read warning until its replacement completes, and remove failed live rows instead of presenting them as a successful empty discovery. Polling frequency, server selection and connection defaults are unchanged.

- Expand the default terminal key row with Alt, Shift and Attach; offer AltGr, navigation, function and symbol keys in preferences. Ctrl and Alt cycle between one-shot, locked and off, and held keys repeat. Preserve custom and empty layouts. Use branded icon buttons for Compose and terminal-key visibility, and reduce terminal side padding to safe-area-aware 2px.

- Select Use saved credentials by default after confirming availability in the native vault. Explicit Password/Private key choices and credentials entered while the availability check is pending keep manual authentication selected. Connect still requires an explicit action and stored secrets stay in the native vault.

- Open the current saved host’s Default multiplexer setting directly from More, with the selector focused. Save a named Herdr, tmux or Zellij default for future connections without changing the running terminal or its saved transport preference. Connection defaults are unchanged.

- Update installation and release acceptance notes with the explicit in-app Unix companion path, current Android/Linux installer proof and published-APK qualification limits. Keep documentation links usable in the attached guide and release notes.

- Discover live Codex and other agent panes reported by Herdr independently of companion lifecycle reports. A single running Herdr server is selected automatically; choose a server when several are running. Only that server is refreshed, and its Idle, Working, Needs attention, Done and Unknown statuses remain distinct from companion history. No input, approval or history authority is inferred from discovery.

- Enable direct vertical touch scrolling through the terminal’s wheel handling, including Herdr mouse reporting and alternate-screen applications. Active phone terminals now default to one compact header: single-session tabs, tool navigation and the workspace restore prompt collapse into More, where their actions remain reachable. Multiple-session navigation, desktop/nonterminal layouts, terminal keys above the keyboard and accessibility gestures remain supported.

- Keep Mosh sessions alive when UDP readiness has drained instead of closing with “No packet received: Success”. Later authenticated traffic resumes on the same client; genuine socket/protocol errors, explicit shutdown, output bounds and connection defaults are unchanged.

- Read Android primary clipboard text and PNG/JPEG images through protected foreground native operations when Paste is explicitly requested. Terminal Paste reports busy and temporarily disables repeated requests while its existing owned read settles. Paste stays literal without Enter; images open in attachment preview and still require a separate Upload action. Existing access locks and payload limits remain in place. Platform metadata is checked before Paste so other-platform browser reads start within the click; failed checks offer a metadata-only retry.

- Keep mobile settings, attachment and tool-panel text inside consistent gutters, align wrapped form and transcript checkbox labels beside their controls, and separate workspace restore actions from their explanation. Expose per-host default multiplexer editing from Preferences, including Herdr. Connection and multiplexer defaults are unchanged.

- Allow the local native app to reach the existing Reconnect uploads action and host companion settings. Keep other windows and remote pages denied, require current unlocked app access, and preserve host verification, authentication and settings revision checks.

- Preserve only bounded, fully framed Android published-APK driver stage entry/exit observations when the original qualification command fails. Progress remains separate from success, failure cause and owned cleanup; application defaults and public APK bytes are unchanged.

- Add explicit same-tab upload recovery for verified direct Mosh connections. Reuse saved or manually entered SSH authentication without starting another terminal or saving credentials; preserve attachment edits and require a separate Upload action afterward. Other SSH tools keep their existing connection, and existing upload limits, path guards and no-overwrite behavior are unchanged.

- Style native file-picker buttons with the active lazysh theme and 44px touch targets, including attachment file and camera selection. Native pickers and upload behavior are unchanged.

- Explain when an attachment upload loses its separate SSH file-transfer connection while a Mosh terminal remains open. Reconnect to the saved host from Connections and upload from the new connection; existing Mosh tabs, upload limits, exclusive file creation, and path checks are preserved. This does not automatically reauthenticate a disconnected side channel.

- Keep session toolbar icons and labels inside their buttons on narrow screens and with enlarged text. Scroll horizontally to reach additional views without widening the workspace.

- Add a manual smoke for public signed ARM64 Android APK installation, native UI startup and same-byte reinstall with preserved synthetic host data on an explicitly admitted ARM translation guest. Physical-device and cross-version acceptance remain separate; application defaults are unchanged.

- Remove unused desktop browser archive tooling from the Android source-build input before scanning, and admit an exact-source retry for the unpublished 1.0.0 release. All source/binary scans and tag protections remain required.

- Keep the Android workspace inside system bars and display cutouts, and resize the terminal and special-key row above docked software keyboards. Compose stays in the fixed controls so opening it does not scroll Esc/Tab out of view. The open composer scrolls within its available space and preserves a complete terminal row, including with larger terminal text. Showing and hiding the keyboard restores the available terminal space; terminal input and toolbar preferences are unchanged.

- Add explicit companion installation inspection and preview-bound local installation for Linux and macOS. The CLI derives one private user-local destination, preserves existing binaries on pre-commit rejection, and distinguishes committed durability uncertainty. Windows installation reports unsupported pending native ownership and SSH verification; existing binary distribution, data, settings, hooks and PATH defaults are unchanged. In-app transfer and installation remain separate work.

- Add persistent Connections, Workspaces and Agents navigation to the existing sidebar/drawer. Connections remains the default; agent drafts persist while hidden owners suspend activity, and Jump To uses one guarded persistent tmux picker.

- Add verified companion executable builds to future complete release sets for Linux x64/ARM64, macOS Intel/ARM64 and Windows x64. Candidate checks create no publication receipts; trusted release builds retain exact source/version/hash and staged-byte CLI/storage gates. Existing companion/data defaults and deferred Apple application packages are unchanged; in-app installation remains separate work.

- Add an explicit in-app Install/Update companion action for supported Linux and macOS hosts, including when agent loading fails. It verifies published release bytes, transfers through the current SSH connection, preserves uncertain outcomes and uses the managed executable for subsequent companion commands. Missing managed installations retain legacy PATH behavior. Installation never starts automatically or changes host permissions, agent hooks or PATH; Windows installation remains separate work.

- Add reported-agent search, status filters and selected-report context while preserving explicit refresh, history and approval ownership. Reported pane IDs remain context; application defaults are unchanged.

- The visible Agents board now refreshes reported activity every five seconds by default while the app is in the foreground. Hidden boards and background windows pause automatic reads; pending snapshots are not duplicated, and manual Refresh remains available. Transcript discovery and other host permissions are unchanged.

- Add an optional per-host default multiplexer and named session for direct SSH entry. Existing hosts keep normal connection behavior; the saved transport is preserved, and unavailable targets never select another session automatically.

- Refresh the default app appearance with the lazysh logo palette, frosted navigation and dialogs, and consistent buttons and selectors. The default app preset is now labelled lazysh; saved preset identifiers, terminal colors, and custom themes are preserved. Reduced-transparency and reduced-motion preferences are respected.

- Show the canonical lazysh logo on the welcome screen, replacing the unrelated terminal illustration. Application defaults are unchanged.

- Reject unsupported tmux client-loop formats before granting navigation or guarded Chat input, and require exactly one matching client for every action. Ordinary terminals remain available on older servers; tmux 3.2a advanced bindings are unavailable.

- Publish the current 0.23.0 version through an explicit source-bound initial release, then preserve every individually merged future Changesets version through the existing verified installer gates. Pending Changesets and application defaults are unchanged; release notes disclose native runtime gaps.

- Require actual Windows NSIS installation, same-version repair with preserved owned data, and uninstall acceptance before staging release bytes. Native Windows PR checks run the same acceptance; application defaults are unchanged.

- Support desktop `--dir` launches while lazysh is running, resolving relative paths against the caller’s working directory and preserving the original access guards. Ambiguous Unicode conversions are refused; no-argument startup is unchanged.

- Fix Windows release packaging validation of workspace path separators without changing application defaults.

- Clarify the project agent workflow so continuation requests proceed from recovered history into implementation and keep working across the requested roadmap scope without requiring Codex `/goal`. Application defaults are unchanged.

- Add a localized Named key shortcut builder for toolbar and gesture bindings, including F1–F12 and optional modifiers. Drafts remain separate between builder modes; Advanced stays the default, and saving never sends terminal input.

- Remove reference-vendor names and URLs from the current source and documentation. Theme import now accepts only `lazysh-theme:` share codes and raw JSON; third-party-prefixed share codes must be converted to JSON before import. Stored themes and existing defaults are unchanged.

- Track the delivery roadmap in GitHub Projects using existing issues and their current statuses; the public delivery epic remains available to readers without project access.

- Add a delivery roadmap linking open feature and platform-verification work, and describe lazysh in its own terms in the README. Application behavior and defaults are unchanged.

- Enable GitHub release publication by default for verified Android, Linux and Windows installers after Changesets version merges. Apple releases and official F-Droid inclusion remain deferred.

- Prepare Android, Linux and Windows release artifacts without requiring Apple packages. Apple releases remain deferred; publication remains gated on verified build and distribution prerequisites.

- Reorganize the README around mobile SSH, persistent sessions, and optional AI-agent workflows, with a source-preview quickstart, clearer release caveats, and contributor calls to action. Documentation only; application behavior and defaults are unchanged.

- Prepare a verified cross-platform release installation pipeline with checksums, changelog and install/update guides. Publication and stable tags remain disabled pending signing credentials and reviewed F-Droid/free-push prerequisites; debug APKs and simulator apps are not advertised as production installers. Existing application defaults are unchanged.
- Add separate, default-off native consent for generic private FOSS Android UnifiedPush event notifications. Bound-v2 events require the original confirmed device enrollment, OS permission/channel, absolute freshness and Keystore-protected replay admission; taps only open lazysh. Existing registration/enrollment does not turn display on. Actual distributor event/display acceptance remains pending.

- Add explicit `push-config-generate --event-format bound-v2` for encrypted Web Push events with a frozen device generation and absolute expiry. Legacy Web Push remains the default; webhook and enrollment formats are unchanged. Switching the private target requires deliberate reconfiguration and fresh enrollment. Native event display remains incomplete.

- Add explicit Zellij tab 1–20 quick-access buttons using the existing typed native action, without timing-sensitive digit chords or automatic tab discovery. Preserve manual drafts, original session/access ownership and raw host errors; the row does not infer existing or current tabs.

- Add an explicit, integrity-checked Noto Sans Mono CJK SC font download from its pinned official source into existing device-local font storage. Downloads stay off until requested; font selection remains a separate action. Existing font budgets, manual imports and delete controls remain, with bounded transfer/cancellation and no broad network permission. Other downloadable font families and native-device runtime acceptance remain incomplete.

- Add explicit **Paste uploaded path** in standalone Attachments: send only the current upload's validated, quoted host path to its original selected terminal without Enter, honoring public terminal bracketed-paste mode. No automatic write, retry or provider integration is added; copy, editable prompt staging and Chat attachment behavior remain unchanged.

- Add explicit line comments on both sides of staged and unstaged repository diffs. Notes preserve the observed selected path, side, line, diff selection and rename context, remain editable across review changes, and enter the existing prompt draft only when requested. A snapshot warning explains that host files may have changed; no note is sent automatically.

- Add opt-in listener refresh in the visible Preview panel, five seconds after each scan settles. It defaults off per panel/session, preserves preview pages and drafts, and shares the existing explicit port filter and optional HTTP checks. Hiding, closing or disabling the panel stops scheduling and suppresses late results; already-issued native scans may finish under existing bounds.

- Refresh agent-board display readiness on native main-window focus as well as browser focus, so an opted-in board can resume after an earlier unavailable observation. Original access/visibility gates and the explicit re-enable requirement after failed acquisition remain unchanged; this does not establish the cause of the separately tracked Android readiness failures.

- Render repository side-by-side diff source and hunk headers with the selected terminal font, including already-loaded imported and CJK fallback families. Changing the font preserves the current review and does not refetch repository data; font size and connection behavior are unchanged.

- Remove the twelve-entry cap on custom keyboard chords and text snippets. Existing valid collections now survive normalization and reload without silent truncation; failed snippet saves retain the draft. Per-entry validation, device storage capacity and the existing settings-sync size limit remain unchanged.

- Catalogue the Next.js preview hint label in all interface locales, preserving the brand and existing discovery behavior while restoring the localization coverage gate.

- Add explicit private F-Droid Android relay enrollment and encrypted challenge confirmation with Keystore-protected state. Registration defaults remain unchanged; event messages and remote notification display remain disconnected.

- Show a server-reported Next.js hint when explicit preview HTTP discovery already has a complete bounded response header available. Probing stays off by default; unknown or incomplete headers preserve ordinary HTTP detection without waiting or issuing another request.

- Use the Bed Mode SVG mark in the existing app sidebar, keeping the visible lazysh name and accessible text singular. Connection behavior and responsive drawer controls are unchanged.

- Add an opt-in authenticated encrypted Web Push server foundation with private single-device enrollment, challenge confirmation and pinned HTTPS delivery. Existing webhook defaults are unchanged; Android enrollment and actual remote notification delivery remain incomplete.

- Replace the default lazysh app, browser, Android and iOS launcher artwork with the original Bed Mode sloth-and-mobile-terminal mark, and add transparent SVG brand variants. The default visual identity changes; app features, connection security and the existing Amber alternate icon are unchanged.

- Update the manual F-Droid source recipe for the UnifiedPush registration foundation. Automatic publishing remains disabled; this does not establish distributor delivery or complete free-software remote push.

- Add explicit opt-in native acceptance for the self-hosted whisper.cpp relay using pinned public engine/model/audio fixtures. This records bounded Linux interoperability, not general accuracy or physical-device acceptance; application defaults are unchanged.

- Catalogue the Cloud speech-engine option prefix in all interface locales while retaining the validated backend label, draft and explicit selection behavior. No defaults change.

- Add an explicit self-hosted whisper.cpp Cloud dictation relay option with a fixed operator-configured loopback endpoint and distinct backend identity. OpenAI remains the default; no provider fallback, model download or hosting is bundled.

- Prepare a disabled stable-tag gate for verified main version transitions, requiring current-candidate F-Droid source/binary checks before create-only tags. Automatic tags, signing and publication remain disabled pending free-software push and official submission prerequisites; product defaults are unchanged.

- Add an initial manual F-Droid source-build recipe and actual metadata/scanner checks. Automatic updates and publishing remain disabled; official inclusion and reproducibility are separate acceptance gates.

- Add opt-in UnifiedPush distributor selection and native registration to the F-Droid build, with consent, stale-callback protection and local registration removal. Registration remains off by default; this slice ignores incoming push messages and does not connect remote delivery.

- Add an explicit F-Droid Android build variant without Google remote push dependencies, retaining local inbox notifications. Normal Android Firebase and iOS APNs defaults remain unchanged; this variant alone does not establish F-Droid listing or release delivery.

- Add truthful English Fastlane-compatible Android listing text for future F-Droid preparation. No store publication, screenshots, application behavior or defaults change.

- Expose checked Android version metadata for source-based update discovery. Release validation now rejects colliding or out-of-range Android versions and version-code overrides; current valid APK codes remain unchanged. Tag publication and F-Droid submission are not enabled.

- Offer opt-in syntax highlighting in Remote Files text previews using the existing safe code renderer. Plain text remains the default, keyboard scrolling stays available, and SFTP paths, read limits and upload consent are unchanged. Keep highlighted previews tied to the current source when file contents refresh.

- Compose completed review dictation with the latest editable draft instead of replacing typed text or prior clips. Empty results preserve the draft; overflow keeps it intact without truncation. Review remains default, while direct delivery still queues only the newly recorded clip and history remains per clip.

- Preserve Pi Records' explicit tool-error booleans and label recorded failures while retaining original output and tool IDs. Other adapters, defaults and live terminal behavior are unchanged.

- Add an explicit attachment editor within Chat. Uploads preserve the existing draft; Add uploaded path appends only the canonical host path without sending, staging or copying automatically. Existing upload/access/cancellation guards and defaults remain unchanged.

- Keep retained native access-status and unlock errors in the current interface language without repeating authentication checks, ready acknowledgements or protected workspace mounts. Access policy and defaults are unchanged.

- Add explicit confirmed Chat input for original guarded Herdr terminals. Stage remains default; preparation candidates are retired on cancellation or context changes, uncertain input is never retried, and acknowledgements establish queue admission rather than agent execution.

- Add the native guarded-Herdr SSH prerequisite: consume private startup credentials before display output and bind explicit terminal preparations to the original connection and access proof. Frontend Herdr Chat controls remain disabled; unsupported builds keep ordinary attachment, and uncertain guarded starts are not retried automatically.

- Defer iOS status review-channel startup registration until all native plugins finish initialization, removing a startup ordering hazard observed in a retained second-launch crash. Readiness deadlines and native privacy/authentication behavior are unchanged.

- Add an optional source-built Herdr guarded-input protocol prerequisite, with exact original-client ownership, explicit expiring bindings and bounded two-stage input admission. Stock attach and lazysh Chat defaults remain unchanged; the native lazysh adapter is separate work.

- Accept explicit saved-host and tmux/Herdr picker launch requests while the desktop app is running. Requests wait for normal unlock and an available connection dialog; pending launches and typed manual credentials are preserved, and Connect remains explicit. Warm directory delivery remains unsupported.

- Extend explicitly chosen and confirmed tmux terminal input to all 17 native Chat readers. Hermes/OpenCode database session selectors are part of immutable authority, and changing a selector requires a new confirmation. Stage remains default; terminal acknowledgement does not establish agent identity, provider receipt or that a process stopped.

- Extend explicitly confirmed Chat terminal input to bounded multiline text and tabs, preserving exact accepted UTF-8 bytes through native tmux paste and one final Enter. Stage remains default. Paste brackets depend on the terminal program; server-global paste buffers may remain after interrupted delivery, and uncertain input is never automatically resent.

- Add explicit Send and Request stop in Claude Chat after choosing an existing tmux terminal. Stage remains the default; direct Send supports single-line drafts up to 4 KiB. Closing the view does not recall already submitted input, and failed or uncertain sends are never retried automatically.

- Keep release generation compatible with strict source duplication checks by identifying only the 15 exact Changesets-generated package changelog paths as generated artifacts. Handwritten root history, documentation, source and tests retain the unchanged zero-clone gate.

- Add an opt-in Claude reported-history shortcut that prefills Chat from an exact hook-reported session/path association on the selected SSH connection. Reading still requires Open transcript, with recorded images and Follow off. Existing manual paths and older companions remain usable; reported history never grants live agent input authority.

- Keep retained transcript validation and read alerts in the current interface language without repeating reads. Raw host diagnostics, parser rules, transcript contents, Follow and image behavior remain unchanged.

- Resolve Tauri's native application version from the synchronized client manifest, fixing Android and Apple mobile generators falling back to unrelated version defaults. Application identifiers, stored data, protocols and permissions are unchanged.

- Keep retained transcript-discovery validation alerts in the current interface language without repeating discovery. Raw host diagnostics, transcript validation and request ownership are unchanged.

- Keep retained recorded-usage validation, transcript discovery and continuity errors in the current interface language without repeating requests. Raw host diagnostics, parser rules, metrics and defaults are unchanged.

- Prepare automatic version and package-changelog pull requests with Changesets, keeping private Bun, Cargo and Tauri product versions together. About labels read the client build version. Existing root changelog history is retained. Publishing, tags and application-store release defaults remain disabled; GitHub PR creation and default-token CI approval require explicit repository setup.

- Add a dedicated owned Android QR-camera acceptance route through real permission denial/approval, camera frames, native decoded preview and camera release. The emulator uses the reviewed QR image with no webcam; production defaults are unchanged and actual hosted execution is reported separately.

- Extend explicit recorded PNG/JPEG previews to Codex user data-URL images in Records. Selecting Codex from a conversation view establishes Records and requires fresh image opt-in; file references and other media stay inert. Defaults, legacy output, paging and transcript bytes are unchanged.

- Add an explicit Mac-host clipboard action for the latest successful attachment. It writes the raw canonical path through the original verified SSH session and fixed `/usr/bin/pbcopy`; uploads still never copy automatically. Cancellation cannot undo a clipboard change already delivered. Linux and Windows host clipboard tools remain unsupported.

- Keep keyboard focus in the terminal after Paste draft, so the next keyboard Enter reaches the shell. Opening Compose and staging new drafts still focus the editor; paste and command bytes are unchanged.

- Add an owned Android app SSH acceptance route through explicit fingerprint review, ephemeral identity paste and interactive shell output. Existing workspace/vault/theme tests and runtime defaults remain unchanged; real hosted UI execution is reported separately.
- Extend explicit recorded PNG/JPEG previews to Claude user images in Records and current branch. Retire selections when their row/image leaves the retained branch, so returning history needs a fresh View action. Image inclusion stays off by default; disk bytes, legacy output and live terminal controls are unchanged.

- Add explicit, bounded PNG/JPEG previews for Grok recorded image chunks. Including image bytes and viewing decoded pixels are separate opt-in actions; defaults, transcript files, paging and live terminal controls remain unchanged.

- Reject replaced transcript and Codex usage sources on Windows using retained file handles and volume/file identity, including same-content, same-size and same-timestamp replacements. Shared snapshot readers fail closed when identity is unavailable; Unix inode checks and append-only Follow behavior are preserved.

- Add explicitly started offline theme QR camera scanning with a bounded PNG/JPEG image fallback and mandatory preview/Apply. QR camera use stays off by default and QR images stay local. Android's CAMERA declaration can also make the existing explicit Attachment Photo action request camera permission; ordinary file picking is unchanged. Apple camera purpose strings cover both explicit actions. Existing theme validation is unchanged; actual native/physical camera acceptance remains separate.

- Keep retained app-icon validation and local failure messages in the current interface language without repeating native icon reads or changes. Native diagnostics, device-local settings, defaults and permissions are unchanged.

- Scope failure-only iOS Mosh process inventory to the owned process group and label positively observed launcher/native images. Startup deadlines, sampling limits, failure gates and defaults are unchanged; this does not establish the intermittent stall's cause.

- Keep an already-visible App Lock authentication failure in the current interface language without repeating native configuration or changing opt-in, access authority or defaults.

- Keep retained theme validation, import/share, clipboard and linked-theme result messages in the current interface language without reapplying themes or repeating clipboard/acknowledgement actions. Theme data, export bytes, validation limits and defaults are unchanged.

- Reject observed truncated, replaced or mixed Claude conversation captures while preserving ordinary append-only growth during Follow. Parse an admitted bounded prefix without retries; defaults, polling, raw Records and Grok behavior are unchanged.

- Keep retained shortcut-parser validation errors in the current interface language while preserving literal key/step data, drafts and exact input bytes. Accepted grammar, stored bindings, defaults and native behavior are unchanged.

- Keep retained local font errors and fallback warnings in the current interface language without reloading fonts or repeating storage operations. Font data, stored names, raw device diagnostics and defaults are unchanged.

- Localize Keep Awake controls and multiplexer prefix shortcuts in English, Brazilian Portuguese and Spanish while preserving native ownership, opt-in state, retained errors and exact input bytes. Keep the board checkbox within narrow layouts; defaults and permissions are unchanged.

- Localize terminal controls, clipboard consent, link confirmation, search/composer status and terminal-owned local errors in English, Brazilian Portuguese and Spanish. Language changes preserve live terminal handlers, raw content, drafts, explicit consent and input bytes; locale defaults and permissions are unchanged.

- Reject observed file changes during Grok recorded-conversation reads, including concurrent appends, instead of publishing a partial, detached or mixed history. Stable incomplete tails, portable manual reads and existing limits/defaults remain unchanged.

- Add owned OpenSSH/tmux acceptance for restoring an exact named-server workload through fresh verified SSH after original transport and native handle retirement. GUI cold start, app-process death and physical roaming remain separate acceptance.

- Add explicit Grok recorded-file Follow with verified preparation, append-only paging, hidden-page pause and original source/access ownership. Manual Records remains the default; reconstructed conversation and live prompt targeting are not enabled.

- Keep About source revisions and expanded legal notices within mobile dialog bounds, including clean builds. Long tokens wrap and preserved notice indentation scrolls within keyboard-focusable legal blocks; legal bytes and source links remain unchanged.

- Add explicit opt-in companion storage failure phase diagnostics and same-worker trace summaries. Default output, SQLite errors, durability and wait budgets remain unchanged; this adds evidence rather than repairing contention.

- Keep dialog keyboard focus on visible, enabled controls, including expanded/collapsed notice summaries and ordinary links; preserve initial field focus, Escape and opener restoration.

- Add an explicitly started foreground companion relay sender, pinned to a required local revision, with one dispatcher, a two-second startup quiet period and global failure cooldown. Default-off admission and synchronous hooks remain unchanged; no OS service/schedule or native mobile provider is installed.

- Add explicit checkpointed Grok Records reads on Unix companions, binding continuation to selected file identity and its observed prefix. Manual paging/output stays unchanged; live-agent targeting is not enabled.

- Disable Turbo caching for client production builds so About/source metadata always embeds the current Git revision and dirty state. Other packages keep their existing cache behavior; source URL and metadata rules are unchanged.

- Add default-off companion publishing of new normalized lifecycle transitions to an explicitly bound self-hosted webhook relay. Admission is atomic with local ingest; bounded flush is explicitly invoked, with stable retry identities and persistent disable. No sender schedule, APNs/FCM delivery or deployment is installed.

- Localize encrypted Sync interface and client-created validation/status messages in English, Brazilian Portuguese and Spanish, with locale-aware import counts. Recovery data, native diagnostics, scopes, explicit action gates and language-import intent remain unchanged; sync and locale defaults do not change.

- Localize Apple status controls, accessibility labels and privacy/review explanations in English, Brazilian Portuguese and Spanish. Language changes preserve subscription ownership, publication timing, raw native diagnostics and snapshot freshness.

- Add owned OpenSSH/Herdr 0.9.3 acceptance coverage for explicit session selection,
  separate child PTYs, durable detach and original-lease revocation. GUI startup
  and biometric launch acceptance remain separate; runtime defaults do not change.

- Localize About interface labels and explanatory text in English, Brazilian Portuguese and Spanish. Imported legal notices, component names, source links and build metadata remain unchanged; locale defaults are unchanged.

- Localize tmux workspace, Herdr and Zellij controls and accessible names in English, Brazilian Portuguese and Spanish; preserve literal remote identities, errors and launch-picker ownership when changing language.

- Add an explicit opt-in Grok ACP recorded-conversation view with bounded chunk grouping, tool replacement and proven prompt-index rewinds. Unsupported controls or ambiguous histories fail visibly with Records available. Records remain the default; Claude Follow, media no-fetch and live-session binding restrictions are unchanged.

- Return the canonical SFTP destination after host-local uploads instead of echoing a relative input path. Attachments now copy/stage that returned path; Files refreshes its resolved parent. The internal `upload_file` result changes from void to `{path}`. Existing files remain protected by exclusive creation; cancellation never deletes remote paths.

- Add cold saved-host CLI composition with `--mux tmux`, `tmux:SERVER` or
  `herdr`. After explicit normal authentication, lazysh opens that fixed picker
  on the new SSH control session; choosing an exact row attaches through the
  existing native child PTY. Mux launches explicitly use SSH without changing
  saved host transport preferences. Warm CLI delivery remains unsupported.

- Allow active host-local uploads to be cancelled from Attachments and the remote Files browser. New reservation defaults allow two occupied jobs (pending, sending or retiring), each up to 10 MiB (20 MiB total); unused reservations expire after 30 seconds, separately from the existing 30-second transfer deadline. Cancellation never deletes a remote pathname: a partial or completed new file may remain. Existing files remain protected against replacement.

- Add an optional self-hosted authenticated webhook relay with private source capabilities, a durable bounded outbox and one fixed HTTPS destination. Delivery is disabled by default; native APNs/FCM delivery remains unavailable.

- Add cold desktop `--host SAVED_ID` / `-host SAVED_ID` launch into the normal
  saved-host connection dialog, with original unlock ownership across explicit
  credential and key-trust retries. The host editor now offers **Copy host ID**.
  Existing transport preferences remain unchanged; warm host delivery and CLI
  multiplexer composition remain unsupported.

- Add metadata-only discovery of existing Grok ACP `updates.jsonl` candidates in the pinned source store layout, honoring literal nonempty `GROK_HOME` overrides. Selecting and opening a file remains explicit; record-stream, conversation-replay and live-binding restrictions are unchanged.

- Add explicit named tmux server selection throughout discovery, attachment, controls, Jump To and saved workspace restoration. Commands now explicitly select `-L default` when no named server is chosen; an inherited `TMUX` environment variable no longer redirects legacy/default operations to another server. Client invocations now force UTF-8 (`-u`) so discovery framing and Unicode metadata are independent of the remote locale.

- Add an optional, default-off agent-board display keep-awake control backed by native display-idle ownership. Leaving the board, loss of foreground, app lock and renderer replacement release ownership. Linux now uses bounded asynchronous XDG portal acknowledgements, with exact cancellation, private-connection cleanup and visible owner-loss reporting. Acknowledgement does not establish physical idle-timeout or battery behavior; hardware validation remains pending.

This is a development preview, not a stable release or a claim of complete reference client
parity. Remaining capability and platform gates are tracked in issue #1.

### Fixed

- Changed companion SQLite close behavior: successful Store connections retain
  private WAL/SHM files after clean exit instead of checkpointing/deleting them
  for each short-lived hook. FULL commit synchronization and normal automatic
  checkpoints remain enabled. A database-only copy can now miss acknowledged
  events even after CLI exit; use a consistent SQLite backup or verified checkpoint.

- Companion initialization checks temporary SQLite journal/WAL/SHM paths while
  holding its existing bootstrap lock, avoiding inspections racing another
  initializer's journal removal. Ownership, permissions, no-follow checks and
  the shared three-second bootstrap budget are unchanged.

- The dictation-history opt-in checkbox uses bounded sizing and a wrapping label
  instead of inheriting full-width text-input sizing, keeping history controls
  within the panel at desktop and phone widths.

- Visible file-size and repository validation errors now follow interface language
  changes, including history errors with local causes. Host diagnostics remain
  verbatim, and changing language does not refetch files or change selections.

- Keep Android `lazysh://` link routing in the canonical manifest so cached
  incremental APK builds retain cold and warm theme-link delivery.

- Cancelled exec, SFTP, preview/probe, bastion, Mosh/ET bootstrap and device-stream
  channel openings retain ownership until peer confirmation and close late results
  without tearing down the parent SSH connection. They now share the existing
  four-pending-open limit per verified transport; a peer that never confirms can
  occupy those slots until it responds or the last local transport owner closes.

- Concurrent companion initialization rechecks a removed SQLite journal, WAL or
  shared-memory entry instead of rejecting its stale zero-link metadata. Rechecks
  are bounded, replacements must pass the original file protections, and bootstrap
  locks still fail closed. Separate SQLite contention failures remain under review.

### Added

- Localize SSH identity generation/import controls, in-memory credential
  explanations and public-key clipboard failures in English, Brazilian Portuguese
  and Spanish. Key material, cryptographic parameters and explicit actions are
  unchanged; no defaults or credential storage behavior change.

- Localize tmux Jump To layouts, current-window markers, navigation guidance and
  the unavailable prefix in English, Brazilian Portuguese and Spanish. Language
  changes format displayed window indexes for the selected language and retain
  native target IDs, pending requests and raw host diagnostics; defaults are unchanged.

- Remote push registration controls, contact/privacy disclosures and retained
  operation errors now support English, Brazilian Portuguese and Spanish.
  Language changes preserve consent and pending registration/revocation;
  native reasons and provider names remain verbatim. Defaults are unchanged.

- Desktop `-dir PATH` / `--dir PATH` cold launches open one local terminal after
  normal unlock, using the literal requested directory. Warm directory requests
  show a localized unsupported notice; host/multiplexer CLI targets remain
  unavailable. Explicit missing directories now fail instead of falling back to
  HOME; manual local terminals and restoration retain their HOME default. Windows
  directory launches use a verified compatible drive-path spelling and refuse
  UNC, device and verbatim-only paths instead of letting the shell change cwd.

- Device discovery, screenshot/video controls and client-owned validation now
  support English, Brazilian Portuguese and Spanish. Interface changes preserve
  stream ownership, frame data, socket drafts and explicit device-input choices;
  native SDK warnings and device identities remain verbatim. Defaults are unchanged.

- Localize optional public-sharing configuration, expiring uploads/history,
  thumbnails, copying and revocation in English, Brazilian Portuguese and Spanish.
  Language changes preserve credential/file drafts and in-flight requests; defaults
  and explicit upload/revoke consent are unchanged.

- Localize host attachment selection, crop/annotation controls, upload/copy/staging
  notices and local validation in English, Brazilian Portuguese and Spanish.
  Language changes preserve file bytes, edits, paths and editable prompts; defaults
  are unchanged. Public sharing controls remain separate work.

- Localize agent-board activity, one-request approval controls and companion
  settings in English, Brazilian Portuguese and Spanish. Language changes retain
  reported agent content, pending decisions and unsaved settings; Keep Awake
  controls remain a separate localization task. Defaults are unchanged.

- Main Voice engine/model/recording and direct-delivery controls now support
  English, Brazilian Portuguese and Spanish, including retained download/import,
  asset, transcription, delivery and local-error messages. Language changes keep
  the same recording, request IDs, selected models/languages and editable draft;
  native diagnostics and transcription content remain verbatim. Defaults are
  unchanged, including review-first dictation and opt-in Enter delivery.

- Cloud dictation enrollment/quota settings and dictation history controls now
  support English, Brazilian Portuguese and Spanish, including visible local
  errors. Language changes preserve pending transcription, drafts and history
  consent/entries. The main Voice engine/recording controls remain a follow-up;
  defaults and native diagnostics are unchanged.

- App language choices now also cover native lock screens and newly created
  biometric prompts on Android, iOS and macOS, including cold launch. Native
  preferences own the choice on those platforms; startup never overwrites it
  with a stale browser value. The first upgrade without a native choice uses
  System rather than automatically migrating a browser-only choice. Reset and
  explicit settings imports use the same
  serialized native update. Existing OS permission-language selection and access
  policy are unchanged; Windows, Linux and browser storage keep their defaults.

- Browser preview controls, forwarding/discovery validation and element-picker
  captions/statuses now support English, Brazilian Portuguese and Spanish.
  Language changes preserve the live iframe, selection and editable note; page
  data and staged annotation payloads remain verbatim. Defaults are unchanged.

- Remote file browsing, uploads, repository history, side-by-side diffs and line
  comments now have English, Brazilian Portuguese and Spanish controls. Language
  changes preserve selected files, revisions and editable drafts; file contents
  and staged annotation payloads stay verbatim. Defaults are unchanged.

- English, Brazilian Portuguese and Spanish interface text for Transcript, Usage
  and the notification inbox, including accessibility labels and validation.
  Usage and inbox dates/numbers follow the selected interface locale. Recorded
  messages, tool arguments, provider/agent names, IDs and remote diagnostics stay
  verbatim. Language changes retain drafts and polling/listener lifecycles;
  language preference defaults and native permission behavior are unchanged.

- Brazilian Portuguese and Spanish Apple permission explanations, with English
  fallback. Apple selects permission-sheet localization through the app's OS
  language; the in-app language override does not override system prompts. The
  microphone purpose now describes dictation using the selected engine.

- Brazilian Portuguese (`pt-BR`) and Spanish (`es`) for the existing interface
  catalogs: shell, host forms and Preferences controls. System remains the
  default and now selects these languages when available; English is the fallback.
  Explicit choices persist and sync without reconnecting live terminals or
  changing user text, commands or remote output. Other panels and native
  lock-cover text remain separate localization work.

- An English interface catalog and an App language preference for System or
  English. System is the default and uses supported English regional formatting,
  falling back to English for other system languages. Shell, host forms and
  Preferences update without reconnecting live terminals; remote output and user
  text remain unchanged. Other panels, native permission text and translated
  languages remain follow-up work.

- In-session tmux Jump To session/window trees with saved list, accordion and
  grid layouts and an exact Current marker. Navigation uses a display-owned
  retained control connection, validates its generation and captured PID/TTY,
  and stops on cancellation, server loss or interrupted/ambiguous responses.
  An unavailable binding disables navigation without replacing the terminal.
  The extra control client affects tmux attached counts/hooks; switching a
  window also changes the destination session's shared current window.
  Cancelled attachment setup closes its unpublished SSH display channel. Saved
  restoration uses the exact validated destination name; unsupported names keep
  the live terminal available with a notice and omit its restoration intent.

- Linux x86_64 Parakeet dictation with an explicitly downloaded, hash-pinned
  local model, one reusable recognizer, and model removal. Whisper remains the
  default. Cancel discards the result while native preparation/inference may
  continue; busy capacity and model files remain owned until the worker finishes.
  Other platforms report Parakeet unavailable; language detection is automatic.
- Linux native linking isolates ORT's embedded protobuf namespace so Mosh
  messages use their matching system protobuf implementation. The existing
  archive-specific export guard remains; upstream cached artifacts are unchanged.

- Repository pre-commit duplicate detection with pinned jscpd and Bun now rejects
  every detected clone, including pre-existing duplication; the previous baseline
  allowance is removed. Refactor with DRY until the scan reports zero clones.
  This instruction prints after successful and failed hook runs without changing
  their exit status. `bun run hooks:install` still explicitly enables the hook
  for the repository and linked worktrees, and lint-staged preserves partial
  staging. Dependency installation does not change the hooks configuration.

- Device-local iOS Home Screen icon selection with the original Default and
  new Amber artwork, UIKit support checks and actual selection readback. The
  default icon is unchanged; desktop, Android and browser builds report this
  feature unavailable. Icon selection does not sync or affect terminal themes.

- Claude transcript tool results retain explicit recorded error flags in paging
  and branch-follow views. Failed results show a recorded-error label with the
  original tool ID and output; no live status or retry action is inferred.
  Existing transcript and follow defaults are unchanged.

- Installed-app `lazysh://theme?data=…` links and selectable theme-link export.
  Incoming links remain pending through resume locks and require explicit review
  and apply or discard; manual import drafts and existing theme defaults are kept.
  Desktop launches now share one app instance. QR scanning remains unavailable.

- Advanced chords, compiled modified Simple shortcuts and multiplexer prefix
  shortcuts dispatch as one bounded native queue item with 50 ms between steps.
  The first step is immediate, literal text stays one write, and later input
  cannot interleave. Unsent steps retain their original access lease and are
  discarded on revocation or disconnect; ET also discards timed remainders and
  queued chords after observed connection loss. The interval is a lazysh choice,
  not a verified reference client timing value. Prefix settings now reject comma-separated
  multi-step and `text:` literal bindings because a prefix must be one key.
  No gesture defaults change.

- Grok ACP record cards now preserve explicit recorded tool statuses and tool-ID
  linkage, including status-only updates previously omitted. Missing/unknown
  statuses remain unassigned and original output stays intact. These historical
  labels do not imply live working state, pending approval or new controls.

- Opt-in following for an explicitly opened Claude conversation branch: bounded
  refreshes run two seconds after completion, replace abandoned branches, pause
  on hidden pages and stop on errors/source/session/access changes. Following
  defaults off; record/export views remain manual. Scrolling up preserves reader
  position until Jump to latest. No new agent, provider or prompt is launched.

- Opt-in native biometric resume protection for supported Android, iOS and macOS
  devices, with native privacy covers, generation-bound command/result access,
  paused terminal delivery and cancellation of pending protected work. Windows
  and Linux report this option unavailable. Physical biometric acceptance remains
  a release gate; existing per-host credential protection stays independent.
  Device-local durable intent preserves the lock on cold launch when its protected
  proof is missing; cancelled enrollment restores off only after confirmed cleanup.

- Four opt-in touch actions for next/previous Zellij tabs and panes. They use
  the existing named-session command interface for terminals attached through
  lazysh; plain, local and other multiplexer terminals are rejected. Existing
  gesture defaults remain unchanged. No session switching or timed key input.

- Simple custom-text builders in custom gesture and D-pad bindings, using the
  existing bounded shortcut compiler. Each editor keeps its own unsaved drafts
  and errors. Advanced remains the default; existing bindings are unchanged.
  Gesture/D-pad chord edits now require their explicit Save button instead of
  saving Advanced text on blur. Building and saving never send terminal input.

- Default-off combined Whisper/Parakeet native acceptance tasks, with fixed
  public speech inputs and separate processes for both initialization orders.
  Linux archive-specific symbol isolation prevents private ORT protobuf symbols
  from overriding Mosh's system protobuf library; no client engine is enabled.

- macOS Parakeet model-storage admission checks actual Darwin ACLs and trusted
  descriptor ancestry, with native filesystem regression fixtures. iOS and Windows
  preparation remain disabled; real recognition and platform acceptance stay open.

- Optional Simple custom-text shortcut builder with Control/Option/Shift,
  first-character modifiers, comma-separated groups and escaped commas. Advanced
  remains the default; existing shortcut records are unchanged. Unicode literal
  text and leading/trailing spaces survive save/reload. Modified text remains
  bounded to printable ASCII and eight steps; unsupported input reports errors.

- Opt-in Linux Parakeet inference acceptance with a licensed public speech
  fixture, repeat-recognizer and model-file cleanup checks, and reported timing
  and process peak memory. No client engine, automatic download or changed voice
  default; device and platform acceptance remain pending.

- Standalone Parakeet CPU runtime foundation with pinned native sources, sealed
  model archive validation and native exception/ownership tests. It adds no
  dictation UI or automatic model download; broader model and device validation
  remain pending, and iOS/Windows model loading fails closed pending native
  ACL validation.

- Custom theme bold-color policies: unchanged colors, bright ANSI colors, or a
  hexadecimal default bold foreground, with import/export and settings sync.
  Reviewed v1 themes without `bold` now keep normal colors instead of implicit
  brightening; bundled themes and existing unreviewed palettes retain their
  bright-bold defaults. The adapter preserves inverse, selection and faint text;
  vendor mobile pixel behavior remains unverified.

- Reviewed whole-app custom themes with bounded JSON/share-code import and export,
  light/dark metadata, contrast-safe app chrome, and settings sync validation.
  Existing bundled choices and terminal-only palettes keep their behavior until
  explicitly changed; QR scanning and OS theme links remain unavailable.

- Remembered list or cards layout for the active-session switcher. Existing
  installations retain the list default; switching layout never reconnects sessions.

- Explicit-file `antigravity-jsonl` step-record snapshots with append-safe
  checkpoints and restart on changed snapshot bytes, literal source/type/status,
  recorded thinking and compact truncation flags. No automatic discovery,
  conversation reconstruction or live compatibility claim; existing defaults
  and other adapters' cursors are unchanged.

- iOS app integration for the verified-SSH Mosh handoff, with original dependency
  privacy manifests embedded in separate resource bundles. Auto transport
  selection now considers Mosh on iOS, where it previously skipped it; host-key
  verification and explicit fallback rules remain unchanged.
- Explicit-file `grok-acp` transcript records, based on a pinned official Grok
  writer contract. Chunks, tool updates and plans remain separate records;
  automatic discovery, active-branch replay and live Grok control are not enabled.
  Existing defaults are unchanged.
- Explicit Cloud dictation enrollment with origin-bound device tokens in the
  platform vault, authenticated service capabilities/language hints and quota
  totals, bounded in-memory WAV uploads, and exact-recording cancellation.
  Local Whisper and editable review remain the defaults; no automatic cloud
  fallback, provider credentials in clients, deployment, or upload on enrollment.
- Optional Unix-host transcription relay with administrator-issued device tokens,
  revocation, durable audio quotas and cancellable bounded WAV uploads to a fixed
  OpenAI transcription endpoint. No deployment, client enrollment or audio-upload
  default changes.
- Optional direct delivery of completed dictation to the current terminal, with
  a separate Auto-send Enter option, bounded input and stale-session cancellation.
  Both options start off and reset when Voice closes; editable review remains the
  default, history reuse stays draft-only, and failed writes are never retried.

- Optional device-local dictation history with explicit Remember consent,
  seven-day availability, 20-entry/256 KiB bounds, editable reuse and Delete/Clear.
  History remains temporary by default; saved text is not encrypted by lazysh,
  and expired entries are pruned on use rather than while the app is closed.

- Explicit downloads of four pinned Whisper tiny/base models, with bounded
  streaming, cancellation and SHA-256 verification before local publication.
  No automatic download, audio upload or prompt-submission default changes.
- Rust/Tauri SSH and local PTY/ConPTY workspace in the Bun/Turborepo monorepo,
  including host-key verification, session controls and bounded terminal traffic.
- Optional agent companion, supported transcript readers, approval handling,
  multiplexer navigation, file/Git tools, previews and editable dictation.
- Native credential storage, explicit encrypted sync, sharing and platform
  integration foundations, each with its documented opt-in behavior and limits.
- Discovery of existing Devin ATIF exports through absolute `XDG_DATA_HOME`, with
  the standard home fallback. No Devin process or exporter is launched.

### Changed

- Companion event storage uses WAL with explicit FULL synchronization, reducing
  rollback-journal sync work while preserving event acknowledgements and the
  three-second ingest wait budget. Existing databases migrate on successful open.
  Bootstrap has one shared three-second native/SQLite wait deadline. Unix state
  ancestors and sidecars now fail closed when unsafe; unsupported/network/FUSE
  storage, parent-traversal paths and custom symlink/reparse routes are rejected
  before mutation. Verified Darwin system aliases remain supported.
  Slow-storage exhaustion remains possible and issue #36 is not declared fixed.

- Paper and explicitly light imported terminal themes now darken bright indexed
  cube colors and reverse the indexed grayscale ramp using the pinned reference client
  desktop 0.5.28 palette math. This changes their default 256-color rendering;
  base ANSI colors, literal RGB, dark themes and legacy palettes without mode
  metadata keep their behavior. Browser rendering is verified; physical mobile
  WebView and current reference client mobile pixel parity remain unverified.

### Fixed

- Saving an Advanced `text:` shortcut now preserves trailing spaces instead of
  trimming the literal payload.

- Linux Parakeet runtime startup now matches each pinned static ONNX Runtime
  artifact's libstdc++ ABI. A real no-model ORT/regex regression catches the
  invalid-free abort found by public-speech acceptance before model loading.

- Retain bounded syscall excerpts from the actual concurrent companion hook test
  in Linux CI, without changing storage durability or its wait budget.
- Bound native iOS CI startup and test execution, and retain raw Mosh diagnostics
  before hosted app checks, while preserving failure gates and no-retry behavior.
- Mobile workspace navigation reserves the full top safe area, keeping the
  Hosts menu below the iOS status bar and its controls inside the toolbar.
- Phone dialog inputs use readable text sizing to avoid WebKit focus zoom
  cropping the host form, while preserving user-controlled pinch zoom.
- Opening another companion event store no longer closes a separate database
  file descriptor that could release an existing SQLite writer's POSIX lock.
- Concurrent companion event writes preserve durable storage within bounded
  lock waits and report numeric SQLite diagnostics without database contents.

Existing defaults remain local-first: credentials stay in memory unless explicitly
saved, cloud/external services require configuration, and dictation does not send
prompts automatically. See the linked feature documentation for exact limits.
