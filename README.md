# lazysh

A direct SSH terminal and agent workspace for Android, iOS, macOS, Linux, and Windows, built with Tauri 2, Rust, React, and xterm.js in a Bun/Turborepo monorepo.

Implementation is in progress. Moshi parity is a release objective, not a claim about this initial repository. Track delivery in the [Project](https://github.com/users/mihazs/projects/2), [parity epic](https://github.com/mihazs/lazysh/issues/1), and [feature evidence](docs/moshi-evidence.md).

The implementation includes password/private-key SSH, explicit server fingerprint verification, concurrent terminal tabs, output backpressure, and an optional [local agent companion](docs/companion.md). The workspace adds transcript readers, tmux/Herdr/Zellij controls, historical Git browsing and review comments, SFTP transfers, image attachments, SSH-forwarded previews, terminal preferences, and local Whisper dictation. These features have individual limits and verification gates; their presence does not establish full Moshi parity.

Credentials remain in memory by default. Explicit saving uses the device's [native credential store](docs/credentials.md), with optional Android/iOS/macOS biometric protection. Optional [encrypted sync](docs/sync.md), [Claude hook approvals](docs/approvals.md), [local notifications](docs/notifications.md), [expiring file sharing](docs/sharing.md), and [remote device controls](docs/devices.md) have separate setup and limits. Mosh currently supports Linux/macOS; ET uses a portable Rust transport. Full agent coverage, remaining transport/platform acceptance, additional voice engines, background push and Apple extensions remain open. Mobile source compatibility does not establish a tested native release.

## Development

Requires Bun, Rust stable, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform, CMake and libclang for the local Whisper engine. Linux/macOS Mosh builds also require `protoc`, protobuf-lite, OpenSSL and zlib development libraries; see its [build notes](packages/mosh-transport/README.md).

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
bun run test:multiplexers
```

`test` runs Vitest and the Rust workspace packages through Cargo. `test:openssh` additionally requires local `sshd`; `test:multiplexers` requires tmux, Herdr and Zellij on PATH and uses isolated temporary sessions. `test:voice` requires explicitly supplied `LAZYSH_WHISPER_TEST_MODEL` and `LAZYSH_WHISPER_TEST_WAV` fixtures. Browser tests check responsive UI and keyboard behavior, not native SSH. Platform/toolchain and release results are recorded in the implementation PR.

## Monorepo

- `apps/client`: shared React/xterm.js client and its Tauri Rust crate, desktop/mobile targets, Vitest tests, and Playwright tests.
- `apps/agent`: optional Rust host companion, with library unit tests and CLI integration tests under `tests/`.
- `apps/share-service`: optional authenticated expiring-upload server, with native HTTP/CLI tests. It is never deployed or contacted automatically.
- `packages/credential-vault`: Rust Tauri plugin with Android Keystore and iOS Keychain implementations, plus desktop OS credential storage.
- `packages/mosh-transport` and `packages/et-transport`: bounded transport libraries and official-server interoperability tests.
- `packages/apple-speech`: native SpeechAnalyzer plugin for supported iOS versions, with explicit OS asset downloads and cancellation.
- Root `Cargo.toml`/`Cargo.lock`: Rust workspace and dependency lock. Root `package.json`/`bun.lock`: Bun workspace and dependency lock. `turbo.json`: package task orchestration.

Dependencies belong to their owning app. Root commands delegate to Turbo package tasks. Frontend build outputs are cached; native builds and integration tests run freshly and use Cargo's compilation cache. There is no `scripts/` directory or custom test runner.

## Connection safety

Compare the full SHA-256 fingerprint shown on first connect with a trusted copy from the server. lazysh verifies pinned keys before sending authentication material and refuses changed keys. Passwords and private keys are never saved in host settings. Run agents inside a multiplexer to keep them alive when a shell disconnects. Uploads create a new file and refuse overwrites; the initial file viewer reads text up to 1 MiB and uploads are limited to 10 MiB.

See [architecture and current limits](docs/architecture.md) for the component boundaries and [companion setup](docs/companion.md) for optional agent lifecycle events.

## Platforms

Desktop: `bun run build:native` creates the native release executable. To create platform bundles, run `bun run --cwd apps/client tauri build`.

Android (API 24+, current Android System WebView): install JDK 21, SDK platform 36, build tools 36.0.0 and NDK 29.0.14206865. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME`, then run `bun run --cwd apps/client tauri android dev`. The Android project is checked in; do not reinitialize it. `bun run build:android` builds a debug ARM64 APK. For an optimized unsigned APK: `CMAKE_ANDROID_NDK=$NDK_HOME WHISPER_DONT_GENERATE_BINDINGS=1 bun run --cwd apps/client tauri android build --target aarch64 --apk --ci`.

iOS (16+): on macOS with Xcode, `bun run build:ios` initializes and builds an unsigned ARM64 simulator app. Distribution requires your own Apple signing identity. macOS desktop requires version 13+.

lazysh is an independent implementation. It does not distribute Moshi code, branding, or assets.

## License

lazysh is licensed under the [GNU GPL version 3 or later](LICENSE). Corresponding source is maintained in [this repository](https://github.com/mihazs/lazysh); use the commit identified with each build. Distribution of modified or binary builds must preserve the applicable license, notices and corresponding-source obligations.

Bundled third-party code retains its own notices and terms. In particular, the official Mosh core and its modifications are documented in [packages/mosh-transport](packages/mosh-transport/README.md), including its OpenSSL exception and iOS notice. ET transport provenance and retained MIT notices are documented in [packages/et-transport](packages/et-transport/PROVENANCE.md). The browser test font includes its Open Font License alongside the fixture.
