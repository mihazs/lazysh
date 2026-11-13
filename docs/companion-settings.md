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

## Companion updates

A companion that is older than the lazysh app talking to it updates itself to the app's version, in the background, unless you turn that off. This is on by default (`install`) and the only network traffic it causes is one HTTPS download of the release from GitHub when an update happens. Show the policy and the last update with `lazysh-agent auto-update status`, and change it with the revision it returned:

```sh
lazysh-agent auto-update set --expected-revision 0 --policy off
```

`off` never updates and uses no network, `notify` never changes the executable, `install` updates when a newer app connects, never during an agent turn and never to a version older than the installed one. Details: [the update flow](companion.md#the-companion-updates-itself-when-a-newer-app-connects) and the [reference](reference/companion-settings.md#auto-update-policy).

See the [settings reference](reference/companion-settings.md) for defaults, gated commands, strict response schema, filesystem protections and verification limits. See [documentation](README.md) for other tasks.
