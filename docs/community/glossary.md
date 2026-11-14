# Glossary for first-time SSH workspace users

Six terms you meet in the first lazysh session. Each definition is checked against the linked guide, which is the authority for details and limits.

| Term | Definition | Guide |
| --- | --- | --- |
| SSH host | A computer you control that runs an SSH server, which lazysh connects to directly with a password or a private key. A saved host records its address, username and authentication method, and a direct connection needs no lazysh account. | [SSH connections](../connections.md) |
| Host-key fingerprint | The SHA-256 fingerprint of the server's host key, which lazysh shows on the first connection before authentication. Verify it with a trusted source before accepting it, because a changed key blocks the connection. | [SSH connections](../connections.md) |
| Terminal | A tab where you type into a shell running on the connected host over SSH, with Mosh and Eternal Terminal as optional transports. A desktop build can also open a local terminal that needs no SSH server. | [SSH connections](../connections.md), [Local terminals](../local-terminal.md) |
| Host-side multiplexer | A program such as tmux, Herdr or Zellij that runs on the host and owns its sessions, windows and panes. lazysh attaches to them, but processes survive only when the multiplexer is configured to keep them, because lazysh itself does not guarantee persistence. | [Durable workspaces](../multiplexers.md) |
| Optional companion | The Rust `lazysh-agent` program that you install on the host yourself so lazysh can read supported agent events and transcripts over your existing verified SSH connection. Ordinary terminal access works without it. | [Companion](../companion.md), [Configure the companion](../how-to/configure-companion.md) |
| Recorded agent activity | The lifecycle events and transcript records that a supported agent such as Claude Code or Codex wrote and the companion reports. They are not proof that the agent is still running, and a crashed agent can leave a recorded turn reading `working`. | [Companion](../companion.md) |

For the first walkthrough, see [your first lazysh contribution](first-contribution.md).
