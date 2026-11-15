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

**Update policy is not part of this schema.** The planned auto-update policy ([ADR 0003](../architecture/adr-0003-host-side-companion-update.md#auto-update), [#1446](https://github.com/mihazs/lazysh/issues/1446)) lives in a separate strict `auto-update.json` with its own revision, lock and 4 KiB limit. `settings.json` keeps exactly the five fields above and `settings update` keeps its three boolean flags, because this schema refuses unknown fields and an older companion sharing the state directory would otherwise fail with `InvalidArgument`.

**The host browser switch is not part of this schema either.** [Host browser](../host-browser.md) has one switch, `hostBrowserEnabled`, and unlike the three above it is **off** when no file exists, because it is the only switch that can reach the user's signed-in web sessions. It lives in its own strict file, `host-browser.json`, in the same state directory, with its own revision, `host-browser.lock` and 4 KiB limit, for the same reason as the update policy: `settings.json` refuses unknown fields, so a sixth field there would make every released companion that shares the directory fail closed on the other three switches, and a `settings show` response with a sixth field would be refused by a released client. Both keep their five fields and three flags unchanged; a released client neither sees nor overwrites the new switch.

| CLI operation | Contract |
| --- | --- |
| `settings host-browser show` | Reads `{"schemaVersion":1,"revision":0,"hostBrowserEnabled":false}`; an absent file reads as off and creates nothing. |
| `settings host-browser update` | Requires `--expected-revision` and `--host-browser-enabled true\|false`; a stale revision returns `SettingsConflict`, a held lock `SettingsBusy`. |

The gate fails closed. Every host-browser command except **Clear browser data** (`host-browser --clear-data`) reads the switch before it validates arguments, finds a browser or creates a profile, and refuses with `HostBrowserDisabled` when the switch is off or absent, and with `InvalidArgument` when `host-browser.json` is malformed, has another schema version, is unsafe (linked, shared or a special file) or exceeds 4 KiB; it is never reset to a default. Clearing stays available with the switch off so that a user who turned the feature off can still remove the profile it kept; it only deletes that one profile and never starts a process. Like the other switches it applies to new commands: turning it off does not stop a browser that is already running. The hidden launcher also still needs the developer flag `LAZYSH_DEV_HOST_BROWSER=1` until the relay ships.

The browser's profile lives under `host-browser/` in the state directory (mode 0700). Each launcher claims its profile with a marker `<name>.pid` that holds its pid, removes both when it ends, and removes the profiles of dead launchers when the next one starts. **Keep profile** (`--keep-profile`) uses the single profile `host-browser/kept`, which survives until `host-browser --clear-data` and is refused while a running launcher holds it (`BrowserProfileInUse`). A pid that the operating system has reused for another process keeps a crashed launcher's profile until a later start.

## Usage collection policy

The account quota read has its own strict file, `usage-collection.json`, with its own revision, `usage-collection.lock`, 4 KiB limit and the same owner-only, atomic, symlink-refusing storage as `settings.json` ([ADR 0005](../architecture/adr-0005-background-usage-collection.md)). It is separate for the same reason as the update policy: an older companion would refuse an unknown key in `settings.json`.

| CLI operation | Contract |
| --- | --- |
| `usage-collection show` | Prints the policy, including its revision. An absent file reports the defaults and creates nothing. |
| `usage-collection update` | Requires `--expected-revision` and `--account-quota-enabled true|false`. Exit 1 with `SettingsConflict` on a stale revision and `SettingsBusy` while another writer holds the lock. |

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "accountQuotaEnabled": false,
  "collectorEnabled": false,
  "collectorIntervalMinutes": 30
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `accountQuotaEnabled` | `true` | Whether `lazysh-agent account-usage` may read provider quotas on this host. Existing hosts keep reading. |
| `collectorEnabled` | `false` | Whether the [usage collector](#usage-collector) records samples. Set by `usage-collector enable` and `disable`. |
| `collectorIntervalMinutes` | `30` | The collector's interval, 5 to 1440. |

With `accountQuotaEnabled` set to `false`, `lazysh-agent account-usage` answers `{"schemaVersion":1,"state":"disabled","source":null,"report":null}` and exits 0. It does so **before** it opens a credential file, starts `ai-usagebar` or a helper process, or makes a request. `disabled` means the quota is unknown because the host forbids reading it: there is no report, so the app shows no percentage and never zero. A policy file that is malformed, has another schema version, an interval outside 5 to 1440, unknown fields or more than 4 KiB makes `account-usage` fail (exit 1, no output), so a host that tried to forbid the read is never treated as allowing it; the file is not repaired.

The change applies to the **next** `account-usage` call. A read already running finishes; nothing is signalled. The guarantee covers the host companion's `account-usage` command, which the app uses for every remote host. It does not govern a companion older than this switch (such a companion has no `usage-collection` command and exits with status 2), nor the desktop app's own read of the machine it runs on, which does not go through the companion.

Native Cargo fixtures run the real binary with a fake `ai-usagebar` that records when it starts: the default policy starts it, a forbidden read does not, a re-enabled switch applies without a restart, and an unreadable policy fails closed. They also cover absent-file reads, persistent updates, stale revisions, strict parsing and file modes. Vitest covers the `disabled` state, which shows no meter and no percentage.

## Usage collector

`lazysh-agent usage-collector` records bounded samples of the account quota report while no lazysh app is open. It is **off by default**, nothing in it runs or is written until `enable`, and the design is [ADR 0005](../architecture/adr-0005-background-usage-collection.md).

| CLI operation | Contract |
| --- | --- |
| `usage-collector enable [--interval-minutes N]` | Installs the user-level timer (below), then records `collectorEnabled: true` and the interval (5 to 1440; absent keeps the stored one, default 30) in `usage-collection.json`. Idempotent. Exit 41 when this account cannot hold a timer (nothing changed) and 42 when the system or an existing file refuses it (written files put back, the collector stays off). |
| `usage-collector disable` | Records `collectorEnabled: false`, then removes the timer, and only files or tasks that carry the marker `lazysh-agent-managed: usage-collector`. A foreign file or task of the same name is left alone and gives exit 42. Recorded samples stay. |
| `usage-collector status [--limit N]` | Read only, creates nothing. Prints the policy, the timer, the last run and a summary of the samples; with `--limit` (0 to 200) also the newest samples, newest first. |
| `usage-collector run` | What the timer runs. Prints `{"schemaVersion":1,"outcome":"..."}` and exits 0 for every expected outcome. |

`run` outcomes: `off` (the collector is off: nothing was read, nothing was written, not even a lock file), `notDue` (the last run is younger than the interval), `busy` (another run or a policy change holds a lock), `recorded` (one sample appended), `skipped` (the host forbids account quota reads, reason `accountQuotaDisabled`: nothing was read) and `unavailable` (the read produced no report, for example `timeout`: the run is recorded, no sample is). A run reads the policy first, reads the quota once with the same code, deadlines and gate as `account-usage`, then takes the policy lock again and re-reads the policy **before it writes**, so a run that was in flight when `disable` returned writes nothing. A malformed policy or sample file makes `run` exit 1 and is never repaired; the sample file is disposable (delete it to start over), the policy file is not.

The timer ticks every five minutes. A run is due at the first tick that is at least the interval after the previous run, less one minute of slack (a run starts a moment after its tick, so a 5-minute interval would otherwise become 10). Intervals are therefore rounded up to a multiple of five minutes.

`status` output:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-11-14T12:05:00Z",
  "policyRevision": 2,
  "accountQuotaEnabled": true,
  "collector": {"enabled": true, "intervalMinutes": 30, "timer": {"state": "installed", "linger": false}},
  "lastRun": {"at": "2026-11-14T12:00:00Z", "outcome": "recorded", "reason": null},
  "samples": {"state": "ok", "count": 1, "oldest": "2026-11-14T12:00:00Z", "newest": "2026-11-14T12:00:00Z", "bytes": 512},
  "recent": []
}
```

`timer.state` is `absent`, `installed` (the files or task are exactly what `enable` writes and the service manager has them loaded), `drift` (something is there that is not exactly that, or is not loaded) or `unsupported` (no user service manager). `timer.linger` is the Linux user manager's `Linger` property, `null` elsewhere or when unreadable. `observedAt` is the host's clock: the app ages every sample against it, not against the phone's clock. `samples.state` is `invalid` for an unreadable sample file (reported, not repaired).

**Samples** live in `usage-samples.json` in the companion [state directory](companion-events.md#state-directory-and-retention) (mode 0600, atomic replace). A sample exists only for a read that produced a report:

```json
{"recordedAt": "2026-11-14T12:00:00Z", "source": "builtin", "truncated": false,
 "entries": [{"id": "anthropic", "name": "Claude", "status": "ready", "stale": false, "fetchedAt": "2026-11-14T11:59:00Z",
              "rows": [{"label": "Session", "percent": 42.5, "reading": "used", "resetAt": "2026-11-14T17:00:00Z", "windowSeconds": 18000}]}]}
```

`reading` says what `percent` measures (`used` or `left`). A reset or window the provider did not report is `null`, never zero. Only metric rows are kept: plan names, balances, free text, credentials, prompts, transcript text, session titles and paths are not, and at most 32 accounts with 16 rows each are kept (`truncated: true` when more existed). **Bounds:** at most 1000 samples, none older than 7 days and at most 1 MiB, oldest dropped first; at the 5-minute minimum interval the size and count bounds, not 7 days, limit the history. Nothing a user sets can grow the file. The bounds are fixed in this version.

**The timer** only wakes `usage-collector run`. No sudo, no elevation, no resident process; its files are fixed templates around the absolute path of the executable that ran `enable`, and nothing else reaches them.

| Host | Mechanism | Needs | Where |
| --- | --- | --- | --- |
| Linux | `systemd --user` service and timer, `OnCalendar=*:0/5`, `Persistent=true` | A reachable user manager (`systemctl --user show-environment`). The user manager only runs while the account has a session unless the owner runs `loginctl enable-linger USER`, which `enable` never does; `status` reports `linger`. A path with `"`, `\` or `%` is refused. | `$XDG_CONFIG_HOME/systemd/user/lazysh-usage-collector.{service,timer}` (default `~/.config`) |
| macOS | launchd agent, `StartInterval` 300 | The user's GUI login domain (`launchctl print gui/UID`); an SSH-only account without one exits 41. | `~/Library/LaunchAgents/app.lazysh.usage-collector.plist` |
| Windows | Scheduled Task of the current user, repeating every 5 minutes, `StartWhenAvailable` | An interactive logon: the task runs while the user is logged on. | Task `lazysh-usage-collector`, registered with `schtasks /Create /XML` |

**Suspend, shutdown and offline.** Nothing runs while the host is off or suspended, and no sample is invented for the gap. The first tick after it finds the interval elapsed and records **one** sample (systemd `Persistent=true`, launchd and Task Scheduler catch up the same way), never a burst. A tick while offline records an `unavailable` run and no sample. The gap stays visible in the timestamps.

**Privacy boundary.** The one thing the collector adds is that the host contacts each configured provider on the user's interval while no lazysh app is open, with the credentials the quota read already uses, so it is off by default and has a 5-minute floor. It reads no transcript, writes nothing outside the state directory and the timer files, sends nothing anywhere itself, stores no credential and exports nothing: the app receives samples only through `usage-collector status` over the user's own SSH connection.

**Restart semantics.** Nothing is resident, so nothing restarts. `enable`, `disable` and `usage-collection update` apply from the next tick or the next `account-usage` call. A read already running finishes; a run in flight when `disable` returned writes nothing. Updating the companion does not touch the timer: the units hold the absolute path of the executable, which an atomic replace keeps valid, but a companion moved or deleted leaves a timer pointing at nothing (`status` reports `drift`).

Native Cargo tests run the collector with an injected clock, quota reader and temporary state directory (off writes nothing, one sample per interval and the slack, projection and what never leaks, bounds, retention, count and size, forbidden and offline reads, suspend, a clock moved back, a policy change during a read, an unreadable file). Other tests run the real binary against stand-in `systemctl`, `launchctl`, `schtasks` and `loginctl`: files rendered and read back (`systemd-analyze verify` on the systemd units, an XML parser on the launchd and Task Scheduler documents), the exact commands issued, exit 41 and 42, foreign files left alone, drift, idempotence, and a real `usage-collector run` against a stand-in `ai-usagebar`. **Not exercised:** a real `systemctl --user enable` (the stand-in stands for the user manager), a real launchd or Task Scheduler, a real suspend and resume, and any Windows or macOS host.

Related: [change host settings](../companion-settings.md) · [companion event storage](companion-events.md) · [documentation](../README.md).
