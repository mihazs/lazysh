# `lazysh-agent update` reference

The companion checks for, installs, tests and rolls back its own releases on the host, over the host's network, never through the phone. This page is the contract of what ships; the design and trust model are in ADR 0003 (tracked by [issue #1443](https://github.com/mihazs/lazysh/issues/1443)), and the parts that are still planned are listed at the end.

```
lazysh-agent update [--check | --dry-run | --rollback | --status]
                    [--version X.Y.Z [--allow-downgrade]] [--channel stable|prerelease]
                    [--expect-sha256 HEX64 --expect-bytes N] [--yes] [--json]
```

With no mode flag the command installs the release. The mode flags exclude each other.

| Flag | Contract |
| --- | --- |
| *(none)* | Installs the latest release of the channel, or `--version`. Asks `Install companion X over Y? [y/N]` on a terminal; without a terminal, and with `--json`, it needs `--yes` (exit 2 otherwise, before any network use). A host already at that version exits 0 with `upToDate` and changes nothing. |
| `--check` | Resolves the release and reports `current` and `latest`. Makes no change and creates no file. Exit 0 when up to date, **10 when an update is available**. |
| `--dry-run` | Does everything an install does up to the replace: resolve, download, verify, self-test. Then deletes what it staged. Nothing installed or recorded changes. Needs no confirmation. |
| `--rollback` | Reinstalls the kept previous companion through the same verified, self-tested replace. The companion it replaces becomes the new previous one, so a second `--rollback` undoes the first. Needs no network. Exit 28 when there is nothing to restore. |
| `--status` | Offline. Reports the installed companion, the previous copy and the last recorded operation. Never creates state and never touches the network. |
| `--version X.Y.Z` | Resolves that release (`releases/tags/vX.Y.Z`) instead of the latest. Strict `X.Y.Z`. A version older than the installed one exits 23 unless `--allow-downgrade` is given. (The latest release being older than the installed build is not an update: `upToDate`.) |
| `--allow-downgrade` | Only with `--version`. Installs an older release; the replaced one is kept as the previous copy. |
| `--channel` | `stable` (default) is the release GitHub marks latest: not a draft, not a prerelease. `prerelease` is the highest `X.Y.Z` among the newest ten releases that is not a draft. |
| `--expect-sha256`, `--expect-bytes` | A caller's pin of the asset: 64 lowercase hex digits and the byte count. They require `--version` and each other. The host still resolves the release itself and exits 22 (`pinMismatch`) unless its own resolution matches both, before it downloads anything. |
| `--yes` | Confirms an install or rollback without asking. |
| `--json` | Newline-delimited JSON: `{"schemaVersion":1,"event":"stage","stage":...}` progress lines, then one final `{"schemaVersion":1,"event":"result",...}` object. Without it the output is short text and an error goes to stderr. |

Usage errors (a missing or conflicting flag, a version that is not `X.Y.Z`, no `--yes`) exit 2, the same status an older companion gives for the unknown `update` subcommand.

## Progress events

`stage` is one of `resolving`, `downloading` (with `bytes` and `total`; at most four per second, the last one always sent), `verifying`, `selfTesting`, `replacing` and `checkingInstalled`. A rollback sends only the last three.

## Result object

```json
{
  "schemaVersion": 1,
  "event": "result",
  "action": "update",
  "outcome": "updated",
  "exitCode": 0,
  "error": null,
  "current":  {"version": "1.56.0", "path": "/home/u/.local/share/lazysh/companion/lazysh-agent", "sha256": "<64 hex>", "bytes": 11700000, "managed": true},
  "previous": {"version": "1.55.0", "sha256": "<64 hex>"},
  "latest":   {"version": "1.56.0", "channel": "stable", "target": "linux-agent-x64", "tag": "v1.56.0", "commit": "<40 hex>", "asset": "lazysh-1.56.0-linux-agent-x64.bin", "bytes": 11700000, "sha256": "<64 hex>"},
  "checkedAt": "2026-11-13T10:00:00Z"
}
```

`action` is `check`, `update`, `dryRun`, `rollback` or `status`; `outcome` is `available`, `upToDate`, `updated`, `dryRunOk`, `rolledBack`, `status`, `failed` or `uncertain`. `--status` adds `lastCheck` (null until auto-update records one) and `lastOperation`. `current` describes the managed copy (`<user data>/lazysh/companion/lazysh-agent`) when there is one, else the running executable with `"managed": false`; after an install it is the installed file. `current.version` is null when that copy cannot print `lazysh-agent X.Y.Z`. A failure keeps what was learned before it (`current`, `latest`). Readers must ignore unknown fields: a writer only adds fields within `schemaVersion` 1.

A failure sets `"outcome": "failed"` and `"error": {"kind", "detail", "message", "retryAfterSeconds"}`. `message` is a fixed sentence, never remote text. Output never contains a URL, an environment value or proxy credentials.

| Exit | `error.kind` | Meaning |
| --- | --- | --- |
| 0 | | Up to date, updated, dry run passed, rolled back, or `--status`. |
| 10 | | `--check` only: an update is available. Not an error. |
| 1 | `internal` | Unexpected failure (for example a full disk). |
| 2 | | Usage error, or an install or rollback that was not confirmed. |
| 20 | `networkUnavailable` | DNS, connect, timeout, TLS handshake, an interrupted body, HTTP 5xx, or a rate limit (403, 429; `retryAfterSeconds` carries `Retry-After`, at most one day). |
| 21 | `releaseUnavailable` | No compatible verified release: unknown version, a draft or prerelease on `stable`, a platform nobody published, or malformed metadata. |
| 22 | `verificationFailed` | The release's own sources disagree (GitHub's asset digest or size against `release.json`, `release.json` against its GitHub digest, the tag against the recorded commit); the downloaded bytes differ from the published digest or size; a body is larger than declared; a redirect leaves the allow-list or is not HTTPS; the server's certificate is not trusted; the caller's pin or the kept previous copy does not match. Treated as a security event, never retried. |
| 23 | `downgradeRefused` | `--version` names a release older than the installed one without `--allow-downgrade`. |
| 24 | `selfTestFailed` | The staged binary did not pass the self-test. Nothing was replaced. |
| 25 | `rolledBack` | The binary was replaced, the check of the installed file failed, and the previous binary was restored. |
| 26 | `busy` | Another update or `installation install` holds the lock. |
| 27 | `unsafeInstallLocation` | The managed directory is not a private directory of this user on a local filesystem (it is writable by others, a symlink, or the installed file is not owner-only), or there is no published companion for this operating system and architecture, or no user data directory. On Windows it also covers a kept previous copy that is still in use (see below). |
| 28 | `noPreviousVersion` | `--rollback` with no kept previous copy, or one nobody recorded. |
| 29 | `uncertain` | The replace may have completed but could not be confirmed or undone. Run `--status`. |

`error.detail` is one of `dns`, `connect`, `timeout`, `tls`, `http`, `rateLimited`, `interrupted`, `digestMismatch`, `sizeMismatch`, `pinMismatch`, `redirectRefused`, `insecureUrl`, `commitMismatch`.

## What is verified, and in which order

1. **The release.** The release, the tag's commit, `release.json` and the per-target receipt must agree with GitHub's own digest and size for the asset, over HTTPS to `api.github.com/repos/mihazs/lazysh/` only, with certificates verified against bundled roots, at most three redirects each re-checked against an allow-list, and bodies capped (a companion at 64 MiB, `release.json` at 64 KiB). The request carries the user agent `lazysh-agent/<version>` and nothing that identifies the host. `HTTPS_PROXY` and `https_proxy` are honored for a `CONNECT` tunnel only (TLS stays end to end and is verified, so an intercepting proxy fails closed); `ALL_PROXY` and `HTTP_PROXY` are ignored.
2. **The pin.** If the caller gave one, it must match before anything is downloaded.
3. **The download** goes into a private file in the managed directory, mode 0600 and not executable. It must be exactly the published byte count, and its SHA-256 must equal the published digest, as streamed and again as read back from disk.
4. **The self-test** is the first time the new bytes run. Only then is the file made executable. In an empty environment (only a private `LAZYSH_STATE_DIR` and `PATH=/usr/bin:/bin`), with a 20-second limit per step: `--version` must print exactly `lazysh-agent <release version>`, a generic lifecycle event piped to `ingest --agent generic` must succeed, and `snapshot --limit 1` must return it. A binary that cannot do what the configured hooks ask of it never becomes current.
5. **The replace.** On Linux and macOS the installed binary is copied (digest-checked) to a private file, then the new file is renamed over `lazysh-agent`, and that rename is atomic: at no instant is the installed path missing or partial. The installed path is then checked again (its size and digest, and `--version`). A failed check renames the copy back (exit 25); if even that fails the result is `uncertain` (29). On success the copy becomes `lazysh-agent.previous`. On Windows a running `lazysh-agent.exe` can be renamed but not overwritten, so the replace is rename then place (below).

`update` never calls `sudo`, `su`, `doas` or `pkexec`, and writes only the managed directory and the state directory. A copy of the companion elsewhere on `PATH` (a `cargo install`, `/usr/local/bin`) is never modified; run from one, `update` installs the managed copy when a newer release exists and the `PATH` copy stays as it was. Hooks and the app run the managed copy.

## Windows

The managed directory is `%LOCALAPPDATA%\lazysh\companion`, the files are `lazysh-agent.exe` and `lazysh-agent.exe.previous`, and staging files end in `.exe` so the self-test can start them. The replace renames the installed `lazysh-agent.exe` to `lazysh-agent.exe.previous` (allowed while it runs, which is the usual case: the app runs `update` from the managed copy) and then renames the verified file to `lazysh-agent.exe`; if the second rename fails the first is undone. Between the two renames the installed name does not exist, which Linux and macOS never allow. The previous kept copy is deleted first: if it is still the image of a running process the command exits 27 before it changes anything, and works once that process ends. Short retries (five attempts, 200 ms apart) cover antivirus and indexer locks. Replacing a file on reboot is not used because it needs administrator rights. The directory check refuses links and non-regular files but does not inspect ACLs: the per-user profile is the boundary. The `lazysh-agent.exe` of a `PATH` copy is never modified, as on the other platforms.

## State and files

The managed directory `<user data>/lazysh/companion` (`$XDG_DATA_HOME` or `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows) holds `lazysh-agent`, `lazysh-agent.previous`, `installation.lock` (shared with `installation install`, so the two exclude each other) and, only while a run is in progress, `.update-*` and `.previous-*` staging files. A run that was killed leaves them; the next install or rollback removes them under the lock. An existing managed directory is never repaired: if it is not private to this user the command exits 27.

`update-state.json` in the companion state directory (`LAZYSH_STATE_DIR` overrides it; mode 0600, at most 4 KiB) records `previous {version, sha256}` and `lastOperation {action, outcome, from, to, at, error}` for the installs and rollbacks that took the lock. It is read by `--status` (`previous` is reported only while `lazysh-agent.previous` exists). Unknown fields are kept and ignored, so an older companion rolled back over a newer file does not lose them; an unreadable or oversized file reads as empty. Failing to write it never fails an update that already replaced the binary, but a rollback then reports 28. `settings.json`, hooks and the event store are never touched.

## Started by a newer app

The app is the trust anchor of an app-driven update. Every command an app runs on a Linux or macOS host sets `LAZYSH_APP_VERSION=X.Y.Z` (an app on a Windows host does not send it yet); a companion that predates this ignores it, and `ingest` and `approval-request`, the commands agents' hooks run, never act on it. A companion that is older than that version, with the [auto-update policy](../companion-settings.md#companion-updates) `install` (the default; `off` and `notify` change nothing), then:

1. **Decides offline.** A value that is not a strict `X.Y.Z` is `skipped` (`invalidAppVersion`, not echoed back), an app that is not newer does nothing, and so does a release the user rolled back from (`skipped`, `rolledBack`). A release that failed with exit 22, 23, 24, 25, 27 or 29 for this app version is `failed` and not tried again until a newer app connects, and one that failed otherwise waits one hour, doubling to a day (`notBefore` in `app-update.json`).
2. **Starts one runner.** `lazysh-agent auto-update run --app-version X.Y.Z` is started detached (own process group, no inherited descriptors, so it neither holds an SSH exec channel open nor dies with it), unless another runner holds `app-update.lock` (an advisory lock that dies with its process, so a crashed runner never blocks the next). The reply to the request in hand is not delayed.
3. **Waits for no agent turn.** A session the event store reports as `working` in the last ten minutes defers the run for two minutes (`skipped`, `activeTurn`).
4. **Runs `lazysh-agent update --yes --json --version X.Y.Z`**, nothing else, with a ten-minute limit. The target is the app's version; the host resolves that release and verifies it exactly as above, so a downgrade (exit 23), a prerelease and a version the app does not carry are not reachable. Exit 0 is `done`, 26 is `busy` (looked at again in a minute), 20 is a quiet `skipped` (`networkUnavailable`) and the other exits are `failed` with the `error.kind` as `reason`.

`snapshot` carries the outcome as `update: {"state","from","to","reason"?}`, only when an app newer than the companion asked (or one finished within ten minutes): `state` is `started` (this request started it), `running`, `done`, `failed` or `skipped`. `reason` is a fixed word: `policyOff`, `policyNotify`, `policyUnreadable`, `invalidAppVersion`, `rolledBack`, `activeTurn`, `busy`, `interrupted`, `internal` or an `error.kind` above.

`lazysh-agent auto-update status|set` read and write the policy (`auto-update.json`: `schemaVersion`, `revision`, `policy`); `auto-update run` is internal and not meant to be run by hand.

## Not yet available

The app's **Update companion** (it still downloads on the device), the shell bootstrap for companions without `update`, and the scheduled auto-update checks (channel, interval, window, OS timers) of [#1446](https://github.com/mihazs/lazysh/issues/1446).
