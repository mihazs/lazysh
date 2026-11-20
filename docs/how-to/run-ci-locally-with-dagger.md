# Run CI functions locally with Dagger

The Dagger module in [`.dagger/modules/ci`](../../.dagger/modules/ci) holds the CI functions that run the same on a laptop and in GitHub Actions. [ADR 0006](../architecture/adr-0006-dagger-for-ci.md) records why Dagger is used, why version 1, and the conditions each migrated job must meet. Today the module provides the shared toolchain and workspace; the migrated checks arrive in later slices of [#2171](https://github.com/mihazs/lazysh/issues/2171).

## Prerequisites

- A Linux container runtime: Docker or Podman. Dagger runs Linux containers only, so the macOS, iOS, Windows and `/dev/kvm` Android emulator jobs stay on native runners.
- The Dagger CLI **v1.0.0-beta.28**, the newest v1 release (there is no stable 1.0 yet; ADR 0006 explains the pin). Download it from `dl.dagger.io`, verify the checksum, and put `dagger` on your `PATH`:

  ```sh
  v=1.0.0-beta.28
  curl -fsSLO "https://dl.dagger.io/dagger/releases/$v/dagger_v${v}_linux_amd64.tar.gz"
  echo "abd9f7e95f03c517e33cfbab0917fa1593d73e088d69304259884f8a47cc61a1  dagger_v${v}_linux_amd64.tar.gz" | sha256sum --check --strict
  tar -xzf "dagger_v${v}_linux_amd64.tar.gz" dagger
  ```

- Optional: `export DAGGER_NO_NAG=1` hides the Dagger Cloud tracing prompt. This repository does not use Dagger Cloud.

The first call pulls the engine image and builds the module, which takes under a minute. The engine keeps its cache between calls.

## Run a function

```sh
dagger functions                                                    # list the module's functions
dagger call workspace with-exec --args=bun,x,moon,--version stdout  # the toolchain plus the repository, then one command
dagger call workspace terminal                                      # an interactive shell in that container
```

`workspace` copies the repository without `.git`, `node_modules`, `target`, `.moon/cache`, `.turbo` and `.gradle`, creates a one-commit git repository (moon needs a VCS, and a git worktree's `.git` file points outside the build context), and runs `bun install --frozen-lockfile`. Node and Bun come from [`.prototools`](../../.prototools); moon runs the version in `bun.lock`.

## Layout and generated files

[`dagger.toml`](../../dagger.toml) records the workspace: the module, and the TypeScript SDK module pinned at a tag (`typescript-sdk@v1.0.6`; v1.0.7 does not load on beta.28). [`dagger.lock`](../../dagger.lock) pins every git ref and image the workspace resolves, so commit it with any change.

A v1 module commits its generated bindings: `clients/`, `entrypoint/` and `__dagger.dispatch.ts` under `.dagger/modules/ci`. They are marked `linguist-generated`, listed in `.jscpd.json` so the duplicate scan skips them, and rewritten by `dagger generate` after you change a function's signature. Edit only `src/`.

## Limits

- The workspace has one commit, so moon's affected selection (`moon ci -g`) sees no history. Functions that need it take the repository's real `.git` explicitly.
- Local results match CI only for the steps a function wraps. Jobs that need the host (emulators, macOS, Windows, `/dev/kvm`) are not functions.

## Bump a tool version

Change the version in `.prototools`, resolve the base image's digest and add it to [`images.ts`](../../.dagger/modules/ci/src/images.ts); `bun test ./tests/dagger-module.test.ts` fails until the digest is there. The resolve command is in that file.
