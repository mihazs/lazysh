# Changelog

## [Unreleased]

This is a development preview, not a stable release or a claim of complete Moshi
parity. Remaining capability and platform gates are tracked in issue #1.

### Added

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

### Fixed

- Opening another companion event store no longer closes a separate database
  file descriptor that could release an existing SQLite writer's POSIX lock.
- Concurrent companion event writes preserve durable storage within bounded
  lock waits and report numeric SQLite diagnostics without database contents.

Existing defaults remain local-first: credentials stay in memory unless explicitly
saved, cloud/external services require configuration, and dictation does not send
prompts automatically. See the linked feature documentation for exact limits.
