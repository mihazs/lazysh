# Install and configure the companion

Add agent visibility to an existing verified SSH connection. You need an agent and host you control; ordinary SSH and terminal access work without the companion. Installing it does not launch an agent or enable reporting automatically.

## Install on the remote host

1. Read [companion distribution and verification](../install-and-update.md#remote-companion-executables). Use a published release that actually contains the required executable and installation command; source support does not establish availability. Public v0.23.0 has no companion assets and is not backfilled.
2. In the native app, connect to the host and open **Agents → Host companion installation → Install companion**. On an existing installation, expand that section and choose **Update companion**.
3. Wait for installed-version and byte verification before treating installation as successful. An interrupted or unconfirmed attempt is not a rollback; retry verifies again. Temporary files may remain after a lost connection, and cleanup does not remove the managed installation.

The app verifies the current stable download, transfers it over the existing SSH connection and installs it in the user's managed location. Installation needs SFTP and supports Linux x64/ARM64 and macOS Intel/ARM64 hosts. Native Windows installation remains [issue #490](https://github.com/mihazs/lazysh/issues/490). The app prefers this managed executable but preserves existing PATH installations, including SSH hosts without SFTP. Installation does not modify PATH, hooks, settings or event data and requires no extra credentials or shell command. The managed binary is not thereby a global `lazysh-agent` command. Its user-data location follows the remote environment: on Linux an absolute `XDG_DATA_HOME` (otherwise `~/.local/share`), and on macOS `~/Library/Application Support`, followed by `lazysh/companion/lazysh-agent`. Do not assume that installation data and the separate event-state directory are the same location.

For a source installation instead, run these commands **on the remote host from a trusted repository checkout**, with Rust stable installed:

```sh
cargo install --path apps/agent --locked
lazysh-agent snapshot --limit 50
```

For this source/PATH installation, make `lazysh-agent` available on the noninteractive SSH PATH. The shell commands below assume that PATH installation; with a managed-only installation, use the app controls or invoke its verified absolute executable path explicitly. A new store can return an empty session list; that confirms a snapshot read, not a running agent.

## Enable reporting deliberately

1. Follow [agent hook setup](../agent-hooks.md) for your installed provider and selected existing profile. Inspect changes before applying them; preserve unrelated hooks. Managed hook setup binds the resolved absolute executable and needs no PATH change. Select alternate profiles explicitly: discovery respects provider overrides/XDG paths but does not prove which profile a running agent loaded. Configuration printers only print fragments and do not install them or change provider trust.
2. For manual Claude configuration, run `lazysh-agent claude-config` on the host and merge its printed `hooks` entries into Claude settings. Run Claude in tmux if you need its reported `TMUX_PANE`. For other agents, use the [adapter contracts](../companion.md); unsupported integration is not implied by the generic event protocol.
3. Open or refresh **Agents** in the app. It reads `lazysh-agent snapshot --limit 50` over the selected verified SSH connection. Check that a known, newly reported event appears. If no event appears, inspect the installed provider hook rather than assuming the agent is idle or finished.

The foreground board refreshes every five seconds without duplicating pending reads. Hidden/background boards do not initiate automatic reads. Refresh does not scan transcripts, open history or reload host settings. A displayed row is the last report, not proof that its process is alive.

## Configure optional access separately

Use [host settings](../companion-settings.md) to control new discovery, recorded-usage and device operations. Reading a selected transcript, enabling [reported history](../companion.md#optional-claude-reported-history-shortcut), installing [product skills](../product-skills.md) and enabling [Claude waiting-hook approvals](../approvals.md) are separate actions. Transcript views and lifecycle events grant no approval or terminal-input authority. Review [confirmed terminal input](../chat-terminal-input.md) before using its separate destination confirmation flow.

For exact schema, retention and backup constraints, see [event storage reference](../reference/companion-events.md). For session meaning, see [session lifetime](../explanation/session-lifetime.md). Return to [documentation](../README.md) for other tasks.
