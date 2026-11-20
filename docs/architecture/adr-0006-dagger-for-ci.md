# ADR 0006: Dagger for the hosted-Linux CI checks, with measured conditions

- Status: **Accepted, conditional**, 2026-11-19, and **amended** the same day by the engine-cap experiments of [#2174](https://github.com/mihazs/lazysh/issues/2174) (see "Cap experiments" and decision 7). The conditions below are checked by every migration slice, and a slice that misses them is reverted to YAML.
- Decision makers: repository maintainer. Tracking: [#2172](https://github.com/mihazs/lazysh/issues/2172), slice 1 of epic [#2171](https://github.com/mihazs/lazysh/issues/2171).
- Related: [CONTRIBUTING: which CI jobs a pull request runs](../../CONTRIBUTING.md#which-ci-jobs-a-pull-request-runs) · [release tag gate](../release-tag-gate.md) · [release artifacts](../release-artifacts.md)

## Context

`.github/workflows/checks.yml` is 2126 lines (about 21 jobs) of YAML anchors and shell. A contributor cannot run a job locally, and `tests/main-verdict.test.ts` and its siblings pin the workflows' text structure. [Dagger](https://dagger.io) would let the pipeline be code that runs the same on a laptop and in Actions.

Dagger does not fix the main CI constraint: only about three hosted jobs run at once across the account (commit `e0e76a85`, [#1007](https://github.com/mihazs/lazysh/pull/1007)). Without remote engines it reduces the job count only if several checks run in one job. The owner ruled out Dagger Cloud, so there are no cloud traces, no shared cache, no remote engines and no new secret. An engine starts empty on every ephemeral hosted runner, so the cost of that has to be measured before anything is migrated.

## Spike

A throwaway workflow (branch `ci/dagger-spike`, commit `5a2b7a4f`, never merged) ran the `main-verdict.yml` commands on `ubuntu-24.04`, once natively (control) and once through Dagger 0.21.12, in the same run. Run [44632222345](https://github.com/mihazs/lazysh/actions/runs/44632222345), four attempts: attempt 1 is cold (no saved engine state), attempts 2 to 4 are warm.

- `client`: `bunx moon run client:build client:check` (Node 24, Bun 1.3.14).
- `agent`: `bunx moon run '#companion:check-rust' '#companion:lint' '#companion:format-check'` (`rust:1-bookworm`).
- Dagger engine: the engine image run with `docker run -d --privileged -v /tmp/dagger-state:/var/lib/dagger`, reached through `_EXPERIMENTAL_DAGGER_RUNNER_HOST=docker-container://dagger-engine`, driven by the CLI installed from its release archive with a pinned sha256 (`.github/scripts/pinned-download.sh`, as for every other pinned download) and the engine image pinned by digest, so no third-party action is needed. `dagger.json` stays the one place the version is chosen.
- State persistence: after the run the engine is stopped and `/var/lib/dagger` is archived with `sudo tar --zstd -cpf`, then stored with `actions/cache`; the next run extracts it with `sudo tar --zstd -xpf` before starting the engine.
- Each run passed a changing `--nonce` so the source-dependent steps re-ran, as they do when a pull request changes the source. Only the engine layer cache and the Dagger cache volumes (Bun install, Cargo registry, `target`) could help.

Seconds, per job:

| | Native control | Dagger, cold | Dagger, warm (attempts 2, 3, 4) |
| --- | --- | --- | --- |
| `client` job total | 48 · 38 · 44 · 49 | 146 | 124 · 145 · 119 (includes saving the state) |
| `client` restore + engine start + call | n/a | 101 | 82 · 100 · 81 |
| `agent` job total | 113 · 109 · 119 · 104 | 347 | 147 · 150 · 167 (includes saving the state) |
| `agent` restore + engine start + call | n/a | 272 | 95 · 99 · 119 |

Cost of the saved state, which a pull request would not pay (it restores only):

| | `client` | `agent` |
| --- | --- | --- |
| Compressed archive | 2.0 GiB | 2.9 GiB |
| Extracted state | not recorded | 7.9 GiB |
| Archive, then save to the cache | 26 to 35 s, then 14 s | 41 to 42 s, then 28 s |

The repository already holds 12.47 GiB in 18 caches against GitHub's 10 GiB budget, so an engine state of 4.9 GiB for two functions would evict the caches other jobs depend on.

For scale, the real jobs on recent green `main` runs took 634 to 1897 s (`client`) and 205 to 941 s (`agent`).

Reading the numbers:

- Warm Dagger adds about 50 s over native for `client` (job total without the state save, 96 s against 44 s) and about 2 s for `agent` (113 s against 111 s). Against the real jobs that is 3 to 8 % for `client` and about 1 % or less for `agent`, inside the +10 % gate.
- The gate is on warm wall-clock only. A cold or missed cache costs +100 s (`client`) and +230 s (`agent`).
- The spike ran only the cheap verdict commands, not the full `client` and `agent` jobs (Playwright, strace and tmux cases). The parity of the heavy parts is an assumption, which is why every slice re-measures.
- The engine start (27 to 68 s) includes extracting the state, so it grows with the state size.

Also learned:

- Dagger 0.21.12 on a developer machine whose `docker` is podman-emulated provisions its engine and runs both functions: `client` in 38 s warm, `agent` in 2 min 55 s cold. The module's first `dagger init` took 27 s.
- `moon` needs a VCS and a worktree's `.git` is a file that points outside the build context, so the module builds a one-commit repository inside the container. `moon ci -g` (affected selection) needs real history and the base ref, so CI must pass `.git` explicitly with a full-depth checkout for that case.
- `bunx` is absent from the `oven/bun` binary copied into another image. Use `bun x`.
- `DAGGER_NO_NAG=1` silences the Dagger Cloud trace prompt.
- The state directory must be archived with `tar -p` as root. Running `chown` on it would change file ownership inside the container images stored there.
- jscpd reports zero clones with the module committed: `dagger init` writes `dagger/.gitignore` for the generated `sdk/` (5.8 MB), and the hand-written module is far below the clone thresholds.

## Cap experiments

Condition 4.2 below asks for an engine state of at most 2 GiB. [#2174](https://github.com/mihazs/lazysh/issues/2174) tested whether a garbage-collection cap can deliver that without losing the warm speed. The engine ran with `/etc/dagger/engine.json` `{"gc":{"maxUsedSpace":…,"reservedSpace":…,"minFreeSpace":"1GB","sweepSize":"50%"}}` and `dagger core engine local-cache prune --use-default-policy` before the state was archived. Warm numbers are the `dagger call` step, in seconds; the uncapped numbers are from the spike above.

| Run | Cap (max / reserved) | Function | Archive | Warm `dagger call` |
| --- | --- | --- | --- | --- |
| [44632222345](https://github.com/mihazs/lazysh/actions/runs/44632222345) (spike) | none | `client` | 2.0 GiB | 42 · 29 · 26 |
| | none | `agent` | 2.9 GiB | 17 · 18 · 21 |
| [44635664652](https://github.com/mihazs/lazysh/actions/runs/44635664652) | 2 GB / 1500 MB | `client` | 1003 MiB | 52 · 66 |
| | 2 GB / 1500 MB | `agent` | 1309 MiB | 164 · 197 |
| [44637871647](https://github.com/mihazs/lazysh/actions/runs/44637871647), with `CARGO_INCREMENTAL=0` | 2 GB / 1500 MB | `client` | 1003 MiB | 49 · 48 |
| | 2 GB / 1500 MB | `agent` | 1310 MiB | 157 · 234 |
| | 3 GB / 2500 MB | `agent` | 1310 MiB | 219 · 159 |

What it shows:

- The cap works for size: archives fall from 2.0 and 2.9 GiB to 1.0 and 1.3 GiB, and the prune takes 3 to 25 s.
- It costs the Rust jobs their warm speed. A warm `agent` call goes from about 20 s to 160 to 230 s, as slow as a cold run, because the prune evicts the Cargo `target` cache volume. `CARGO_INCREMENTAL=0` (which `Swatinem/rust-cache` sets in the native job) and a 3 GB cap change nothing. The archive stays 1310 MiB at both caps, so the cap is not what limits the retained set.
- `client` keeps its warm benefit: 48 to 66 s against 26 to 42 s uncapped, inside condition 4.1 against the real job (634 to 1897 s).
- The repository already refuses to restore `target/` for release builds (`.github/actions/cargo-registry`), and the Rust jobs use `Swatinem/rust-cache`, which prunes workspace-crate artifacts instead of keeping a whole `target` tree.

## Decision

1. **Adopt Dagger for the hosted-Linux checks, conditionally.** TypeScript SDK on Bun (the repository is Bun and TypeScript), Dagger 0.21.12 pinned exactly (the latest stable 0.21.x on 2026-11-19; the 1.0 beta is not used for required checks), `dagger/dagger-for-github@v8.4.1`.
2. **The engine is Docker on the hosted runner, state is persisted with `actions/cache`, and pull requests restore but never save.** Main saves, as the repository does for the Rust cache. The archive is made with `sudo tar --zstd -cpf`. The engine runs with a GC policy (`maxUsedSpace` 2 GB, `reservedSpace` 1500 MB) and is pruned to it before archiving. One state exists per ISO week, saved by the first main push of that week, so at most the current and the previous week's entries are alive.
3. **No Dagger Cloud.** The owner decided against it.
4. **Conditions, checked by every migration slice and recorded in its pull request:**
   1. Warm wall-clock of the migrated job is within +10 % of the median of the same job on `main` over the last six green runs, measured on at least three warm runs.
   2. The persisted engine state is at most 2 GiB compressed across all functions together (one shared state, pruned to the cache volumes and the pinned base images), so the repository's cache total does not grow past what it is today. Slice [#2174](https://github.com/mihazs/lazysh/issues/2174) proves a pruning method or this ADR is superseded.
   3. A deliberately failing check turns the job red.
   A slice that fails a condition moves that job back to YAML and says why in its issue. Outcome of #2174: condition 2 holds for the cache-light jobs and not for jobs whose cost is a Cargo `target` tree (decision 7).
5. **Every migrated job keeps its name.** The required checks are a hard-coded list in the local PR driver, not in the repository ruleset ([#2183](https://github.com/mihazs/lazysh/issues/2183)).
6. **Base images are pinned by digest and downloads by sha256**, as the repository does today.
7. **Jobs whose cost is a Cargo `target` tree stay in YAML with `Swatinem/rust-cache`:** `agent`, `herdr-native`, `native-android`, `native-terminal-bridge`, `native-linux`, `native-linux-surface` and `native-linux-runtimes`. They fail condition 4.1 (capped, warm Rust is as slow as cold) or condition 4.2 (uncapped, the state is 2.9 GiB). Dagger covers the cache-light jobs (`client`, the `release-tools` test step, `verdict-client`) and gives every contributor local reproducibility through the shared toolchain. A Rust function may still exist for local use, but CI does not call it.

## Non-goals

`release-tag.yml`, `release-artifacts.yml`, `companion-artifacts.yml` and `version-pr` (signing, publishing, `contents: write`); macOS, iOS and Windows jobs and every `/dev/kvm` Android emulator job (Dagger runs Linux containers only); `terminal-perf` (timing-sensitive); the `changes` job and `.github/scripts/native-changes.sh`; `conventional-commits.yml` and `fdroid.yml` (little to gain).

## Alternatives considered

- **Do not adopt Dagger.** Cheaper and faster per job, but keeps CI unreproducible locally. Rejected because the measured warm overhead is small against real job lengths.
- **Dagger Cloud or remote engines.** Would remove the cold-engine cost and the cache budget problem, but needs a new secret and an external service. Rejected by the owner.
- **A self-hosted runner with a resident engine.** Would remove the fixed cost entirely. Not adopted: the repository has no self-hosted runner and runner-provider experiments were reverted (#1805, #1814, #1856).
- **Persist only Dagger cache volumes, not the whole engine state.** Tried through the GC cap: the prune evicts the Cargo target volume as well, so the Rust jobs lose their warm speed (see "Cap experiments").
- **A Go or Python module.** Rejected: a second toolchain for contributors.

## Delivery

1. This ADR (docs only), closing [#2172](https://github.com/mihazs/lazysh/issues/2172).
2. [#2173](https://github.com/mihazs/lazysh/issues/2173) scaffolds the module and [#2174](https://github.com/mihazs/lazysh/issues/2174) adds the setup action, the CI check and this amendment.
3. [#2175](https://github.com/mihazs/lazysh/issues/2175) runs `client` through Dagger, [#2177](https://github.com/mihazs/lazysh/issues/2177) shares its function with `verdict-client` and the `release-tools` test step, and [#2183](https://github.com/mihazs/lazysh/issues/2183) and [#2184](https://github.com/mihazs/lazysh/issues/2184) stay open.
4. Closed as not planned under decision 7, with a pointer here: [#2176](https://github.com/mihazs/lazysh/issues/2176), [#2178](https://github.com/mihazs/lazysh/issues/2178), [#2179](https://github.com/mihazs/lazysh/issues/2179), [#2180](https://github.com/mihazs/lazysh/issues/2180), [#2181](https://github.com/mihazs/lazysh/issues/2181) and [#2182](https://github.com/mihazs/lazysh/issues/2182). A future cache or runner change (a resident engine, a larger cache budget) can reopen them.
