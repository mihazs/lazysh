# lazysh

A direct SSH terminal and agent workspace for Android, iOS, macOS, Linux, and Windows, built with Tauri 2, Rust, React, and xterm.js in a Bun/Turborepo monorepo.

Implementation is in progress. Moshi parity is a release objective, not a claim about this initial repository. Track delivery in the [Project](https://github.com/users/mihazs/projects/2), [parity epic](https://github.com/mihazs/lazysh/issues/1), and [feature evidence](docs/moshi-evidence.md).

The first implementation includes password/private-key SSH, explicit server fingerprint verification, concurrent terminal tabs, bounded output with backpressure, SFTP browsing/text reads/new-file uploads, staged/unstaged Git diffs, independent tmux attachments, and an optional [local agent-event companion](docs/companion.md). Credentials are prompted per connection and stay in memory.

Mosh/ET, complete multiplexer controls, vault/biometrics, native agent chat/approvals, voice, previews, notifications, sync and Apple extensions remain open issues. Mobile source compatibility does not establish a tested native release.

## Development

Requires Bun, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```sh
bun install --frozen-lockfile
bun run dev
```

The browser development server is a UI preview; direct SSH requires the native Tauri application.

## Checks

```sh
bun run build
bun run test
bun run test:install-browser
bun run test:e2e
bun run check
bun run lint
bun run format:check
bun run test:openssh
```

`test` runs the client Vitest suite and both Rust suites through Cargo. `test:openssh` additionally requires a local `sshd` executable. Browser tests check responsive UI and keyboard behavior, not native SSH. Platform/toolchain and release results are recorded in the implementation PR.

## Monorepo

- `apps/client`: shared React/xterm.js client and its Tauri Rust crate, desktop/mobile targets, Vitest tests, and Playwright tests.
- `apps/agent`: optional Rust host companion, with library unit tests and CLI integration tests under `tests/`.
- Root `Cargo.toml`/`Cargo.lock`: Rust workspace and dependency lock. Root `package.json`/`bun.lock`: Bun workspace and dependency lock. `turbo.json`: package task orchestration.

Dependencies belong to their owning app. Root commands delegate to Turbo package tasks. Frontend build outputs are cached; native builds and integration tests run freshly and use Cargo's compilation cache. There is no `scripts/` directory or custom test runner.

## Connection safety

Compare the full SHA-256 fingerprint shown on first connect with a trusted copy from the server. lazysh verifies pinned keys before sending authentication material and refuses changed keys. Passwords and private keys are never saved in host settings. Run agents inside a multiplexer to keep them alive when a shell disconnects. Uploads create a new file and refuse overwrites; the initial file viewer reads text up to 1 MiB and uploads are limited to 10 MiB.

See [architecture and current limits](docs/architecture.md) for the component boundaries and [companion setup](docs/companion.md) for optional agent lifecycle events.

## Platforms

Desktop: `bun run build:native` creates the native release executable. To create platform bundles, run `bun run --cwd apps/client tauri build`.

Android (API 24+, current Android System WebView): install JDK 21, SDK platform 36, build tools 36.0.0 and NDK 29.0.14206865. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`, then run `bun run --cwd apps/client tauri android dev`. The Android project is checked in; do not reinitialize it. `bun run build:android` builds a debug ARM64 APK. For an optimized unsigned APK: `bun run --cwd apps/client tauri android build --target aarch64 --apk --ci`.

iOS (16+): on macOS with Xcode, `bun run build:ios` initializes and builds an unsigned ARM64 simulator app. Distribution requires your own Apple signing identity. macOS desktop requires version 13+.

lazysh is an independent implementation. It does not distribute Moshi code, branding, or assets.
