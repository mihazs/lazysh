# Agent events over your own SSH connection

The terminal works without this optional host component. The initial companion observes lifecycle events; it does not parse transcripts, answer approvals, launch agents, or send data to a cloud service.

Install on the **remote host**, using Rust stable from a checkout of this repository:

```sh
cargo install --path apps/agent --locked
lazysh-agent snapshot --limit 50
```

Ensure `lazysh-agent` is on the noninteractive SSH PATH. lazysh reads `lazysh-agent snapshot --limit 50` over the existing verified SSH session when you open or refresh the Agents panel. There is no HTTP server or listening port.

## Claude Code

Run `lazysh-agent claude-config` and merge the printed `hooks` entries into your Claude settings, preserving existing entries. This command only prints JSON. Run Claude in tmux to include its `TMUX_PANE` identity. The [official hook reference](https://code.claude.com/docs/en/hooks) defines the inputs this adapter handles. Lifecycle summaries include tool names but omit prompts, tool arguments, transcripts, and credentials. An informational notification does not imply a pending approval.

The displayed status is the last reported event, not proof that a process is still running. Refresh explicitly. Respond to prompts in the live terminal until race-safe approvals are implemented.

## Other agents and scripts

Other adapters can send the explicit generic schema; this is a protocol, not a claim that every agent is already integrated:

```sh
printf '%s' '{"schemaVersion":1,"sessionId":"build-1","agent":"My agent","project":"/work/app","state":"working","summary":"Running tests","paneId":"%1"}' | lazysh-agent ingest --agent generic
```

States are `working`, `needs_attention`, and `done`. Agent plus session ID identifies a row. No fields authorize remote command execution. Summaries are plain text and may contain project-sensitive information; the snapshot is visible to the authenticated SSH user. Only install hooks on hosts and agents you control.

At most 100 session summaries are retained for seven days in `events.sqlite3` in the user's state directory (`~/.local/state/lazysh` on Linux; the local application data directory on macOS/Windows). A mode-0700 directory and mode-0600 database are used on Unix. `LAZYSH_STATE_DIR` overrides that directory for testing. No original event payloads are retained. This does not yet provide history, usage/context metrics, native chat, automatic background refresh, or remote approval actions.

Run the native Rust unit and CLI integration tests with `cargo test --package lazysh-agent --locked`, or `bunx turbo run test --filter=@lazysh/agent`. Tests spawn the compiled executable with isolated state directories; there is no Python runtime or test script dependency.
