# moon task reference

moon (pinned as the `@moonrepo/cli` dev dependency) runs every build, check, lint, test and
acceptance task of the Bun and Cargo workspaces. This page is the lookup for the configuration
layout, the project graph, the task ids and the `bun run` aliases. For day-to-day use see
[Run tasks with moon](../how-to/run-tasks-with-moon.md).

## Configuration

| File | Purpose |
| --- | --- |
| `.moon/workspace.yml` | Project globs (`apps/*`, `packages/*`), the two explicit sources `client-native` (`apps/client/src-tauri`) and `herdr-guard`, layer and tag constraints, VCS settings |
| `.moon/toolchains.yml` | Bun as package manager. Rust is deliberately unpinned: CI and the Herdr build choose their own toolchain. moon never edits `package.json` or `bun.lock` |
| `.moon/tasks.yml` | Inputs every task shares (`package.json`, `bun.lock`, `.moon/tasks*`) |
| `.moon/tasks/cargo.yml` | Tasks every project tagged `cargo` inherits, and the `sources` marker (below) |
| `.moon/tasks/cargo-binary.yml` | The release `build` of the four binaries |
| `apps/*/moon.yml`, `packages/*/moon.yml` | Language, layer, stack, tags, `dependsOn` and the project's own tasks |
| `.prototools` | Developer pins for moon, Bun and Node, for [proto](https://moonrepo.dev/proto) users |

CI installs nothing extra: `bun install --frozen-lockfile` provides the pinned moon, and
`MOON_TOOLCHAIN_FORCE_GLOBALS=true` makes moon use the Bun from `setup-bun`.

## Tags, layers and stacks

| Tag | Projects | Meaning |
| --- | --- | --- |
| `cargo` | every Cargo workspace member | inherits `check-rust`, `test-rust`, `lint`, `format-check`, `sources` |
| `cargo-binary` | agent, notification-service, share-service, transcription-service | inherits the release `build` |
| `companion` | agent, the three services, notification-client, account-usage, companion-release | the set the `agent` CI job verifies |
| `vendor` | ai-usagebar-vendor, deep-link-vendor, portable-pty-vendor, herdr-upstream, herdr-guard | vendored or separately built code; inherits no tasks |

`client` is the only `application`. `client-native`, the services, the agent and the Herdr projects are
`tool`; every other crate is a `library`. `workspace.yml` enforces layer relationships, and Cargo crates may
depend only on `cargo` or `vendor` projects.

## Inherited Cargo tasks

All run in the project directory, so no `-p` or `--manifest-path` flag is needed. They are uncached.

| Task | Command |
| --- | --- |
| `check-rust` | `cargo check --locked` |
| `test-rust` | `cargo test --locked` |
| `lint` | `cargo clippy --locked --all-targets -- -D warnings` |
| `format-check` | `cargo fmt -- --check` |
| `build` (binaries only) | `cargo build --release --locked` |
| `sources` | no-op marker |

`common` and `account-usage` pass `--all-features` to `check-rust`, `test-rust` and `lint`.

`sources` exists for `moon ci -g`: `check-rust`, `test-rust`, `lint` and `build` depend on `^:sources`, so a
change to a crate selects every crate that depends on it, directly or not.

## Dependencies moon cannot infer

moon reads `[dependencies]`, `[dev-dependencies]` and `[build-dependencies]` from `Cargo.toml` and
`workspace:*` entries from `package.json`. It does not read `[target.'cfg(..)'.dependencies]` or `[patch]`,
so `apps/client/src-tauri/moon.yml` declares `agent`, `mosh-transport`, `portable-pty-vendor` and
`deep-link-vendor`, and `packages/herdr-upstream/moon.yml` declares `herdr-guard`.
`tests/moon-graph.test.ts` compares every Cargo path dependency with the moon graph.

## Client tasks (`apps/client`)

| Task | Runs | Cached |
| --- | --- | --- |
| `build` | `bun run build` (`tsc -b && vite build`; Tauri's `beforeBuildCommand` calls the same script) | no: Vite embeds the Git revision |
| `check` | `bun run check` | yes |
| `test` | `bun run test` (Vitest) | yes |
| `check-native-gui` | `tsc --project tsconfig.native-gui.json` | yes |
| `dev`, `dev-native` | Vite, or `tauri dev` | server presets |
| `test-e2e`, `test-install-browser` | Playwright | no |
| `test-native-gui` | namespaced Vitest GUI run, Linux only; builds `build-native` first | no |
| `build-native` | `tauri build --no-bundle` | no |
| `build-android`, `-emulator`, `-fdroid`, `-fdroid-emulator` | `tauri android build` | no |
| `test-android`, `-theme-links`, `-ssh`, `-ssh-parity`, `-herdr-navigation`, `-tmux`, `-qr`, `-biometric`, `-fdroid`, `-ntfy`, `-push-artifact` | Gradle or `bun test` acceptance, each depending on the build it needs | no |
| `init-ios`, `build-ios`, `test-ios-workspace` | Tauri and Xcode, macOS only | no |

Android `build-*` and `test-android-*` tasks set their constants (`WHISPER_DONT_GENERATE_BINDINGS`,
`CMAKE_ANDROID_NDK`, `LAZYSH_ANDROID_UI_*`) in `env` with `options.envOverride: true`.

## Native crate tasks (`apps/client/src-tauri`, id `client-native`)

Inherited `check-rust`, `test-rust`, `lint`, `format-check`, plus `verify-native` (an aggregate of those four
for this crate and its direct Cargo dependencies) and the opt-in integration tasks `test-resume-policy`,
`test-openssh`, `test-openssh-connections`, `test-host-clipboard`, `test-local`, `test-mosh`, `test-et`,
`test-multiplexers`, `test-connection-loss`, `test-tmux`, `test-voice`, `test-parakeet-product`,
`test-voice-interop-smoke`, `test-voice-interop` and `test-voice-interop-release`.

## Other project tasks

| Project | Tasks |
| --- | --- |
| `agent` | `test-storage`, `test-hooks` |
| `apple-status` | `test-apple-status`, `build-watchos` (macOS) |
| `push-registration` | `test-apns` (macOS) |
| `credential-vault` | `test-resume` (macOS) |
| `et-transport` | `test-et` |
| `mosh-transport` | `test-mosh`, `test-android-mosh`, `test-ios-mosh` |
| `parakeet-runtime` | `test-parakeet-native`, `test-parakeet-inference`, `test-parakeet-inference-release` |

## `bun run` aliases

The root `package.json` keeps every script name; each is a `moon run` call.

| Script | moon target |
| --- | --- |
| `dev` | `client:dev-native` |
| `build` | `:build` |
| `check` | `:check :check-rust` |
| `test` | `:test :test-rust :test-hooks` |
| `lint`, `format:check` | `:lint`, `:format-check` |
| `test:openssh`, `test:openssh-connections`, `test:multiplexers`, `test:voice`, `test:install-browser` | the task of the same name, `:test-<name>` |
| `test:et`, `test:mosh` | `:test-et`, `:test-mosh` (the native crate and the transport crate) |
| `test:e2e`, `test:native-gui`, `build:native`, `build:android*`, `build:ios`, `test:android*`, `test:ios-workspace` | `client:<id>`, with `:` written as `-` |
| `test:storage` | `agent:test-storage` |
| `test:android-mosh`, `test:ios-mosh` | `mosh-transport:<id>` |

`changeset`, `release:*`, `test:release`, `test:fdroid`, `test:hooks`, `test:ci`, `hooks:install` and
`duplicates:*` are plain Bun scripts and do not use moon.

## Environment

moon does not filter the environment: every task sees the process environment. A task `env` value loses to a
conflicting process value unless the task sets `options.envOverride: true`.

## Caching

Only `client:check`, `client:test` and `client:check-native-gui` are cached. The `client` CI job restores
`.moon/cache/hashes` and `.moon/cache/outputs` from `main` and saves them only on `main`. No remote cache is
configured. To add one later, use a Bazel Remote Execution v2 backend through a `remote:` block in
`.moon/workspace.yml` (`host` and an `auth.token` that names an environment variable), with the token held in
GitHub secrets.
