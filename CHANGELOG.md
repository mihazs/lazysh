# Changelog

## [Unreleased]

- Add explicit named tmux server selection throughout discovery, attachment, controls, Jump To and saved workspace restoration. Commands now explicitly select `-L default` when no named server is chosen; an inherited `TMUX` environment variable no longer redirects legacy/default operations to another server. Client invocations now force UTF-8 (`-u`) so discovery framing and Unicode metadata are independent of the remote locale.

- Add an optional, default-off agent-board display keep-awake control backed by native display-idle ownership. Leaving the board, loss of foreground, app lock and renderer replacement release ownership. Linux now uses bounded asynchronous XDG portal acknowledgements, with exact cancellation, private-connection cleanup and visible owner-loss reporting. Acknowledgement does not establish physical idle-timeout or battery behavior; hardware validation remains pending.

This is a development preview, not a stable release or a claim of complete Moshi
parity. Remaining capability and platform gates are tracked in issue #1.

### Fixed

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
  not a verified Moshi timing value. Prefix settings now reject comma-separated
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
  cube colors and reverse the indexed grayscale ramp using the pinned Moshi
  desktop 0.5.28 palette math. This changes their default 256-color rendering;
  base ANSI colors, literal RGB, dark themes and legacy palettes without mode
  metadata keep their behavior. Browser rendering is verified; physical mobile
  WebView and current Moshi mobile pixel parity remain unverified.

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
