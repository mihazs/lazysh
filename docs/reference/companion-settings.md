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

**Update policy is not part of this schema.** The auto-update policy (see [Auto-update policy](#auto-update-policy)) lives in a separate strict `auto-update.json` with its own revision, lock and 4 KiB limit. `settings.json` keeps exactly the five fields above and `settings update` keeps its three boolean flags, because this schema refuses unknown fields and an older companion sharing the state directory would otherwise fail with `InvalidArgument`.

**The host browser switch is not part of this schema either.** [Host browser](../host-browser.md) has one switch, `hostBrowserEnabled`, and unlike the three above it is **off** when no file exists, because it is the only switch that can reach the user's signed-in web sessions. It lives in its own strict file, `host-browser.json`, in the same state directory, with its own revision, `host-browser.lock` and 4 KiB limit, for the same reason as the update policy: `settings.json` refuses unknown fields, so a sixth field there would make every released companion that shares the directory fail closed on the other three switches, and a `settings show` response with a sixth field would be refused by a released client. Both keep their five fields and three flags unchanged; a released client neither sees nor overwrites the new switch.

| CLI operation | Contract |
| --- | --- |
| `settings host-browser show` | Reads `{"schemaVersion":1,"revision":0,"hostBrowserEnabled":false}`; an absent file reads as off and creates nothing. |
| `settings host-browser update` | Requires `--expected-revision` and `--host-browser-enabled true\|false`; a stale revision returns `SettingsConflict`, a held lock `SettingsBusy`. |

The gate fails closed. Every host-browser command except **Clear browser data** (`host-browser --clear-data`) reads the switch before it validates arguments, finds a browser or creates a profile, and refuses with `HostBrowserDisabled` when the switch is off or absent, and with `InvalidArgument` when `host-browser.json` is malformed, has another schema version, is unsafe (linked, shared or a special file) or exceeds 4 KiB; it is never reset to a default. Clearing stays available with the switch off so that a user who turned the feature off can still remove the profile it kept; it only deletes that one profile and never starts a process. Like the other switches it applies to new commands: turning it off does not stop a browser that is already running. The hidden launcher also still needs the developer flag `LAZYSH_DEV_HOST_BROWSER=1` until the relay ships.

The browser's profile lives under `host-browser/` in the state directory (mode 0700). Each launcher claims its profile with a marker `<name>.pid` that holds its pid, removes both when it ends, and removes the profiles of dead launchers when the next one starts. **Keep profile** (`--keep-profile`) uses the single profile `host-browser/kept`, which survives until `host-browser --clear-data` and is refused while a running launcher holds it (`BrowserProfileInUse`). A pid that the operating system has reused for another process keeps a crashed launcher's profile until a later start.

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

### The operating system timer

Where nothing reads a snapshot for days (a host nobody opens the app on) the companion cannot start its own check, so an operating system timer can wake it. It is optional and off until you ask, and it is the user's own, never a system service: nothing here uses `sudo` or needs elevation.

| Command | What it does |
| --- | --- |
| `lazysh-agent auto-update enable` | Writes the timer files and turns the timer on. Exit 40 while the policy is `off`, 41 when this account cannot have one, 42 when the system refused (the files are put back as they were), 27 when there is no managed companion to run. |
| `lazysh-agent auto-update disable` | Turns it off and removes the files that carry the lazysh marker. Does nothing when nothing is installed. |
| `lazysh-agent auto-update status` | Adds `timer`: `{"kind","supported","installed","enabled","drift"}`, read from the system each time. `drift` is true when what is there is not what `enable` would write now (the companion moved, a file was edited, the timer was disabled behind our back, or only part is there). |

| Platform | Timer | Needs |
| --- | --- | --- |
| Linux | a systemd user timer and service, `~/.config/systemd/user/lazysh-agent-update.{timer,service}`, enabled with `systemctl --user enable --now` | A running user manager (a login session, or lingering). A bare SSH login without one is exit 41 and nothing is written. |
| macOS | a launchd agent, `~/Library/LaunchAgents/app.lazysh.agent-update.plist`, loaded with `launchctl bootstrap gui/<uid>` | A login session of the user (the `gui/<uid>` domain). Without one, exit 41. |
| Windows | a Scheduled Task `lazysh-agent-update` of the current user, at logon and every hour, created with `schtasks /Create /XML` | Task Scheduler, without elevation. |

The timer wakes `lazysh-agent auto-update run` of the **managed** companion (by its absolute path) every hour, with a few minutes of spread on Linux, and `run` decides from the settings whether a check is due, so changing the interval, channel, window or policy never touches the timer. A path that systemd cannot carry (a quote or a backslash in it) is refused (27) rather than escaped. A file or task of that name that does not carry the lazysh marker is somebody else's: `enable` refuses (42) and `disable` leaves it.

Verification: on Linux the written units are checked with `systemd-analyze verify` in the tests, against a stand-in `systemctl` (a test never touches a real user manager). The launchd property list and the Windows task definition are rendered and checked as well-formed documents and read back with an XML parser (and with `plutil -lint` where that exists), but nothing here ran `launchctl` or `schtasks` on a macOS or Windows host: those two drivers are compiled and type-checked everywhere, and their commands follow the tools' documented syntax. A Windows task starts a console program, so a console window may appear briefly each hour.

Related: [change host settings](../companion-settings.md) · [companion event storage](companion-events.md) · [documentation](../README.md).
