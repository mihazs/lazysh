# Why a saved host is not a running workspace

lazysh separates connection information, a live terminal, a persistent host workspace and an agent's recorded activity. These objects can outlive one another. A saved host named “workstation” may still exist after its server is offline; a recorded “working” event may remain after its agent exits.

## Connection information and live authority

Saved host metadata identifies where to connect. Passwords, private keys and passphrases stay in memory unless explicitly saved in the native credential store. A host entry or restored workspace intention cannot authenticate by itself. Fresh connections still verify the server key and follow the user's credential and optional biometric policy.

A terminal belongs to a specific native session and app-access lease. Locking, disconnecting and replacing a renderer have different effects. Ordinary same-view locks retain terminal models and pause display; Android Activity/WebView replacement retires old requests and closes old renderer-owned sessions. Resume protection has device-specific triggers and is off by default. Its [credential and lifetime contract](../credentials.md#opt-in-native-resume-protection) also explains why locking does not recall already dispatched remote bytes or revoke existing SSH-agent forwarding.

## Persistent work belongs to the host

A plain shell connection does not promise that its processes survive disconnection. A tmux, Herdr or Zellij server can own a persistent workspace independently of the client display, subject to that tool's configuration and host lifecycle. Disconnecting a display and terminating its host-side session are distinct actions. Closing a temporary source shell preserves separately owned attached multiplexer PTYs; it does not make every remote process persistent.

Workspace restoration saves an intention, such as a host, transport preference and exact multiplexer selection. It authenticates afresh instead of restoring terminal output, transport secrets, tickets or input authority. Zellij restoration remains manual. Ordinary Herdr's name-based semantics can create a new same-named server after the old server disappears; a matching name does not prove the old agent resumed. See [multiplexer contracts](../multiplexers.md) and [saved default entry](../connections.md#enter-a-saved-default-multiplexer).

Mosh's UDP terminal can remain alive when its SSH tools connection closes. That does not make files, uploads or companion reads available through a dead SSH channel. Upload recovery requires explicit reauthentication and a separate upload retry; it does not replace the original Mosh terminal. ET has its own bounded backpressure and replay behavior. Transport support, simulator tests and source builds do not establish roaming or physical-device acceptance; consult [transport limits](../connections.md#transport-selection).

## A report is evidence of a past observation

The Agents board displays the last reported lifecycle event. Foreground refresh reads that stored snapshot; it is not a process-health probe. A missing report is unknown, and an old report can be stale. Transcript records, reported pane identifiers and account-usage windows have their own identity and freshness bounds. They do not prove ownership of a currently running pane, a current provider allowance or a still-pending approval.

That distinction keeps observation separate from authority. Opening a transcript does not grant permission to send input. [Confirmed terminal input](../chat-terminal-input.md) requires its own explicit destination checks. [Claude approvals](../approvals.md) refer to an exact expiring waiting hook, not a general “needs attention” row. Shared Herdr focus also affects other clients; it is not a private view of a server.

For a first connection, follow the [SSH tutorial](../tutorials/first-ssh-session.md). For reporting setup, use [configure the companion](../how-to/configure-companion.md). The [architecture](../architecture.md) describes the component boundary; the [documentation map](../README.md) links the remaining tasks and evidence.
