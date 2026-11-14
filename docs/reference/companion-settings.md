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
| `collectorEnabled` | `false` | Reserved for the opt-in background collector, which is not released yet; no command sets it and nothing records samples. |
| `collectorIntervalMinutes` | `30` | The collector's interval, 5 to 1440. Reserved with the field above. |

With `accountQuotaEnabled` set to `false`, `lazysh-agent account-usage` answers `{"schemaVersion":1,"state":"disabled","source":null,"report":null}` and exits 0. It does so **before** it opens a credential file, starts `ai-usagebar` or a helper process, or makes a request. `disabled` means the quota is unknown because the host forbids reading it: there is no report, so the app shows no percentage and never zero. A policy file that is malformed, has another schema version, an interval outside 5 to 1440, unknown fields or more than 4 KiB makes `account-usage` fail (exit 1, no output), so a host that tried to forbid the read is never treated as allowing it; the file is not repaired.

The change applies to the **next** `account-usage` call. A read already running finishes; nothing is signalled. The guarantee covers the host companion's `account-usage` command, which the app uses for every remote host. It does not govern a companion older than this switch (such a companion has no `usage-collection` command and exits with status 2), nor the desktop app's own read of the machine it runs on, which does not go through the companion.

Native Cargo fixtures run the real binary with a fake `ai-usagebar` that records when it starts: the default policy starts it, a forbidden read does not, a re-enabled switch applies without a restart, and an unreadable policy fails closed. They also cover absent-file reads, persistent updates, stale revisions, strict parsing and file modes. Vitest covers the `disabled` state, which shows no meter and no percentage.

Related: [change host settings](../companion-settings.md) · [companion event storage](companion-events.md) · [documentation](../README.md).
