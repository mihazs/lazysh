# Install and configure the companion

Add agent visibility to an existing verified SSH connection. You need an agent and host you control; ordinary SSH and terminal access work without the companion. Installing it does not launch an agent or enable reporting automatically.

## Install on the remote host

1. Read [companion distribution and verification](../install-and-update.md#remote-companion-executables). Use a published release that actually contains the required executable and installation command; source support does not establish availability. Public v0.23.0 has no companion assets and is not backfilled.
2. In the native app, connect to the host and open **Agents → Host companion installation → Install companion**. On an existing installation, expand that section and choose **Update companion**.
3. Wait for the host's result and the app's own check of the installed version before treating installation as successful. An interrupted or unconfirmed attempt is not a rollback; retry verifies again.

**The host downloads the companion, not the phone.** The app fetches only the small release metadata and verifies it (the tag's commit, the release manifest and GitHub's digest for the asset), then sends the host a pin: the version, the exact size and the SHA-256. The host downloads that one file over HTTPS with its own `curl` or GNU `wget`, checks the exact size and digest before anything runs, runs the new executable once in a cleared environment (`--version` and a lifecycle event round trip), keeps the previous companion as `lazysh-agent.previous` and replaces the managed executable atomically. If the check after the replace fails, the previous companion is put back. A newer companion already on the host is never replaced, a file that is not the pinned one is discarded, and nothing uses `sudo`. The panel shows the host's download progress and each step. Companions without an `update` command (1.28.0 onwards) are updated this way; the app does not need SFTP for it.

**Check for updates and Roll back.** **Check for updates** reads, without installing, the version on the host and the latest verified release, and says whether the host is up to date, can be updated, or is newer. When the host companion has the `lazysh-agent update` command, **Update companion** runs `lazysh-agent update --json --yes --version <pin>` on the host instead of the script: the host fetches the release metadata itself and refuses (exit 22) anything that differs from the pin the app sends, then downloads, verifies, tests and replaces exactly as above. The same command keeps the previous companion, and after a check that found one the panel offers **Roll back to <version>**, which runs `lazysh-agent update --rollback` on the host. A companion without `update` is updated by the script and cannot be rolled back from the app until it has been updated once.

The host therefore needs outbound HTTPS to `github.com`, `curl` or GNU `wget` (BusyBox `wget` is refused because it may not check certificates) and `sha256sum` or `shasum`. If it cannot reach GitHub or lacks those tools, the panel shows a separate button, **Install through this device**. That is the previous behavior, kept only as an explicit offline fallback: this device downloads the 9 to 12 MB companion, verifies it and uploads it over SFTP, so it uses the device's data and needs SFTP. It is never used unless you press it. Failures from the host are named in the panel (for example a downloaded file that did not match the release, a companion that failed its self test, or another update already running) and none of them leaves a partial installation.

The managed location supports Linux x64/ARM64 and macOS Intel/ARM64 hosts. Native Windows installation remains [issue #490](https://github.com/mihazs/lazysh/issues/490). The app prefers this managed executable but preserves existing PATH installations, including SSH hosts without SFTP. Installation does not modify PATH, hooks, settings or event data and requires no extra credentials or shell command. The managed binary is not thereby a global `lazysh-agent` command. Its user-data location follows the remote environment: on Linux an absolute `XDG_DATA_HOME` (otherwise `~/.local/share`), and on macOS `~/Library/Application Support`, followed by `lazysh/companion/lazysh-agent`. Do not assume that installation data and the separate event-state directory are the same location.

For a source installation instead, run these commands **on the remote host from a trusted repository checkout**, with Rust stable installed:

```sh
cargo install --path apps/agent --locked
lazysh-agent snapshot --limit 50
```

For this source/PATH installation, make `lazysh-agent` available on the noninteractive SSH PATH. The shell commands below assume that PATH installation; with a managed-only installation, use the app controls or invoke its verified absolute executable path explicitly. A new store can return an empty session list; that confirms a snapshot read, not a running agent.

## Update the companion on the host (planned)

**Not released yet.** Epic [#1441](https://github.com/mihazs/lazysh/issues/1441) moves the update onto the host; [ADR 0003](../architecture/adr-0003-host-side-companion-update.md) fixes the design. Until it ships, **Update companion** downloads the executable on the device as described above.

What will change, and what stays the same:

- **No download on the phone.** The app fetches only the small release metadata (at most 344,064 bytes) and tells the host which version, size and SHA-256 to install. The host downloads the release over its own network, over HTTPS with certificate verification, checks the size and the pinned SHA-256 before it runs anything, tests the new executable, keeps the previous one and replaces the managed executable atomically. The host needs outbound HTTPS to GitHub, no `sudo` and no extra credentials. It only ever writes the user's managed `lazysh/companion` location, never a PATH copy.
- **Old companions.** A companion without the new `update` command (for example 1.28.0) is updated by a short fixed script that the app runs over SSH: `sh` with `curl` or GNU `wget` on Linux and macOS, PowerShell on Windows. It needs `curl` or GNU `wget` and `sha256sum` or `shasum`.
- **Host has no internet.** The app then offers a separate, clearly labelled **Install through this device** action, which keeps today's behavior (the device downloads about 9 to 12 MB and uploads it over SFTP). It is never used unless you choose it.
- **From the host terminal**, with a PATH or managed executable that has the command:

  ```sh
  lazysh-agent update --check     # exit 0 up to date, 10 update available
  lazysh-agent update --dry-run   # download, verify and test, change nothing
  lazysh-agent update --yes       # install the latest stable release
  lazysh-agent update --rollback --yes
  lazysh-agent update --status --json
  ```

  Exit codes, JSON output and every flag are in the [CLI contract](../architecture/adr-0003-host-side-companion-update.md#cli-contract). A lower version is installed only with `--version X.Y.Z --allow-downgrade`.
- **Automatic updates.** A companion setting chooses `off`, `notify` (the host checks for a newer release at most once per interval, the app shows an update-available badge, nothing is replaced) or `install` (the planned default, on since 2026-11-13: replaces when a newer release is out or a newer lazysh app connects, only when no agent turn is active and that version has not already failed). `lazysh-agent auto-update enable` can add a user-level timer (systemd user timer, launchd agent or Scheduled Task); it never uses `sudo`. See [host settings](../companion-settings.md#companion-updates-planned).

## Enable reporting deliberately

1. Follow [agent hook setup](../agent-hooks.md) for your installed provider and selected existing profile. Inspect changes before applying them; preserve unrelated hooks. Managed hook setup binds the resolved absolute executable and needs no PATH change. Select alternate profiles explicitly: discovery respects provider overrides/XDG paths but does not prove which profile a running agent loaded. Configuration printers only print fragments and do not install them or change provider trust.
2. For manual Claude configuration, run `lazysh-agent claude-config` on the host and merge its printed `hooks` entries into Claude settings. Run Claude in tmux if you need its reported `TMUX_PANE`. For other agents, use the [adapter contracts](../companion.md); unsupported integration is not implied by the generic event protocol.
3. Open or refresh **Agents** in the app. It reads `lazysh-agent snapshot --limit 50` over the selected verified SSH connection. Check that a known, newly reported event appears. If no event appears, inspect the installed provider hook rather than assuming the agent is idle or finished.

The foreground board refreshes every five seconds without duplicating pending reads. Hidden/background boards do not initiate automatic reads. Refresh does not scan transcripts, open history or reload host settings. A displayed row is the last report, not proof that its process is alive.

## Configure optional access separately

Use [host settings](../companion-settings.md) to control new discovery, recorded-usage and device operations. Reading a selected transcript, enabling [reported history](../companion.md#optional-claude-reported-history-shortcut), installing [product skills](../product-skills.md) and enabling [Claude waiting-hook approvals](../approvals.md) are separate actions. Transcript views and lifecycle events grant no approval or terminal-input authority. Review [confirmed terminal input](../chat-terminal-input.md) before using its separate destination confirmation flow.

For exact schema, retention and backup constraints, see [event storage reference](../reference/companion-events.md). For session meaning, see [session lifetime](../explanation/session-lifetime.md). Return to [documentation](../README.md) for other tasks.
