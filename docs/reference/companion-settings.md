# Companion settings reference

| CLI operation | Contract |
| --- | --- |
| `settings show` | Reads the current response, including revision; no absent-state creation. |
| `settings update` | Requires `--expected-revision` and all three explicit boolean flags: `--transcript-discovery-enabled`, `--recorded-usage-enabled`, `--device-tools-enabled`. |
| `settings features show` | Reads the [host feature switches](#host-feature-switches) and their revision; no absent-state creation. |
| `settings features update` | Requires `--expected-revision` and both explicit boolean flags: `--simulator-streaming-enabled`, `--port-scan-enabled`. |

| Setting | Commands affected |
| --- | --- |
| Transcript discovery | `lazysh-agent discover` metadata listing. Explicit `transcript --path ...` reads remain available. |
| Recorded usage inspection | `lazysh-agent usage`, including recorded counters, Codex context metadata and provider windows. No background collector is enabled. |
| Device tools | All new `lazysh-agent devices` operations: inventory, probes, screenshots, Android/iOS streams, input and lifecycle controls. |

All three default to enabled when no settings file exists, preserving existing behavior. Reads of absent settings do not create the state directory, database, lock or config file. A disabled command fails before reading the selected transcript or dispatching an SDK process. Malformed, unsupported or unsafe settings fail closed for these gated operations; they are not silently reset to defaults. Lifecycle ingestion/snapshots, approvals, explicit transcript reading and agent configuration fragments remain available.

Every successful update increments the revision exactly once. Native SSH APIs format only typed integer/boolean arguments and validate the bounded response; no arbitrary settings text is placed in a remote shell command.

The host browser switch has its own native commands, `get_host_browser_settings` and `update_host_browser_settings`, which run `lazysh-agent settings host-browser show` and `update --expected-revision R --host-browser-enabled true|false` on the same verified session with the same limits (4 KiB, schema version 1, revision below 2^53, unknown fields refused). They never carry the three switches above, and `get_companion_settings` and `update_companion_settings` never carry the host browser switch. A companion that predates the subcommand answers with clap's `error: unrecognized subcommand` usage error; that one error becomes the fixed kind `host_browser_companion_required`, which the app shows as an update message while it writes nothing. Every other failure, such as `SettingsConflict`, keeps its own text. The per-host confirmation is app-side only: one device-local list of host ids under `lazysh.hostBrowserConfirmed.v1`, outside the preferences that encrypted sync uploads.

Changes apply to **new CLI operations**. An already running command, device stream or preview continues until it is stopped; settings do not signal or kill existing processes. Later refresh/capture requests use the new value. These three switches do not affect port discovery or HTTP probing, which run through the app's own SSH implementation; the [port-scan feature switch](#host-feature-switches) covers them. The nested-agent and unlocked-desktop switches are [separate](#notification-policy-nested-agents-and-an-unlocked-desktop).

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

Native Cargo fixtures cover absent-file reads, persistent typed updates, concurrent/stale revision handling, CLI gates before unavailable transcript/SDK paths, permissions, links, FIFO rejection and bounds, and, for the feature switches, absent and stale reads, the streaming refusal against fake `adb`, `idb` and `ffmpeg` that log every start, and the older-companion reader. They are Unix-only for the fake SDK tools; no real Android emulator or iOS simulator was started for this change. Vitest covers versioned parsing, actual update payloads, unavailable companions, conflicts and late responses from an old SSH session. No developer's real settings or SDK/device is used by these tests.

## Host feature switches

Two further switches live in their own strict file, **`host-features.json`**, in the same state directory, with its own revision, its own lock (`host-features.lock`) and the same 4 KiB limit, mode 0600 and atomic-replace discipline as `settings.json`. They are not fields of `settings.json` for the reason in the last paragraph below.

| Switch | Default | Effect |
| --- | --- | --- |
| `simulatorStreamingEnabled` | enabled | `lazysh-agent devices android ID stream` and `devices ios ID stream` fail with `SimulatorStreamingDisabled` before any SDK, `idb` or `ffmpeg` process starts. Inventory, probes, screenshots, input and lifecycle controls keep following **Device tools**, so a host can allow screenshots and forbid live video. A stream also still needs **Device tools** enabled: with both off the reason is `DeviceToolsDisabled`. |
| `portScanEnabled` | enabled | When off, the Preview panel reads the file before every discovery, does not invoke `discover_preview_ports`, sends no HTTP check, and says the scan is turned off on the host. |

**Port scanning is enforced by the app, not by the companion.** Listener discovery and the HTTP check run through the app's own native SSH connection (`ss`, `lsof`, then `HEAD /`); the companion is not involved and cannot refuse them. The switch therefore binds a lazysh app that reads `host-features.json` before scanning, which this app does, and nothing else: another SSH client, or an app version from before this change, is not stopped by it. Streaming, in contrast, is enforced by the companion itself.

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "simulatorStreamingEnabled": false,
  "portScanEnabled": true
}
```

Absent means both enabled, and `settings features show` then creates nothing (no directory, lock or file). `settings features update` takes the lock, checks `--expected-revision` under it and bumps the revision exactly once; a stale revision returns `SettingsConflict` and a held lock `SettingsBusy`, as for `settings update`. Unknown or missing fields, other schema versions, non-boolean values, invalid revisions and files above 4 KiB are refused, and a device stream then fails closed with `InvalidArgument` instead of reading the file as defaults.

**Restart semantics.** Nothing is restarted or signalled. A change applies to **new operations**: the next `devices ... stream` command reads the file, and the Preview panel reads it at the start of each scan. A stream that is already running continues until it is stopped; a scan already issued finishes. An automatic scan that finds the switch off stops after that one read and resumes only when a later manual scan finds it on again.

**An app without the file.** A host whose companion has no `settings features` (older, not installed, or a host the app cannot identify as Linux or macOS on x64 or arm64) has no feature switches, so every switch counts as enabled and the Preview panel scans as before. On a Linux or macOS host, a `host-features.json` the companion refuses makes the Preview panel report the error and not scan, and the Host companion settings panel then offers no feature switches while the other three stay editable.

**Remembered Preview choices.** The Preview panel remembers whether the user chose the HTTP check and the automatic refresh, per saved host, in this device's local storage (`lazysh.preview.scan.<host id>`; the port filter keeps its own key). The remembered choice never overrides the host switch.

**Update policy is not part of this schema.** The auto-update policy (see [Auto-update policy](#auto-update-policy)) lives in a separate strict `auto-update.json` with its own revision, lock and 4 KiB limit. `settings.json` keeps exactly the five fields above and `settings update` keeps its three boolean flags, because this schema refuses unknown fields and an older companion sharing the state directory would otherwise fail with `InvalidArgument`.

**The host browser switch is not part of this schema either.** [Host browser](../host-browser.md) has one switch, `hostBrowserEnabled`, and unlike the three above it is **off** when no file exists, because it is the only switch that can reach the user's signed-in web sessions. It lives in its own strict file, `host-browser.json`, in the same state directory, with its own revision, `host-browser.lock` and 4 KiB limit, for the same reason as the update policy: `settings.json` refuses unknown fields, so a sixth field there would make every released companion that shares the directory fail closed on the other three switches, and a `settings show` response with a sixth field would be refused by a released client. Both keep their five fields and three flags unchanged; a released client neither sees nor overwrites the new switch.

| CLI operation | Contract |
| --- | --- |
| `settings host-browser show` | Reads `{"schemaVersion":1,"revision":0,"hostBrowserEnabled":false}`; an absent file reads as off and creates nothing. |
| `settings host-browser update` | Requires `--expected-revision` and `--host-browser-enabled true\|false`; a stale revision returns `SettingsConflict`, a held lock `SettingsBusy`. |

The gate fails closed. Every host-browser command except **Clear browser data** (`host-browser --clear-data`) reads the switch before it validates arguments, finds a browser or creates a profile, and refuses with `HostBrowserDisabled` when the switch is off or absent, and with `InvalidArgument` when `host-browser.json` is malformed, has another schema version, is unsafe (linked, shared or a special file) or exceeds 4 KiB; it is never reset to a default. Clearing stays available with the switch off so that a user who turned the feature off can still remove the profile it kept; it only deletes that one profile and never starts a process. Like the other switches it applies to new commands: turning it off does not stop a browser that is already running. The hidden launcher also still needs the developer flag `LAZYSH_DEV_HOST_BROWSER=1` until the relay ships.

The browser's profile lives under `host-browser/` in the state directory (mode 0700). Each launcher claims its profile with a marker `<name>.pid` that holds its pid, removes both when it ends, and removes the profiles of dead launchers when the next one starts. **Keep profile** (`--keep-profile`, on the launcher and on `host-browser serve`) uses the single profile `host-browser/kept`, which survives until `host-browser --clear-data` and is refused while a running launcher holds it (`BrowserProfileInUse`). A pid that the operating system has reused for another process keeps a crashed launcher's profile until a later start.

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
| `collectorEnabled` | `true` | Whether the [usage collector](#usage-collector) records samples. Set by `usage-collector enable` and `disable`. |
| `collectorIntervalMinutes` | `30` | The collector's interval, 5 to 1440. |

With `accountQuotaEnabled` set to `false`, `lazysh-agent account-usage` answers `{"schemaVersion":1,"state":"disabled","source":null,"report":null}` and exits 0. It does so **before** it opens a credential file, starts `ai-usagebar` or a helper process, or makes a request. `disabled` means the quota is unknown because the host forbids reading it: there is no report, so the app shows no percentage and never zero. A policy file that is malformed, has another schema version, an interval outside 5 to 1440, unknown fields or more than 4 KiB makes `account-usage` fail (exit 1, no output), so a host that tried to forbid the read is never treated as allowing it; the file is not repaired.

The change applies to the **next** `account-usage` call. A read already running finishes; nothing is signalled. The guarantee covers the host companion's `account-usage` command, which the app uses for every remote host. It does not govern a companion older than this switch (such a companion has no `usage-collection` command and exits with status 2), nor the desktop app's own read of the machine it runs on, which does not go through the companion.

Native Cargo fixtures run the real binary with a fake `ai-usagebar` that records when it starts: the default policy starts it, a forbidden read does not, a re-enabled switch applies without a restart, and an unreadable policy fails closed. They also cover absent-file reads, persistent updates, stale revisions, strict parsing and file modes. Vitest covers the `disabled` state, which shows no meter and no percentage.

## Usage collector

`lazysh-agent usage-collector` records bounded samples of the account quota report while no lazysh app is open. It is **enabled by default** with no saved policy. Managed companion setup provisions the user timer when supported. Manual installations can run `ensure`. The design is [ADR 0005](../architecture/adr-0005-background-usage-collection.md).

| CLI operation | Contract |
| --- | --- |
| `usage-collector enable [--interval-minutes N]` | Installs the user-level timer (below), then records `collectorEnabled: true` and the interval (5 to 1440; absent keeps the stored one, default 30) in `usage-collection.json`. Idempotent. Exit 41 when this account cannot hold a timer (nothing changed) and 42 when the system or an existing file refuses it (written files put back and policy preserved). |
| `usage-collector ensure` | Provisions a missing timer on a supported host when collection and account quota reads are enabled. Returns status and preserves saved policy. |
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

**In the app.** The usage page runs `usage-collector status --limit 24` over the session's SSH connection (a native command, `usage_collector_status`) and revalidates the host's answer before it reaches the page: schema version, every enumeration, bounds (at most 24 samples, 32 accounts and 16 rows each, 512 KiB), and text without control or bidirectional characters. A field it does not know is ignored. A companion without `usage-collector` (exit status 2, 126 or 127) is reported as needing an update. The page ages each time against `observedAt` (the host's clock), not the phone's. It shows no controls: the switches are changed on the host.

**Suspend, shutdown and offline.** Nothing runs while the host is off or suspended, and no sample is invented for the gap. The first tick after it finds the interval elapsed and records **one** sample (systemd `Persistent=true`, launchd and Task Scheduler catch up the same way), never a burst. A tick while offline records an `unavailable` run and no sample. The gap stays visible in the timestamps.

**Privacy boundary.** The one thing the collector adds is that the host contacts each configured provider on the user's interval while no lazysh app is open, with the credentials the quota read already uses. The interval has a 5-minute floor. It reads no transcript, writes nothing outside the state directory and the timer files, sends nothing anywhere itself, stores no credential and exports nothing: the app receives samples only through `usage-collector status` over the user's own SSH connection.

**Restart semantics.** Nothing is resident, so nothing restarts. `enable`, `disable` and `usage-collection update` apply from the next tick or the next `account-usage` call. A read already running finishes; a run in flight when `disable` returned writes nothing. Updating the companion does not touch the timer: the units hold the absolute path of the executable, which an atomic replace keeps valid, but a companion moved or deleted leaves a timer pointing at nothing (`status` reports `drift`). `enable` and `disable` take one lifecycle lock (`usage-collector-lifecycle.lock`, taken only once the account is known to hold a timer) and wait for each other, so the timer and the policy never end up disagreeing. A failed re-enable leaves the collector that was already on in place, and `enable` refuses a launchd job with the collector's label that lazysh did not load instead of replacing it; an earlier launchd or systemd install is loaded again when a replacement fails.

Native Cargo tests run the collector with an injected clock, quota reader and temporary state directory (off writes nothing, one sample per interval and the slack, projection and what never leaks, bounds, retention, count and size, forbidden and offline reads, suspend, a clock moved back, a policy change during a read, an unreadable file). Other tests run the real binary against stand-in `systemctl`, `launchctl`, `schtasks` and `loginctl`: files rendered and read back (`systemd-analyze verify` on the systemd units, an XML parser on the launchd and Task Scheduler documents), the exact commands issued, exit 41 and 42, foreign files left alone, drift, idempotence, and a real `usage-collector run` against a stand-in `ai-usagebar`. One manual run on a Linux desktop (systemd 262, lingering on) used the real user manager: `enable --interval-minutes 15` installed the units and `systemctl --user is-enabled` answered `enabled`, the timer was listed with the next five-minute tick, `systemctl --user start lazysh-usage-collector.service` ran `usage-collector run` (exit 0, `{"outcome":"off"}` because that unit reads the account's own state directory, where the collector is off), and `disable` removed both units and the timer. **Not exercised:** a real launchd or Task Scheduler, a real suspend and resume, a real tick followed by a recorded sample under the user manager, and any Windows or macOS host.

## Companion updates in the app

`get_companion_settings` adds `autoUpdate: {revision, policy}` to the response when `lazysh-agent auto-update status` answers (`policy` is `off`, `notify` or `install`; a companion without the command has no `autoUpdate`, and a failed status read is that, not an error). `update_companion_settings` takes an optional `autoUpdate: {expectedRevision, policy}`, which the app only sends when the policy changed; the host's reply to `lazysh-agent auto-update set --expected-revision R --policy P` replaces the value shown, and a `SettingsConflict` is reported like the other settings. Every command the app runs on a Linux or macOS host sets `LAZYSH_APP_VERSION`; a `snapshot` reply's `update` field becomes the one-line row of the Agents panel (`started` and `running` show progress, `done` the new version, `failed` says the companion stays on its version, and `skipped` is shown only for `policyOff`, `policyNotify` and `activeTurn`). See [Companion update](companion-update.md#started-by-a-newer-app).

## Notification policy: nested agents and an unlocked desktop

Two opt-in switches decide whether a lifecycle event may queue a [relay notification](../notification-relay.md#opt-in-the-host-companion) on this host. Both default to **off**, which is the behavior before they existed, so no default changes. They live in their own `notification-policy.json` with its own revision, `notification-policy.lock` and 4 KiB limit, for the same reason as the update policy: `settings.json` and `settings update` stay exactly as they are, and an older companion sharing the state directory keeps reading `settings.json` and ignores the new file.

| CLI operation | Contract |
| --- | --- |
| `settings notifications show` | Reads the policy and revision; an absent file reports both switches off and creates nothing. |
| `settings notifications update` | Requires `--expected-revision` and both `--nested-agent-suppression-enabled` and `--suppress-while-desktop-unlocked`. A stale revision is `NotificationPolicyConflict`, a busy lock `NotificationPolicyBusy`. |
```json
{
  "schemaVersion": 1,
  "revision": 1,
  "nestedAgentSuppressionEnabled": true,
  "suppressWhileDesktopUnlocked": false
}
```

**What a switch changes.** Only whether a state change is added to the relay outbox. The event is always recorded locally, so `snapshot`, the Agent view and the board show it exactly as before, and an event already queued stays queued. A change applies to the next hook run: every hook is its own process, so nothing needs a restart. An unreadable or invalid policy file counts as no policy, so a hook is never refused over a preference; `settings notifications show` is where the file is reported as invalid.

**Nested agents.** With `nestedAgentSuppressionEnabled`, an `ingest` or `approval-request` from an agent that another supported agent started stores the event and queues no relay event. For `approval-request` (Claude Code and Codex), no approval is taken either: nothing is listed for the phone, the hook prints nothing, and the agent decides as it would without the hook (Codex then shows its own terminal prompt). A nesting is claimed only when it is seen, in one of two ways:

- **A declared parent session**, on every platform. A launcher that starts an agent on purpose sets `LAZYSH_PARENT_SESSION_ID` (1 to 256 printable characters) in that agent's environment, for example `LAZYSH_PARENT_SESSION_ID="$session_id" codex exec ...` in a hook of the outer agent. The value is only checked for shape, never stored or sent.
- **Process ancestry**, on Linux and macOS (and other Unix hosts). The companion walks up to 64 parent processes (`/proc` where the host has it, otherwise `ps`) and recognizes an agent by its command name or by the script an interpreter runs: `claude`, `codex`, `opencode`, `gemini`, `droid`, `kimi`, `copilot`, `cursor-agent`, `amp` and `cline`. The reporting agent's own process is not a nesting; any other agent above it is. Processes of one agent that follow each other directly count once, because that is a launcher script and the program it starts.

What it does not detect, which therefore notifies as before:

- Windows: no process ancestry; only the declared parent session works.
- An agent running under a name that is not listed (a renamed or wrapped binary shown as `node` with no script name), and agents that do not call the companion, such as Aider.
- The same agent started by itself with no other process between them, which looks like a launcher and its program.
- A hook that detaches from its parent (a double fork or `setsid` daemon): its ancestry ends at the init process.
- A hook-less nesting where the inner agent never calls `lazysh-agent`: nothing is reported, so there is nothing to suppress.

**Unlocked desktop.** With `suppressWhileDesktopUnlocked`, a state change queues no relay event while the host's own desktop is known to be unlocked. It is evaluated on the host that runs the companion and fails open: **only a known unlocked desktop suppresses; a locked, unknown or unreadable state notifies.**

- Linux (systemd-logind): `loginctl show-user UID -p Display` names the user's display session, then `loginctl show-session ID -p Type -p Remote -p Active -p LockedHint`, each bounded at 2 seconds. The desktop is unlocked only for a local (`Remote=no`), active (`Active=yes`) `x11`, `wayland` or `mir` session with `LockedHint=no`. A session over SSH, on a text console, in the background, or a host without `loginctl` reads as unknown.
- macOS and Windows: not implemented. The state is always unknown, so the switch never suppresses there.
- `LockedHint` is only as accurate as the screen locker. One that never sets it leaves the hint at `no`, which this reads as unlocked, and notifications are then suppressed while the screen is locked. Lock the screen and read `loginctl show-session "$(loginctl show-user "$UID" -p Display --value)" -p LockedHint` before relying on the switch.
- It detects a lock, not presence: an unlocked desktop that nobody sits at still suppresses.

**Verification and limits.** Rust fixtures cover the defaults, the revision protocol, the `settings.json` compatibility, the rule table for both switches against injected process trees and session states, the `loginctl` argument and output handling against a controlled `loginctl`, and the `lazysh-agent` binary end to end (the relay policy row is written into the state database, because a live relay needs a server): a declared parent session and a real process chain of scripts named `claude` and `codex` are stored without a relay event while the switch is on and queue one while it is off, an unlocked, locked and absent `loginctl` give suppress, notify and notify, and a nested permission request takes no approval. On one Linux desktop (CachyOS, systemd-logind, Wayland) the real provider reported the locked session as `Locked`, matching `loginctl`, and a hook run by a script named `claude` inside a real Claude Code session was detected as nested, while the same script detached from every agent was not. **Not run:** macOS and Windows hardware (so the `ps` reader was exercised only through Linux's `ps`, not BSD's), any lock or unlock transition on a real desktop, other screen lockers and desktop environments, and the real `codex exec`, OpenCode, Gemini or other agent started by a real outer agent. The app has no control for these switches yet ([#1817](https://github.com/mihazs/lazysh/issues/1817)); change them with the commands above. macOS and Windows lock state and Windows process ancestry are tracked in [#1818](https://github.com/mihazs/lazysh/issues/1818).

## Auto-update policy

`lazysh-agent auto-update status` prints the policy and the last app-driven update; `auto-update set --expected-revision R --policy off|notify|install` changes it (a stale revision returns `SettingsConflict`, a concurrent writer `SettingsBusy`). A host with no file behaves as `install` and reading it creates nothing. The file `auto-update.json` in the [state directory](companion-events.md#state-directory-and-retention) is separate from `settings.json`, so companions that predate it keep reading `settings.json`:

```json
{ "schemaVersion": 1, "revision": 1, "policy": "install" }
```

The schema is strict like `settings.json`: another schema version, an unknown field or policy, and a file above 4 KiB are refused, and a policy that cannot be read blocks app-driven updates (`reason: "policyUnreadable"`); it is never replaced by the default. `status` also prints `appUpdate`, the record in `app-update.json` (`state`, `from`, `to`, `reason`, `failures`, `notBefore`, `blocked`), which the runner owns.

Related: [change host settings](../companion-settings.md) · [companion event storage](companion-events.md) · [documentation](../README.md).
