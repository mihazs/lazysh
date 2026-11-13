# Companion settings reference

| CLI operation | Contract |
| --- | --- |
| `settings show` | Reads the current response, including revision; no absent-state creation. |
| `settings update` | Requires `--expected-revision` and all three explicit boolean flags: `--transcript-discovery-enabled`, `--recorded-usage-enabled`, `--device-tools-enabled`. |

| Setting | Commands affected |
| --- | --- |
| Transcript discovery | `lazysh-agent discover` metadata listing. Explicit `transcript --path ...` reads remain available. |
| Recorded usage inspection | `lazysh-agent usage`, including recorded counters, Codex context metadata and provider windows. No background collector is enabled. |
| Device tools | All new `lazysh-agent devices` operations: inventory, probes, screenshots, Android/iOS streams, input and lifecycle controls. |

All three default to enabled when no settings file exists, preserving existing behavior. Reads of absent settings do not create the state directory, database, lock or config file. A disabled command fails before reading the selected transcript or dispatching an SDK process. Malformed, unsupported or unsafe settings fail closed for these gated operations; they are not silently reset to defaults. Lifecycle ingestion/snapshots, approvals, explicit transcript reading and agent configuration fragments remain available.

Every successful update increments the revision exactly once. Native SSH APIs format only typed integer/boolean arguments and validate the bounded response; no arbitrary settings text is placed in a remote shell command.

Changes apply to **new CLI operations**. An already running command, device stream or preview continues until it is stopped; settings do not signal or kill existing processes. Later refresh/capture requests use the new value. Port discovery and HTTP probing currently run through a separate native SSH implementation, so these switches do not affect them. There is no port-scan or nested-agent switch that lacks an enforcing implementation.

The response and persisted `settings.json` use this strict schema:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "transcriptDiscoveryEnabled": true,
  "recordedUsageEnabled": false,
  "deviceToolsEnabled": true
}
```

Unknown/missing fields, other schema versions, non-boolean switches, invalid revisions and files above 4 KiB are refused. The location is the companion [state directory](companion-events.md#state-directory-and-retention), overridden by `LAZYSH_STATE_DIR` when explicitly configured. Settings contain only feature flags and a revision; no credentials, prompts, terminal contents or device frames are stored here.

Updates hold a private `settings.lock`, check the expected revision under that lock, and atomically replace the config using a private temporary file. The config is synced before replacement, and the containing directory is synced on Unix. Lock release is explicit on every exit path. On Unix the state directory must belong to the current user with no group/other permissions, and config/lock files must be owned regular files with one hard link and no group/other permissions. Parent directories must belong to the current user or root and resist group/other replacement; trusted sticky temporary directories are allowed. Leaf symlinks and special files are refused, with no-follow/nonblocking opens. New Unix directories use mode 0700 and files 0600. Other platforms use the operating system's user-state ACLs; this work does not independently verify Windows ACL enforcement for custom state-directory overrides.

Native Cargo fixtures cover absent-file reads, persistent typed updates, concurrent/stale revision handling, CLI gates before unavailable transcript/SDK paths, permissions, links, FIFO rejection and bounds. Vitest covers versioned parsing, actual update payloads, unavailable companions, conflicts and late responses from an old SSH session. No developer's real settings or SDK/device is used by these tests.

## Auto-update policy

`lazysh-agent auto-update status` prints the settings, the last scheduled check, when the next one may use the network (`nextCheckAt`, `null` under `off`) and the last app-driven update. `auto-update set --expected-revision R --policy off|notify|install` changes them (a stale revision returns `SettingsConflict`, a concurrent writer `SettingsBusy`); the settings are:

| Setting | Flag of `set` | Values | Default |
| --- | --- | --- | --- |
| `policy` | `--policy` (required) | `off`: no check, no network. `notify`: checks and records, never changes the executable. `install`: also installs. | `install` |
| `channel` | `--channel` | `stable` (the release GitHub marks latest) or `prerelease` (the highest version that is not a draft) | `stable` |
| `intervalHours` | `--interval-hours` | 1 to 720: how often a check may use the network | 24 |
| `window` | `--window` | `HH:MM-HH:MM` in the host's local time, or `none`: when an install may start. An end earlier than the start runs over midnight (`22:00-06:00`). | none |

A setting `set` does not name keeps its value. A host with no file behaves as the defaults and reading it creates nothing. The file `auto-update.json` in the [state directory](companion-events.md#state-directory-and-retention) is separate from `settings.json`, so companions that predate it keep reading `settings.json`. A field is written only when it differs from its default, so a file that only turns updates off is still read by a companion that does not know the other fields:

```json
{ "schemaVersion": 1, "revision": 2, "policy": "notify", "channel": "prerelease", "intervalHours": 6, "window": "22:00-06:00" }
```

The schema is strict like `settings.json`: another schema version, an unknown field or policy, an interval outside 1 to 720, a window that is not two clock times, and a file above 4 KiB are refused, and settings that cannot be read block updates (`reason: "policyUnreadable"`); they are never replaced by the defaults. `status` also prints `appUpdate`, the record in `app-update.json` (`state`, `from`, `to`, `reason`, `failures`, `notBefore`, `blocked`), which the runner owns. `lazysh-agent update --status` carries the same settings as `autoUpdate`.

### The scheduled check

`lazysh-agent auto-update run` is one scheduled check, started by the companion itself (see [the companion checks by itself](../companion.md#the-companion-checks-for-updates-by-itself)) or by hand. Under `off` it does nothing. Otherwise, when a check is due, it runs `update --check` on the channel and records the answer as `lastCheck` in `update-state.json`:

```json
{ "at": "2026-11-13T10:00:00Z", "latest": "1.56.0", "available": true, "error": null }
```

`available` is true while `latest` is newer than the installed companion; it is cleared when an update installs `latest` (or an older release), and a reader that wants to be certain compares `latest` with the version `update --status` reports. A check that failed keeps what was known about `latest`, sets `error` to `{"kind": ...}` (the `error.kind` words of [`update`](companion-update.md)), and counts `failures`; the next check waits until `notBefore`: one hour, doubling to a day. A host that is offline is therefore a recorded skip and exit 0, not an error. The check is noted as failed (`interrupted`) before the network is used, so a run that dies halfway, or a state directory that cannot be written (the run then exits 1), cannot make the host ask again at once.

Under `install` a newer release is then installed through the same guarded install a newer app starts (`update --yes --version <latest> --channel <channel>`): the release must be strictly newer than a version the installed companion can name (a development build is never replaced), the host's clock must be inside the window (otherwise `skipped`, `outsideWindow`; a newer app that connects is held by the same window), the release must not be one the user rolled back from, and not one that failed verification, self-test or restore (`blocked`, until a newer release exists) or is waiting out its backoff, and no session may have reported `working` in the last ten minutes (`skipped`, `activeTurn`). While a newer release waits like this it is looked at again every 30 minutes instead of every interval. The reply is `{"schemaVersion":1,"state":"checked|updated|skipped|failed","reason":"...","latest":"..."}`, always exit 0 unless the settings or state cannot be read or written.

Related: [change host settings](../companion-settings.md) · [companion event storage](companion-events.md) · [documentation](../README.md).
