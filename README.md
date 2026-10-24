# lazysh

A direct SSH terminal and agent workspace for Android, iOS, macOS, Linux, and Windows, built with Tauri 2, Rust, React, and xterm.js.

Implementation is in progress. Moshi parity is a release objective, not a claim about this initial repository. Track delivery in the [Project](https://github.com/users/mihazs/projects/2), [parity epic](https://github.com/mihazs/lazysh/issues/1), and [feature evidence](docs/moshi-evidence.md).

The first implementation includes password/private-key SSH, explicit server fingerprint verification, concurrent terminal tabs, bounded output with backpressure, SFTP browsing/text reads/new-file uploads, staged/unstaged Git diffs, independent tmux attachments, and an optional [local agent-event companion](docs/companion.md). Credentials are prompted per connection and stay in memory.

Mosh/ET, complete multiplexer controls, vault/biometrics, native agent chat/approvals, voice, previews, notifications, sync and Apple extensions remain open issues. Mobile source compatibility does not establish a tested native release.

## Development

Requires Bun, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```sh
bun install --frozen-lockfile
bun run tauri dev
```

The browser development server is a UI preview; direct SSH requires the native Tauri application.

## Checks

```sh
bun run build
bun run test
bunx playwright install chromium
bun run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
python3 -m unittest discover -s companion -v
```

The Rust suite includes a separately enabled OpenSSH/SFTP interoperability test; see its test documentation. Browser tests check responsive UI and keyboard behavior, not native SSH. Platform/toolchain and release results are recorded in the implementation PR.

## Connection safety

Compare the full SHA-256 fingerprint shown on first connect with a trusted copy from the server. lazysh verifies pinned keys before sending authentication material and refuses changed keys. Passwords and private keys are never saved in host settings. Run agents inside a multiplexer to keep them alive when a shell disconnects. Uploads create a new file and refuse overwrites; the initial file viewer reads text up to 1 MiB and uploads are limited to 10 MiB.

See [architecture and current limits](docs/architecture.md) for the component boundaries and [companion setup](docs/companion.md) for optional agent lifecycle events.

## Platforms

Desktop: `bun run tauri build`.

Android (API 24+, current Android System WebView): install JDK 21, SDK platform 36, build tools 36.0.0 and NDK 29.0.14206865. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`, then run `bun run tauri android dev`. The Android project is checked in; do not reinitialize it. To build a debug ARM64 APK: `bun run tauri android build --target aarch64 --debug --apk`.

iOS (16+): on macOS with Xcode, run `bun run tauri ios init` and `bun run tauri ios dev`. Distribution requires your own Apple signing identity. macOS desktop requires version 13+.

lazysh is an independent implementation. It does not distribute Moshi code, branding, or assets.
