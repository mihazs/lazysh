# Managed Herdr install and removal

Slice of [#1522](https://github.com/mihazs/lazysh/issues/1522), tracked in
[#1760](https://github.com/mihazs/lazysh/issues/1760). It adds the explicit action that puts the optional
managed Herdr on one host over the SSH session you are already connected to, and removes it again. **No release or
platform support is claimed**: the verified release set does not list a managed Herdr yet (publishing it is
[#1758](https://github.com/mihazs/lazysh/issues/1758)), so today the action stops with "The current release has no
verified managed Herdr for this host yet" before anything reaches the host. The captured system-or-managed backend that
makes the app use the installed binary is [#1759](https://github.com/mihazs/lazysh/issues/1759), and the acceptance on the
exact release artifact beside a stock Herdr is [#1761](https://github.com/mihazs/lazysh/issues/1761).

## Where it is

The **Multiplexer workspaces** panel of an SSH connection has a **Managed Herdr on this host** section (collapsed by default) with two buttons, **Install managed
Herdr** and **Remove managed Herdr**. Nothing runs until you press one. It is offered for SSH connections only: it needs
a host to install onto.

## What install does

1. **Host.** The host must be a positively identified Linux or macOS SSH shell (the same probe the companion uses).
   Anything else stops with "not supported".
2. **Closed artifact choice.** The choice is the host's own platform: `linux-herdr-x64`, `linux-herdr-arm64`,
   `macos-herdr-x64` or `macos-herdr-arm64`. No path, URL, version or command comes from the screen; the native side builds
   the host command from this repository's reviewed script
   ([`managed_herdr.sh`](../apps/client/src-tauri/src/companion/install/managed_herdr.sh)).
3. **Verified release.** This device resolves the artifact through the same verified release chain the companion uses
   (tag, manifest commit, per-target receipt, GitHub's asset digest and size) and downloads it, bounded to 64 MiB. A target
   the release set does not list is refused.
4. **Upload and read back.** The bytes go to a private directory in the host's home over the connected SFTP channel and are
   read back and hashed there against the pin.
5. **Host re-check and plan.** The host script checks, on the host, that the staged file is a private regular file of exactly
   the pinned size and SHA-256, and that its first bytes are an ELF (Linux) or 64-bit Mach-O (macOS) executable for this CPU
   and this target. It then prints a plan: the SHA-256 of the destination, the target, the pinned bytes and what is at the
   destination now. Nothing has changed yet.
6. **Publish.** `install` repeats that check and publishes **only that plan**. If the host changed in between (another
   client installed, the destination changed) the plan no longer matches and the install stops with "The host changed while
   the install was being planned". The binary is copied into a private work directory inside the managed directory, checked
   again, run once as `lazysh-herdr --version` in a cleared environment for at most 20 seconds (it must exit 0, so an
   executable the host cannot run, for example one that needs a newer libc, is never published) and then moved into place
   with one `rename`, so the destination is the old file or the new one, never a partial file. The destination is read back
   and its digest, size and mode confirmed.

The managed binary is `<data>/lazysh/herdr/lazysh-herdr`, where `<data>` is the host's `XDG_DATA_HOME` (default
`~/.local/share`) or, on macOS, `~/Library/Application Support`: beside the companion's directory and never inside Herdr's
own `lazysh-herdr` application namespace for configuration, sockets and state. The directory and the file belong to you and
are private (`0700`).

## What is refused, and what that leaves behind

| Situation | Result | State on the host |
| --- | --- | --- |
| Host is not Linux or macOS, or the platform is not the chosen target | `unsupportedHost` | unchanged |
| Directory, an ancestor or the destination is a symbolic link, belongs to another user, is group- or world-writable (outside a sticky root directory), or the destination is not a private regular file | `unsafeLocation` | unchanged; nothing it points at is written |
| Staged file differs in size, digest, owner or mode from the pin | `stagedMismatch` | unchanged |
| Executable for another CPU, a script or any non-executable file | `architectureMismatch` | unchanged |
| Plan made before the host changed | `stalePlan` | unchanged |
| Another install or removal holds the lock (a lock older than ten minutes is taken over) | `hostBusy` | unchanged |
| `lazysh-herdr --version` does not exit 0 | `selfTestFailed` | the previous managed binary, if any, is kept |
| No SHA-256 tool on the host | `hostToolMissing` | unchanged |
| Cancelled, disconnected or killed before the rename | the script removes its work directory and lock | the destination is the old file or absent |
| Connection lost after the install command was sent | the result is reported as **unconfirmed**; run install again, which finds the same bytes and reports "already installed" | the old file or the new one, whole |

The install never reads, writes, signals or restarts the system `herdr` binary, its configuration, running servers, saved
default or session data, and it never migrates existing stock agents. After a hard kill (SIGKILL, power loss) the next run
removes its own `.work.*` leftovers under the lock.

## What removal does

`Remove managed Herdr` deletes `<data>/lazysh/herdr/lazysh-herdr` and **nothing else**. It refuses when that path is not a
private regular file owned by you (a link, a directory, another mode), says "not installed" when nothing is there, never stops
a server and never deletes configuration, state, sockets or sessions of either Herdr. A server started from the managed
binary keeps running after the file is removed (the host keeps the open file until the server exits); stop it yourself with
`herdr server stop` against its own socket.

## What was exercised

- The reviewed host script, run exactly as sshd's shell receives it, against a private home that holds a stock Herdr (binary,
  configuration, state, a running server) that no case may change: `tests/herdr-managed-install.test.ts` covers inspect,
  install, reuse, upgrade, removal, wrong digest, size, mode and CPU, a target that is not the host, a stale plan, every
  unsafe-destination shape, an executable that does not run, an interrupted copy or rename, cancellation by signal, the lock,
  a missing digest tool and malformed arguments. It runs under `dash` (Ubuntu) and `bash` as `sh`.
- The whole path over a real `sshd`, SFTP and the app's own install code with an owned publisher fixture:
  `ssh::tests::openssh_managed_herdr_installs_and_removes_only_its_own_binary` (Linux).
- The macOS branch of the script (BSD `stat -f`, Mach-O headers) was **simulated** on Linux with shimmed `stat` and `uname`
  for `inspect` only. No Apple hardware, no Windows host and no real published Herdr release asset have been used.
- Not exercised: the real release asset, Windows hosts (not supported by this slice), installing over a macOS host and
  running the installed derivative through the app.
