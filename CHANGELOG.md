# Changelog

## [Unreleased]

This is a development preview, not a stable release or a claim of complete Moshi
parity. Remaining capability and platform gates are tracked in issue #1.

### Added

- Simple custom-text builders in custom gesture and D-pad bindings, using the
  existing bounded shortcut compiler. Each editor keeps its own unsaved drafts
  and errors. Advanced remains the default; existing bindings are unchanged.
  Gesture/D-pad chord edits now require their explicit Save button instead of
  saving Advanced text on blur. Building and saving never send terminal input.

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
  remain pending, and Apple/Windows model loading fails closed pending native
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
