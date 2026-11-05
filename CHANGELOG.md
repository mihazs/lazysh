# Changelog

## [Unreleased]

- Show Workspace tools as swipeable pages instead of collapsed sections. Session views, More tools, Connections and Application options are each one page: swipe sideways, tap a page dot or the Previous and Next arrows, drag with a mouse, or use the arrow, Home and End keys on the page dots. Screen readers hear a labelled carousel with the page name and position. The sheet reopens on the page last used in that session. Changed default: Workspace tools no longer opens with collapsed More tools, Connections and Application options sections; it opens on Session views, and every action stays one swipe or tap away. End connection stays below the pages.

- Include the changes of prepared versions that were never published (for example after a failed or superseded release run) in the next GitHub release notes, under "Also included from X.Y.Z". Previously those changes were missing from every published release's notes.

- Redesign the app chrome to be subtle and borderless. Buttons, inputs, selects, text areas, toolbar keys and toolbar editor chips drop their outlines for tonal fills, selected items use a soft accent fill instead of an accent outline, the current terminal session in the session switcher and live sessions list also keeps a 3:1 accent bar, and every control keeps a clear 2px keyboard focus ring. The terminal toolbar, the floating terminal selection actions and desktop dialogs, including Preferences, join the header, sheets and tab bar as translucent, blurred glass with a soft top highlight; reading surfaces, cards and full-screen phone pages stay opaque. Glass never drops below the opacity at which every theme colour keeps 4.5:1 text contrast over any background, and every glass surface turns opaque with reduced transparency, increased contrast or forced colours. Increased contrast also restores visible control borders. The user's terminal theme colours are unchanged. Changed defaults: the default lazysh app theme's accent is now a restrained periwinkle (`#b4bdf8`) instead of cyan (`#77f3ec`), which also changes the default primary button, links, focus ring, crop outline and the Android dark-mode native accent; the green Language settings icon replaces the teal one; card and fieldset edges are now faint hairlines; the phone Workspace tools sheet is slightly more opaque (83% instead of 78%) to keep that contrast. Imported themes keep their own accent. The lazysh logo artwork is unchanged.

- Fix intermittent companion release and CI failures where sixteen-writer storage contention cases returned `StorageError` with SQLite code 5 (`ingest_begin`) on Windows. The cases ran at the same time as other companion runs in one test process, and their durable flushes slowed each other until a burst of sixteen serialized commits no longer fit the three-second wait budget. Each burst now runs alone, and a new Linux check replays the whole CLI suite beside a simulated slow shared volume. Companion storage, FULL durability and the 3-second wait budget are unchanged. No defaults change.

- Declutter the Herdr Spaces tree on the Workspaces screen. Each space is a compact card with one status summary and its tab count; tabs and panes sit one indentation step in, without guide lines. A tab shows its status only when it differs from its space, and a pane only when it differs from its tab; screen readers still hear every status. Long labels and paths stay on one line and end with an ellipsis, with the full text in the tooltip, and pane paths shorten the login user's home to `~` (another user's home shows as `~name`); search matches the shortened path as well as the full one. Disclosure chevrons now sit on the right and appear only on spaces and on tabs with more than one pane; a collapsed tab shows its pane count. **New worktree from this workspace** moved from an icon on every space into the space's **More actions** menu, which a long press on the space also opens; Escape or Android back closes only that menu, also in the phone sidebar. Search, server, focus note, refresh, **New workspace** and the tree share the same edges and spacing, and the host caption stays on one line. In the narrowest sidebars a space's status shows only its dot, so the name keeps its room. Every navigation target is unchanged. No defaults change.

- Fix the phone Preferences page sliding up after adding a toolbar key from Available keys, which pushed its title and Close button off the top of the screen where they could not be scrolled back. Hidden screen-reader labels in the page now stay inside its scrolling body, so moving focus to the next available key scrolls only the settings list. No defaults change.

- Show an ongoing Android notification while terminal sessions keep running: it reads **lazysh is running** with the number of active sessions, updates as sessions open and close, and disappears after the last one ends. Tapping it returns to the open workspace. It uses the existing low-importance **Terminal connections** channel, so it makes no sound. On Android 13 and later, lazysh asks for notification permission once, when the first session starts; declining keeps sessions running in the background without the notification. Works in the Google and F-Droid builds. Changed default: the notification now appears immediately instead of after Android's ten-second delay, and its text names the session count instead of "Terminal connections are active".

- Split the terminal toolbar into pages you slide between. The **Tools** page holds the configured key rows with Find and Copy; the **Snippets** page holds saved snippets and chords. Slide sideways (or use a trackpad's sideways scroll) to change page, or tap the page indicators below the keys; with the default single key row, a slide first scrolls the keys and turns the page once the last key shows. The indicators are one tab stop that the arrow keys, Home and End move between. A page shows at most about a quarter of the window height (three rows on a phone without the keyboard, usually two above a docked keyboard) and scrolls the rest; keep swiping or scrolling the wheel past the last row to open the next page, and past the first row to go back. Both pages share the height of the key rows, so changing page never resizes the terminal, and each device remembers the last page. Keys keep hold-to-repeat and long-press actions (a drag after a held key repeats or runs its long-press action never turns the page), modifiers and the D-pad, and choosing a page leaves the keyboard as it was. Changed default: snippets and chords no longer follow the keys on the last toolbar row; they open on their own page. Toolbars without snippets or chords stay a single page with no indicators.

- Show files attached from the terminal composer as inline tokens in the draft, as agent CLIs do. Attach in the composer opens the attachment tool; after the upload, **Add to the terminal draft** returns to the composer and inserts `[Image #1]` for an image or `[File #2]` for another file at the caret, numbered per draft. Each token is highlighted in the editor and listed as a chip above it: tapping a chip (or the token) previews the image with its uploaded path, and its remove button deletes the token. Tokens are atomic: Backspace, Delete or a selection that touches part of a token removes the whole token and releases its attachment, and the caret never lands inside one. Send replaces each token with the shell-quoted path the upload returned, in draft order, then pastes as before. An IME composition that deletes part of a token (as Android keyboards do when Backspace recomposes the previous word) also removes the whole token once it commits. Token text you type yourself, such as a `[Image #1]` copied from an agent CLI, is never taken for an upload: new tokens take the next unused number. A deleted token's attachment stays known until the draft is sent, so restoring its exact text brings the chip back. The composer refuses an upload path that direct paste would refuse (relative, `..`, control characters, over 4096 bytes) with the same error, and adds no token. Ctrl+Enter, Send Enter and the kept draft are unchanged; screen readers hear each chip's label and an announcement when one is added or removed, and on phone widths the chips wrap instead of clipping. Uploads started from the toolbar still offer **Paste uploaded path**. No defaults change.

- Find a safely admitted default Herdr installation under the remote user’s `.local/bin` when it is absent from the command PATH of a positively identified x86_64 or arm64 Linux or macOS host; PATH remains preferred. Other architectures, hosts without `/usr/bin/uname`, `/usr/bin/id` and `/usr/bin/stat`, and homes below a symlinked directory keep PATH-only lookup. Changed default: the Herdr lookup on those hosts now includes this fallback.

- Keep the software keyboard connected when arming the terminal toolbar's ctrl, Alt or Shift key. The terminal editor no longer blurs or becomes read-only for the tap, so SwiftKey, Gboard and other keyboards keep their Shift and suggestion state instead of restarting. Pending composition is still sent first, and the editor is still revoked when it is not focused. No defaults change.

- Keep finger scrolling responsive after a pause in history while the on-screen
  keyboard (SwiftKey, Gboard) holds a word in composition. A drag whose first
  movement was short or sideways was dropped entirely, so a full-screen agent
  with mouse reporting (Claude Code fullscreen, Herdr, tmux mouse mode, Mosh)
  received no scroll and only its Jump to bottom control moved the view. A
  toolbar key that sends the composed word no longer leaves the terminal
  treating later drags and long-presses as part of that composition. No
  defaults change.

- Fix toolbar keys leaving the terminal scrolled into history. Toolbar keys, chord buttons, custom gesture and D-pad corner chords, the D-pad and modified keyboard shortcuts now return the terminal to the live screen after sending, as keyboard typing already did. A reader left looking at an earlier copy of an agent menu, for example after the agent redrew it, now sees the agent's answer after toolbar Enter instead of an unchanged menu. The bytes sent are unchanged. No defaults change.

- Open reported agent activity in a focused mobile detail view with contextual Back and restored list position.

- Add **New workspace** and **New worktree from this workspace** to Herdr Spaces. New workspace takes a label and an absolute directory, typed, chosen from known directories or browsed on the host. New worktree reads the workspace directory's Git repository and suggests a branch, the current HEAD as base and a sibling `<repo>-worktrees/<branch>` path (or the parent shared by existing linked worktrees); all three stay editable. Both dialogs ask whether to start an agent; the default is not to. Choosing yes requires an agent CLI that `command -v` finds on the host, and Codex and Claude Code accept an optional single-line initial prompt. Before anything runs, the dialog shows every exact command (`command -v`, `git -C … worktree add -b … -- …`, `herdr workspace create`, `herdr agent start`). Each command runs under `sh` with exactly the shown arguments, whether the host's login shell is POSIX (sh, dash, bash, zsh, ksh) or fish, so quotes, `;` and `$(…)` in labels, paths, branches, prompts or host directory names are never run as shell syntax. The agent starts only in the new workspace's first pane through Herdr's own `agent start`; existing panes never receive input. A missing agent CLI fails before any worktree or workspace exists. If a later step fails, the dialog says what was already created and removes nothing. Branch names follow Git's ref rules; labels, paths and prompts reject line breaks and backslashes. No defaults change.

- Fix Android biometric-protected credentials failing to save or unlock after a successful fingerprint: the Keystore operation received its associated data before authentication and refused the request. Enabling the biometric resume lock no longer stalls on its second fingerprint prompt, a late prompt result can no longer be applied to a different credential operation, and a prompt that cannot start because the previous one is still closing now fails with a retryable error instead of showing a prompt whose result is lost. No defaults change.

- Add multiplexer-aware terminal gestures. In a terminal attached to tmux, Herdr or Zellij, a two-finger pinch zooms the active pane (tmux `resize-pane -Z` through the prefix, Herdr's zoom key, Zellij `toggle-fullscreen`), and **Pinch in tmux, Herdr or Zellij** can instead resize text, run another action or do nothing; plain terminals keep pinch-to-resize text. Zoom is a toggle in all three, so pinching in or out zooms an unzoomed pane and restores a zoomed one. Pull the session header down to run a **Short header pull** (56 px) or **Long header pull** (144 px) action; a label names the action before release, and pulling back cancels it. New gesture actions move to the next or previous multiplexer tab (tmux window) or pane and zoom the pane; tmux and Herdr use the prefix saved in their shortcut panel. Each toolbar key except the modifiers can have a **Long-press** action, set when you select the key in **Toolbar keys and order**: holding the key for half a second (or right-clicking it) runs that action once, while keys without one keep hold-to-repeat. Like toolbar keys, long-press actions and touch gestures that send keys or a multiplexer prefix now return the terminal to the live screen. With both header pulls set to **No action**, lazysh leaves header touches alone. Changed defaults: two-finger swipes, the multiplexer pinch and both header pulls now default to **Level-aware default** instead of no action. In tmux, Herdr and Zellij, two-finger left and right change tabs, up and down change panes, a pinch zooms the pane and a short pull opens the next tab; in a plain terminal, two-finger left and right change lazysh sessions. A long pull opens the next lazysh session. Earlier saved two-finger choices, including **No action**, are kept, and existing pinch-to-resize settings now apply only outside multiplexers. Settings sync accepts the new toolbar long-press field; older clients reject settings imports that contain long-press actions, and snapshots without any still import there.

- Fix companion hook events failing on Windows with `StorageError: operation failed (sqlite_code=5)` when many agent hooks open the companion store at once, including the first run that creates it. Opening a store that is already set up no longer waits behind other openers or their durable commits; only creating or upgrading the store is exclusive. WAL mode, full commit durability, private sidecar checks and the 3-second wait budget are unchanged. No defaults change.

- Keep an opened Chat transcript reader when switching to the terminal or another session view and back: its messages, reading position and unsent draft stay as they were instead of resetting to an empty reader. Following pauses while the reader is out of view, a confirmed terminal destination is still released on leaving, and a reader opened from reported agent history still retires when left.

- Add terminal text selection for copying, including selections longer than the screen. On touch screens, hold a finger still on a word and lift to select it. Then drag the start and end handles across rows; holding a handle past the top or bottom edge scrolls local history, faster the further past the edge. With a mouse, xterm's drag selection keeps scrolling past the edges; when the remote app uses mouse reporting, hold Shift to select locally. A floating bar offers Copy, Select all and Copy screen. Copy keeps the raw buffer rows, line breaks included, and the selection stays put through finger scrolling and streaming output. Moving the finger before lifting still scrolls. Remote clipboard writes (OSC 52), including ones forwarded through tmux or screen passthrough, still need explicit consent.

- Redesign the terminal composer as a sheet that replaces the visible terminal output while it is open: a large multi-line editor with character and line counts, a primary **Send** action, **Clear draft**, **Close composer** and Attach. Send pastes the draft exactly as before (bracketed paste when the remote program enables it) and then sends one separate Enter, so a multi-line draft is submitted once. Changed default: the composer's primary action now submits the draft; turn off **Preferences → Keyboard and gestures → Send Enter after pasting the draft** to restore the previous paste-only **Paste draft** action. Send is disabled for empty or whitespace-only drafts. Ctrl+Enter (⌘+Enter on Apple devices) sends from the editor, Enter inserts a newline, and Esc or Close returns to the terminal with the draft kept. The terminal session and its size stay unchanged underneath: opening the composer, showing the keyboard or hiding the key row never resizes the PTY. On touch layouts the sheet sits directly above the on-screen keyboard and the key row returns when the composer closes. Settings sync accepts the new preference.

- Arrange terminal toolbar keys by dragging in **Preferences > Keyboard and gestures > Toolbar keys and order**: drag keys to reorder them, drag from Available keys to add, and drag onto Remove or back to Available keys to remove. Touch screens start a drag with press and hold, so swiping still scrolls the page. A live preview shows the resulting toolbar. Without dragging, select a key for Earlier, Later and Move to row actions, or focus it and press Alt with an arrow key to move it or Delete to remove it; each change is announced to screen readers. The ↑/↓ buttons are replaced by these actions. Add **Toolbar rows** (1–3) so the terminal toolbar can show several horizontal lines of keys, Haven-style; keys move between rows by drag or action. Defaults are unchanged: one row and the same keys. Rows are stored in the existing `toolbar` setting with a `row-break` marker, so existing toolbars load as one row and older versions and sync peers show the same keys on one row.

- Show a live Herdr agent's lifecycle state when Herdr itself reports Unknown, as Herdr 0.9.3 does for an idle Codex prompt. When the pane's Herdr-reported session ID is unique and matches exactly one companion report from the same connection, live Agents and Spaces show Working, Needs attention or Done. Herdr's own states still take precedence, workspace and tab summaries are unchanged, and a pane without an exact match stays Unknown. No defaults change.

- Redesign pending agent approvals and the agent inbox. Each approval card shows the agent and tool, the project and how long ago it was requested, the full tool input, a live expiry countdown (Deny and Allow disable when it reaches zero), equal-width Deny/Allow buttons and a project, agent session and pane summary. The inbox groups events into foldable Needs you, Working and Done sections with counts; rows show a status ring, project, host and relative time (absolute time on hover), with icon buttons to archive or open the connected session. Changed default: when monitoring is on and events exist, the monitoring and notification controls start collapsed under Monitoring and notifications; they start open when monitoring is off or the inbox is empty. Approval and inbox data, polling and decisions are unchanged.

- Turn the Ctrl/Cmd+K host picker into a command palette that also finds open sessions, the current connection's tools (Files, Diff, Sessions, Preview, Transcript, Agents and more) and actions such as Preferences, sync, the notification inbox and About, with fuzzy, accent-insensitive matching and arrow/Enter/Esc keyboard control. Files now shows PNG, JPEG, GIF and WebP images up to 2 MiB, shows SVG only as an inert image, and renders Markdown without raw HTML, active links or remote images. Changed defaults: Ctrl/Cmd+Shift+P now opens the palette even from a focused terminal instead of reaching the shell, and Markdown files in Files open rendered, with **Show source** for the text.

- Read theme from clipboard now works on Android: Preferences → Appearance reads the clipboard through the same native path as terminal Paste instead of the WebView clipboard API, validates it like pasted input and always stops at the preview for explicit Apply. Text over 16 KiB or an invalid theme shows the validation error and keeps the current draft.

- Choose the Amber launcher icon on Android from Preferences → App icon, using lazysh's own artwork. Switching keeps the running workspace and its sessions open; the launcher may take a moment to redraw, and a remote-event notification posted before a switch still opens the workspace. Changed default: the launcher entry is now an alias of a small trampoline activity instead of `MainActivity` itself, and the icon choice stays device-local (not synced, exported or reset with preferences). Upgrade note: updating an existing install to this version changes the launcher component from `.MainActivity` to `.LauncherDefault` even if you never open App icon, so some launchers may move, re-map or drop a home-screen icon or shortcut pinned under the previous version; add it again from the app drawer if it is missing.

- Discover Cline quota credentials from the CLI-selected provider store, data directory or profile instead of always reading the home-directory default. Preserve explicit usage paths and API-key priority; missing or malformed selected stores do not fall back to another login. Follow the CLI-selected Cline account instead of ranking accounts by token expiry; validate every store entry against the pinned structural schema and bound regular-file reads. Other providers and invalid selected auth cannot replace the selected account or its quota cache. Nondefault environment-selected stores are unavailable on Windows; existing explicit auth paths and API keys remain available.

- Honor host `CODEX_HOME/auth.json` during automatic AI account discovery when no usage profile exists. Invalid nonempty paths report usage unavailable instead of selecting another account; explicit profiles, paths and disabled providers remain authoritative.

- Add an opt-in per-host **Identify lazysh to this host** option that asks the SSH server to set `LC_TERMINAL=lazysh` for new SSH terminals and tmux, Herdr and Zellij attachments, so remote shells and agents can detect the client. It is off by default and applies only when the server's `AcceptEnv` admits `LC_TERMINAL` (the common default `AcceptEnv LANG LC_*` does); Mosh and ET sessions do not send it.

- Show plan, question and turn-state cards in native Chat for Claude Code, Codex and OpenCode. Plans show each step with its recorded status. Questions list their options and point to the terminal for the answer, since Chat cannot choose options in an agent prompt. Conversation views show whether the agent is working, waiting for an answer, idle or stopped, based on recorded lifecycle records; other cases show an unknown state. Display only: the raw tool cards remain and no defaults change.

- Redesign the main surfaces so the phone UI reads like a modern agent client. Agents use a small Live agents | Activity segmented control, uppercase status sections with counts (Live sections can collapse), and rounded rows with a status ring, bold title, secondary context and coloured project/agent/recency tags; the agent inbox now uses the same status ring and collapsible section headings, and Activity recency uses the inbox's relative times and stays current while the list is open. Live and Activity search, setup and refresh share one row with the host as a caption; setup stays behind one icon unless nothing is configured, and the status filters are compact chips. Saved hosts are compact rows in one group with a letter avatar and transport tag, and the transport is part of the row's accessible description. Connections, Workspaces and Agents switch from a floating glass tab bar on phone and desktop. The welcome screen gains brand light and feature chips. Settings are grouped inset lists with icon tiles, values on the right, switches and a platform back control. Motion is limited to the segmented-control thumb, tab bar and switch transitions, the working-ring spin, a colour-only dialog fade and a short phone drawer settle, and none of it plays when reduced motion is requested; glass keeps its solid reduced-transparency and forced-colour fallbacks. Status and agent tag colours switch to light-tuned values for Paper and imported light themes. Changed default: the bundled lazysh app theme now uses a true-black canvas with brand-ink surfaces instead of the navy background; Midnight and Paper are unchanged, and the browser theme colour and native splash surfaces stay brand navy. Existing controls, accessible names and ownership checks are preserved; the visible Search label is removed and remains the search field's accessible name, and the visible “Reported details ›” row hint is removed while each report row keeps its existing accessible name.

- Show the Chat attachment editor as a focused mobile view, preserving the draft and reading position when returning.

- Compact recorded-conversation drafts into one editor with named attachment, refresh and terminal controls. Changed default: staging guidance opens on request from How staging works; explicit staging and confirmed terminal input remain intact.

- Correct Android UnifiedPush and Firebase-free notification setup guidance, including the separate relay and display consent steps.

- Add support, security and code-of-conduct policies, contributor paths and a first-contribution walkthrough. No application defaults change.

- Show reported prepaid spend-cap percentages in AI usage details and the compact usage button. Keep formatted monetary amounts and over-cap numbers intact; uncapped balances and missing percentages remain unmetered.

- Reduce workspace clutter by removing the redundant explanation beneath the session manager action.

- Import SSH private keys from a file in the SSH identities panel on desktop and Android. The file contents stay in memory, are not shown in the paste field, and files over 64 KiB are refused before reading. Imported OpenSSH, PEM and PKCS#8 keys tolerate Windows line endings and a byte-order mark. Connecting with a public key (`.pub`, `authorized_keys` entry, certificate, RFC 4716 or PEM public key) now fails before authentication with a specific error instead of a generic decode error, and an encrypted key without its passphrase reports that a passphrase is needed. Host-key pins stay in `hosts.json`; storage is unchanged.

- Keep a terminal reader in history while output streams and across resizes: a finger scroll that starts at the live bottom no longer snaps back to new output, width changes keep the same logical line after reflow, and a taller viewport (for example, closing the on-screen keyboard) no longer moves a Mosh reader or stops a Mosh session at the bottom from following output.

- Add an optional gesture to hide the keyboard when scrolling past the bottom of local terminal history. It is off by default; remote mouse scrolling, alternate screens and active text composition keep their existing behavior. Settings snapshots from this version always include the new preference, so older clients reject them until they are updated.

- Add a reference-client parity matrix for Android and desktop that records each sub-behavior as verified, implemented, partial, missing or not applicable, with test and CI evidence and the issue that owns each gap. Documentation only; no application defaults change.

- Preserve terminal Enter delivered as an input-only line break, including an explicitly selected toolbar Shift modifier.

- Preserve owned terminal corrections delivered as paired keyless composition-text input events.

- Never pause terminal typing when a keyboard edit, such as an accepted SwiftKey suggestion, cannot be translated safely into terminal input. Changed default: lazysh now skips that one edit, leaves the terminal unchanged and keeps typing, Compose paste and toolbar keys working; a small "Keyboard edit skipped" notice fades after 8 seconds unless expanded for review. Previously typing stayed paused until the review was dismissed.

- Add explicitly selected OpenCode recorded Conversation views for V1 and V2 databases, with current tool updates, revert handling and recorded token counters. Records remains the default; recorded history does not establish live agent identity or enable unconfirmed input.

- Preserve owned IME corrections across zero-code Process keys and keep subsequent hardware keypresses ordered and sent once; retain focus, access and unsupported-edit protections.

- Keep owned ASCII forward deletions without key229 synchronized with later terminal suggestions and typing; preserve composition fallback and review for edits outside the locally owned input.

- Preserve the visible scrollback line during height-only terminal resizing, including keyboard-sized viewport changes; keep bottom-following and the separate Mosh rendering path.

- Simplify workspace navigation with focused Workspaces and Agents screens, compact session context and clearer work-state rows. Changed default: desktop tools now open from Workspace tools instead of a permanent tab strip; all existing tools remain reachable. Preserve the compact phone terminal, existing sessions and contextual return.

- Keep owned Android IME fallback edits from repeating earlier text or dropping ASCII deletions, while preserving cancellation and explicit review for unsupported edits.

- Keep Mosh repaint geometry synchronized with complete server frames during keyboard, composer and viewport resizes, avoiding duplicated screen rows in scrollback. Existing history cells retain their original width and can be clipped in narrower views until widened.

- Increase custom-theme glass opacity only when its selected chrome colors need more backing for readable text; bundled theme glass and solid accessibility fallbacks remain unchanged.

- Keep Compose and the expanded D-pad mutually exclusive so the draft stays editable above a mobile keyboard; switching tools preserves the unsent draft.

- Compact the terminal draft editor, prioritize uploaded attachment paths and explicit use, and guide push setup through relay enrollment. Agents opens Live by default; recorded Activity and setup stay available separately, with pending approvals reachable in both views. Connected sessions, drafts, upload protections and notification consent remain intact.

- Keep recorded Conversation messages readable in constrained workspaces instead of letting the reading region collapse behind its controls.

- Add an explicit recorded Codex Conversation view with turn rollback, canonical item updates and protected fork/revert prefixes; Records remains the default and recorded history does not grant live-agent or approval authority.

- Prevent the browser touch default on owned expanded D-pad direction gestures; ordinary clicks, corner shortcuts and accessibility controls remain available.
- Change toolbar Shift to one-shot: it clears after the next completed key, while a held arrow or D-pad gesture keeps its initial Shift for that hold. Tapping Shift again turns it off without sending pending IME text. Explicit Control and Alt locks are unchanged.

- Start mobile Workspaces with compact selected-session context and a session count; expand all connected app sessions on request. Desktop keeps the expanded session list.


- Preserve fractional scroll distance between short finger drags in the same active terminal, making small gestures responsive without amplifying repeated movement; navigation, cancellation and connection changes retire pending travel.

- Allow vertical finger scrolling after selecting terminal text, using xterm’s normal wheel selection behavior; horizontal gestures, taps and accessibility safeguards remain unchanged.
- Keep unavailable Home Screen icon settings compact without hiding errors or explicit refresh recovery.
- Keep sidebar mode labels whole and reachable across narrow layouts, translations and enlarged text.

- Preserve slow sub-row finger movement in terminal scrollback instead of losing travel between xterm redraws.

- Expanded terminal D-pad controls now suppress their browser context menu by default.

- Run each Google/FOSS ntfy acceptance branch as a complete emulator-runner shell command, preserving the existing native checks and deadlines.

- Keep browser acceptance aligned with dedicated Preferences screens and compare attachment file-picker styling in a settled normal state; application behavior and defaults are unchanged.

- Persist the selected Android push provider before explicit registration or cleanup so late previous-provider token callbacks cannot change it after restart. Status inspection remains read-only, and failed persistence prevents the control action.

- Add Firebase-free UnifiedPush setup to Google Android builds alongside explicit FCM. New/off Google installations select UnifiedPush without registering; existing active FCM registrations remain selected. Provider changes require paused/revoked registration. Add opt-in Gotify relay delivery to the separate Gotify client; encrypted lazysh event display remains behind its original private enrollment and consent gates.

- Keep vertically dominant finger drags responsive and preserve complete coalesced scroll motion before finger lift.

- Replace mobile Preferences disclosures with category navigation and contextual Back; simplify workspace and agent controls, refine theme-derived glass navigation chrome, and honor reduced motion for short navigation transitions. Settings values, credentials and transport defaults are unchanged.

- Keep Android autocomplete corrections editable when the keyboard leaves the caret inside an owned composing range.

- Preserve physical and toolbar Shift+Enter as a distinct modified Enter key for agent newline bindings, instead of submitting an ordinary Enter. Plain Enter and other modifier combinations retain their existing behavior.

- Add held-pointer panning to the expanded terminal D-pad, with paced arrow repeats, a pause zone and cancellation when input ownership or session availability changes. Existing arrow taps, keyboard activation, corner shortcuts and toolbar defaults remain unchanged.

- Organize documentation by learning, tasks, reference and explanation; add a guided first SSH session and separate companion setup, settings and event-storage contracts. Preserve established links, security limits and platform acceptance boundaries. No application defaults change.

- Prioritize connected app sessions above discovered Herdr spaces and refine compact themed navigation. Healthy Herdr server setup in Workspaces is now collapsed by default. Missing selections and unhealthy readers still reveal setup automatically. Keep shared-focus warnings visible and preserve session identity, reader drafts, contextual return, authentication and transport defaults.

- Keep delayed terminal, composer and search focus inside their pane from taking focus away from an open credential or other modal dialog. Preserve terminal protocol replies, sessions and explicit input after dismissal; no authentication or transport defaults change.

- Add explicit V3 discovery and inspected managed Amp system-plugin setup with absolute companion binding. Setup tries V3 metadata with one bounded V2 compatibility fallback; V1/V2 provider mappings stay unchanged. Same-name foreign plugins block installation while fresh exact-owned removal remains available; settings, trust and live reporting are not enabled or verified.

- Add an owned Android manual Mosh attachment checkpoint for a large valid protected-clipboard PNG and exclusive creation against a pre-existing destination. Closed-control recovery and physical-device/file-picker/camera acceptance remain unverified; no upload defaults change.

- Add explicit version-2 hook discovery and inspected managed Copilot setup for selected existing Linux profiles, with shell-free absolute companion handlers and protected file ownership. Default version-1 discovery keeps its seven managed providers and Copilot manual; settings, disabled hooks, trust and live reporting remain unchanged.

- Keep touch scrolling continuous when terminal output redraws under a held finger on coarse-pointer screens. Preserve screen-reader mode and desktop hit testing; no input, connection or permission defaults change.

- Make touch scrolling in mouse-tracking terminals depend on finger travel rather than touch-event frequency. Accumulate partial movement, keep the original pane and clear pending distance when the gesture ends.
- Keep the terminal canvas anchored when the keyboard resizes the available space and the browser reveals its input. Terminal history continues to scroll inside xterm's viewport.

- Stop the updated Amp plugin from reporting completion for an initially idle thread or treating error-to-idle as recovery. It reports idle only after observing that thread running. Replace previously copied manual Amp plugin files to receive the fix; existing historical reports, legacy ingestion and trust defaults remain unchanged.

- Complete independently identified Copilot child reports while preserving the parent's state and ignoring ambiguous child completion callbacks. No installation, permission or input defaults change.

- Document Linux Copilot CLI 1.0.105 manual-hook completion and unanswered elicitation attention qualification, with explicit runtime limits (#704).

- Give mobile Agents and Workspaces full-width working views, compact Herdr navigation actions and selectable reported-activity rows with focused details. Reduce repeated navigation chrome while preserving terminal space, session state, setup disclosure and explicit live/reported distinctions. Label recorded attention neutrally instead of implying a valid pending request, and visibly return focus to the selected row when closing its details. No connection, permission or input defaults change.

- Discover separate current Kimi Code and legacy Kimi CLI profile candidates without executing agents or reading configuration. Preserve literal overrides, manual-only setup and legacy hook output; clarify the printer targets Kimi CLI 1.52 and current lifecycle remains unqualified. No setup or trust defaults change.

- Correct packaged agent-reporting guidance for read-only discovery and explicit managed Cline setup. Preserve plugin restrictions and separate installation from loaded reporting; no installation or trust defaults change.

- Add optional Herdr reported-session details for bounded Codex, Claude Code and OpenCode IDs, with same-connection companion report matches, stale-reference labels and selected-server shared-reference counts. These read-only details do not establish pane ownership or enable Chat.

- Document Obtainium as the preferred Android installation/update method, with explicit APK flavor filters, signature-channel caveats and manual SHA256 verification. No application default changes.

- Correct README download availability and link to the public roadmap and installation guidance.

- Add direct Live agents and Activity jump controls at the top of the Agents drawer. Move focus and only the drawer scroll position while preserving mounted readers, drafts, approvals and Back behavior; no agent data or connection settings change.
- Add explicit managed Cline root lifecycle plugin setup for a selected existing profile, with protected absolute companion binding, inspected install/remove plans and profile discovery. Existing plugin restrictions and settings are preserved; a new Cline session must load the profile, and setup does not verify live reporting.

- Detect installed host agents and known profile locations when opening Agent hook setup, with no provider preselected. Select a detected target or enter a manual profile before inspecting and installing hooks; discovery does not install hooks, create profiles or change trust settings. Executable discovery and live activity remain separate.

- Shorten the default Workspace tools sheet to six frequent session actions, with explicit More tools, Connections and Application options disclosures. Keep End session distinct, all actions and capability checks available, and touch targets at least 44 pixels; no connection or permission defaults change.

- Explain the selected-profile startup and verification steps for configured Codex, Claude Code and OpenCode hooks. Provider trust, disabled hooks, server startup and live reporting remain under user control; setup still does not verify event delivery.
- Restore the mobile Agents drawer scroll offset once when returning from a tool to the same session and mode. Discard stale offsets after source, mode, server, access or layout changes; focus, navigation history, provider readers and connection defaults are unchanged.

- Collapse the Herdr server chooser for every healthy selected server, including hosts with multiple servers. Missing selections and unhealthy readers still expose setup automatically; alternate servers remain available on demand.

- Add contextual Back and Return to terminal for workspace tools and AI usage, retaining the opening live session and terminal draft. Keep mobile tools in compact navigation and let Android Back close the current local surface first; connection and transport defaults are unchanged.


- Distinguish a full terminal input queue from a closed input channel, and record content-free write-caller and ownership diagnostics for investigating Android session navigation failures. Input delivery, queue capacity and error visibility are unchanged.
- Open Preferences at the top with collapsed categories for appearance, language, terminal behavior, keyboard controls, security and connection settings. Preserve mounted drafts, async operations and safety text; opening settings no longer focuses Font size or requests text input. Saved settings and permission defaults are unchanged.

- Prioritize Connect when opening a saved host: connection options now start collapsed with the effective transport shown. Focus required credentials when needed or Connect when saved credentials are available, without stealing focus from a manual entry. Advanced Mosh/ET settings, saved defaults and validation remain available.
- Keep the native branded startup cover until the current renderer acknowledges its first workspace commit when app lock is disabled, including after renderer recreation. Confirmed locks retain their native unlock controls.

- Offer Agent hook setup directly from empty Activity, opening the existing inspected setup workflow for the selected host. Hook installation and provider trust remain explicit; an empty list does not establish whether live reporting is configured.

- Refine theme-aware frosted navigation and short action sheets, keeping long forms and terminal output opaque and preserving reduced-transparency and forced-color fallbacks. No theme defaults change.

- Prioritize live agents and reported activity over optional configuration. Healthy Agents setup and single-server Herdr selection now start collapsed; explicit setup preserves mounted drafts and operations, while companion repair and pending approvals remain visible. Connection, permission and collection defaults are unchanged.

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
