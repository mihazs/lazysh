# Host companion settings

Disable or re-enable companion transcript discovery, recorded usage inspection or device tools for a host. You need an installed [companion](how-to/configure-companion.md) and access to the same remote operating-system user.

The Agents panel shows host settings after a valid companion snapshot is available. It loads the settings over the selected verified SSH session. Controls appear only after a supported settings response; older companions show an update/setup message. Saving changes the remote operating-system user's companion configuration, shared by that user's lazysh clients. It does not save these switches in browser storage or change an agent's own configuration.

## Change settings in the app

1. Connect to the host, open **Agents**, and obtain a valid snapshot.
2. In host settings, change the required switches and choose **Save host settings**.
3. If the companion is unsupported or unavailable, update it before retrying. If another client changed the revision, refresh and review its values before saving again.
4. Start a new operation to use the new values. Stop any existing stream separately; saving settings does not terminate it.

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

## Companion updates

A companion that is older than the lazysh app talking to it updates itself to the app's version, in the background, unless you turn that off. This is on by default (`install`) and the only network traffic it causes is one HTTPS download of the release from GitHub when an update happens. Show the policy and the last update with `lazysh-agent auto-update status`, and change it with the revision it returned:

```sh
lazysh-agent auto-update set --expected-revision 0 --policy off
```

`off` never updates and uses no network, `notify` never changes the executable and only records what it found, `install` updates when a newer app connects and when its own check finds a newer release, never during an agent turn and never to a version older than the installed one. Three more settings shape the checks the companion makes by itself: how often it may ask GitHub (24 hours by default, 1 to 720), which releases it looks at (`stable`, or `prerelease`) and when an install may start (a window in the host's local time):

```sh
lazysh-agent auto-update set --expected-revision 1 --policy install --interval-hours 12 --channel stable --window 22:00-06:00
```

A setting you leave out keeps its value, and `--window none` removes the window. `lazysh-agent auto-update status` shows the settings, `lastCheck` (what the last check found) and `nextCheckAt`. Details: [the update flow](companion.md#the-companion-updates-itself-when-a-newer-app-connects) and the [reference](reference/companion-settings.md#auto-update-policy).

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
