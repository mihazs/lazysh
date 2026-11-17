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

## Forbid account quota reads on a host

`lazysh-agent account-usage` reads each configured provider's quota with the host's own sign-ins and makes outbound requests to those providers. By default any connected lazysh app may ask for it. To forbid it on a host, run on that host (the app does not offer this switch yet):

```sh
lazysh-agent usage-collection show
lazysh-agent usage-collection update --expected-revision 0 --account-quota-enabled false
```

Replace `0` with the revision `show` returned. While the switch is off, the AI account usage page and the status-bar item show that this host does not allow account usage reads, with **no percentage**: the quota is unknown, not zero. Nothing reads a credential file, starts a helper or contacts a provider. Turn it back on with `--account-quota-enabled true`; the next refresh uses it, with no restart. A stale revision returns `SettingsConflict`; reread and retry. A malformed `usage-collection.json` makes the quota read fail, not allow it: correct the file; the companion never rewrites it.

The switch binds the host companion. A companion older than this switch ignores it, and the desktop app's own read of its local machine does not use the companion. It is stored in `usage-collection.json`, separate from the three switches above. See the [reference](reference/companion-settings.md#usage-collection-policy).

## Record account quota samples in the background

By default nothing is collected while the app is closed, so a refresh shows no history. To record one bounded sample of each account's quota on a schedule, run on the host:

```sh
lazysh-agent usage-collector enable --interval-minutes 30
lazysh-agent usage-collector status --limit 5
lazysh-agent usage-collector disable
```

**Read this first:** enabling makes the host contact each configured provider every interval, with the sign-ins the quota read already uses, while no lazysh app is open. That is why it is off by default and the shortest interval is 5 minutes. A sample holds only percentages, resets and staleness per account: no plan name, balance, credential, prompt or path. At most 1000 samples, 7 days and 1 MiB are kept, oldest first, in `usage-samples.json` in the companion state directory; delete that file to erase them. If account quota reads are [forbidden](#forbid-account-quota-reads-on-a-host), the collector reads nothing and records the skipped run.

`enable` installs a user-level timer without sudo: a systemd user timer on Linux, a launchd agent on macOS, a Scheduled Task on Windows. `disable` removes only what `enable` wrote. Exit 41 means this account cannot hold a timer (no user service manager or login session) and nothing was changed; exit 42 means the system or a file of another origin refused it and the collector stays off. On Linux the user manager stops when the last session ends unless you run `loginctl enable-linger USER` yourself; `status` shows `linger`. While the host is suspended or off nothing is recorded; the first tick afterwards records one sample, so a gap stays a gap. An interval is rounded up to a multiple of five minutes. The usage page of the app shows the collector's state, its last run and the age of every sample under **Background collection** (it needs a companion that has `usage-collector`); it has no controls for it, so `enable` and `disable` are run on the host. See the [reference](reference/companion-settings.md#usage-collector) for the schema, bounds, per-system details and what was and was not tested.

## Companion updates (planned)

**Not released yet** ([#1446](https://github.com/mihazs/lazysh/issues/1446), design in [ADR 0003](architecture/adr-0003-host-side-companion-update.md#auto-update)). The three switches above do not change. Update behavior is a separate setting with its own revision, kept in `auto-update.json` in the same state directory so that an older companion that shares the directory keeps reading `settings.json`.

| Setting | Values | Default |
| --- | --- | --- |
| Policy | `off`, `notify`, `install` | `install` |
| Channel | `stable`, `prerelease` | `stable` |
| Check interval | 1 to 720 hours | 24 |
| Update window | `HH:MM-HH:MM` in the host's local time, or none | none |

`install` is the planned default (user decision 2026-11-13) and **changes what a companion does on its own**: it replaces the managed companion when every guard passes: the target is newer, inside the window, no session reported a working state in the last 10 minutes and that version has not already failed on this host. It also does so when a newer lazysh app connects, with the app's version as the target (the app sends it in `LAZYSH_APP_VERSION`; never a downgrade, never a prerelease). It sends no host identifier; the only traffic is the conditional release check per interval and one download when it updates. `notify` checks and records whether a newer release exists, shows the version and an update-available badge in the Agent view and this panel, and replaces nothing. Choose `off` for no request at all and no change (`lazysh-agent auto-update set --expected-revision R --policy off`). Hooks never start a check or an update. A metered connection is not detected: use `notify` or `off` on one.

`lazysh-agent auto-update enable` installs a user-level timer (systemd user timer, launchd agent or Scheduled Task) and `disable` removes it; `status` shows whether it is present or has drifted. If the host has no user service manager, `enable` reports that and changes nothing.

See the [settings reference](reference/companion-settings.md) for defaults, gated commands, strict response schema, filesystem protections and verification limits. See [documentation](README.md) for other tasks.

## Host browser shim

The browser shim (host browser requests opened on your device) is not one of these switches. It is installed, inspected and removed on the host with `lazysh-agent browser-shim install|status|uninstall`, is off until installed, and the app's own policy for it (ask, always or never, per host and per device) is not stored in the host settings. See [Open host browser requests on your device](companion.md#open-host-browser-requests-on-your-device-browser-shim).
