# Agent events over your own SSH connection

The terminal works without this optional host component. The companion observes lifecycle events and can read explicitly selected Claude Code, Codex, Pi, OMP, Hermes, OpenCode, Copilot CLI, Qoder IDE, Kimi CLI, or jcode transcripts. It does not answer approvals, launch agents, or send data to a cloud service.

Install on the **remote host**, using Rust stable from a checkout of this repository:

```sh
cargo install --path apps/agent --locked
lazysh-agent snapshot --limit 50
```

Ensure `lazysh-agent` is on the noninteractive SSH PATH. lazysh reads `lazysh-agent snapshot --limit 50` over the existing verified SSH session when you open or refresh the Agents panel. There is no HTTP server or listening port.

The Agents panel's [host companion settings](companion-settings.md) control new transcript discovery, recorded usage inspection and device operations. Settings persist on the host; absent settings preserve existing defaults without creating state.

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

Concurrent lifecycle writes use short lock polls within a three-second elapsed-time wait budget per SQLite locking episode. Sustained contention fails explicitly; storage failures include only the numeric SQLite extended error code, never its potentially sensitive message. Journal and synchronization settings retain SQLite's durable defaults.

The Linux CI companion test task explicitly opts into syscall observation for
the existing `concurrent_hooks_preserve_every_event` Cargo integration case via
`LAZYSH_TEST_STORAGE_TRACE_DIR`. Only that case's sixteen synthetic CLI child
processes are wrapped in `strace`; other cases and services remain untraced.
An explicit request fails if the tool or results directory is unavailable.
Traces contain PID-separated `fcntl`, `fsync` and `fdatasync` calls with absolute
timestamps, durations and file-descriptor paths, without event payload reads,
writes, argv or environment. Strace propagates the child's exit status; the
original sixteen-success and event-count assertions remain unchanged.

The native fixture reaps every worker and exports evidence before checking the
success gates. It exports at most 64 owned regular PID files, preserving up to
128 KiB of beginning/end data per file (at most 8 MiB of trace excerpts), plus
a bounded status manifest. Symlinks, hard links, foreign ownership and unexpected
filenames are rejected. The temporary raw spool is **not byte-capped during
tracing**; only the exported excerpts are capped, and the spool is removed when
the fixture exits normally. CI uploads `lazysh-storage-syscalls` after the
original task on success/failure, without rerunning the suite, and bounds the
agent job to twenty minutes. Tracing changes scheduling and I/O timing, so these
artifacts are evidence with an observer effect, not a diagnosis or storage fix
for [issue #36](https://github.com/mihazs/lazysh/issues/36). Production storage,
durability and the three-second busy budget are unchanged.

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

### Factory Droid

`--agent droid` reads the persisted JSONL message envelope shipped in Factory Droid **0.249.0**. Discovery lists UUID-named JSONL files at most one directory below `~/.factory/sessions`; an explicit root supports other installations. It uses the same bounded byte-cursor record stream as the other JSONL adapters. Text, plaintext thinking, tool calls/results, timestamps and parent IDs are normalized. Messages marked `llm_only`, `hiddenFromUserViews`, or `isUserVisible: false` are omitted. Opaque reasoning, signatures, system/session metadata and unverified token metadata are omitted. This adapter does not reconstruct active branches or assert provider quota, current context, cloud sync or compaction behavior. Restart paging from zero after transcript replacement.

Evidence is the [official installer](https://app.factory.ai/cli) and its [Linux x64 0.249.0 artifact](https://downloads.factory.ai/factory-cli/releases/0.249.0/linux/x64/droid), inspected without execution on 2026-10-24. The binary's SHA-256 is `ef63246cbdd93cd1f97e6d058e31d27fb135bf46b258a4ce179434f0c62e2455`, matching the publisher checksum. Static analysis observed the native `appendMessageToSessionUnlocked` writer and its content sanitizer. The `.bun` section starts at ELF file offset `0x06804000`; selected section-relative source spans are `[96566150,97077586)` (storage, SHA-256 `0da735067bbf0a5ec621db4b5a50a2259980186c677e7349f819f210a6c78129`) and `[96166944,96212246)` (sanitizer, SHA-256 `ddd6f9daaac1e29057b10572c2add840cd4c26da089beedccf542f9056d4b5c3`). REA parsed the selected JavaScript as inert text with zero parse failures; its relationship graph was partial. Native disassembly providers were unavailable. No proprietary source or assets were copied into the application; fixtures independently exercise the observed format. Installed Droid behavior and real account transcripts were not tested.

### Cursor IDE

`--agent cursor` supports the JSONL transcript export shipped in **Cursor IDE 3.27.12**, commit `df132ffba90dfc15a12e6b8f020ba4e5d026c4be`. Discovery lists `~/.cursor/projects/<workspace>/agent-transcripts/<id>.jsonl` and the current `<id>/<id>.jsonl` layout. Subagent files are excluded from discovery and remain available by explicit selection. Text and tool names/inputs are supported. The native exporter combines reasoning with text and omits tool results, IDs, timestamps and token counters; lazysh preserves these limitations. Byte offsets provide record identity within the selected file. Refresh from offset zero after the IDE rewrites it. This does not claim compatibility with Cursor CLI session databases, full tool outputs, active branch reconstruction or provider quotas.

Evidence: [official Linux download metadata](https://www.cursor.com/api/download?platform=linux-x64&releaseTrack=stable) and the [versioned official Debian package](https://downloads.cursor.com/production/df132ffba90dfc15a12e6b8f020ba4e5d026c4be/linux/x64/deb/amd64/deb/cursor_3.27.12_amd64.deb), inspected without executing it on 2026-10-24. Package SHA-256: `d4ef921445ace628a9cb2b41b5d82d734d370a672e2d22ddef728a951655a036`; `resources/app/out/vs/workbench/workbench.desktop.main.js` SHA-256: `456c522f94070571946de2e2b2fe980d4f5806467805a7c28d04afcc2bef9d90`. The statically observed JSONL serializer and message projection occupy byte range `[18923762,18931618)` of that bundle (derived span SHA-256 `117c21aacae9b61b31644b18c89739f06c58c12725a4dcb5a5dae44c4ddfc2a8`). REA parsed the selected inert JavaScript with zero parse failures; analysis was partial and did not execute the application. Fixtures contain independently created messages, and no private account transcripts or installed runtime behavior were inspected.

### OmO Native

`--agent omo` supports OmO Native **`omo-ai` 5.1.46** with its pinned **`@code-yeongyu/senpi` 2026.10.23-1** engine. This engine persists version 3 Pi-family message envelopes, so the adapter shares Pi's text/thinking/tools/results and recorded billing counter normalization. It returns the append record stream, including branches; it does not infer the current conversation branch. Context-specific measurements, costs, system messages and custom extension records are omitted. Billing counters remain billing counters and are not relabeled current context usage.

Discovery uses `~/.omo/agent/sessions/<encoded-cwd>/*.jsonl`, honoring `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR` overrides. Legacy/profile/XDG stores can be selected with an explicit root. This adapter targets the standalone native edition. The older oh-my-opencode OpenCode plugin uses its host's storage and requires the appropriate OpenCode reader instead.

Primary evidence at commit `784d7f9197eac084340331c1612f939728c6ad57`: [native package and pinned engine](https://github.com/code-yeongyu/oh-my-openagent/blob/784d7f9197eac084340331c1612f939728c6ad57/packages/omo-native/package.json), [canonical agent directory precedence](https://github.com/code-yeongyu/oh-my-openagent/blob/784d7f9197eac084340331c1612f939728c6ad57/packages/omo-native/bin/lib/agent-dir.js), [first-party session format reference](https://github.com/code-yeongyu/oh-my-openagent/blob/784d7f9197eac084340331c1612f939728c6ad57/packages/shared-skills/skills/coding-agent-sessions/references/senpi.md), and the [published pinned engine](https://registry.npmjs.org/@code-yeongyu/senpi/-/senpi-2026.10.23-1.tgz) (`dist/core/session-manager.js` and `.d.ts`) plus [message/usage types](https://registry.npmjs.org/@code-yeongyu/senpi-ai/-/senpi-ai-2026.10.23-1.tgz) (`dist/types.d.ts`), inspected without executing either package. Tests use synthetic native records and isolated environment overrides.

### Devin ATIF export

`--agent devin-atif` reads a selected **ATIF-v1.7** export file. Devin CLI documents `--export [PATH]` as writing the conversation after turns; lazysh does not run that command or start/resume an agent. This is exported-history support, not a reader for Devin's native `sessions.db`, a live hook integration, or an automatic export.

`discover --agent devin-atif` lists existing export candidates immediately inside `$XDG_DATA_HOME/devin/cli/transcripts`, falling back to `~/.local/share/devin/cli/transcripts` when that variable is unset, empty, or relative. The documented per-session filename is `<id>.json`; IDs remain opaque and lazysh does not assume a UUID or parse them from file contents. An explicit `--root <export-directory>` selects another flat directory. Discovery reads metadata only, examines at most 10,000 entries, returns at most 100 candidates, skips symlink/nonregular files, refuses a symlink root, and creates no missing directory. A listed JSON file is a candidate, not confirmed ATIF: the reader validates its schema and bounds when selected. Existing rewrites require reopening from offset zero. Linux fixture tests verify default/XDG resolution; live provider exports and other operating systems remain unverified.

Discovery evidence: the [official Moshi companion v0.4.37 Linux archive](https://cdn.getmoshi.app/hook/v0.4.37/moshi-hook_Linux_x86_64.tar.gz), SHA-256 `c401ba0adeaa46d38558ff862a584c824d32e64dc8d79d44daa53e81a6aab4af` matching the publisher checksums and Homebrew formula. Its shipped `docs/api.md` transcript section and `docs/hooks.md` Devin section describe the XDG directory, `<id>.json` mapping, and ATIF step conversion. This documents the target app's export integration; the Devin CLI/export-format evidence below independently pins the supported ATIF version. Relative/empty XDG handling follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/).

Each request reads at most 16 MiB and 10,000 sequential steps, then returns up to 100 normalized messages under the existing 512 KiB message-output budget. `nextOffset` is an opaque **step index**, including skipped system steps. Unsupported versions, malformed snapshots, duplicate/nonsequential step IDs, unknown sources/content kinds, more than 1,000 parts/calls/results per step, or a text block above 256 KiB fail explicitly. The reader uses the existing regular-file, no-follow, Unix-owner checks and detects size/mtime changes plus Unix file identity changes during reading. This detects common concurrent rewrites rather than locking the source. Reopen at zero after replacement or truncation.

User/agent text, image placeholders, explicit plaintext reasoning, tool names/arguments and observation content are supported. System prompts, root/final rollups, provider-specific `extra`, costs and referenced subagent trajectories are omitted. Images and subagent references are never opened or fetched. Per-step `prompt_tokens` maps to recorded input tokens (including cached input), `completion_tokens` to output, and `cached_tokens` to cache reads; no cache-write count or context/quota value is inferred. Copied-context steps are retained as exported, so this is an ordered export record stream and should not be summed as fresh billing.

Evidence: [Devin's documented export flag](https://docs.devin.ai/cli/reference/commands) and the [official 3000.11.205 Linux archive](https://static.devin.ai/cli/3000.11.205/devin-3000.11.205-x86_64-unknown-linux.tar.gz), obtained through its official installer/manifest and matching the published SHA-256 `2e65c8b93682258fc91f5e4cead92e3698338cebf1b31dbc32a3201cb63705c4`. Its `bin/devin` SHA-256 is `642c82e32cb3dec90cf5ab01975520b425307872c7a650c9fb5b0653f37681f4`; static x86-64 disassembly at VA `0x5b36e16` through `0x5b36e27` constructs `ATIF-v1.7`. This is a static format anchor, not execution of its exporter. Canonical ATIF field evidence is pinned to Harbor commit `6099b8cf2bfbbb3e7ff1eb2163bfc4524dbd9ba5`: [step](https://github.com/harbor-framework/harbor/blob/6099b8cf2bfbbb3e7ff1eb2163bfc4524dbd9ba5/src/harbor/models/trajectories/step.py), [tool call](https://github.com/harbor-framework/harbor/blob/6099b8cf2bfbbb3e7ff1eb2163bfc4524dbd9ba5/src/harbor/models/trajectories/tool_call.py), [observation result](https://github.com/harbor-framework/harbor/blob/6099b8cf2bfbbb3e7ff1eb2163bfc4524dbd9ba5/src/harbor/models/trajectories/observation_result.py), and [metrics](https://github.com/harbor-framework/harbor/blob/6099b8cf2bfbbb3e7ff1eb2163bfc4524dbd9ba5/src/harbor/models/trajectories/metrics.py). Independently constructed fixtures exercise this contract. No private transcripts or Devin runtime were accessed; real exported-file compatibility remains untested.

### Amp JSON export

`--agent amp-json` reads an explicitly selected full thread JSON export using the format observed in official **`@sourcegraph/amp` 0.0.1778732631-gc5875c**. Amp documents `amp threads export T-...` for creating full JSON exports, but lazysh never invokes Amp, starts an agent, loads plugins, or fetches the thread. This adapter does not discover a native Amp cache. Latest CLI exports remain unverified; the pinned distribution is historical evidence for the supported shape, not a claim that all versions use it. Top-level `v` is a thread revision counter, not a schema version.

The bounded snapshot reader shares Devin export's 16 MiB input, 10,000 records, 100 messages/page, 1,000 blocks/message, 256 KiB text/block and 512 KiB message-output limits, regular-file/owner/no-follow checks and concurrent replacement detection. `nextOffset` is a message index. Duplicate IDs fail; numeric and string IDs are preserved distinctly. Restart at zero after rewrites. No default discovery path is assumed; an explicit export-directory root lists JSON files at depth zero.

The reader supports main-thread user/assistant text, plaintext thinking, tool calls, image placeholders and completed tool results. Structured tool results are rendered as JSON; progress/error/cancelled runs are omitted rather than presented as completed output. Info records, delegated-agent messages (`parentToolUseId`), root debug/system/provider state, unknown content, file mentions and referenced media are omitted. Recorded per-message input/output/cache-read/cache-write counters are preserved; total/max context values and timestamps are not inferred.

Primary evidence: [official thread export documentation](https://ampcode.com/docs/threads) and the [versioned official npm artifact](https://registry.npmjs.org/@sourcegraph/amp/-/amp-0.0.1778732631-gc5875c.tgz), inspected as inert JavaScript on 2026-10-24. Archive SHA-256 `c64e86edecde79e659914df30dad4060c8d7dd2d91a884e2b94b4262d0f8c911`; `dist/main.js` SHA-256 `458435712c9c4e222822847fc9e70080cdf023ffb3c820e959a30425a22a5836`. The full-thread JSON export function occupies bundle byte range `[8692546,8692830)` (selected-span SHA-256 `46f08280586103e38944b2a4cfefb09b10e026002b9265ab2b9cb06b9a167470`); its message projection occupies `[2355907,2356741)` (SHA-256 `69cf3797d4147e3603ae5ce8290abb57a30a9e2b1d17b70b6fdd9327d86c5b5e`). REA parsed both selected spans with zero parse failures; relationship analysis remained partial. No Amp code was executed or copied into lazysh, and no private account data was read. Native Cargo fixtures independently recreate the observed envelope and content shapes; real exported files remain untested.

### Grok ACP records

`--agent grok-acp` reads an explicitly selected modern `updates.jsonl` file:

```sh
lazysh-agent transcript --agent grok-acp --path /absolute/path/updates.jsonl --limit 50
```

This is a **record stream**, not reconstructed Grok Chat View. Every normalized row has a byte-offset record ID, so chunks sharing a provider `messageId` remain distinct. Standard ACP user/assistant text, plaintext thinking, attachment placeholders, tool calls and recorded output/diffs are supported. Tool updates remain separate snapshots; their optional collections replace upstream state rather than representing append deltas. Complete ACP plan snapshots and xAI `plan_kept` content render as labeled text. Media, resource URIs, terminal references, diff paths and plan URIs are never opened or fetched. Metadata/status-only updates do not fabricate tool output.

The modern disk envelope is `{timestamp, method, params: {sessionId, update}}`. `timestamp` is a provider-recorded unsigned UNIX-second value, converted to RFC 3339; missing/invalid/out-of-range values are skipped without substituting local time. Only `session/update` and `_x.ai/session/update` are accepted. Legacy raw notifications, unknown event types, usage/quota fields, turn-completion summaries and rewind markers are omitted while advancing the cursor. Malformed complete JSON fails. The existing regular-file, Unix owner/no-follow/nonblocking checks, 256 KiB record, 4 MiB scan, 100 messages/page and 512 KiB output budgets apply. An incomplete final line remains retryable from the returned cursor. Grok tool IDs are limited to 256 UTF-8 bytes and tool content to 999 blocks for a call or 1,000 for an update, checked before cloning identifiers; oversized records fail without truncating identity. A single normalized record exceeding the page budget fails explicitly instead of returning a non-progressing cursor.

Automatic discovery and `--view conversation` are explicitly unsupported for this adapter. The UI labels it **Grok ACP records (explicit file)** and disables discovery. Grok's append-only rewind records create timeline branches; this record view can contain abandoned history and does not merge chunks, replace tool cards in place, reconstruct turns or remove rewound messages. It does not launch a Grok CLI/exporter, access account APIs, install hooks or establish that the selected file belongs to the live terminal. Defaults and live terminal controls are unchanged.

Evidence is official `xai-org/grok-build` commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (`SOURCE_REV` `559751fdcec02d413e4c57c8832ab275e4f44980`), inspected 2026-10-25: the [disk envelope and fixtures](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/mod.rs#L721), [actual JSONL writer](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs#L634), and [xAI extension definitions](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L517). Its lockfile pins ACP 0.10.4 with schema 0.11.4. [Synthetic fixture provenance](../apps/agent/tests/fixtures/grok-acp/README.md) records checksums and type anchors. These source contracts do not prove equivalence to the previously inspected Grok 1.0.70 artifact or every installed release. No provider CLI, account data or real user transcript was executed/accessed. Full Grok conversation/runtime compatibility remains [issue #5](https://github.com/mihazs/lazysh/issues/5) work.

Run the native Rust unit and CLI integration tests with `cargo test --package lazysh-agent --locked`, or `bunx turbo run test --filter=@lazysh/agent`. Tests spawn the compiled executable with isolated state directories; there is no Python runtime or test script dependency.


## Diagnose companion write contention

The CI `agent` job runs a separate native timing probe after the normal package checks, including when those checks fail. Its result never changes the preceding checks' failure status. The probe has a two-minute CI step limit and prints only fixed phase names, worker indices, durations and commit counts for a temporary synthetic database. It does not print SQL, event values, database paths or account data.

Run the same probe locally with:

```sh
cargo test --locked --package lazysh-agent --lib storage_diagnostics::profile_storage_commit_phases -- --ignored --exact --nocapture
```

SQLite's statement profile records `BEGIN`, insert, retention and commit duration. The existing busy callback is wrapped only in this fixture to measure its elapsed waiting separately; `other_wall` includes all remaining work and scheduling, not a direct measurement of filesystem synchronization. SQLite profile durations have millisecond resolution. The hosted probe injects no delay and keeps the production journal, synchronization and three-second per-locking-episode budget unchanged. This follow-up probe runs after the normal checks, so it does not reproduce all concurrent load present in an earlier failure.

A second ignored native probe, `storage_diagnostics::profile_storage_with_known_commit_hold`, deliberately holds each transaction for 250 ms in a test-only commit hook. It demonstrates that serialized write-held time can exhaust some wait budgets, while checking that every acknowledged commit remains in storage. It is not run by CI and is not evidence that hosted failures are caused by `fsync`. Neither probe replaces the strict concurrent-write acceptance tests or fixes [issue #36](https://github.com/mihazs/lazysh/issues/36); hosted phase evidence is needed before changing the storage algorithm.

## Antigravity explicit step records

`--agent antigravity-jsonl` reads only an explicitly selected JSONL file:

```sh
lazysh-agent transcript --agent antigravity-jsonl --path /absolute/path/transcript.jsonl --limit 50
```

Native SSH Chat offers **Antigravity step records (explicit file)**. Discovery and
conversation mode are rejected. Nothing launches Antigravity, reads sibling full
transcripts, executes tool arguments or follows media URIs. Existing adapter
choices/defaults and cursors remain unchanged.

The contract is pinned to the official **Antigravity CLI 1.4.7**, build
**5900205422411776**, extracted binary SHA-256
`40349135371a8ed1f1af1e9f8b741de99174ae9fce6380b96c2d1f543480af7a`.
Read-only runtime struct descriptors/JSON tags and writer callsites establish the
step record shape and both append and full-rewrite operations. [Independent
fixture provenance](../apps/agent/tests/fixtures/antigravity-jsonl/README.md) records
field types, artifact checks and the separate REA build-metadata evidence boundary.

Each record displays its literal `source`, `type`, `status`, optional `step_index`,
exit/error codes and producer `truncated_fields` flags. Available `content` and
`thinking` use existing text/thinking blocks. Tool summaries have no invented
invocation/result identifiers, and media become inert attachment placeholders.
All records use the neutral `record` role; repeated indices/status updates remain
separate physical records. Optional zero values are retained. Token counters are
exact decimal strings, including uint64 values that JavaScript numbers cannot
represent. Unknown string enums are retained without guessing roles. Known fields
with invalid types/ranges fail the read; unknown extra fields are ignored.

The response retains numeric byte `nextOffset` and adds an Antigravity-only
`checkpoint`: `v1:<observed file length>:<SHA-256 of those observed bytes>`.
Every request after the initial open must supply the returned checkpoint, even
when `hasMore` is false and refreshing. For example, pass both
`--offset <nextOffset> --checkpoint <checkpoint>`. Appends can continue only when
the entire previously observed prefix still matches. Truncation, changed bytes
(including same-size in-place or replacement rewrites), or a cursor beyond the
previous snapshot fail with `TranscriptChanged`; reopen at offset zero without a
checkpoint to replace the visible records. Byte-identical replacements are
content-equivalent and accepted between requests. Incomplete final lines wait
without advancing, and may be completed by a later append.

The reader bounds the observed file/hash to **16 MiB**, each physical line to
**256 KiB**, page scanning to **4 MiB**, output to **512 KiB** and page records to
**100**. Arrays/block amplification and label lengths are bounded. It reuses
regular-file, owner and no-follow admission checks, then compares size/mtime and
Unix device/inode after reading to detect ordinary concurrent writer changes.
This is not a lock or atomic snapshot of a hostile metadata-preserving concurrent
rewrite. On such read errors, retry by reopening rather than mixing generations.
Producer compact truncation flags do not mean lazysh fetched a full transcript.

Focused checks:

```sh
cargo test --locked -p lazysh-agent --test antigravity_transcript
bun run --cwd apps/client test src/ChatPanel.test.tsx
```

Synthetic fixtures and controlled rewrite tests establish this bounded contract;
no actual Antigravity conversation/account file or provider CLI was used. Full
enum normalization, branch/update reconstruction, tool-result associations,
producer truncation thresholds, crash consistency, cross-version behavior and
real-file/device acceptance remain open integration work.
