# `lazysh-agent update` reference

The companion checks GitHub's release metadata on the host itself. This page is the contract of what ships; the design, trust model and the parts that are still planned (installing, rollback, auto-update) are in ADR 0003 (tracked by [issue #1443](https://github.com/mihazs/lazysh/issues/1443)).

```
lazysh-agent update --check  [--version X.Y.Z] [--channel stable|prerelease] [--json]
lazysh-agent update --status [--json]
```

One of `--check` and `--status` is required. Installing an update is not part of this command yet.

| Flag | Contract |
| --- | --- |
| `--check` | Resolves the release and reports `current` and `latest`. Makes no change and creates no file. Exit 0 when up to date, **10 when an update is available**. |
| `--status` | Offline. Reports the installed companion, the previous copy and the last recorded check and operation. Never creates state and never touches the network. Conflicts with `--version` and `--channel`. |
| `--version X.Y.Z` | Resolves that release (`releases/tags/vX.Y.Z`) instead of the latest. Strict `X.Y.Z`. A version older than the installed one exits 23. |
| `--channel` | `stable` (default) is the release GitHub marks latest: not a draft, not a prerelease. `prerelease` is the highest `X.Y.Z` among the newest ten releases that is not a draft. |
| `--json` | Newline-delimited JSON: `{"schemaVersion":1,"event":"stage","stage":"resolving"}` progress lines, then one final `{"schemaVersion":1,"event":"result",...}` object. Without it the output is short text and an error goes to stderr. |

Usage errors (a missing or conflicting flag, a version that is not `X.Y.Z`) exit 2, the same status an older companion gives for the unknown `update` subcommand.

## Result object

```json
{
  "schemaVersion": 1,
  "event": "result",
  "action": "check",
  "outcome": "available",
  "exitCode": 10,
  "error": null,
  "current": {"version": "1.55.0", "path": "/home/u/.local/share/lazysh/companion/lazysh-agent", "sha256": "<64 hex>", "bytes": 11700000, "managed": true},
  "previous": null,
  "latest": {"version": "1.56.0", "channel": "stable", "target": "linux-agent-x64", "tag": "v1.56.0", "commit": "<40 hex>", "asset": "lazysh-1.56.0-linux-agent-x64.bin", "bytes": 11700000, "sha256": "<64 hex>"},
  "checkedAt": "2026-11-13T10:00:00Z"
}
```

`outcome` is `available`, `upToDate`, `status` or `failed`. `--status` adds `lastCheck` and `lastOperation` (null until a later operation records them). `current` describes the managed copy (`<user data>/lazysh/companion/lazysh-agent`, `.exe` on Windows) when there is one, else the running executable with `"managed": false`; `current.version` is null when that copy cannot print `lazysh-agent X.Y.Z`. Readers must ignore unknown fields: a writer only adds fields within `schemaVersion` 1.

A failure sets `"outcome": "failed"` and `"error": {"kind", "detail", "message", "retryAfterSeconds"}`. `message` is a fixed sentence, never remote text. Output never contains a URL, an environment value or proxy credentials.

| Exit | `error.kind` | Meaning |
| --- | --- | --- |
| 0 | | Up to date, or `--status`. |
| 10 | | `--check` only: an update is available. Not an error. |
| 1 | `internal` | Unexpected failure. |
| 20 | `networkUnavailable` | DNS, connect, timeout, TLS handshake, interrupted body, HTTP 5xx, or a rate limit (403, 429; `retryAfterSeconds` carries `Retry-After`, at most one day). |
| 21 | `releaseUnavailable` | No compatible verified release: unknown version, a draft or prerelease on `stable`, a platform nobody published, or malformed metadata. |
| 22 | `verificationFailed` | The release's own sources disagree (GitHub's asset digest or size against `release.json`, `release.json` against its GitHub digest, the tag against the recorded commit), a body is larger than declared, a redirect leaves the allow-list or is not HTTPS, or the server's certificate is not trusted. Treated as a security event. |
| 23 | `downgradeRefused` | `--version` names a release older than the installed one. |
| 27 | `unsafeInstallLocation` | An operating system or architecture with no published companion, or no user data directory. |

`error.detail` is one of `dns`, `connect`, `timeout`, `tls`, `http`, `rateLimited`, `interrupted`, `digestMismatch`, `sizeMismatch`, `redirectRefused`, `insecureUrl`, `commitMismatch`.

## What is checked

The check follows the same chain as the app's installer: the release, the tag's commit, `release.json` and the per-target receipt must agree with GitHub's own digest and size for the asset, over HTTPS to `api.github.com/repos/mihazs/lazysh/` only, with certificates verified against bundled roots, at most three redirects each re-checked against an allow-list, and bodies capped (a companion at 64 MiB, `release.json` at 64 KiB). Nothing is downloaded or executed by `--check`, except that the managed copy is asked for its `--version` with an empty environment and a ten-second limit. The request carries the user agent `lazysh-agent/<version>` and nothing that identifies the host.

`HTTPS_PROXY` and `https_proxy` are honored for a `CONNECT` tunnel only (TLS stays end to end and is verified, so an intercepting proxy fails closed); `ALL_PROXY` and `HTTP_PROXY` are ignored.

## State

`update-state.json` in the companion state directory (`LAZYSH_STATE_DIR` overrides it) is read by `--status`: `previous {version, sha256}` (reported only while `lazysh-agent.previous` exists beside the managed copy), `lastCheck` and `lastOperation`. It is read-only for this command: absent means empty and creates nothing, an unreadable or oversized file reads as empty, unknown fields are ignored.
