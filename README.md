# lazysh — Cross-platform SSH terminal and AI agent workspace

**lazysh** is a cross-platform SSH client and terminal workspace in development for **Android, iOS, macOS, Linux, and Windows**. It is designed for developers who want to connect directly to their own servers, work in remote shells, and manage long-running AI coding agents from desktop or mobile.

The project is being built with **Rust, Tauri 2, React, and xterm.js**, using **Bun and Turborepo** for the application workspace. The goal is a native SSH experience with optional agent-aware tools—not a hosted terminal service.

> **Project status:** Work in progress. There is no stable release or verified cross-platform feature parity. The default `main` branch currently contains planning and research documents; the native application is under development in [draft PR #22](https://github.com/mihazs/lazysh/pull/22).

## What is lazysh for?

- **SSH terminal on desktop and mobile:** a shared client for remote Linux/macOS/other SSH hosts, with native builds targeted for Android, iOS, macOS, Linux, and Windows.
- **Remote development and persistent sessions:** work with terminal multiplexers such as **tmux, Herdr, and Zellij**, so long-running programs can remain on the host when the client disconnects.
- **AI coding-agent workflows:** a planned workspace for existing host-side tools such as **Claude Code, Codex, and OpenCode**, without pretending that every agent has the same integration level.
- **Local-first connections:** direct SSH is the foundation; a separate host companion and any external services are optional rather than requirements for a terminal session.

These are **project goals**, not a list of features shipped on `main`. See the [implementation PR](https://github.com/mihazs/lazysh/pull/22) and [tracked issues](https://github.com/mihazs/lazysh/issues) for implemented slices, open work, and test evidence.

## Planned SSH and developer tools

Development tracks secure SSH host-key verification, password/private-key authentication, multiple terminal sessions, remote multiplexer navigation, SFTP file browsing and transfers, Git diff review, SSH-forwarded local web previews, and agent events or transcripts. Mobile interaction, optional voice input, and platform-specific integrations have separate milestones and verification requirements.

See the [feature and behavior evidence](docs/moshi-evidence.md) for research and the limits of the planned scope. Research and prototype functionality should not be interpreted as an available release.

## Technology stack

| Layer | Planned implementation |
| --- | --- |
| Native application | Tauri 2 and Rust |
| Terminal UI | React and xterm.js |
| Build and workspace | Bun and Turborepo |
| Connectivity | Direct SSH, with transport extensions tracked separately |
| Optional host integrations | Rust companion for agent/session events |
| Target platforms | Android, iOS, macOS, Linux, Windows |

## Explore the development preview

The default branch is **not yet a runnable app**. To inspect the active implementation, see [draft PR #22](https://github.com/mihazs/lazysh/pull/22) or check out its feature branch:

```sh
git clone https://github.com/mihazs/lazysh.git
cd lazysh
git switch feat/tauri-agent-workspace
bun install --frozen-lockfile
bun run dev
```

The preview requires Bun, stable Rust, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/). Some native integrations require additional system dependencies. Refer to the [implementation branch README](https://github.com/mihazs/lazysh/blob/feat/tauri-agent-workspace/README.md) for platform-specific commands, testing prerequisites, and current limitations. A browser-only UI preview cannot provide native direct SSH.

## Roadmap and contributions

Development progress is tracked in the [GitHub Project](https://github.com/users/mihazs/projects/2), the [feature-parity epic](https://github.com/mihazs/lazysh/issues/1), and the [issue tracker](https://github.com/mihazs/lazysh/issues). Bug reports, design feedback, and implementation discussions are welcome through issues and pull requests. Check the current branch and issue status before assuming that a feature is complete.

## Independence

lazysh is an independent implementation informed by research into Moshi's documented SSH and agent workflows. **Moshi parity is a development objective, not a current capability claim.** lazysh does not distribute Moshi source code, branding, or assets.
