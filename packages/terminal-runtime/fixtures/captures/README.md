# Captured terminal streams

Raw bytes a real program wrote to a pty with `TERM=xterm-256color`, replayed by the `captures.json`
fixtures. Each was recorded on Linux from a throwaway pty (python `pty.fork`, window size set before the
program started, keys typed through the pty) with an empty `HOME`, `-u NONE` for vim and a private
`-L` tmux socket and config, so nothing personal is in them. The only text is a three-line sample
file (`The quick brown fox`, `jumps over the lazy dog`, `日本語のテキスト and é`) and the
program's own chrome.

| File | Program | Size | Keys |
| --- | --- | --- | --- |
| `vim-edit.bin` | vim 9.x `-u NONE -N -n` on the sample file | 60x12 | `ihello<Esc>`, `:set number`, `gg`, `:q!` |
| `less-page.bin` | `less -R` on the sample file | 60x6 | `q` |
| `tmux-splits.bin` | tmux 3.x, status line, `%` then `"` splits, a coloured `printf` | 60x14 | `printf`, `C-b %`, `printf`, `C-b "`, `printf` |
| `claude.bin` | Claude Code 2.1.322, first run: the theme picker | 100x30 | none |
| `claude-onboarding.bin` | Claude Code 2.1.322, first run: Down, Down, Enter, ending on the login method screen | 100x30 | `Down`, `Down`, `Enter` |
| `codex-login.bin` | Codex 0.167.0, first run: the sign-in menu | 100x30 | `Down`, `Up` |
| `opencode-home.bin` | OpenCode 2.2.7 (`/usr/bin/opencode`), home screen, text typed then cleared | 100x30 | `hello 日本語 é`, `Ctrl+C` |
| `zellij-panes.bin` | Zellij 0.46.0, `simplified_ui`, no startup tips: a shell command, a new pane, a command in it | 100x16 | `echo hello 日本語 é`, `Ctrl+p n`, `Esc`, two spaces (the new pane's shell drops its first keystrokes), `echo second pane` |
| `herdr-session.bin` | Herdr 0.9.5 on a private socket: welcome card, integrations settings, a shell command, the keybinds overlay | 100x30 | `Enter`, `Esc`, `echo hello 日本語 é`, `Ctrl+b ?`, `Esc` |

The agent and multiplexer captures were recorded the same way (a python `pty.fork`, window size set before
`exec`, keys typed through the pty) with a scrubbed environment: `HOME`, `XDG_*`, `CODEX_HOME`,
`CLAUDE_CONFIG_DIR` and `ZELLIJ_SOCKET_DIR` pointing into one throwaway directory, a made-up user name,
`TERM=xterm-256color`, telemetry and auto-update switched off, and for Herdr `HERDR_SOCKET_PATH` on a socket
inside that directory (the live server was never contacted). No account is signed in: Claude Code and Codex
stop at their login screens, OpenCode runs with no provider. Nothing in them is personal; each was scanned for
the user name, home path, host names, e-mail-like strings and token shapes. Two launcher lines that were not
terminal output (a Codex warning on stderr that named the throwaway directory, OpenCode's `Starting background
server...`) were cut from the start of the stream. Nobody answered the programs' terminal queries while
recording, so a program that waits for a reply (colours, cursor position) shows the screen it falls back to.
Recorded versions are named above; a newer release draws different screens, so these are frozen samples, not a
claim about current releases.

Not captured: sessions of the agents doing work (a signed-in Claude Code, Codex or OpenCode turn streaming a
reply, tool cards, diffs). That needs an account and a network, and a capture would hold a prompt and a
response; the synthetic live-region streams in `vt/tui-streams.json` stand in for the redraw patterns.
