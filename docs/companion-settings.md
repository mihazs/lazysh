# Host companion settings

Disable or re-enable companion transcript discovery, recorded usage inspection or device tools for a host. You need an installed [companion](how-to/configure-companion.md) and access to the same remote operating-system user.

**Preferences → Agents and notifications → Agents** shows host settings after a valid companion snapshot is available. It loads the settings over the selected verified SSH session. Controls appear only after a supported settings response; older companions show an update/setup message. Saving changes the remote operating-system user's companion configuration, shared by that user's lazysh clients. It does not save these switches in browser storage or change an agent's own configuration.

## Change settings in the app

1. Connect to the host, open **Agents**, and obtain a valid snapshot, then open **Preferences → Agents and notifications → Agents**.
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
