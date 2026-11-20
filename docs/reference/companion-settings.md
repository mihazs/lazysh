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

**Update policy is not part of this schema.** The planned auto-update policy ([ADR 0003](../architecture/adr-0003-host-side-companion-update.md#auto-update), [#1446](https://github.com/mihazs/lazysh/issues/1446)) lives in a separate strict `auto-update.json` with its own revision, lock and 4 KiB limit. `settings.json` keeps exactly the five fields above and `settings update` keeps its three boolean flags, because this schema refuses unknown fields and an older companion sharing the state directory would otherwise fail with `InvalidArgument`. For the same reason `host-features.json` is a separate file: an older companion never opens it, so creating it changes nothing for that companion (checked by a Cargo test that reads the `settings.json` written beside it with the strict older schema).

**The host browser switch is not part of this schema either.** [Host browser](../host-browser.md) has one switch, `hostBrowserEnabled`, and unlike the three above it is **off** when no file exists, because it is the only switch that can reach the user's signed-in web sessions. It lives in its own strict file, `host-browser.json`, in the same state directory, with its own revision, `host-browser.lock` and 4 KiB limit, for the same reason as the update policy: `settings.json` refuses unknown fields, so a sixth field there would make every released companion that shares the directory fail closed on the other three switches, and a `settings show` response with a sixth field would be refused by a released client. Both keep their five fields and three flags unchanged; a released client neither sees nor overwrites the new switch.

| CLI operation | Contract |
| --- | --- |
| `settings host-browser show` | Reads `{"schemaVersion":1,"revision":0,"hostBrowserEnabled":false}`; an absent file reads as off and creates nothing. |
| `settings host-browser update` | Requires `--expected-revision` and `--host-browser-enabled true\|false`; a stale revision returns `SettingsConflict`, a held lock `SettingsBusy`. |

The gate fails closed. Every host-browser command except **Clear browser data** (`host-browser --clear-data`) reads the switch before it validates arguments, finds a browser or creates a profile, and refuses with `HostBrowserDisabled` when the switch is off or absent, and with `InvalidArgument` when `host-browser.json` is malformed, has another schema version, is unsafe (linked, shared or a special file) or exceeds 4 KiB; it is never reset to a default. Clearing stays available with the switch off so that a user who turned the feature off can still remove the profile it kept; it only deletes that one profile and never starts a process. Like the other switches it applies to new commands: turning it off does not stop a browser that is already running. The hidden launcher also still needs the developer flag `LAZYSH_DEV_HOST_BROWSER=1` until the relay ships.

The browser's profile lives under `host-browser/` in the state directory (mode 0700). Each launcher claims its profile with a marker `<name>.pid` that holds its pid, removes both when it ends, and removes the profiles of dead launchers when the next one starts. **Keep profile** (`--keep-profile`) uses the single profile `host-browser/kept`, which survives until `host-browser --clear-data` and is refused while a running launcher holds it (`BrowserProfileInUse`). A pid that the operating system has reused for another process keeps a crashed launcher's profile until a later start.

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

Related: [change host settings](../companion-settings.md) · [companion event storage](companion-events.md) · [documentation](../README.md).
