# lazysh — Cross-platform SSH terminal and AI agent workspace

**lazysh** is a cross-platform SSH client and terminal workspace in development for **Android, iOS, macOS, Linux, and Windows**. It is designed for developers who want to connect directly to their own servers, work in remote shells, and manage long-running AI coding agents from desktop or mobile.

The project is built with **Rust, Tauri 2, React, and xterm.js**, using **Bun and Turborepo** for the application workspace. Direct SSH works with the user's own hosts; the companion and external services are optional.

> **Project status:** Work in progress. The native implementation is available as a development preview. There is no stable release or verified cross-platform Moshi parity. See [implementation PR #22](https://github.com/mihazs/lazysh/pull/22), the [GitHub Project](https://github.com/users/mihazs/projects/2), and the [parity epic](https://github.com/mihazs/lazysh/issues/1) for test evidence and remaining work.

## What is lazysh for?

- **SSH terminal on desktop and mobile:** connect directly to remote SSH hosts using a shared native client.
- **Remote development and persistent sessions:** use **tmux, Herdr, and Zellij** to keep long-running programs on the host when the client disconnects.
- **AI coding-agent workflows:** view supported events and transcripts from host-side tools such as **Claude Code, Codex, and OpenCode**. Integration depth varies by agent.
- **Local-first connections:** use SSH independently, with optional companion tools for agent and session workflows.

## SSH and developer tools

The implementation includes password/private-key SSH, explicit server fingerprint verification, concurrent terminal tabs, output backpressure, and an optional [local agent companion](docs/companion.md). The workspace adds transcript readers, tmux/Herdr/Zellij controls, historical Git browsing and review comments, SFTP transfers, image attachments, SSH-forwarded previews, terminal preferences, and local Whisper dictation. These features have individual limits and verification gates; their presence does not establish full Moshi parity.

Credentials remain in memory by default. Explicit saving uses the device's [native credential store](docs/credentials.md), with optional Android/iOS/macOS biometric protection. Optional [encrypted sync](docs/sync.md), [Claude hook approvals](docs/approvals.md), [local notifications](docs/notifications.md), [expiring file sharing](docs/sharing.md), and [remote device controls](docs/devices.md) have separate setup and limits. Mosh supports Linux/macOS/Android with native protocol tests; iOS library tests pass but app integration remains open. ET uses a portable Rust transport. New hosts offer observable Auto selection through Mosh, ET and SSH. Full agent coverage, remaining transport/platform acceptance, additional voice engines and background push delivery remain open. Native Apple status and Watch surfaces are implemented; physical-device acceptance remains open. Simulator and CI checks do not establish a tested native release.

See the [feature and behavior evidence](docs/moshi-evidence.md) for research and the limits of the target scope.

## Technology stack

| Layer | Implementation |
| --- | --- |
| Native application | Tauri 2 and Rust |
| Terminal UI | React and xterm.js |
| Build and workspace | Bun and Turborepo |
| Connectivity | Direct SSH, with Mosh and Eternal Terminal integrations |
| Optional host integrations | Rust companion for agent/session events |
| Target platforms | Android, iOS, macOS, Linux, Windows |

## Explore the development preview

Requires Bun, Rust stable, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform, CMake and libclang for the local Whisper engine. Linux/macOS Mosh builds also require `protoc`, protobuf-lite, OpenSSL and zlib development libraries; see its [build notes](packages/mosh-transport/README.md).

```sh
git clone https://github.com/mihazs/lazysh.git
cd lazysh
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
- `apps/transcription-service`: optional Unix-host [cloud dictation relay](docs/cloud-transcription.md), with device enrollment, revocation, durable audio quotas, and native fixture tests. Client integration and deployment remain separate.
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

## Roadmap and contributions

Development progress is tracked in the [GitHub Project](https://github.com/users/mihazs/projects/2), the [feature-parity epic](https://github.com/mihazs/lazysh/issues/1), and the [issue tracker](https://github.com/mihazs/lazysh/issues). Bug reports, design feedback, and implementation discussions are welcome through issues and pull requests. Check the current branch and issue status before assuming that a feature is complete.

## Independence

lazysh is an independent implementation informed by research into Moshi's documented SSH and agent workflows. **Moshi parity is a development objective, not a current capability claim.** lazysh does not distribute Moshi source code, branding, or assets.

## License

lazysh is licensed under the [GNU GPL version 3 or later](LICENSE). Corresponding source is maintained in [this repository](https://github.com/mihazs/lazysh); use the commit identified with each build. Distribution of modified or binary builds must preserve the applicable license, notices and corresponding-source obligations.

Bundled third-party code retains its own notices and terms. In particular, the official Mosh core and its modifications are documented in [packages/mosh-transport](packages/mosh-transport/README.md), including its OpenSSL exception and iOS notice. ET transport provenance and retained MIT notices are documented in [packages/et-transport](packages/et-transport/PROVENANCE.md). The browser test font includes its Open Font License alongside the fixture.
