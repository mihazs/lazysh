# Host companion settings

Disable or re-enable companion transcript discovery, recorded usage inspection or device tools for a host, and, separately, live simulator streaming and the app's port scanning. You need an installed [companion](how-to/configure-companion.md) and access to the same remote operating-system user.

The Agents panel shows host settings after a valid companion snapshot is available. It loads the settings over the selected verified SSH session. Controls appear only after a supported settings response; older companions show an update/setup message. Saving changes the remote operating-system user's companion configuration, shared by that user's lazysh clients. It does not save these switches in browser storage or change an agent's own configuration.

## Change settings in the app

1. Connect to the host, open **Agents**, and obtain a valid snapshot.
2. In host settings, change the required switches and choose **Save host settings**.
3. A host whose companion has `lazysh-agent auto-update` also shows **Companion updates**: **Update automatically** (the default: a companion older than this app updates itself to this app's version, on the host, never through the phone, and never during an agent turn), **Only tell me** or **Never**. It is saved with the other switches and changes `lazysh-agent auto-update` on the host. While a host updates, the Agents panel shows one line, **Updating the host companion to X…**, and then the new version; it never blocks the board.
4. If the companion is unsupported or unavailable, update it before retrying. If another client changed the revision, refresh and review its values before saving again.
5. Start a new operation to use the new values. Stop any existing stream separately; saving settings does not terminate it.

### Host browser

Under the three switches, **Host browser** has its own row and its own **Save host browser setting** button. It is **off by default** and the only switch that is, because a browser started on the host can reach the web sessions you sign in to inside it. The app reads and saves it separately from the three switches (the companion keeps it in its own file with its own revision), so saving one never sends the other's values.

- Turning it **on** asks first, once per host on this device. The confirmation names what the browser can reach: the host's network and the services listening only on the host, any file the browser can open, and every site you sign in to inside it. **Keep it off** changes nothing.
- The confirmation is remembered on this device for that saved host only. It is not part of [encrypted sync](sync.md), never leaves the device, and the app stores only the host's id for it: no page address, title or image. Two saved profiles for the same machine are asked separately. Turning the switch **off** needs no confirmation.
- A companion that predates the command shows the row as unavailable with a message to update the companion, and the app writes nothing. If another client changed the revision, the app asks you to refresh before saving again.
- Nothing in this row starts a browser: it only allows one. The browser view itself ships with the Chrome viewer ([#1254](https://github.com/mihazs/lazysh/issues/1254)).

The same panel has a second form, **Quiet notifications**, with two switches that decide which events may notify your phone: **Do not notify for nested agents** and **Do not notify while this desktop is unlocked**. Both are **off** by default. They are kept in their own file with their own revision, so **Save notification switches** saves only them and **Save host settings** saves only the three switches above; a conflict on one never discards edits to the other. The form appears only when the companion answers `lazysh-agent settings notifications show`; a companion that predates it shows an update message instead, and a read that fails for another reason shows the companion's own error.

- The unlocked-desktop switch works on **Linux hosts only**. On macOS, Windows or an unknown lock state the setting is ignored and you are always notified.
- The nested-agent switch relies on process ancestry on Linux and macOS, and on `LAZYSH_PARENT_SESSION_ID` on every host.

## Change settings from the host terminal

These shell commands require a PATH installation. For a managed-only installation, use the app controls above or substitute its verified [absolute executable path](how-to/configure-companion.md#install-on-the-remote-host). Run `lazysh-agent settings show` and note its revision. To disable recorded usage only when that revision is `0`, run:

```sh
lazysh-agent settings update --expected-revision 0 \
  --transcript-discovery-enabled true \
  --recorded-usage-enabled false \
  --device-tools-enabled true
```

Replace `0` with the revision actually returned by `show`; review all three values before writing. A stale revision returns `SettingsConflict`. On `SettingsBusy`, reread after the other writer finishes. Confirm the returned values with `lazysh-agent settings show`. Do not delete malformed settings to bypass a refusal.

## Host browser switch

[Host browser](host-browser.md) is **off by default** and is the only switch that is, because it is the only one that can reach the signed-in web sessions of the browser it starts. It is not one of the three switches above and not part of `settings show`: it has its own file and revision (`host-browser.json`), so that a released lazysh client or companion that shares the host keeps reading and updating the other three. Nothing in the app turns it on yet; the browser view and its first-use confirmation ship with the Chrome viewer ([#1254](https://github.com/mihazs/lazysh/issues/1254)). From the host terminal:

```sh
lazysh-agent settings host-browser show
lazysh-agent settings host-browser update --expected-revision 0 --host-browser-enabled true
```

While it is off, or its file is unreadable, every host-browser command refuses before it starts a process. Turning it off does not stop a browser that already runs. `lazysh-agent host-browser --clear-data` removes the profile that **Keep profile** left, and works with the switch off. See the [reference](reference/companion-settings.md) for the file, the errors and the profile lifetime.

## Forbid account quota reads on a host

`lazysh-agent account-usage` reads each configured provider's quota with the host's own sign-ins and makes outbound requests to those providers. By default any connected lazysh app may ask for it. To forbid it on a host, run on that host (the app does not offer this switch yet):

```sh
lazysh-agent usage-collection show
lazysh-agent usage-collection update --expected-revision 0 --account-quota-enabled false
```

Replace `0` with the revision `show` returned. While the switch is off, the AI account usage page and the status-bar item show that this host does not allow account usage reads, with **no percentage**: the quota is unknown, not zero. Nothing reads a credential file, starts a helper or contacts a provider. Turn it back on with `--account-quota-enabled true`; the next refresh uses it, with no restart. A stale revision returns `SettingsConflict`; reread and retry. A malformed `usage-collection.json` makes the quota read fail, not allow it: correct the file; the companion never rewrites it.

The switch binds the host companion. A companion older than this switch ignores it, and the desktop app's own read of its local machine does not use the companion. It is stored in `usage-collection.json`, separate from the three switches above. See the [reference](reference/companion-settings.md#usage-collection-policy).

## Record account quota samples in the background

Background quota collection is enabled by default. Managed companion setup provisions a supported user timer. For a manual installation, run `lazysh-agent usage-collector ensure`. To inspect, change the interval or opt out, run on the host:

```sh
lazysh-agent usage-collector enable --interval-minutes 30
lazysh-agent usage-collector status --limit 5
lazysh-agent usage-collector disable
```

**Read this first:** enabling makes the host contact each configured provider every interval, with the sign-ins the quota read already uses, while no lazysh app is open. The default interval is 30 minutes and the shortest is 5 minutes. A saved disabled policy is preserved. A sample holds only percentages, resets and staleness per account: no plan name, balance, credential, prompt or path. At most 1000 samples, 7 days and 1 MiB are kept, oldest first, in `usage-samples.json` in the companion state directory; delete that file to erase them. If account quota reads are [forbidden](#forbid-account-quota-reads-on-a-host), the collector reads nothing and records the skipped run.

`enable` installs a user-level timer without sudo: a systemd user timer on Linux, a launchd agent on macOS, a Scheduled Task on Windows. `disable` removes only what `enable` wrote. Exit 41 means this account cannot hold a timer (no user service manager or login session) and nothing was changed; exit 42 means the system or a file of another origin refused it and the previous policy is preserved. On Linux the user manager stops when the last session ends unless you run `loginctl enable-linger USER` yourself; `status` shows `linger`. While the host is suspended or off nothing is recorded; the first tick afterwards records one sample, so a gap stays a gap. An interval is rounded up to a multiple of five minutes. The usage page of the app shows the collector's state, its last run and the age of every sample under **Background collection** (it needs a companion that has `usage-collector`); it has no controls for it, so `enable` and `disable` are run on the host. See the [reference](reference/companion-settings.md#usage-collector) for the schema, bounds, per-system details and what was and was not tested.

## Quiet notifications for nested agents and an unlocked desktop

If you opt in to the [relay](notification-relay.md#opt-in-the-host-companion), two more host switches decide which events may notify your phone. Both are **off** by default, so nothing changes until you turn one on, and they are not part of the three switches above. There is no control for them in the app yet; use the host terminal:

```sh
lazysh-agent settings notifications show
lazysh-agent settings notifications update --expected-revision 0 \
  --nested-agent-suppression-enabled true \
  --suppress-while-desktop-unlocked false
```

- **Nested agents.** An agent that another agent started (a Claude Code session that runs `codex exec`, a hook that starts a headless agent) no longer pages you for work you never see, and its permission requests are not offered for a decision. Events are still recorded and shown on the board. A launcher can mark a nested start with `LAZYSH_PARENT_SESSION_ID`; on Linux and macOS the companion also recognizes known agents above the reporting one.
- **Unlocked desktop (Linux only).** No notification while you sit at the host's unlocked desktop that already shows the agent. If the lock state is unknown (macOS, Windows, no `loginctl`, a remote or inactive session) you are notified.

Both apply to the next hook run. The [reference](reference/companion-settings.md#notification-policy-nested-agents-and-an-unlocked-desktop) lists exactly which agents, platforms and cases are covered and which validation could not be run.

## Turn off live streaming or port scanning for a host

Two more switches have their own save button under **Host feature switches** in the same panel, because they are kept in a separate file with their own revision:

- **Simulator and emulator streaming** stops new live Android and iOS video streams. Screenshots, input and the other device tools keep following **Device tools**.
- **Port scanning from the app** stops the Preview panel from listing listeners and sending HTTP checks to this host. Because the app scans over its own SSH connection and not through the companion, only a lazysh app that reads this switch obeys it.

Both default to enabled. They apply to new operations only: a stream that is already running continues until you stop it, and a scan already under way finishes. With the port scan off, **Discover listeners** reads the switch, scans nothing and says the scan is turned off on the host; an automatic refresh stops after that one read. Opening a preview by typing its port is not a scan and still works. A host whose companion is older or absent has no feature switches (the panel says so) and scans as before.

The Preview panel also remembers, per saved host and on this device, whether you chose the HTTP check and the automatic refresh. The host switch wins over that memory.

From the host terminal, with the revision `show` returns:

```sh
lazysh-agent settings features show
lazysh-agent settings features update --expected-revision 0 \
  --simulator-streaming-enabled false \
  --port-scan-enabled true
```

A stream refused by the host fails with `SimulatorStreamingDisabled` before any Android or iOS tool starts. A stale revision returns `SettingsConflict`. See the [settings reference](reference/companion-settings.md#host-feature-switches).

## Companion updates

A companion that is older than the lazysh app talking to it updates itself to the app's version, in the background, unless you turn that off. This is on by default (`install`) and the only network traffic it causes is one HTTPS download of the release from GitHub when an update happens. Show the policy and the last update with `lazysh-agent auto-update status`, and change it with the revision it returned:

```sh
lazysh-agent auto-update set --expected-revision 0 --policy off
```

`off` never updates and uses no network, `notify` never changes the executable, `install` updates when a newer app connects, never during an agent turn and never to a version older than the installed one. Details: [the update flow](companion.md#the-companion-updates-itself-when-a-newer-app-connects) and the [reference](reference/companion-settings.md#auto-update-policy).

### Still planned

These parts of [#1446](https://github.com/mihazs/lazysh/issues/1446) (design in [ADR 0003](architecture/adr-0003-host-side-companion-update.md#auto-update)) are **not released yet**; the policy above is. Until they ship the companion never asks GitHub on its own: it updates only when a newer app connects.

| Setting | Values | Default |
| --- | --- | --- |
| Channel | `stable`, `prerelease` | `stable` |
| Check interval | 1 to 720 hours | 24 |
| Update window | `HH:MM-HH:MM` in the host's local time, or none | none |

A scheduled check will also install a newer release when every guard passes (newer, inside the window, no session reported a working state in the last 10 minutes, that version has not already failed on this host), will send no host identifier and will ask once per interval. `notify` will then record what it found, and the Agent view and this panel will show the version and an update-available badge. `lazysh-agent auto-update enable` will install a user-level timer (systemd user timer, launchd agent or Scheduled Task) and `disable` will remove it; `status` will show whether it is present or has drifted. If the host has no user service manager, `enable` will report that and change nothing.

See the [settings reference](reference/companion-settings.md) for defaults, gated commands, strict response schema, filesystem protections and verification limits. See [documentation](README.md) for other tasks.

## Host browser shim

The browser shim (host browser requests opened on your device) is not one of these switches. It is installed, inspected and removed on the host with `lazysh-agent browser-shim install|status|uninstall`, is off until installed, and the app's own policy for it (ask, always or never, per host and per device) is not stored in the host settings. See [Open host browser requests on your device](companion.md#open-host-browser-requests-on-your-device-browser-shim).
