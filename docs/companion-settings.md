# Host companion settings

Disable or re-enable companion transcript discovery, recorded usage inspection or device tools for a host. You need an installed [companion](how-to/configure-companion.md) and access to the same remote operating-system user.

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
