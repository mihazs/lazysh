# Agent events over your own SSH connection

The terminal works without this optional host component. The companion observes lifecycle events and can read explicitly selected Claude Code, Codex, Pi, OMP, Hermes, OpenCode, Copilot CLI, Qoder IDE, Kimi CLI, or jcode transcripts. It does not answer approvals, launch agents, or send data to a cloud service.

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

At most 100 session summaries are retained for seven days in `events.sqlite3` in the user's state directory (`~/.local/state/lazysh` on Linux; the local application data directory on macOS/Windows). A mode-0700 directory and mode-0600 database are used on Unix. `LAZYSH_STATE_DIR` overrides that directory for testing. No original event payloads are retained. This does not yet provide automatic background refresh or remote approval actions.

## Read transcript records

Select a transcript file on the host and request a page:

```sh
lazysh-agent transcript --agent claude --path /absolute/path/session.jsonl --limit 50
lazysh-agent transcript --agent codex --path /absolute/path/rollout.jsonl --offset 0 --limit 50
```

The JSON response has `schemaVersion: 1`, `view: "record_stream"`, `agent`, `messages`, `nextOffset`, `hasMore`, and `truncated: false`. Pass `nextOffset` as the next request's `--offset`; it is a byte cursor at a complete JSONL boundary. A partial trailing record remains unread until its newline arrives, with `hasMore: false` so a client does not spin on an unchanged cursor. Refresh at the last cursor to see appended records. A truncated or replaced transcript should be reopened from offset zero; the cursor does not authenticate file identity or detect same-length rewrites.

Each message has an `id`, `role`, `blocks`, and optional `timestamp`, `parentId`, and `usage`. Block types are `text`, `thinking`, `tool_use`, `tool_result`, and `image`; tool IDs/names and plain text arguments/results are preserved. Markdown/code remain plain source for the client renderer. Images are placeholders, without following file paths or fetching URLs. Claude usage includes only recorded input/output/cache token counts, without fabricated remaining context or provider quotas. Codex includes public reasoning summaries, without hidden reasoning or encrypted content. Unknown record/block types are omitted rather than guessed. Transcript content can include prompts, commands, and secrets that the agent recorded; request only files you intend to expose to your authenticated SSH client.

The default view is an append-record browser. Claude sidechain, team, and meta records are omitted, but old branches/compaction records can still occur in file order. Pi and OMP use `--agent pi` or `--agent omp` with the same paging contract; only their version-3 message/tool records are normalized. Custom extension entries, external blobs, branch navigation, and context compaction reconstruction for these agents remain terminal workflows. Prompts and stop/approval actions must use the original live terminal. Additional agent formats and live lifecycle verification remain tracked by [issue #5](https://github.com/mihazs/lazysh/issues/5).

The app's transcript view includes an editable **Draft for this terminal** composer. **Stage in terminal** (or Ctrl/Command-Enter after IME composition ends) moves the draft into the composer for that existing SSH terminal. Review the intended live agent pane there before using **Paste draft**. Staging does not send a prompt, launch an agent, or establish that the manually selected transcript belongs to the current pane. Permissions, plans, questions and stop requests remain live-terminal actions until their exact runtime mapping is verified. **Open terminal** returns to that terminal without staging text.

### Claude current branch

Use `lazysh-agent transcript --agent claude --view conversation --path /absolute/path/session.jsonl --limit 100` to reconstruct the current main conversation branch. This reads a bounded complete snapshot, picks the latest main user/assistant leaf, follows `parentUuid`, and recovers sibling tool calls and results belonging to responses on that branch. Compaction follows the new summary chain without reconnecting `logicalParentUuid` to obsolete context. Duplicate UUIDs use their latest record; cycles fail closed.

The response uses `view: "active_branch"`, optional `branchId`, `hasMore: false`, and `truncated: true` when older selected messages exceed the requested limit or output budget. Refresh replaces the whole conversation snapshot, including when the selected branch changes. `--offset` must be zero in this mode. It accepts at most 16 MiB and 10,000 linked records; larger files return an error and remain available through record paging/the terminal. Conversation mode is supported only for Claude.

### Find session files

Run `lazysh-agent discover --agent claude --limit 50` (or `codex`, `pi`, `omp`) to list recent transcript paths, filenames, modification times and sizes. Discovery reads filesystem metadata, without parsing prompts or transcript content. Defaults are Claude's `~/.claude/projects`, Codex's `~/.codex/sessions`, Pi's `~/.pi/agent/sessions`, and OMP's `~/.omp/agent/sessions`. It honors `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `PI_CODING_AGENT_DIR` respectively. Supply `--root /explicit/session/directory` for alternate layouts, OMP named profiles, XDG storage, or custom agent directories.

The response has `schemaVersion: 1`, `agent`, `sessions: [{path, name, modifiedAt, bytes}]`, and `truncated`. At most 100 paths are returned, sorted newest first. Traversal is limited to the documented project/date directory depths and 10,000 entries; `truncated: true` means additional or unexamined paths may exist. Symlink entries are ignored. A missing default directory returns an empty list. Discovery does not attach a transcript to a live pane; the selected file is a read-only view until its runtime identity is independently established.

### Hermes and OpenCode databases

Current Hermes sessions use SQLite rather than the legacy per-session JSONL files. Current OpenCode v2 uses `session_v2` and `session_message` projections. Select a session ID from discovery and request records explicitly:

```sh
lazysh-agent discover --agent hermes --limit 50
lazysh-agent transcript --agent hermes --path /absolute/path/state.db --session-id selected-session --limit 50
lazysh-agent discover --agent opencode --root /absolute/path/opencode.db
lazysh-agent transcript --agent opencode --path /absolute/path/opencode.db --session-id ses_selected --limit 50
```

Discovery adds `sessionId` to each result and reads session metadata, without reading message content. Hermes resolves `$HERMES_HOME/state.db` (otherwise `~/.hermes/state.db`, or local app data `hermes/state.db` on Windows); OpenCode resolves `$XDG_DATA_HOME/opencode/opencode.db` (otherwise `~/.local/share/opencode/opencode.db`). `--root` accepts an explicit database path or its containing directory. Select the profile's actual database for isolated Hermes profiles. Missing databases return an empty discovery list; incompatible schemas return an error without running migrations.

SQLite `--offset` is an opaque numeric row cursor rather than a byte position; always reuse the returned `nextOffset`. Hermes reads only rows for the selected session with `active = 1` and `compacted = 0`; OpenCode reads the selected session's ordered v2 projection. Reopen from offset zero to see rewritten, rewound, or updated earlier rows. Hermes compression ancestry and OpenCode v1/event-log reconstruction are not implemented. These readers do not grant access to a live process or a pending approval.

Database connections use SQLite read-only/no-follow flags, `query_only`, and disabled trusted schema. Source rows and schema remain unchanged. Reads include committed WAL content through SQLite's normal locking/sidecar handling. Requests examine at most 200 rows, cap SQLite row size at 512 KiB, retain the normal 512 KiB output budget, and interrupt after approximately 10 million VM steps or two seconds. Busy waits have a two-second timeout. A single oversized record fails instead of returning a nonadvancing page. Hermes text, structured content, tools/results and OpenCode v2 text, thinking, tools/results, attachments and recorded token counts are supported; unknown provider/native fields remain omitted. There is no fabricated Hermes per-message usage or provider quota.

The reader accepts regular files only, refuses leaf symlinks, and checks current-user ownership on Unix. Unix opens are nonblocking so a named pipe cannot hang the companion. Requests scan at most 4 MiB, accept records up to 256 KiB, and return at most 100 messages and 512 KiB of serialized message data plus envelope overhead. If ignored records exhaust the scan budget, an empty page can still have `hasMore: true` with an advanced cursor. Oversized or malformed complete records fail without echoing the payload; the terminal remains available. Reading a transcript never writes the companion database or the transcript.

Format evidence: [Anthropic's session browser cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) and [official SDK transcript reconstruction](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py); [Codex rollout envelope](https://github.com/openai/codex/blob/main/codex-rs/history/src/lib.rs) and [response item models](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs); [Pi session entry source](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) and [message types](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/types.ts); [OMP entry types](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/session-entries.ts) and [session discovery documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/session-switching-and-recent-listing.md), inspected 2026-10-24. These formats are version-sensitive; fixtures verify the supported shapes, not every installed agent version.

Database format evidence: [Hermes session storage](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md), [schema](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_common.py), and [content encoding](https://github.com/NousResearch/hermes-agent/blob/main/hermes_state_messages.py); [OpenCode v2 schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts), [message models](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-message.ts), and [global path roots](https://github.com/anomalyco/opencode/blob/dev/packages/util/src/global-roots.ts), inspected 2026-10-24. Validation uses synthetic native fixtures in temporary directories; no developer's actual session database was read.

### Copilot CLI, Qoder IDE and Kimi CLI

These formats use the normal byte-cursor record paging contract:

| Agent argument | Default discovery root | Selected transcript |
| --- | --- | --- |
| `copilot` | `~/.copilot/session-state` | `<session-id>/events.jsonl` |
| `qoder-ide` | `~/.qoder/projects` | `<project>/transcript/<session-id>.jsonl` |
| `kimi` | `$KIMI_SHARE_DIR/sessions`, otherwise `~/.kimi/sessions` | `<workdir-key>/<session-id>/context.jsonl` |

Copilot support follows the official generated event schema associated with CLI `1.0.104-3`. It reads persisted user/assistant messages, completed thinking, executed tool calls and results. Ephemeral streaming deltas, subagent events carrying a parent tool-call identity, and hidden skill/inter-agent user-message sources are omitted. Tool requests embedded in assistant messages are not duplicated as additional executed tools. Only explicitly stored output-token counts are shown; the full usage event is ephemeral and is not guaranteed in the persisted log. Alternate configuration directories require an explicit discovery root.

Qoder support is specifically the **IDE transcript format** published in its hook documentation: user/assistant messages, text, tool calls and tool results. Its record adapter does not establish Qoder CLI storage compatibility, native chat resumption, provider quotas, or safe approval targeting.

Kimi support follows open-source **Kimi CLI 1.52.0** (`MoonshotAI/kimi-cli`), using its `context.jsonl` format. User/assistant/tool messages, plaintext `think` content and function tools/results are normalized. System prompts, checkpoints, context-count metadata, encrypted thinking fields and partial messages are omitted. This is separate from newer `kimi-code` distributions documented under `~/.kimi-code` with `agents/main/wire.jsonl`; those formats are not claimed by this adapter. Context rewind/compaction can replace the file, so reopen at offset zero after such changes.

Primary format evidence: [Copilot persisted path and event loop](https://github.com/github/copilot-sdk/blob/main/docs/features/agent-loop.md), [Copilot event types at inspected commit](https://github.com/github/copilot-sdk/blob/c57638f4a7ce2255a34192d5035932d0e109bbdd/nodejs/src/generated/session-events.ts), [Qoder IDE transcript specification](https://docs.qoder.com/zh/extensions/hooks), [Kimi 1.52 context writer](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/context.py), and [Kimi message types](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/packages/kosong/src/kosong/message.py), inspected 2026-10-24. Native tests exercise synthetic records only; installed runtime behavior remains unverified.

### jcode snapshot and journal

Use `--agent jcode` to read a jcode `0.99.1` snapshot together with its append journal. Discovery lists `*.json` snapshots under `$JCODE_HOME/sessions` (otherwise `~/.jcode/sessions`); reading `session.json` also reads its sibling `session.journal.jsonl` if present. Messages already contained in the snapshot are deduplicated by their IDs, preserving the first authoritative copy, matching jcode's idempotent replay behavior. Text, history thinking traces, signed Anthropic thinking text, tool calls/results and recorded token usage are supported. Signatures, hidden replay reasoning, opaque provider state, system prompts and display-only system/background messages are omitted. Other unsupported content remains a terminal workflow.

The opaque numeric `nextOffset` is a message index for this format. Each request reconstructs the bounded snapshot/journal before paging. Snapshots and journals are each limited to 16 MiB, journal lines to 256 KiB, and reconstructed messages and journal entries to 10,000 each. Partial trailing journal entries are retried on refresh; malformed complete entries fail instead of attempting jcode's recovery/migration writes. File sizes and modification times are checked again after reading, plus file identity on Unix; a detected concurrent checkpoint or append fails for a fresh retry. This is not a lock on the running agent or protection against all same-size metadata-preserving rewrites. Reopen from offset zero after an agent rewind or snapshot rewrite.

Primary evidence: [jcode snapshot model](https://github.com/1jehuang/jcode/blob/022e13f88c1b55319f3f4aa9cfb63039246a51da/crates/jcode-base/src/session.rs), [message types](https://github.com/1jehuang/jcode/blob/022e13f88c1b55319f3f4aa9cfb63039246a51da/crates/jcode-message-types/src/lib.rs), [journal entry shape](https://github.com/1jehuang/jcode/blob/022e13f88c1b55319f3f4aa9cfb63039246a51da/crates/jcode-base/src/session/journal.rs), and [snapshot/journal replay](https://github.com/1jehuang/jcode/blob/022e13f88c1b55319f3f4aa9cfb63039246a51da/crates/jcode-base/src/session/persistence.rs), inspected 2026-10-24.

Run the native Rust unit and CLI integration tests with `cargo test --package lazysh-agent --locked`, or `bunx turbo run test --filter=@lazysh/agent`. Tests spawn the compiled executable with isolated state directories; there is no Python runtime or test script dependency.
