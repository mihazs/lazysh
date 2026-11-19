# Run CI functions locally with Dagger

The Dagger module in [`dagger/`](../../dagger) holds the CI functions that run the same on a laptop and in GitHub Actions. [ADR 0006](../architecture/adr-0006-dagger-for-ci.md) records why Dagger is used and the conditions each migrated job must meet. Today the module provides the shared toolchain and workspace; the migrated checks arrive in later slices of [#2171](https://github.com/mihazs/lazysh/issues/2171).

## Prerequisites

- A Linux container runtime: Docker or Podman. Dagger runs Linux containers only, so the macOS, iOS, Windows and `/dev/kvm` Android emulator jobs stay on native runners.
- The Dagger CLI at the version pinned by `engineVersion` in [`dagger.json`](../../dagger.json) (0.21.12). Install it from the [release page](https://github.com/dagger/dagger/releases) and verify the checksum, or use your distribution's package if it carries that version:

  ```sh
  gh release download v0.21.12 -R dagger/dagger -p 'dagger_v0.21.12_linux_amd64.tar.gz' -p checksums.txt
  grep linux_amd64.tar.gz checksums.txt | sha256sum -c -
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

## Limits

- The workspace has one commit, so moon's affected selection (`moon ci -g`) sees no history. Functions that need it pass the real `.git` explicitly.
- Local results match CI only for the steps a function wraps. Jobs that need the host (emulators, macOS, Windows, `/dev/kvm`) are not functions.

## Bump a tool version

Change the version in `.prototools`, resolve the base image's digest and add it to [`dagger/src/images.ts`](../../dagger/src/images.ts); `bun test ./tests/dagger-module.test.ts` fails until the digest is there. The resolve command is in that file.
