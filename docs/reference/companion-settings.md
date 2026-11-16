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

Changes apply to **new CLI operations**. An already running command, device stream or preview continues until it is stopped; settings do not signal or kill existing processes. Later refresh/capture requests use the new value. Port discovery and HTTP probing currently run through a separate native SSH implementation, so these switches do not affect them. There is no port-scan switch that lacks an enforcing implementation, and the nested-agent and unlocked-desktop switches are [separate](#notification-policy-nested-agents-and-an-unlocked-desktop).

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
- **Process ancestry**, on Linux, macOS (and other Unix hosts) and Windows. The companion walks up to 64 parent processes and recognizes an agent by its command name or by the script an interpreter runs, reading the process table from `/proc` where the host has it, otherwise `ps`, and on Windows from a Toolhelp snapshot (`CreateToolhelp32Snapshot`, parent ids and image names, so `claude.exe` and `Claude.EXE` are the same and the `.exe` suffix does not matter). The names are: `claude`, `codex`, `opencode`, `gemini`, `droid`, `kimi`, `copilot`, `cursor-agent`, `amp` and `cline`. The reporting agent's own process is not a nesting; any other agent above it is. Processes of one agent that follow each other directly count once, because that is a launcher script and the program it starts.

What it does not detect, which therefore notifies as before:

- Windows: an agent whose process is not named for it. A Toolhelp snapshot has image names but no command lines, so an agent shipped as a `.cmd` shim or run by an interpreter (`node.exe cli.js`) shows only `cmd.exe` or `node.exe`, and only the declared parent session works for it. A native `claude.exe`, `codex.exe` or `opencode.exe` is recognized. Windows reuses a process id once its process exits, so an exited parent whose id another agent's program later took would be read as that agent.
- An agent running under a name that is not listed (a renamed or wrapped binary shown as `node` with no script name), and agents that do not call the companion, such as Aider.
- The same agent started by itself with no other process between them, which looks like a launcher and its program.
- A hook that detaches from its parent (a double fork or `setsid` daemon): its ancestry ends at the init process.
- A hook-less nesting where the inner agent never calls `lazysh-agent`: nothing is reported, so there is nothing to suppress.

**Unlocked desktop.** With `suppressWhileDesktopUnlocked`, a state change queues no relay event while the host's own desktop is known to be unlocked. It is evaluated on the host that runs the companion and fails open: **only a known unlocked desktop suppresses; a locked, unknown or unreadable state notifies.**

- Linux (systemd-logind): `loginctl show-user UID -p Display` names the user's display session, then `loginctl show-session ID -p Type -p Remote -p Active -p LockedHint`, each bounded at 2 seconds. The desktop is unlocked only for a local (`Remote=no`), active (`Active=yes`) `x11`, `wayland` or `mir` session with `LockedHint=no`. A session over SSH, on a text console, in the background, or a host without `loginctl` reads as unknown.
- macOS: `CGSessionCopyCurrentDictionary` returns the window-server session of the calling process. The desktop is unlocked only when that session is on the console (`kCGSSessionOnConsoleKey`), past the login window (`kCGSSessionLoginDoneKey`) and without the lock flag (`CGSSessionScreenIsLocked` is absent or false); the lock flag set to true is locked. A process outside a window-server session (started over SSH or by a daemon), a session in the background after a fast user switch, the login window, and a lock flag of an unexpected type all read as unknown. `CGSSessionScreenIsLocked` is not public API, which is why an absent flag counts only beside the two documented keys.
- Windows: `WTSQuerySessionInformationW` with `WTSSessionInfoEx` reads `SessionFlags` of the session the companion runs in (`WTS_SESSIONSTATE_UNLOCK` is unlocked, `WTS_SESSIONSTATE_LOCK` is locked, anything else unknown). It counts only when that session is the physical console (`WTSGetActiveConsoleSessionId`) and active (`WTSActive`). A hook that runs in the services session (started by OpenSSH or a service), a Remote Desktop session or a session that is disconnected after a fast user switch reads as unknown. Windows 7 and Server 2008 R2 report the two flags reversed (a documented Windows defect), which this does not special-case.
- `LockedHint` is only as accurate as the screen locker. One that never sets it leaves the hint at `no`, which this reads as unlocked, and notifications are then suppressed while the screen is locked. Lock the screen and read `loginctl show-session "$(loginctl show-user "$UID" -p Display --value)" -p LockedHint` before relying on the switch.
- It detects a lock, not presence: an unlocked desktop that nobody sits at still suppresses.

**Verification and limits.** Rust fixtures cover the defaults, the revision protocol, the `settings.json` compatibility, the rule table for both switches against injected process trees and session states, the `loginctl` argument and output handling against a controlled `loginctl`, the macOS and Windows decision tables against injected session states (they run on Linux CI too), the Windows process chain with Windows image names, and the `lazysh-agent` binary end to end (the relay policy row is written into the state database, because a live relay needs a server): a declared parent session and a real process chain of scripts named `claude` and `codex` are stored without a relay event while the switch is on and queue one while it is off, an unlocked, locked and absent `loginctl` give suppress, notify and notify, and a nested permission request takes no approval. On one Linux desktop (CachyOS, systemd-logind, Wayland) the real provider reported the locked session as `Locked`, matching `loginctl`, and a hook run by a script named `claude` inside a real Claude Code session was detected as nested, while the same script detached from every agent was not. On macOS and Windows runners (`native-desktop`, which runs on pushes to `main` and not on pull requests) the real readers are exercised: the macOS one reads the runner's window-server dictionary and requires booleans under the two documented keys, the Windows one reads the session of the test process and checks it against `ProcessIdToSessionId`, the macOS one also runs the `ps` process-table test against macOS's `ps`, and a Windows test starts a real child and finds it in the Toolhelp snapshot by parent id and image name. The macOS and Windows code was also type-checked and linted for `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` from Linux (the macOS reader in isolation). **Not run:** any lock or unlock transition on a real macOS or Windows desktop (a hosted runner has no one to lock the screen, so `CGSSessionScreenIsLocked` and `SessionFlags` were never observed changing), the `ps` reader on BSDs other than macOS, other screen lockers and desktop environments, a Windows hook started by a real outer agent, and the real `codex exec`, OpenCode, Gemini or other agent started by a real outer agent. Before relying on the switch on a Mac or Windows PC, lock and unlock it while a hook runs and confirm that the next notification arrives while locked and not while unlocked. The app has no control for these switches yet ([#1817](https://github.com/mihazs/lazysh/issues/1817)); change them with the commands above. Real lock and unlock transitions on macOS and Windows hardware stay open on [#1818](https://github.com/mihazs/lazysh/issues/1818).

Related: [change host settings](../companion-settings.md) · [companion event storage](companion-events.md) · [documentation](../README.md).
