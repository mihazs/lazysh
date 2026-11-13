# ADR 0003: host-side companion update, `lazysh-agent update` and auto-update

- Status: **Accepted** as the design. The behavior below is not implemented yet: [#1444](https://github.com/mihazs/lazysh/issues/1444) (CLI), [#1445](https://github.com/mihazs/lazysh/issues/1445) (app) and [#1446](https://github.com/mihazs/lazysh/issues/1446) (auto-update) deliver it. Date: 2026-11-13.
- Decision makers: repository maintainer. Tracking: [epic #1441](https://github.com/mihazs/lazysh/issues/1441), design issue [#1443](https://github.com/mihazs/lazysh/issues/1443).
- Related: [configure the companion](../how-to/configure-companion.md) · [companion](../companion.md) · [host settings](../companion-settings.md) · [settings reference](../reference/companion-settings.md) · [install and update](../install-and-update.md) · [release artifacts](../release-artifacts.md).

## Context

The user's requirement (2026-11-13): the **Host companion installation** update must run on the host and never download the companion on the phone; the companion needs an `update` command and an auto-update feature.

What the code does today (read at `origin/main` 6d291b52):

- `apps/client/src-tauri/src/companion/install.rs` detects a positively identified Linux or macOS shell, selects a release, then calls `publisher.download(&selection)` **on the device** (up to `MAX_BINARY`, 64 MiB), uploads the bytes over SFTP into a staging directory, runs `<staged> installation inspect`, rechecks the tag, runs `<staged> installation install --expected-plan <hash>` and confirms `--version`. The whole operation has a 240-second deadline and each remote command 15 seconds and 16,384 output bytes.
- The client `Publisher` (`companion/release.rs`) is HTTPS-only, ignores proxies, has a 60-second whole-request timeout and follows at most three redirects, each re-checked against an allow-list (`api.github.com/repos/mihazs/lazysh/`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`). The phone therefore pays 8.9 to 11.7 MB of mobile data and battery per update (v1.50.0 companions: linux x64 11,694,768 bytes, linux arm64 9,589,408, macOS arm64 8,941,584, macOS x64 10,671,552, Windows 10,167,296), is slow, and fails when the phone has no route to GitHub.
- `select()` accepts only `linux-agent-x64|arm64` and `macos-agent-x64|arm64` and expects the file name `lazysh-<version>-<target>.bin`. The Windows companion is published as `lazysh-<version>-windows-agent-x64.exe` but cannot be installed from the app ([#490](https://github.com/mihazs/lazysh/issues/490)); `installation` answers `windowsInstallerUnsupported`.
- The companion has no `update` command, no automatic check and no rollback. An old companion (1.28.0) lacks `transcript-watch` and `herdr-conversation`; the app can only say "update the companion".
- The companion rejects an unknown subcommand with a usage error (exit status 2), which the app already treats as "this companion is too old" (`docs/companion.md`, live conversation stream). All other failures of `main.rs` exit 1.

What a release publishes (checked on v1.50.0 with `gh release view`): 14 assets. `lazysh-<v>-linux-agent-x64.bin`, `-linux-agent-arm64.bin`, `-macos-agent-x64.bin`, `-macos-agent-arm64.bin`, `-windows-agent-x64.exe`, the desktop and Android packages (`-linux-x64.deb`, `-linux-x64.AppImage`, `-windows-x64.exe`, two APKs), `release.json`, `SHA256SUMS`, `release-notes.md` and `INSTALL-AND-UPDATE.md`. GitHub returns a `sha256:<hex>` digest for every asset. `release.json` (schema 1) lists `sha` (the tag's commit), `version` and nine platform receipts, each with `target`, `signing` (`unsigned` for Linux and Windows, `ad-hoc` for macOS) and `files[{name, bytes, sha256}]`. The release workflows publish **no detached signature and no build attestation** (searched `.github/workflows` for attest, cosign and sigstore: none).

What the client verifies today before it downloads (`Publisher::select`): `releases/latest` is not a draft or prerelease and has at most 32 assets; the tag is `vX.Y.Z`; `git/ref/tags/vX.Y.Z` is a commit; `release.json` is at most 64 KiB and its SHA-256 equals the digest GitHub reports for that asset; its `sha`, `version` and the single receipt for the target agree with the tag's commit; the file name, byte count (at most 64 MiB) and SHA-256 equal the asset's size and GitHub digest. `recheck()` repeats the tag-to-commit check just before the install command. The downgrade guard (`reject_newer`) refuses a parseably newer installed version.

## Decision

1. **The host downloads and installs; the phone sends a pin.** The phone fetches and verifies only the small release metadata (at most 262,144 + 16,384 + 65,536 = 344,064 bytes, against a companion of about 9 to 12 MB) and sends the host a *pin*: version, target, byte count and SHA-256. `Publisher::download`, SFTP staging and the `downloading` and `uploading` stages leave the default path.
2. **The trust root is unchanged and the pin is a second opinion.** The digest pinned for the host comes from the same chain the client already verifies. A host that can re-fetch the metadata (a companion with `update`) does so and refuses any disagreement with the pin; the bootstrap, which has no JSON parser, verifies the downloaded bytes against the pin.
3. **`lazysh-agent update`** (and `auto-update`) is added to the companion with the contract in [CLI contract](#cli-contract). The CLI only ever writes the user's *managed* companion.
4. **Companions without `update` (including none at all) are updated by a small fixed bootstrap** run over SSH exec: POSIX `sh` using `curl` or GNU `wget` on Linux and macOS, Windows PowerShell on Windows.
5. **The phone-download path survives only as an explicit, labelled offline fallback** behind its own command, offered only when the host cannot reach GitHub.
6. **Auto-update policy is `off | notify | install`, default `notify`.** Nothing is replaced unless the user chose `install`. Settings live in their own strict file so older companions keep reading `settings.json`.
7. **Rollback and downgrade protection are part of every replace**: the staged binary is self-tested before the replace, the installed one after it, the previous version is kept, and a lower version is installed only when the user names it.

## Trust model

| Question | Decision |
| --- | --- |
| Root of trust | TLS to GitHub plus the repository's release pipeline (whoever can publish a release can publish a matching digest). This is the trust the app's installer already has. No new trust is added and none is removed. |
| Where does the pinned digest come from? | The per-target receipt of `release.json` (`files[0].sha256`), cross-checked against the asset's GitHub `sha256:` digest, the asset's size, the manifest `sha`, the tag's commit and the version. The release body and `SHA256SUMS` are **not** used as anchors: they are sibling assets of the same release and add no independence (`SHA256SUMS` stays a human-facing artifact). |
| Who resolves it? | **The app, by default.** The phone does the metadata fetch it does now and passes the pin. Reasons: (a) a second, independent network path: the pin comes from the phone's connection and arrives over SSH, so a man in the middle on the host's network cannot substitute bytes, including a TLS-intercepting proxy whose CA is in the host's system trust store (which the bootstrap's `curl` and PowerShell accept); (b) the shell bootstrap needs no JSON parsing; (c) the app can refuse a downgrade before dispatching anything; (d) the 344,064-byte cost is negligible. |
| Does the host re-fetch? | **Yes when it can.** `lazysh-agent update --version V --expect-sha256 H --expect-bytes N` resolves `releases/tags/vV` itself with the same chain and exits 22 on any disagreement with the pin. A bare `lazysh-agent update` (headless host, timer) resolves alone because no app is involved. |
| Phone cannot reach GitHub, host can | Optional, on explicit confirmation only and only for a companion with `update`: the app omits the pin and says that the host decides alone. The bootstrap never runs without a pin. |
| Signature or attestation | None exists (see Context). Version 1 does not invent a signing scheme: key custody is a release-engineering decision. The pin format leaves room for a future `signature` field; verifying a Sigstore bundle on the host would need a verifier the companion does not ship. Recorded as a follow-up the maintainer can schedule. The platform's own signatures stay as they are: macOS ad hoc, Windows unsigned. |
| What the pin does not protect | A compromise of the release pipeline (the digest would match), or of the phone-to-host SSH session (the pin travels over it). Both are outside this change; the second is the existing threat model of every SSH command the app sends. |
| Tag moved between phone and host | The pin binds *bytes*, so a retag cannot change what is installed. The app still repeats `recheck()` before it dispatches and reports a moved tag. |

Shared code: the release verification chain moves out of the Tauri crate into a new crate `packages/companion-release` (no Tauri dependency), used by `apps/agent` and `apps/client/src-tauri`, so there is one implementation (the repository's jscpd gate allows no clones). The agent already links `reqwest` with `rustls-tls-webpki-roots` through `lazysh-notification-client`, so the update adds no TLS stack and verifies certificates against bundled roots on every host, including static musl builds with no system store.

Rate limits: unauthenticated GitHub API calls are limited per IP address ([GitHub documents 60 requests per hour](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). The CLI therefore never polls, sends `If-None-Match` with the stored ETag, honors `Retry-After` and records the failure for backoff. The bootstrap uses the public release download URL, not the API. The CLI honors `HTTPS_PROXY` and `https_proxy` for `CONNECT` tunnelling only (TLS stays end to end and is verified against the bundled roots, so an intercepting proxy fails closed); the proxy URL, its credentials and every request URL are never printed or stored. The app's own client keeps ignoring proxies.

## Host-side update flow

1. **Detect.** The app runs the positive Unix probe it has (`resolve::detect`). A new positive Windows probe runs `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>` (base64 survives `cmd.exe`, PowerShell and POSIX quoting alike) and is tried when the POSIX probe finds no `sh`. An unidentified shell stays unsupported: nothing is guessed.
2. **Capability and current state.** The app runs `lazysh-agent update --status --json` through the existing managed-executable resolver. Exit 0 means the companion has `update` and reports its version and previous version, offline and instantly. Exit 2 (unknown subcommand), 126 or 127 (missing or not executable, the codes `required_command` already maps) selects the bootstrap. `--status` is the probe because it needs no network.
3. **Pin.** The phone fetches and verifies the metadata for the host's target (`<os>-agent-<arch>`: `linux-agent-x64`, `linux-agent-arm64`, `macos-agent-x64`, `macos-agent-arm64`, `windows-agent-x64`) and builds the pin. If the installed version equals the pin, the app reports `upToDate` and touches nothing. A host newer than the pin ends as `downgradeRefused` (exit 23 semantics, decided by the app before dispatch) and offers no action.
4. **Run on the host.** Fast path: `lazysh-agent update --json --yes --version V --expect-sha256 H --expect-bytes N`. Bootstrap: the fixed script with `VERSION SHA256 BYTES TARGET DIR` as validated arguments. Either streams progress lines and ends with one result object (same schema). The app needs a new exec primitive for this: today `ssh::exec_bounded` maps every non-zero exit to `remote_command_failed` and discards stdout, which would lose the exit codes below. The new primitive returns exit status, stdout and stderr, streams complete lines to the progress channel, and is bounded by the operation deadline and an output cap. `exec_bounded` is unchanged.
5. **Confirm.** The app does not trust the host's JSON alone: it re-runs `--version` through the resolver and requires `lazysh-agent <pin version>`, exactly as it does today (`CheckingInstalled`).
6. **Refresh.** No companion process is resident, and hooks and the app bind the absolute managed path, which the atomic replace keeps valid. Long-lived channels (`transcript-watch`, `account-usage --watch-channel`) keep running the old image until they close (a running executable survives a rename on Unix); the app clears its cached "companion lacks this command" memos (the one-minute re-ask of `transcript-watch` and `herdr-conversation`) so the new capabilities are used at once. A hook that is bound to a PATH copy is not changed; the result reports `current.managed` so the app can say so.
7. **Report.** Stages shown to the user: `detecting`, `checkingRelease` (the phone's metadata), `downloading` (on the host, with byte counts), `verifying`, `selfTesting`, `installing`, `checkingInstalled`. `uploading` and `cleaningUp` exist only in the fallback.

Failure mapping in the panel: 20 and 30 offer the labelled fallback; 22 is shown as a security event ("the downloaded file did not match the release"), never retried silently; 23 explains that the host has a newer companion; 24 and 25 say the previous version is still installed; 26 says another update is running; 29 is the existing `uncertain` state.

## CLI contract

```
lazysh-agent update [--check | --dry-run | --rollback | --status]
                    [--version X.Y.Z [--allow-downgrade]]
                    [--channel stable|prerelease]
                    [--expect-sha256 HEX64 --expect-bytes N]
                    [--yes] [--json]
```

| Flag | Contract |
| --- | --- |
| *(no mode flag)* | Install the latest release of the channel, or `--version`. Requires `--yes`, or an interactive confirmation on a terminal. |
| `--check` | Resolve and report `current` and `latest`. No download, no change. Exit 0 when up to date, **10 when an update is available**. |
| `--dry-run` | Resolve, download to the private staging area, verify the pin and size, run the self-test, then delete everything. Changes nothing installed. |
| `--rollback` | Replace the managed binary with the kept previous one through the same verified, self-tested replace; the replaced binary becomes the new previous, so a second `--rollback` undoes the first. Exit 28 when there is none. |
| `--status` | Offline, no lock: current and previous binary, last check and last operation recorded on disk (and, from [#1446](https://github.com/mihazs/lazysh/issues/1446), the auto-update policy). The app's capability probe and update-available source. |
| `--version X.Y.Z` | Resolve that release (`releases/tags/vX.Y.Z`) instead of the latest. Strict `X.Y.Z`; a lower version than the installed one needs `--allow-downgrade`. |
| `--allow-downgrade` | Only with `--version`. The app never passes it. `--rollback` is its own explicit act and needs no flag. |
| `--channel` | `stable` (the release GitHub marks latest: not draft, not prerelease) or `prerelease` (the highest SemVer 2.0 release that is not a draft). Defaults to the auto-update policy, else `stable`. Until the pipeline publishes prereleases the second resolves like the first. |
| `--expect-sha256`, `--expect-bytes` | The app's pin. Require `--version` and each other. The host refuses (exit 22) unless its own resolution matches both. |
| `--yes` | Required for any mutation without a terminal. `--json` never prompts, so `--json` without `--yes` on a mutation is a usage error (exit 2). |
| `--json` | stdout is newline-delimited JSON, one object per line, each with `"schemaVersion": 1` and an `event`. The last line is always the `result`. Human output otherwise. Errors never print URLs, environment or proxy credentials. |

Mode flags are mutually exclusive; `--version` conflicts with `--rollback` and `--status`.

**Progress events** (`--json` only; `downloading` is throttled to at most four per second):

```json
{"schemaVersion":1,"event":"stage","stage":"resolving"}
{"schemaVersion":1,"event":"stage","stage":"downloading","bytes":1048576,"total":11694768}
{"schemaVersion":1,"event":"stage","stage":"verifying"}
{"schemaVersion":1,"event":"stage","stage":"selfTesting"}
{"schemaVersion":1,"event":"stage","stage":"replacing"}
{"schemaVersion":1,"event":"stage","stage":"checkingInstalled"}
```

**Result object** (fields not applicable to the action are `null` or absent):

```json
{
  "schemaVersion": 1,
  "event": "result",
  "action": "check | update | dryRun | rollback | status",
  "outcome": "upToDate | available | updated | dryRunOk | rolledBack | status | failed | uncertain",
  "exitCode": 0,
  "error": null,
  "current":  {"version": "1.51.0", "path": "/home/u/.local/share/lazysh/companion/lazysh-agent", "sha256": "<64 hex>", "bytes": 11700000, "managed": true},
  "previous": {"version": "1.28.0", "sha256": "<64 hex>"},
  "latest":   {"version": "1.51.0", "channel": "stable", "target": "linux-agent-x64", "tag": "v1.51.0", "commit": "<40 hex>", "asset": "lazysh-1.51.0-linux-agent-x64.bin", "bytes": 11700000, "sha256": "<64 hex>"},
  "checkedAt": "2026-11-13T10:00:00Z"
}
```

A failure sets `"outcome":"failed"` and `"error":{"kind":"verificationFailed","detail":"digestMismatch","message":"<fixed text>","retryAfterSeconds":null}`. `kind` is the stable identifier in the table below; `detail` is optional and one of `dns`, `connect`, `timeout`, `tls`, `http`, `rateLimited`, `interrupted`, `digestMismatch`, `sizeMismatch`, `pinMismatch`, `redirectRefused`, `insecureUrl`, `commitMismatch`, `noDownloader`, `noDigestTool`. Messages are fixed strings, never remote text.

Compatibility rule: **readers ignore unknown fields; writers only add fields within schema 1; a breaking change bumps `schemaVersion`.** This matters more than for other companion output because auto-update will make a host's companion *newer* than its app.

**Exit codes** (shared by the CLI and the bootstrap; `auto-update` adds 40 to 42 in [#1446](https://github.com/mihazs/lazysh/issues/1446)):

| Exit | `error.kind` | Meaning | Retry |
| --- | --- | --- | --- |
| 0 | - | `upToDate`, `updated`, `dryRunOk`, `rolledBack`, `status` | - |
| 1 | `internal` | Unexpected failure (same class as the other subcommands) | no |
| 2 | - | Usage error (clap). Also what a companion without `update` answers. | - |
| 10 | - | `--check` only: an update is available (`outcome: available`, not an error) | - |
| 20 | `networkUnavailable` | DNS, connect, timeout, TLS handshake, interrupted body, HTTP 5xx, rate limit (403, 429) | later; offline fallback eligible |
| 21 | `releaseUnavailable` | No compatible verified release: inconsistent or invalid metadata, draft or prerelease on `stable`, platform not published, unknown version | no |
| 22 | `verificationFailed` | Digest, size, pin or tag-commit mismatch, body larger than declared or capped, redirect off the allow-list, non-HTTPS URL. Treated as a security event. | no |
| 23 | `downgradeRefused` | Target lower than installed without `--allow-downgrade` | explicit flag |
| 24 | `selfTestFailed` | The staged binary failed the identity or protocol check; nothing replaced | no |
| 25 | `rolledBack` | Replaced, the post-check failed, the previous binary was restored | investigate |
| 26 | `busy` | Another update or install holds the lock | later |
| 27 | `unsafeInstallLocation` | Managed namespace missing, foreign, group or world writable, a symlink, or not a local filesystem; unsupported OS or architecture | no |
| 28 | `noPreviousVersion` | `--rollback` with nothing to restore | no |
| 29 | `uncertain` | Committed but the result could not be confirmed | run `--status` |
| 30 | `hostToolMissing` | Bootstrap only: no `curl` or GNU `wget`, or no `sha256sum`/`shasum` (Windows: no usable .NET/PowerShell feature) | offline fallback eligible |

**State.** In the managed namespace (`$XDG_DATA_HOME` else `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows, followed by `lazysh/companion/`): `lazysh-agent[.exe]`, `lazysh-agent.previous`, the existing `installation.lock` (so `update` and `installation install` exclude each other) and `.update-<uuid>` staging files (mode 0700, removed on every exit path). In the companion state directory (`LAZYSH_STATE_DIR` overrides): `update-state.json` (mode 0600, at most 4 KiB, strict schema): previous version and SHA-256, last check, last operation, ETag, backoff counter. Absent state creates nothing on reads.

**Only the managed binary is ever written.** A PATH installation (`cargo install`, `/usr/local/bin`) is never modified in place: it may be root-owned, and writing outside the user's namespace needs privileges the CLI will not ask for. Run from a PATH copy, `update` installs or refreshes the managed copy exactly like the app's **Install companion**, and says that the PATH copy is unchanged. This matches the existing resolver, which prefers the managed executable and preserves PATH installations. `current` describes the managed binary when one exists.

## Bootstrap for companions without `update`

The app runs it as `sh -c '<script>' lazysh-bootstrap VERSION SHA256 BYTES TARGET DIR` (the same `sh -c <quoted script>` form `resolve.rs` already uses). `DIR` is the managed directory the positive probe computed. The script is a repository file embedded in the client, so it is reviewed like code and its SHA-256 can be printed for audit; it is not generated from user input.

1. `set -eu`, `umask 077`, POSIX `sh` only (the tests run it under dash, bash in POSIX mode and, where installed, BusyBox ash; no `eval`, no unquoted expansion). Every argument is validated by `case` patterns before use: `VERSION` is `X.Y.Z`, `SHA256` is 64 lowercase hex, `BYTES` is 1 to 67,108,864, `TARGET` is one of the four Unix agent targets, `DIR` is absolute without control characters. Anything else exits 2.
2. The managed directory is created with mode 0700 if absent, and must be a real directory owned by the user and not group or world writable (the same namespace rules `resolve.rs` enforces); otherwise exit 27. An atomic `mkdir` lock with a ten-minute stale rule gives exit 26 when another bootstrap runs.
3. **Download.** The URL is assembled by the script from the validated parts: `https://github.com/mihazs/lazysh/releases/download/v${VERSION}/lazysh-${VERSION}-${TARGET}.bin`. The host is a constant. `curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --max-redirs 3 --max-filesize BYTES --max-time 300`, or GNU `wget` only when it identifies itself as GNU Wget (BusyBox `wget` is refused because it may not validate certificates); neither: exit 30. The download runs under `ulimit -f` set from `BYTES`, a hard cap that does not depend on the server telling the truth. On this design's authoring machine `ulimit -f` cut both `curl` 8.23.0 and GNU `wget` off at the limit (exit 153, SIGXFSZ); a cap the downloader cannot exceed is independent of `Content-Length`. Redirect hosts cannot be allow-listed with `curl`, which is acceptable: integrity comes from the pin, not from the redirect target.
4. **Verify before anything runs.** `wc -c` must equal `BYTES` exactly (else 22) and `sha256sum` or `shasum -a 256` must equal `SHA256` (else 22; neither tool: 30). The file is not executable until this passes.
5. **Self-test** in a private scratch directory with `env -i`, only `LAZYSH_STATE_DIR` and `PATH` set: `--version` must print `lazysh-agent VERSION`; a fixed synthetic generic lifecycle event piped to `ingest --agent generic` must appear in `snapshot --limit 1`. Failure: exit 24, nothing replaced.
6. **Install.** If `lazysh-agent` exists it must be a regular, non-symlink file; its installed version is read with `--version` and a parseably newer one exits 23. It is copied to `lazysh-agent.previous` (a temporary name then `mv`, atomic), then the verified file is moved over `lazysh-agent` with `mv -f` in the same directory (`rename(2)`, atomic). A crash at any point leaves a runnable current binary.
7. **Post-check.** `lazysh-agent --version` of the installed path must match; otherwise the previous binary is moved back and the script exits 25 (29 if even the restore failed).
8. Output is the progress lines and one result object of the CLI schema (fewer fields are allowed; readers treat missing ones as unknown). `trap` removes the temporary file, the scratch directory and the lock on every exit path including HUP, INT and TERM. No `sudo`, `su`, `doas` or `pkexec`; writes only inside `DIR`. No environment or URL is printed.

**Windows.** `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64 of UTF-16LE>`. Windows PowerShell 5.1 is assumed; PowerShell 7 is not. The same steps: validated parameters, `[Net.ServicePointManager]` pinned to TLS 1.2, a streaming `HttpWebRequest` read that aborts past `BYTES` (`Invoke-WebRequest` has no size cap), `Get-FileHash -Algorithm SHA256`, self-test, rename-based replace (below), the same result schema and exit codes. **Constraint to verify in #1445:** `cmd.exe` limits a command line to 8,191 characters, and base64 of UTF-16LE is 8/3 of the script size, so the script must stay near 2.8 KB of source; if it cannot, it travels gzip plus base64 behind a fixed 300-character decoder. The ADR does not claim the script fits: it is a stated budget. This design could not execute PowerShell (none on the authoring machine); the script is executed on the Windows CI job.

**Dependencies on the host** (Unix): `sh`, `curl` or GNU `wget`, `sha256sum` or `shasum`, `find`, `mkdir`, `mv`, `cp`, `wc`, `chmod`, `grep`, `env`. A host missing a required tool exits 30 and gets the labelled fallback.

## Offline upload fallback

The existing flow (phone downloads, SFTP upload, `installation inspect`, `installation install --expected-plan`, `--version`) stays, moved behind a separate Tauri command (`install_companion_from_device`) and registered in the app-lock protected set like the others. It is offered only after exit 20 or 30 from the host (it cannot reach GitHub, or lacks a downloader or digest tool), as a secondary button labelled **Install through this device**, with text saying it downloads about 9 to 12 MB on this device. It needs SFTP and a Unix host, exactly as today. The default `install_companion` has no code path that fetches the asset: `Publisher::download` becomes available only to the fallback, and a test makes the default command fail if the client touches an asset URL. Rejected alternative: deleting the fallback, because air-gapped lab and corporate hosts are common SSH targets and the code is already written and tested.

## Replace, rollback and Windows

**Unix.** The staged file is created `O_EXCL | O_NOFOLLOW` with an unpredictable name inside the 0700 managed directory, written, size and digest checked on the open descriptor, only then `chmod 0700`. Then: hard-link (copy if the link fails) the current binary to a temporary name, `rename` it to `lazysh-agent.previous`, `rename` the staged file over `lazysh-agent`, `fsync` the directory. Every step is a same-directory `rename(2)`; at no instant is the current path missing or partial. The agent already has these primitives (`apps/agent/src/installation.rs`: lock, temporary file, `Directory::rename`, plan hash) and `update` reuses them rather than copying them.

**Windows.** A running executable can be renamed but not overwritten or deleted. The replace is therefore rename then place: rename `lazysh-agent.exe` to `lazysh-agent.exe.previous` (which becomes the rollback copy; the old previous is deleted first, and if it is still in use the update fails with 27 before touching anything), move the verified file to `lazysh-agent.exe`, and if the second step fails move the first back. Short retries (5 times, 200 ms) cover antivirus and indexer locks. Windows "replace on reboot" (`MOVEFILE_DELAY_UNTIL_REBOOT`) is rejected: it needs administrator rights to write the pending-rename registry key, and the design installs at user level only. The managed Windows location is `%LOCALAPPDATA%\lazysh\companion\lazysh-agent.exe`. **To be proven in #1444 on the Windows CI job:** that an update succeeds while the old image is running (a long-lived `account-usage --watch-channel` or `transcript-watch`), and that `--rollback` works the same way.

**Self-test (before the replace).** Run the staged binary with a cleared environment, working directory the staging directory, a 20-second limit and 64 KiB output cap: `--version` must print exactly `lazysh-agent <expected>`, and a synthetic generic lifecycle event must round-trip through `ingest --agent generic` and `snapshot --limit 1` in a throwaway `LAZYSH_STATE_DIR`. This is the "hook-protocol check": the hooks the user configured call `ingest` with this binary, so a binary that cannot do that must never become current. Executing the staged file is allowed only after its digest and size matched the pin: nothing runs before verification.

**After the replace.** Run the installed path's `--version`. A mismatch restores the previous binary and exits 25. `--rollback` goes through the same commit routine with the previous file as the source (its SHA-256 recorded in `update-state.json` is verified again first, and it is self-tested), so it cannot install a swapped file.

## Downgrade protection

Versions are compared with the strict `X.Y.Z` parser already in `release.rs` (leading zeros and non-numeric parts are rejected). `update` installs only when the target is strictly greater than the installed version; the same version is `upToDate`. A lower target needs `--version` and `--allow-downgrade`; the app never sends it, and the bootstrap enforces the same rule by reading the installed `--version`. An installed version that does not parse (a development build) is never replaced by `auto-update`, and replaced by an explicit `update --yes` only. After `--rollback`, `auto-update` will not reinstall the version the user rolled back from until a newer one is published (`blockedVersion` in `update-state.json`).

## Auto-update

Tracked by [#1446](https://github.com/mihazs/lazysh/issues/1446).

| Policy | Behavior |
| --- | --- |
| `off` | No scheduled or opportunistic check, no network. Manual `update` still works. |
| `notify` (**default**) | Checks at most once per interval and records the result for `update --status`. Never modifies the executable. |
| `install` | As `notify`, then installs through the same code as `update --yes` when every guard passes: target strictly newer, inside the optional update window (local host time, `HH:MM-HH:MM`), no session in the event store reported in a `working` state in the last 10 minutes (deferred otherwise, recorded as `deferred`), and the version has not failed before. A version that failed with 22, 24 or 25 is not retried automatically until a newer one exists. |

Settings: `policy`, `channel` (`stable` | `prerelease`), `intervalHours` (default 24, 1 to 720), `window` (default none). They live in **`auto-update.json`** in the state directory, mode 0600, at most 4 KiB, strict schema with a `revision` and the same lock and atomic-replace discipline as `settings.json`; absent means defaults and creates nothing. They are not added to `settings.json`: that file is read with `deny_unknown_fields` and its `settings update` takes exactly three booleans, so a new field would make older companions that share the state directory fail with `InvalidArgument`. The settings page in the app composes both.

Commands: `auto-update status | set --expected-revision R --policy P [--channel C] [--interval-hours N] [--window W|none] | enable | disable | run`, all with `--json`. `run` is what triggers execute. Additional exit codes: 40 `policyOff` (`enable` refuses while off), 41 `timerUnsupported`, 42 `timerFailed`.

Triggers:

- **Opportunistic.** `snapshot`, the read the app already issues, starts a detached, null-stdio, new-session `auto-update run` when a check is due. It never blocks the snapshot, and a detached child must not keep the SSH exec channel open (hence null stdio and a new session; on Windows `DETACHED_PROCESS`). **Hooks (`ingest`) never touch the network or spawn anything**: they run inside the agent's turns and are latency-critical.
- **Optional OS timer**, installed only by `auto-update enable`, from fixed templates with no user text, running the absolute managed path: a systemd **user** timer and service on Linux (`~/.config/systemd/user/lazysh-agent-update.*`, `systemctl --user enable --now`), a launchd agent on macOS (`~/Library/LaunchAgents/app.lazysh.agent-update.plist`), a Scheduled Task without elevation on Windows (`schtasks`). The timer fires at least daily; `run` enforces the interval itself. If the user manager, launchd domain or Task Scheduler is unavailable (a headless SSH-only account without lingering, for instance) `enable` exits 41 and changes nothing. `disable` removes only files carrying the lazysh marker; `status` reads the real OS state and reports `drift` when it differs from the expected unit. No `sudo`.

Offline and metered hosts: a failed check is not an error for a timer run (exit 0, recorded) and backs off 1 h, doubling to 24 h. Metered-link detection is **not implemented**; a host on a metered link should use `notify` or `off`. An update downloads under 12 MB.

**Changed default, called out.** `notify` is the default for new and updated companions, so a companion makes one conditional HTTPS request to GitHub per day when something drives it. No host identifier is sent: the request carries the user agent `lazysh-agent/<version>` and the platform target only, and GitHub sees the host's IP address as for any download. `lazysh-agent auto-update set --policy off` (or the same switch in Host settings) stops it. Companions older than this change are unaffected.

## Notification to the app

`update --status --json` carries `lastCheck {at, latest, available, error}`, `lastOperation {action, outcome, from, to, at, error}`, `current` and `previous`. The app reads it when Agents opens, after each connect, every six hours while foregrounded and after any update action, never on the five-second board poll (the board reads `snapshot` only). It shows the companion version in the Agent view and Host settings and an update-available badge from `lastCheck.available`. For a companion without `update` the badge compares its `--version` with the latest release the app has itself observed (metadata only, ETag, at most one fetch per six hours), so old hosts are still told. An older app reading a newer companion ignores unknown fields.

## Security requirements and where they are enforced

| Requirement | Mechanism | Tested by |
| --- | --- | --- |
| HTTPS only | Rust client `https_only(true)`; `curl --proto '=https' --proto-redir '=https'`; PowerShell `https` URL built from constants | Fake server serving plain HTTP and an `http://` redirect must be refused (exit 22) |
| Certificate verification | Bundled webpki roots in the CLI; system store for `curl` and PowerShell; BusyBox `wget` refused | Fake server with a certificate outside the test CA must be refused |
| Digest pinned from release metadata | Pin from the verified chain; host re-resolution; bytes compared before `chmod` | Tampered asset, wrong metadata digest, pin mismatch |
| Size cap | 64 MiB and the exact pinned byte count; streamed counting; `ulimit -f`; `--max-filesize` | Oversized `Content-Length`, over-long body, short body |
| No execution before verification | Staged file not executable until size and digest match; self-test only afterwards, in a cleared environment | A tampered asset that, if run, would create a marker file: the marker must not exist |
| Atomic replace, rollback | Same-directory `rename`; previous kept; post-check restores | Fault injected after the replace restores the old binary; a crash-point test at each rename |
| Downgrade protection | Strict `X.Y.Z` compare; `--allow-downgrade`; blocked version | Server advertising an older latest; explicit downgrade |
| No sudo, least privilege | Writes only the managed namespace, the state directory and (D) user-level timer files | A `PATH` shim for `sudo`, `su`, `doas` and `pkexec` that records calls must record none |
| No secrets in logs | Fixed error strings; no URLs, environment or proxy credentials | `HTTPS_PROXY=https://user:secret@...` must not appear in stdout, stderr or `update-state.json` |
| Test endpoint cannot ship | Override exists only under the Cargo feature `update-test-endpoint` | Release acceptance runs the shipped binary with the override set against a local server and asserts the server received no request |

## Test plan

Tests execute the real artifacts and assert exit codes, output, files and request logs (repository testing policy); none greps source text.

1. **Fake release server** (one implementation, in `packages/companion-release` under a `test-support` feature, using the `axum`, `rcgen` and `tokio-rustls` the agent already uses as dev-dependencies): self-signed CA, endpoints `releases/latest`, `releases/tags/vX`, `git/ref/tags/vX`, `releases/assets/{id}` (with a redirect to a CDN path), the public `releases/download/vX/<asset>` path, ETag and 304, and per-test faults: tampered or truncated body, connection dropped mid-body, oversized or lying `Content-Length`, wrong digest in the metadata, moved tag, draft or prerelease flag, missing platform, redirect to `http://` or a foreign host, 403/429 with `Retry-After`, slow body. It logs method, path and user agent of every request.
2. **CLI** (`apps/agent/tests/update.rs`, #1444): the real `lazysh-agent` built with `update-test-endpoint`, pointed at the server through `LAZYSH_UPDATE_TEST_ENDPOINT` and `LAZYSH_UPDATE_TEST_CA` and isolated `XDG_DATA_HOME`/`LAZYSH_STATE_DIR`. One test per exit code in the table, plus: up to date, update with the previous kept, `--dry-run` leaves no trace, `--rollback` twice, concurrent runs, staging residue removed on every failure, a real built agent as the downloaded asset passing the self-test, and the Windows replace-while-running case on the Windows job.
3. **Bootstrap script** (#1445): executed with a recording `curl` shim first in `PATH` (the technique `tests/pinned-download.test.ts` already uses) to assert, as observable behavior, the exact URL host, `--proto`, `--max-filesize` and absence of any other network tool; then against the fake server with the same script rendered with only two substituted values (base URL and CA file, tests only); then the PowerShell script on the Windows job. The production rendering has no CA or base-URL parameter.
4. **Owned SSH fixture** (#1445, `tests/support/sshFixture.ts` companion mode and the Rust owned-OpenSSH tests): the host is a user-namespaced `sshd` that shares loopback with the fake server. Two seeded hosts: **1.28.0** (`lazysh-1.28.0-linux-agent-x64.bin`, 11,481,648 bytes, SHA-256 `d8f0bab955d71e3d2f2d9731a2514c88f482b6809fe20593a9906737a977f1d0`) and **1.33.4** (`lazysh-1.33.4-linux-agent-x64.bin`, 11,514,416 bytes, SHA-256 `b37f2b673732b99fc2e751cf8974393a9329fc979d8e1ef205cf6829cc8b6804`), fetched in CI with `.github/scripts/pinned-download.sh` and checked against these digests. Each is updated through the bootstrap to the candidate build, ending with the new `--version`, the old binary kept as previous, and hooks and settings byte-identical. A third host with the candidate uses the CLI path. A test runs the real 1.28.0 binary with `update --status --json` and asserts exit 2, which proves the capability probe against a genuine old companion. A host with no route to the server must end with the labelled fallback and the fallback must still install.
5. **Zero download on the device** (#1445): the client runs against the fake server; the log must show only metadata requests from the client's user agent (`lazysh-companion-installer`) and exactly one asset request, from the host's (`lazysh-agent/<version>` or the shim `curl`). The client has no code path that fetches an asset except `install_companion_from_device`, which this test never calls.
6. **App**: Vitest for `CompanionInstallPanel` (stages, failure kinds, the labelled fallback only after 20 or 30, rollback, version and badge); Playwright on phone and desktop for the same; Rust tests for pin construction, the new exec primitive and app-lock admission of the new commands (the existing `protected_requests` test enumerates them).
7. **Auto-update** (#1446): every policy, due and not-due checks, ETag, offline backoff, window and active-turn deferral, blocked version, revision conflicts, and timer files rendered from templates and validated where a tool exists (`systemd-analyze verify`, `plutil -lint`, `schtasks /Query`).

**Limitations stated up front.** The agent's `axum`, `rcgen` and `tokio-rustls` dev-dependencies are `cfg(unix)` today; #1444 moves the fake server into the shared crate so the Windows job can run it. No Windows SSH fixture exists, so the Windows app path is covered by executing the PowerShell script and the CLI on the Windows job plus unit tests of the command construction, not by an end-to-end SSH session. launchd and Scheduled Task behavior can only be exercised on the macOS and Windows jobs. The Android emulator job is not extended unless the owned fixture proves reachable from it; the owned-SSH Rust and Bun tests are the acceptance for the phone-side guarantee. Real GitHub TLS and rate limits are not exercised in tests.

## Delivery

Each slice is complete and shippable on its own, merged to `main` independently, never stacked; only the last PR of an issue uses `Closes`.

| Issue | Slices (suggested) | Priority |
| --- | --- | --- |
| [#1443](https://github.com/mihazs/lazysh/issues/1443) A: this ADR and the docs | one PR | P1 |
| [#1444](https://github.com/mihazs/lazysh/issues/1444) B: CLI | B1 shared `packages/companion-release` crate (client switched to it, Windows `.exe` selection) with `update --check` and `--status`; B2 `update`, `--dry-run`, `--rollback` on Unix; B3 Windows replace and CI | P1 |
| [#1445](https://github.com/mihazs/lazysh/issues/1445) C: app | C1 exec primitive, pin, Unix bootstrap, default path no longer downloads, fallback command, panel stages (this alone fixes the phone download and does not need B); C2 CLI fast path, check, rollback and version display; C3 Windows probe and PowerShell bootstrap | P1 |
| [#1446](https://github.com/mihazs/lazysh/issues/1446) D: auto-update | D1 policy file, `auto-update status`, `set` and `run`; D2 opportunistic trigger; D3 OS timers; D4 settings UI and badge | P2 |

Order: A, then B1 and C1 in parallel; C2 after B2 is on `main`; D after B2. Every user-facing slice carries a `CHANGELOG.md` `[Unreleased]` entry and a minor changeset (`@lazysh/agent` and `@lazysh/client`) and ships through the normal release policy; changed defaults (the phone no longer downloads; `notify`) are called out.

## Alternatives considered

| Alternative | Why not chosen |
| --- | --- |
| Keep the phone download | Rejected by the user; it is the problem. |
| Host resolves everything, the app sends nothing | Loses the second network path (TLS-intercepting host proxy), forces JSON parsing into `sh`, and the app cannot refuse a downgrade before dispatch. Kept as an explicit, consented variant when the phone cannot reach GitHub. |
| Bootstrap by pushing a small updater binary over SFTP | Needs a trusted updater to start with, SFTP, and per-platform binaries; a 3 KB script is smaller to audit than a binary. |
| Only `SHA256SUMS` or the release body as the anchor | Same release, same trust channel: no independence over `release.json` plus GitHub's asset digest. |
| Sigstore attestation or a signing key in v1 | No signature exists; key custody and a verifier are separate release engineering. Left as a follow-up. |
| Update a PATH installation in place | Needs write access outside the user's namespace, often root. The managed binary is the one the app already prefers. |
| Windows replace on reboot | Needs administrator rights. |
| Auto-update default `install` or `off` | `install` replaces without opt-in; `off` would contradict the epic. `notify` was chosen with its egress called out. |
| Settings in `settings.json` | `deny_unknown_fields` plus a three-boolean `update` would break older companions sharing the state directory. |
| A resident updater daemon | The companion has no resident server and the design keeps it that way. |
| Hooks trigger the check | Hooks run inside agent turns and must stay offline and instant. |
| Remove the upload fallback | Air-gapped hosts would lose any in-app path. |

## Consequences

- The phone spends at most 344,064 bytes on an update instead of 9 to 12 MB, and stops depending on its route to GitHub for the transfer.
- The host needs outbound HTTPS to GitHub, `curl` or GNU `wget` and a SHA-256 tool for the bootstrap; without them the labelled fallback applies.
- The release asset naming (`lazysh-<v>-<os>-agent-<arch>.bin|.exe`), the 14-asset set and the `release.json` schema 1 become an updater contract; [release artifacts](../release-artifacts.md) records that changing them is a breaking change for every installed `lazysh-agent update`.
- Companions can become newer than their app, so every reader of companion JSON must ignore unknown fields.
- New code: a shared crate, the `update` and `auto-update` modules, a bootstrap script pair, an exec primitive, a Windows probe. Removed from the default path: the device download, SFTP staging and two stages.
- Hosts that do not enable a user service manager keep `notify` driven by app activity only.

## What was and was not verified

Verified while writing this: the client code paths cited above; the v1.50.0, v1.33.4 and v1.28.0 release assets, sizes and GitHub digests (`gh release view`); the `release.json` schema of v1.50.0; that no workflow publishes an attestation or signature; that `curl` 8.23.0 and GNU `wget` honor `ulimit -f` and that both `--proto-redir` and `--https-only` exist; `sh -n` on a throwaway draft of the bootstrap (not committed: the script lands with #1445); the owned SSH fixture's namespace (`bwrap --unshare-user`, no network namespace).

Not verified: any PowerShell behavior (none installed here), Windows running-image rename, the `cmd.exe` length budget, launchd, systemd user timers and Task Scheduler behavior, BusyBox `wget` certificate handling (refused by design instead), macOS `sh` `ulimit -f` units, and GitHub's rate-limit figures beyond its documentation. Each is an explicit acceptance item in #1444, #1445 or #1446.
