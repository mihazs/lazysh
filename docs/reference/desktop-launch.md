# Desktop launch arguments

The desktop executable is `lazysh`. These selectors refer to an existing saved host or a native local directory; they never contain credentials. Actual GUI/singleton delivery and platform credential prompts retain the [desktop-launch acceptance limits](../connections.md#cold-saved-host-desktop-launch).

| Selector | Value and constraints |
| --- | --- |
| `--host`, `-host` | Exact opaque saved host ID, 1–100 UTF-8 bytes without control characters. Display names, SSH aliases and raw hostnames are not IDs. |
| `--mux`, `-mux` | Requires `--host`. Values: `tmux`, `tmux:SERVER`, `herdr`. `tmux` and `tmux:default` denote the default tmux server. |
| `--dir`, `-dir` | Existing native directory. Incompatible with host/multiplexer selectors. No fallback to HOME for a failed explicit directory. |

Both separated and equals forms are accepted. Duplicate selectors are refused. tmux server names are literal, 1–64 UTF-8 bytes, without slash or control characters, excluding `.` and `..`; they are not shell commands or socket paths. `--mux` does not accept Zellij or a target session name.

| Launch intent | Behavior |
| --- | --- |
| Saved host only | Normal connection dialog after unlock; explicit Connect and key/credential checks; saved transport remains selectable. |
| Saved host plus mux | Fresh SSH control session and fixed requested picker; no automatic first-row attachment; saved transport preference is unchanged. |
| Local directory | Native canonical directory retained until guarded PTY startup; relative warm requests resolve against the forwarding caller's directory. |
| Already running | One bounded intent waits for unlock/busy work. A second cannot replace a queued, prepared or connecting request. Singleton handoff success confirms delivery only. |
| Revoked receipt | No replay after lock/reunlock or renderer replacement. Authentication success or cancellation spends the saved-host receipt. |

Warm host IDs, mux names and required path strings containing `U+FFFD` are refused because the singleton handoff is lossy. Cold lossless validation permits a literal replacement character in otherwise valid Unicode. Windows directory launch admits only safely simplified, identity-checked ordinary absolute drive paths; UNC, device and verbatim-only paths remain unsupported. Shell startup files can change a child's working directory afterward.

For retrieving a host ID, issuing a request and selecting a workspace, see [saved-host desktop launch](../connections.md#cold-saved-host-desktop-launch). For local launch and cleanup behavior, see [local desktop terminal](../local-terminal.md). For the meaning of a restored session, see [session lifetime](../explanation/session-lifetime.md). Return to [documentation](../README.md) for other references.
