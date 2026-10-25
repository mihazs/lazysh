# Durable workspaces

Open **Sessions** on an SSH connection. lazysh discovers tmux, Herdr and Zellij independently. Attaching opens a separate PTY on the verified SSH transport, preserving the original shell. Closing an attached terminal detaches that client; the remote multiplexer owns its processes.

## tmux

The workspace tree lists real session, window and pane IDs, current commands, directories and active state. Create/rename sessions and windows, choose a project directory, select windows/panes, split panes and toggle zoom. Refresh reads current host state. Actions use exact IDs instead of injecting prefix sequences into a foreground agent.

Choose a list, accordion or grid layout; the client remembers it. Load recent projects from the host companion's real agent history, ordered by most recent event, then select a directory in the launcher. The companion remains optional: you can always enter a directory manually.

Shell quoting alone does not protect tmux arguments: tmux parses trailing semicolons and expands format strings. lazysh separately escapes those layers to preserve literal names and directories. Control characters in names/paths are rejected because the discovery protocol is tab/line delimited. A response exceeding 1 MiB or 4096 panes fails explicitly.

## Herdr

List running named servers, then attach or browse one. The Herdr tree preserves server/workspace/tab/pane identity and displays reported agent states. Create and rename workspaces/tabs, focus workspaces/tabs, split and zoom exact panes, and focus reported agents. Plain panes can be selected through the terminal; Herdr's `agent focus` command only accepts agent panes.

The integration uses the [public Herdr CLI/socket snapshot contract](https://herdr.dev/docs/socket-api/), verified against Herdr **0.9.5**, protocol 22. Older or incompatible responses fail explicitly. lazysh does not install Herdr, alter its configuration, or stop existing servers.

Attached tmux and Herdr terminals also offer prefix shortcuts and numbered window/tab controls. Configure one prefix key, such as `Ctrl+b` or `F12`; it is validated with the existing terminal chord parser. The panel uses the host's default action bindings. It only appears on a terminal known to be attached to that multiplexer, so a plain shell never receives prefix input from these controls. Custom host action remappings remain available through the terminal or configurable keyboard chords.

## Zellij

List running sessions or enter a name to create/attach one. Its shortcut panel creates named tabs in a project directory, selects numbered tabs, moves between tabs, splits the focused pane and toggles fullscreen. Commands target the selected named session; focused-pane actions follow that session's current focus. Zellij does not expose the tmux/Herdr Jump To tree here.

The [public Zellij commands](https://zellij.dev/documentation/commands) were verified against **0.45.1**. Session names beginning with a dash are rejected: Zellij's attach CLI uses `--` for an initial command rather than to disambiguate that positional name.

## Native checks

With tmux, Herdr and Zellij installed on PATH:

```sh
cargo test --locked -p lazysh '::tests::real_' -- --ignored
```

These Cargo tests create isolated temporary tmux sockets, Herdr configuration/server state and Zellij runtime/cache directories. They exercise actual lifecycle commands, tree parsing, hostile literal labels, pane splitting, focus and zoom. They never target a pre-existing user multiplexer. Vitest checks session/pane identity and action/error behavior through the actual React panels.

The client workspace handles saved tmux/Herdr attachment intents separately from these controls. Zellij restoration remains manual, matching the documented initial-attach boundary. Native device lifecycle, network-loss/reconnect and durable-process survival still require device acceptance under issue #7. Trees currently refresh explicitly.
