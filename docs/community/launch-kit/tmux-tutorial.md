# Walkthrough: persistent remote work with SSH and tmux

Status: source-reviewed procedure, **not device-executed in this assignment**.
Before publication as a tested tutorial, a maintainer must run it on an owned
host with a stated lazysh release/device and retain the capture receipt.

## Prepare a host you control

Use an existing reachable SSH account and a host with tmux installed through its
normal package manager. Confirm SSH works from a trusted computer first. Record
the server's full SHA256 host-key fingerprint through a trusted independent path;
never accept a fingerprint solely because it appeared in the app.

On that host, create an isolated demonstration session with
`tmux new-session -s lazysh-demo`. Inside it, run `printf 'demo session remains on host
'`
and leave the shell open. Detach with tmux's default Ctrl-b then d. Confirm it is
listed by `tmux list-sessions`. These commands are ordinary tmux setup, not commands
run automatically by lazysh. Avoid using a session name already containing work.

## Connect and return

Install the compatible preview using [installation guidance](../../install-and-update.md).
Open the native app, add the owned host and authenticate only after verifying its
identity. The browser-only UI preview cannot perform this connection.

In **Edit host**, select tmux as **Default multiplexer** and enter the explicit
session name `lazysh-demo`, or use the supported session picker to attach to the
existing session. For this walkthrough select SSH explicitly. The remote
multiplexer must be installed and runnable. See [connections](../../connections.md)
and [multiplexer limits](../../multiplexers.md) for the current build.

Type a harmless marker in the terminal, disconnect, then connect to that same
named session again. Verify the marker and existing shell. If it does not resume,
record the exact outcome rather than claiming persistence. A stopped host,
terminated tmux server or exited process cannot be restored by the client.

## Optional coding-agent follow-up

A later walkthrough may start a supported agent in this owned session and inspect
its records through the [companion](../../companion.md). That needs compatible
agent setup, credentials on the host, explicit companion installation and separate
native verification. It is not required for SSH or this tmux exercise.

After capture, close only the demonstration session you created when no process
inside it is needed. Do not stop a shared tmux server or delete unrelated sessions.

Primary command reference: [tmux getting started](https://github.com/tmux/tmux/wiki/Getting-Started).
