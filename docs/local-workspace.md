# Local workspace

Status: specification. Tracked by the epic [#1129](https://github.com/mihazs/lazysh/issues/1129) and its slice issues on the
[GitHub Project](https://github.com/users/mihazs/projects/2). Nothing here is released
until the slice that implements it ships. Today's behaviour is described in
[Local desktop terminals](local-terminal.md), including the native multiplexer commands
that already accept local session ids ahead of their interface.

lazysh on the desktop (Linux and Windows; macOS follows Linux unless noted) must be
the single place to run and supervise coding agents, on remote hosts **and** on the
machine it runs on. A local session therefore offers every feature a remote session
offers, wherever the platform allows it. Features tied to the SSH transport itself
stay remote-only and say so.

## Goals and rules

1. **Parity by default.** A feature that works for an SSH session works for a local
   session through the same code path, the same UI and the same tests. A local gap is
   a bug or an explicit `n/a` row in the capability table below, never silence.
2. **Remote behaviour does not change.** Every remote command, string, limit, error
   kind and test stays as it is. Local support is a second arm of the same seam.
3. **Terminal and Agent view co-exist** (hard requirement from
   [#1119](https://github.com/mihazs/lazysh/issues/1119)). A local agent runs in its
   real PTY or multiplexer pane; the **Terminal | Agent** switch, **Both** on wide
   desktop and the agent launcher ([#1128](https://github.com/mihazs/lazysh/issues/1128))
   work for local sessions exactly as in [Agent view](agent-view.md).
4. **No localhost SSH.** Local sessions never start or require an SSH server, a network
   listener for host tools, credentials or a fabricated host identity.
5. **Gate by capability, not by `local`.** The UI asks the native side what a local
   target can do and shows exactly that.

## Architecture

Today every host tool calls `AppState::session(id)`, which only knows SSH sessions,
and then reaches the host through four funnels: one-shot exec (`exec_for_access` /
`exec_bounded`), companion calls (exec of `lazysh-agent <subcommand>`), SFTP, and
long-lived channels (`open_owned*`, PTY with a command). The local registry
(`local.rs`) only offers PTY I/O; `account_usage` is the one feature that already
branches on `local:` ids.

### Host context

A new `host.rs` adds one enum, resolved from a session id:

```rust
pub(crate) enum Host { Remote(Arc<ssh::Session>), Local(LocalHost) }
```

`Host::resolve(&AppState, &LocalState, id, lease)` dispatches on the `local:` prefix,
like `account_usage` does today. The `Local` arm takes its cancel receiver from the
local registry (`local::usage_session`: adopted, not cancelled, renderer alive), so a
closed local session cancels its tools exactly as a dropped SSH session does. Tauri
commands move from `state.session()` to `Host::resolve()` one at a time; each
`Remote` arm calls today's function unchanged. `herdr_create.rs`'s `trait Remote` is
folded into this enum rather than kept as a second abstraction.

`Host` offers five operations, each a `match` whose remote arm is the existing code:

| Operation | Remote arm (unchanged) | Local arm |
| --- | --- | --- |
| `exec(lease, Cmd, deadline, limit)` | `exec_bounded` over an SSH exec channel | `tokio::process::Command` from argv: stdin null, `kill_on_drop`, process-group or job-object cleanup, shared stdout/stderr byte budget, same deadline and error kinds (`remote_command_failed`, `output_too_large`, `timeout`, `disconnected`) |
| `read_file`, `list_dir`, `symlink_metadata` | SFTP | `std::fs` in `spawn_blocking`, same caps (FILE_LIMIT, 10 000 entries / 2 MiB listing), same no-follow and path checks |
| `create_new(path, bytes)` | SFTP `CREATE\|EXCLUDE` | `OpenOptions::create_new(true)`, owner-only permissions, never overwrites |
| `spawn_stream(Cmd)` | `open_owned` channel stream | child with piped stdin/stdout plus an exit future |
| `connect_tcp(port)` | `ChannelRequest::DirectTcp` | `TcpStream::connect(("127.0.0.1", port))` |

The budget, deadline and cancel logic is lifted out of `exec_bounded` so both arms
share it (the jscpd zero-clone rule applies).

### Commands are argv locally

`Cmd` is `Argv(Vec<OsString>)`. The local arm executes argv directly and **never**
passes a command string to `sh`, `cmd.exe` or PowerShell. Builders that today emit a
quoted POSIX string are changed to emit argv; the remote arm renders that argv with
`ssh::quote` into the same string it sends today, which the existing remote and
real-runtime tests pin. Where a remote command relies on shell composition, the local
arm implements the step in Rust instead of a script:

| Remote script | Local replacement |
| --- | --- |
| `command -v tmux herdr zellij …` discovery | PATH lookup in Rust (with `PATHEXT` on Windows) |
| `herdr_path` ADMIT (`~/.local/bin` fallback) | Same owner-checked fallback directories, checked with `std::fs` |
| Companion POSIX probe (`resolve::detect`) | `std::env::consts` plus the app's data directory; no probe |
| `ss -H -ltnp \|\| lsof` (previews) | `ss`/`lsof` argv on Linux, `netstat -ano -p TCP` argv on Windows, output parsed in Rust |
| `git cat-file … \| od` (repository images) | `git cat-file` argv, raw stdout bytes |

The single shell use is a fixed, constant probe of the login shell's `PATH` on Unix
(`$SHELL -lc` with no interpolated text), run once per app start and cached. A GUI
app launched from a desktop entry often lacks `~/.local/bin`, `~/.cargo/bin` or
version-manager paths that the user's terminal has; children receive that captured
`PATH`. Windows uses the process `PATH` as is. Children also drop `TMUX`, `ZELLIJ`,
`ZELLIJ_SESSION_NAME`, `HERDR_SESSION`, `HERDR_SOCKET_PATH`, `ENV` and `BASH_ENV`, so
a lazysh started inside a multiplexer does not hit nested-session refusals.

### Local targets and launch specs

`local_capability` grows from `{available, reason}` to a list of **targets**, each with
the capabilities the UI gates on:

```json
{ "available": true, "targets": [
  { "id": "default", "label": "Bash", "kind": "posix",
    "tools": { "files": true, "repository": true, "tmux": true, "herdr": true,
               "zellij": false, "companion": true, "previews": true, "devices": false } }
] }
```

Target kinds: `posix` (Linux, macOS: the login shell), `windows` (pwsh, Windows
PowerShell, `cmd.exe`, Git Bash) and `wsl` (one per distribution from
`wsl.exe --list --quiet`, decoded from UTF-16LE, names validated). Targets are
detected natively; the renderer chooses an id, never a path or command.

`local_connect` accepts a launch spec `{ target, cwd?, attach? }`. `attach` is the
existing typed `multiplexer::Entry` (tmux, tmux server, Herdr, Zellij;
`deny_unknown_fields`), validated natively and turned into argv by the existing
`attach_command` builders. The PTY is started with `CommandBuilder` from that argv.
For WSL the PTY runs `wsl.exe -d <distro> --cd <dir> -e <argv>` and the host context
runs every tool the same way, so all POSIX features (tmux included) work inside the
distribution with no shell string.

### Per-session state

The tmux display binding, Herdr guard binding, tmux server, upload slot and companion
install semaphore move from `ssh::Session` into a small `Bindings` struct embedded in
both session types. `TmuxServer::for_session`, `tmux_jump`, `tmux_chat` and
`herdr_guard` take `&Bindings`. Their actors become generic over a byte stream plus a
close signal, so a local `tmux -C attach-session` child or a local guarded `herdr`
child drives the same parser, budgets and admission checks. Locally the tmux display
identity comes from the owned PTY (`child.process_id()`, `MasterPty::tty_name()`), so
the printf handshake is not needed.

### Local companion

The companion runs locally without SSH. The desktop bundle ships the matching
`lazysh-agent` (`linux-agent-*`, `windows-agent-x64`, macOS) next to the app; the
local arm resolves it by absolute path, falling back to a managed copy and then
`PATH`. Calls are argv (`lazysh-agent <subcommand> …`), JSON on stdout, as remotely.
Inside a WSL target the existing Linux install path is reused through `wsl.exe`.
Hooks install into the local user's agent profiles, so local agents report state,
approvals and transcripts to the board.

### Frontend

`sessionViews`, `remoteActive` and the per-panel `!active.local` checks in `App.tsx`
are replaced by one capability lookup per session (`hostTools(session)`), fed by the
remote companion/multiplexer detection for SSH sessions and by the target's `tools`
for local ones. `bridge.ts` keeps rejecting `local:` ids only for Mosh, ET and the
other transport-only helpers. `session.attached` is set for local attaches, which
enables the multiplexer toolbar, gestures, Jump To and confirmed Chat input. Local
sessions get a stable host key and label (`local:<target>`, **This device** or
**This device · Ubuntu (WSL)**) so the board groups and archives them like a host.

## Capability table

`yes` works as on a remote host. `n/a` is not applicable, with the reason.

| Feature | Linux local | Windows native (pwsh, PowerShell, cmd, Git Bash) | Windows WSL target | Slice |
| --- | --- | --- | --- | --- |
| Terminal, search, selection, dictation, account usage | yes (today) | yes (today, cmd only) | yes | — |
| Choose the shell or WSL distribution | login shell only | yes | yes | #1135 |
| Files view and file reads | yes | yes (`C:\…`; WSL files via `\\wsl.localhost\<distro>\…`) | yes | #1130 |
| Repository and diff review | yes (git) | yes (`git.exe`) | yes (git in the distro) | #1130 |
| tmux discovery, attach, Jump To, navigation, create | yes | n/a: no native tmux; offered through a WSL target | yes | #1131 |
| Herdr tree, navigation, workspaces, guarded input | yes | yes, Herdr ≥ 0.8.2 native (named pipe); focus needs a named-pipe branch in the companion | yes | #1131 |
| Zellij discovery, attach, actions | yes | yes, Zellij ≥ 0.44 native | yes | #1131 |
| Companion: Agents board, approvals, settings, transcripts, Chat, usage reports | yes | yes (`windows-agent-x64`); managed hook writes depend on [#490](https://github.com/mihazs/lazysh/issues/490), until then Herdr agent detection supplies state | yes (Linux companion) | #1132 |
| Agent hooks install | yes | templates only until #490 | yes | #1132 |
| Inbox and OS notifications | yes | yes | yes | #1132 |
| Apple status | n/a: macOS hosts only (works on a macOS local target) | n/a | n/a | #1132 |
| Agent view and confirmed input | yes (tmux, guarded Herdr; plain PTY and Zellij follow the remote rules) | yes (guarded Herdr; others Stage in terminal) | yes | #1133 |
| Agent launcher (#1128): folder, new folder, worktree, no-multiplexer terminal | yes | yes | yes | #1133 |
| Attachments and paste of the local path | yes (private file in `/tmp`) | yes (private file in `%TEMP%`) | yes (`/tmp` in the distro) | #1134 |
| Copy to host clipboard | n/a: the host is this device; uses the device clipboard | n/a, same | n/a, same | #1134 |
| Previews | yes, direct to `127.0.0.1:<port>` through the picker proxy | yes | yes (WSL forwards localhost) | #1134 |
| Devices (Android/iOS SDK on the host) | yes for Android; iOS n/a (needs macOS) | yes for Android; iOS n/a (needs macOS) | yes for Android | #1134 |
| Workspace restore, crash reattach, `--dir` with `--mux` | yes | yes | yes | #1134 |
| Mosh, ET, connection-loss recovery, network probes, jump hosts, agent forwarding, host-key trust, `restore_host_tools` | n/a: SSH transport only | n/a | n/a | — |

## UX

- **Hosts and picker.** **This device** appears with the saved hosts. Opening it shows
  the same flow as a host: target (shell or WSL distribution on Windows), optional
  directory, then the multiplexer picker listing local tmux, Herdr and Zellij sessions.
  **Open local terminal** keeps its one-click behaviour with the default target.
- **Views.** A local session shows the same view bar as a remote session, filtered by
  its target's capabilities. The "SSH host tools are unavailable" banner is removed; a
  hidden view shows its reason in the session details (for example "tmux needs a WSL
  target on Windows").
- **Agents.** The Agents board, notifications and Agent view include local sessions,
  grouped under **This device**. The Agent view switch, **Both** layout, remembered
  choice and launcher behave as in the Agent view spec. The launcher's
  **No multiplexer** choice opens a new local terminal in that directory with the agent.
- **Companion setup.** For local targets the companion panel shows **Bundled** (or
  **Install in WSL** for a WSL target) instead of an SSH install.
- **Restore.** A local intent saves `{ local: true, target, attached? }`, so restore
  reattaches the same local multiplexer session. The working directory is still not
  saved; the multiplexer session keeps its own.

## Security

- Local tools run with the desktop user's own permissions; nothing gains privileges.
- Renderer input never becomes a command: targets, entries, agents and paths are typed
  and validated natively; commands are argv; no shell, `cmd /c` or PowerShell string is
  built from user text. The login-shell `PATH` probe is a fixed constant.
- Windows: npm agents are `.cmd` shims, and batch argument escaping is unsafe
  (CVE-2024-24576). The launcher resolves the real executable; a batch shim gets no
  user arguments, and an initial prompt is sent through the guarded input path after
  start. Children use `CREATE_NO_WINDOW`.
- Paths: absolute, at most 4096 UTF-8 bytes, no NUL; uploads never overwrite and are
  owner-only (`0600`, or the per-user `%TEMP%` ACL); symlinks are not followed for
  reads, as over SFTP. UNC and device paths are refused except validated
  `\\wsl.localhost\<distro>\` paths.
- The preview proxy binds `127.0.0.1` only and never rebinds the dev server's port.
- The bundled companion is the release artifact verified by the existing release
  checks; a managed or `PATH` fallback is reported in the companion panel.
- Mobile builds are unchanged: `local_capability` stays unavailable there.

## Test strategy

Tests assert observable behaviour (repository testing policy). Each slice ships with:

- **Rust real-runtime tests** through `Host::resolve` on a real local session
  (`local::desktop::start_with_access`): listing and reading files, git status and
  diff in a temporary repository, discovery and attach of real tmux (isolated
  `TMUX_TMPDIR`, unique `-L`), stock Herdr (isolated config) and Zellij (temporary XDG
  dirs), Jump To moving the displayed client, companion snapshot and hook events,
  exclusive owner-only uploads, preview proxying to a local listener. Linux cases join
  `test:local` and `test:multiplexers` in `native-linux-runtimes`, counted with
  `--list --ignored` so a renamed case fails.
- **Windows** cases in the `native-desktop` windows-latest job: argv exec, `std::fs`
  files, `git.exe`, pwsh/PowerShell/cmd targets, native Zellij and Herdr fixtures with
  pinned binaries, `.cmd` shim refusal. Hosted runners are expected to lack a WSL
  distribution; WSL cases are written as ignored tests, and the matrix records WSL as
  unverified until a runner with WSL runs them.
- **Playwright** phone and desktop with the mocked bridge: local sessions show exactly
  the views their target reports, Agent view and terminal switch over a local session.
- **Linux native GUI** (`apps/client/native-e2e`): a local session opens Files and
  Diff, attaches local tmux, shows a hook event on the Agents board and switches to the
  Agent view and back without losing terminal output.
- **Android** must not regress; no Android behaviour changes.
- The [parity matrix](reference/parity-matrix.md) gets a **Local sessions** section
  with Linux and Windows evidence per row.

## Out of scope

- A localhost SSH server or treating `localhost` as an SSH host.
- Mosh, ET, connection-loss recovery and other SSH-transport features for local
  sessions (see the table).
- Native Windows tmux (MSYS2/Cygwin); tmux on Windows is WSL only.
- Native Windows managed hook writes and the Windows companion installer (#490).
- Local sessions on Android or iOS.
- Elevated (administrator) local sessions.

## Slices

In delivery order; each is independently shippable.

1. [#1130](https://github.com/mihazs/lazysh/issues/1130) Host context, local Files and repository/diff review.
2. [#1131](https://github.com/mihazs/lazysh/issues/1131) Local tmux, Herdr and Zellij discovery, attach, Jump To, navigation and create.
3. [#1132](https://github.com/mihazs/lazysh/issues/1132) Local companion: Agents board, approvals, hooks, transcripts, usage reports, notifications.
4. [#1133](https://github.com/mihazs/lazysh/issues/1133) Agent view and agent launcher in local sessions.
5. [#1134](https://github.com/mihazs/lazysh/issues/1134) Attachments, previews, devices and restore.
6. [#1135](https://github.com/mihazs/lazysh/issues/1135) Windows targets: PowerShell, cmd, Git Bash and WSL distributions.
7. [#1136](https://github.com/mihazs/lazysh/issues/1136) Parity-matrix **Local sessions** section with Linux and Windows CI evidence.
