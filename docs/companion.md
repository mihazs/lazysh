# Agent events over your own SSH connection

The terminal works without this optional host component. The companion observes lifecycle events and can read explicitly selected Claude Code, Codex, Pi, OMP, Hermes, OpenCode, Copilot CLI, Qoder IDE, Kimi CLI, or jcode transcripts. It does not answer approvals, launch agents, or send data to a cloud service.

Install on the **remote host**. Future releases with companion executables provide
verified Linux x64/ARM64, macOS Intel/ARM64 and Windows x64 assets; follow the
[distribution and verification guide](install-and-update.md#remote-companion-executables).
Published v0.23.0 has no such assets and is not backfilled. In-app installation is
separate [issue #476](https://github.com/mihazs/lazysh/issues/476) work.

Alternatively, use Rust stable from a checkout of this repository:

```sh
cargo install --path apps/agent --locked
lazysh-agent snapshot --limit 50
```

Ensure `lazysh-agent` is on the noninteractive SSH PATH. lazysh reads `lazysh-agent snapshot --limit 50` over the existing verified SSH session when you open or refresh the Agents panel. There is no HTTP server or listening port.

The Agents panel's [host companion settings](companion-settings.md) control new transcript discovery, recorded usage inspection and device operations. Settings persist on the host; absent settings preserve existing defaults without creating state.

## Claude Code

Run `lazysh-agent claude-config` and merge the printed `hooks` entries into your Claude settings, preserving existing entries. This command only prints JSON. Run Claude in tmux to include its `TMUX_PANE` identity. The [official hook reference](https://code.claude.com/docs/en/hooks) defines the inputs this adapter handles. Lifecycle summaries include tool names but omit prompts, tool arguments, transcripts, and credentials. An informational notification does not imply a pending approval.

### Optional Claude reported-history shortcut

Run `lazysh-agent claude-config --reported-history` to print an explicitly opted-in
hook fragment, then merge it into your Claude settings without replacing other
hooks. If the ordinary lazysh ingest command is already installed, replace that
command with the flagged form rather than installing both; keep unrelated hooks.
The fragment adds `SessionStart` and passes `--reported-history` to Claude
ingest commands. Neither printing the fragment nor ordinary `claude-config` or
ingest enables capture automatically; the default remains off.

For supported top-level `SessionStart` and `UserPromptSubmit` hooks, the companion
retains the exact `session_id` and absolute `transcript_path` supplied together
by Claude, with optional reported pane metadata and report time. No filename,
UUID or working-directory relationship is inferred. This is the official
[common hook input](https://code.claude.com/docs/en/hooks#common-input-fields)
association, not evidence that the process is still running; transcript writes
may also lag the hook event. Subagent metadata is not used for this shortcut.
Ingest does not open a transcript, store prompts/tool arguments/content or send
the path through lifecycle snapshots, notifications or relay publishing.

Metadata lives in a separate additive table in the existing private SQLite store,
under the existing bootstrap, transaction and filesystem admission mechanisms.
The frozen lifecycle table and older positional writers remain compatible. At
most 100 associations are retained for seven days after their last report.
Conflicting or malformed path reports stay unavailable while the association is
retained, rather than selecting a first/latest file. Invalid metadata does not
discard an otherwise valid lifecycle event. Capture preserves the host's exact
absolute spelling, including spaces and Unicode; it does not expand `~` or
normalize paths. Actual file admission still occurs when the user opens it.

In Agents, select **Use reported history** on the intended Claude row. The app
looks up that exact opaque Claude session on the row's existing authenticated SSH
connection and prefills Chat with Claude, Records, images off and Follow off.
Press **Open transcript** to read the file through the existing guarded reader.
The notice states that the history may be old and its running agent is
unverified. Ordinary manual path entry remains available, including when the
host has an older companion or no usable association. Raw host diagnostics are
preserved rather than matching English error text or guessing versions.

The companion's metadata lookup is
`lazysh-agent reported-history --session-id=OPAQUE_ID`; use the exact reported
session identifier, not an inferred filename. It obeys the host's transcript
discovery setting and returns schema-v1 `available`, `missing` or `ambiguous`.
Only `available` includes the path, report time and nullable reported pane.
The hook opt-in controls collection independently of this lookup setting.

The user action selects a destination terminal for the existing draft staging
workflow. It is not a live transcript/process binding, direct prompt/Stop action
or approval grant. A pane ID is server-scoped and may be stale; the shortcut does
not infer a tmux server or running agent from it. Lookup/read publication retains
the original app-access lease; lock, source/session changes and unmount retire
stale callbacks without automatic replay.

This shortcut itself still grants no input authority. Claude Chat on an existing
native tmux attachment offers a separate [confirmed terminal input](chat-terminal-input.md)
flow; the user must choose and confirm its destination explicitly.

The displayed status is the last reported event, not proof that a process is still running. The visible Agents board refreshes every five seconds while the app is in the foreground; hidden boards and background windows do not start automatic reads. A pending snapshot is never duplicated, and Refresh remains available. Automatic refresh does not scan transcripts, load history or reload host settings. Respond to prompts in the live terminal until race-safe approvals are implemented.

## Other agents and scripts

Other adapters can send the explicit generic schema; this is a protocol, not a claim that every agent is already integrated:

```sh
printf '%s' '{"schemaVersion":1,"sessionId":"build-1","agent":"My agent","project":"/work/app","state":"working","summary":"Running tests","paneId":"%1"}' | lazysh-agent ingest --agent generic
```

States are `working`, `needs_attention`, and `done`. Agent plus session ID identifies a row. No fields authorize remote command execution. Summaries are plain text and may contain project-sensitive information; the snapshot is visible to the authenticated SSH user. Only install hooks on hosts and agents you control.

At most 100 session summaries are retained for seven days in `events.sqlite3` in the user's state directory (`~/.local/state/lazysh` on Linux; the local application data directory on macOS/Windows). A mode-0700 directory and mode-0600 database are used on Unix. `LAZYSH_STATE_DIR` overrides that directory for testing. No original event payloads are retained. This does not yet provide automatic background refresh or remote approval actions.

The event Store uses SQLite WAL with explicit `synchronous=FULL` on every connection. Existing rollback-journal databases change to WAL when opened successfully; existing rows remain. This changes the storage default, without reducing the three-second ingest lock-wait budget or retrying a failed transaction. WAL still has one writer, so sufficiently slow storage can exhaust that budget and produces an explicit error. The directory must be on an admitted local filesystem; shared network filesystems are unsupported by SQLite WAL.

Admission runs before directory creation, chmod, bootstrap files or SQLite access. Linux admits ext2/3/4, Btrfs, XFS, tmpfs, ramfs, overlayfs and F2FS by kernel filesystem type; FUSE (including local FUSE implementations), network/cluster and unknown types fail closed. macOS requires the kernel's `MNT_LOCAL` flag. Windows resolves the actual volume and permits fixed, removable and RAM drives; network/unknown volumes fail. Other OS targets are unsupported. Rejection reports the fixed `UnsupportedStateFilesystem` class without migrating or changing existing data; configure a supported local state directory explicitly. These are OS-reported classifications, not a probe of storage hardware or a guarantee that remote block devices honor sync. See [Linux filesystem types](https://github.com/torvalds/linux/blob/master/include/uapi/linux/magic.h), [Darwin statfs](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html), and [Windows drive types](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew).

State paths containing a `..` component fail with `InvalidArgument` before admission or mutation. They are not lexically normalized across symlinks: a missing prefix followed by parent traversal could otherwise be admitted on one filesystem and created on another. Ambiguous Windows drive-relative paths such as `C:state` are also rejected before admission; ordinary relative paths are joined to the current directory and must produce an absolute path. Use the intended path directly without parent traversal.

An existing read-only transaction can prevent the rollback-to-WAL transition; this fails explicitly without retrying or changing journal mode. A new open after that reader releases its transaction can migrate. Older SQLite versions from before WAL support (3.7.0) cannot read WAL databases. Earlier lazysh builds use modern SQLite, but mixed-version concurrent bootstrap is not an acceptance claim. To deliberately revert format, stop all Store users and use SQLite to checkpoint and change `journal_mode=DELETE`; never remove a WAL file yourself. No automatic rollback or dual-format fallback is provided.

Store connections now enable SQLite's [NO_CKPT_ON_CLOSE](https://www.sqlite.org/c3ref/c_dbconfig_defensive.html#sqlitedbconfignockptonclose) immediately after a successful SQLite open, before subsequent validation or database queries. Clean CLI exit retains `events.sqlite3-wal` and `events.sqlite3-shm` instead of repeatedly checkpointing/removing them. They contain private, unencrypted event data/metadata and retain the same owner-only protections; this is a changed sidecar-lifetime default, not encryption or secure erasure. Logical event retention does not securely erase old SQLite/WAL contents.

**The main database file alone can omit acknowledged events even after every CLI process has exited.** Do not discard the WAL or treat retained sidecars as disposable temporary files. Prefer SQLite's [consistent online backup API](https://www.sqlite.org/backup.html). Alternatively, stop all Store users and use a compatible SQLite connection to perform and verify an explicit checkpoint (for example `PRAGMA wal_checkpoint(TRUNCATE)` returning a zero busy result) before copying the main file; or preserve the quiescent database and its WAL together as one consistent set. Copying the main file alone without that verification is not a complete backup. No database/sidecar is removed manually by lazysh.

Commit synchronization remains `FULL`. The normal automatic checkpoint threshold remains 1000 pages, and `journal_size_limit` remains 1 MiB for recycling after a successful checkpoint. That limit is not a hard maximum on live WAL size: long readers, busy checkpoints or storage failures can prevent recycling and permit growth. The native single-writer fixture observes growth followed by recycling across 1100 commits; it is not a universal size or latency bound. Explicit checkpoints still work.

A private `events.sqlite3-init-lock` coordinates connection bootstrap using an OS advisory lock; it contains no event data and is retained to keep a stable lock inode. Ephemeral journal/WAL/SHM validation runs while that lock is held. The original finite re-observation rule still rejects zero-link snapshots rather than accepting removed inodes. Legacy/external SQLite connections with default close behavior can still checkpoint/remove WAL/SHM; the native cleanup fixture explicitly covers that boundary. A failed SQLite open that never returns a handle also cannot be configured by Store. No claim of eliminating every unlink or establishing the intermittent SQLITE_BUSY cause is made.

Native-lock waiting, ephemeral validation and SQLite schema/mode waiting still share one absolute three-second bootstrap deadline; ingestion retains its existing separate locking-episode budget. Blocking filesystem I/O cannot be interrupted by a busy-handler deadline. No per-call cancellation API is added.

Store chooses one checked absolute namespace before filesystem admission and uses that exact path for subsequent state access, without another canonicalization. Custom Unix symlink routes, including symlinked home/state paths, are unsupported. Only Darwin's root-owned `/var`, `/tmp` and `/etc` system aliases with their verified exact `/private/...` targets are mapped; their destinations are checked component by component. Windows rejects reparse points, including directory junctions, in directory routes and existing database/sidecar files. Missing directories are created one component at a time and rechecked without following links before proceeding, so replacing a missing component after admission cannot redirect further creation or chmod onto its target.

On Unix, directory ancestors must be owned by the current user or root and must not have group/other write permission bits, except a root-owned sticky ancestor such as `/private/tmp`. The leaf must belong to the current user and is tightened to 0700 before opening state. The database must be owned and have one link. Existing journal/WAL/SHM/bootstrap files must be owned regular single-link files with mode 0600; unsafe files fail without following their links or changing their targets. SQLite creates new WAL/SHM files with the database's private permissions and its bundled Unix VFS uses no-follow opens. No database/sidecar descriptors are opened and closed outside SQLite, preserving its POSIX locks. Processes running as the same user and root remain trusted. These mode/ownership checks do not inspect additional macOS ACL grants and do not establish their safety. Windows relies on the state directory's existing user ACLs; Windows ACL validation is not added here.

SQLite documents [FULL synchronization in WAL](https://www.sqlite.org/pragma.html#pragma_synchronous) as durable across power loss subject to the underlying filesystem honoring sync. Native acceptance tests cover concurrent first-open, previous-format migration, explicit FULL settings, unsafe sidecars and recovery after killing a writer with both committed data and spilled uncommitted WAL frames. Process-kill recovery is not a hardware power-loss test. See [WAL lifetime, checkpointing and filesystem limits](https://www.sqlite.org/wal.html).

Concurrent lifecycle writes use short lock polls within a three-second elapsed-time wait budget per SQLite locking episode. Sustained contention fails explicitly; storage failures include only the numeric SQLite extended error code, never its potentially sensitive message. WAL changes journal behavior while synchronization stays explicitly FULL.

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

Supported Chat views on an existing native tmux attachment also offer explicit
**Send to terminal** and **Request stop** after confirming the connected host,
tmux session/window and pane. Send accepts UTF-8 text up to 4 KiB plus Enter;
multiline text and tabs use the existing bounded tmux paste path. Request stop sends Escape. The running agent remains unverified, and a tmux
acknowledgement does not prove provider receipt or that a process stopped. Stage
remains the default and the fallback for other drafts, unsupported agents and multiplexers.
Already admitted input cannot be recalled by closing the view, and uncertainty
never causes an automatic resend. See the [destination and lifetime contract](chat-terminal-input.md). The closed 17-reader extension includes Hermes/OpenCode database-session selectors in confirmation authority; it does not establish a live agent or provider association.

### Claude recorded tool errors

Claude `tool_result` blocks preserve an explicit boolean `is_error` as optional
`isError` metadata in the existing schema-v1 response. The client labels `true`
as **Recorded tool error**, retaining the original output and tool ID. Explicit
`false` is preserved without inventing a completion badge; missing, null and
non-boolean flags remain unknown. Optional missing content produces an empty
result, not fabricated output. This applies to record paging and current-branch
snapshots/following, and does not establish a current failure, approval or retry
action. Other adapters do not gain this metadata from similarly named fields.

Primary provenance: Anthropic's Agent SDK Python commit
[`0e89b298e771259378a6cd3734e00d323dff5703`](https://github.com/anthropics/claude-agent-sdk-python/tree/0e89b298e771259378a6cd3734e00d323dff5703),
[`types.py:1218–1223`](https://github.com/anthropics/claude-agent-sdk-python/blob/0e89b298e771259378a6cd3734e00d323dff5703/src/claude_agent_sdk/types.py#L1218)
defines optional result content and error flag;
[`message_parser.py:115–120`](https://github.com/anthropics/claude-agent-sdk-python/blob/0e89b298e771259378a6cd3734e00d323dff5703/src/claude_agent_sdk/_internal/message_parser.py#L115)
reads them from Claude CLI user-message content. The official
[tool-result error contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
defines `true` as an execution error. Native and browser fixtures are synthetic;
no Claude CLI, private transcript, provider account or physical mobile WebView
was used to verify this slice.

### Snapshot file identity

Claude and Grok conversation captures, bounded JSON exports, jcode snapshots and
journals, Antigravity step reads, and Codex usage windows retain a handle to the
initially opened file until their pathname checks finish. Unix compares device
and inode. Windows compares the volume serial number and 128-bit file ID from
[`GetFileInformationByHandleEx(FileIdInfo)`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex),
as specified by Microsoft's
[`FILE_ID_INFO` contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info).
These identity checks reject replacement even when content, size and modification
time match. A Windows identity API/filesystem error fails the read without a
metadata-only fallback; platforms other than Unix and Windows return
`TranscriptIdentityUnsupported` for these readers. Existing owner/no-follow
admission and each reader's length, time and output bounds still apply.

This is a per-read check, not a lock, an atomic content snapshot, a persistent
source receipt or a live-terminal binding. Same-file rewrites that restore all
observed bytes/metadata, and changes after the last observation, remain outside
its guarantee. Legacy append Records and the separate Unix-only Grok `g1`
checkpoint contract are unchanged.

### Pi recorded tool errors

Pi Records preserve an explicit boolean `message.isError` on `toolResult`
messages as optional `isError` metadata on the normalized tool-result block.
Only `true` adds the existing **Recorded tool error** label; explicit `false`
does not invent a success/completion badge. Missing, null and non-boolean flags
remain unknown. Original output, tool ID/name, parent links, usage and record
cursor semantics are retained, including empty recorded results. This is a
recorded outcome, not current working state, an approval, or a retry action.
OMP and OmO remain unchanged despite sharing the message normalizer.

Primary pinned evidence: Pi commit
[`85c2ee3e761e4fc4f901ff0ed584fb2465aa552e`](https://github.com/badlogic/pi-mono/tree/85c2ee3e761e4fc4f901ff0ed584fb2465aa552e),
[`ToolResultMessage`](https://github.com/badlogic/pi-mono/blob/85c2ee3e761e4fc4f901ff0ed584fb2465aa552e/packages/ai/src/types.ts#L605)
defines `isError: boolean`; the
[`message` entry writer](https://github.com/badlogic/pi-mono/blob/85c2ee3e761e4fc4f901ff0ed584fb2465aa552e/packages/coding-agent/src/core/session-manager.ts#L1130)
retains that message, and
[`_persist`](https://github.com/badlogic/pi-mono/blob/85c2ee3e761e4fc4f901ff0ed584fb2465aa552e/packages/coding-agent/src/core/session-manager.ts#L1090)
serializes the full entry. Native/component fixtures are synthetic; installed
Pi compatibility, provider execution and physical WebView behavior are not
established by these tests.

### Claude current branch

Use `lazysh-agent transcript --agent claude --view conversation --path /absolute/path/session.jsonl --limit 100` to reconstruct the current main conversation branch. This reads a bounded complete snapshot, picks the latest main user/assistant leaf, follows `parentUuid`, and recovers sibling tool calls and results belonging to responses on that branch. Compaction follows the new summary chain without reconnecting `logicalParentUuid` to obsolete context. Duplicate UUIDs use their latest record; cycles fail closed.

The response uses `view: "active_branch"`, optional `branchId`, `hasMore: false`, and `truncated: true` when older selected messages exceed the requested limit or output budget. Refresh replaces the whole conversation snapshot, including when the selected branch changes. `--offset` must be zero in this mode. It accepts at most 16 MiB and 10,000 linked records; larger files return an error and remain available through record paging/the terminal. Conversation mode is supported only for Claude.

Claude captures exactly the initially observed prefix into an owned buffer of at
most 16 MiB before parsing. Short reads, observed truncation and file identity
replacement on Unix or Windows fail without publishing a shorter or detached branch. If observed
size or modification time changes, one bounded, chunked comparison checks that
the selected file still contains the exact captured prefix. Matching append-only
growth remains useful during Follow: this read returns the original prefix and
the next read can include the appended messages. An incomplete final line,
including split UTF-8 or JSON awaiting its newline, stays unconsumed.

There is no capture retry or new deadline. The changed-metadata path reads at most
one additional original-length prefix, using an 8 KiB comparison buffer rather
than another full snapshot allocation. The captured buffer is released after
parsing, before branch reconstruction. This is observational consistency, not a
file lock. The single comparison observes chunks sequentially: a later change
to an already-compared chunk during verification can escape detection, so it
cannot certify that all captured bytes coexist at one instant. Unseen changes
restored before checks, metadata-preserving rewrites, and mutations after the
final observation also remain outside the guarantee. The shared
[snapshot identity checks](#snapshot-file-identity) apply, including fail-closed
identity errors. Raw record readers, Grok capture policy, Follow polling and error
handling are unchanged.

After opening a Claude transcript in **Latest conversation branch**, optionally
enable **Follow selected Claude branch**. Following is off by default, is not
saved, and applies only to that explicitly opened source. Each read requests a
fresh branch snapshot at offset zero; abandoned messages are replaced rather
than appended. Existing companion input/output limits and the latest-50-message
client request remain unchanged. This is bounded polling over the existing SSH
companion command, not a new gateway stream or proof that the selected transcript
belongs to the live agent pane.

Only one transcript/discovery request runs in the view at a time. The next
automatic read is scheduled two seconds after the previous request completes;
there is no catch-up burst. Errors stop following and require explicitly enabling
it again. Hidden pages and `pagehide` pause automatic reads and discard an
automatic result that arrives after the pause. Returning to the visible page
resumes only if the original access lease and source remain valid. Explicit
manual reads/discovery retain their existing completion behavior on visibility
changes. Already-dispatched reads are not cancelled by hiding or unchecking the
control; their stale automatic results are ignored.

Changing the agent/path/view/session, losing app access, or leaving the view
stops following. A new mount or unlock starts with following off and cannot reuse
the previous mount's continuation to acquire a fresh nonce. Results and errors
check the original lease, request token and mounted view before publication.
No discovery, agent CLI, exporter, prompt, approval or stop operation is launched
by following. Other agents and record/export views retain manual refresh because
their branch/rewrite semantics are not expanded here.

While following, the bounded conversation region stays at the newest message.
Scrolling up preserves the reader's position as new snapshots arrive and reveals
**Jump to latest**; selecting it returns to the bottom and resumes automatic
scrolling. This follows the documented Chat View reading behavior (source URL omitted)
within the supported Claude snapshot scope, without claiming full native chat or
physical mobile WebView parity. Vitest checks polling/lifecycle/access races;
Playwright desktop and phone profiles check real scrolling and late results with
synthetic snapshots and a mocked native bridge, not actual account transcripts.

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

The opaque numeric `nextOffset` is a message index for this format. Each request reconstructs the bounded snapshot/journal before paging. Snapshots and journals are each limited to 16 MiB, journal lines to 256 KiB, and reconstructed messages and journal entries to 10,000 each. Partial trailing journal entries are retried on refresh; malformed complete entries fail instead of attempting jcode's recovery/migration writes. File sizes and modification times are checked again after reading, plus the shared Unix/Windows file identity check; a detected concurrent checkpoint or append fails for a fresh retry. This is not a lock on the running agent or protection against all same-size metadata-preserving rewrites. Reopen from offset zero after an agent rewind or snapshot rewrite.

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

Discovery evidence: the official reference client companion v0.4.37 Linux archive (source URL omitted), SHA-256 `c401ba0adeaa46d38558ff862a584c824d32e64dc8d79d44daa53e81a6aab4af` matching the publisher checksums and Homebrew formula. Its shipped `docs/api.md` transcript section and `docs/hooks.md` Devin section describe the XDG directory, `<id>.json` mapping, and ATIF step conversion. This documents the target app's export integration; the Devin CLI/export-format evidence below independently pins the supported ATIF version. Relative/empty XDG handling follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/).

Each request reads at most 16 MiB and 10,000 sequential steps, then returns up to 100 normalized messages under the existing 512 KiB message-output budget. `nextOffset` is an opaque **step index**, including skipped system steps. Unsupported versions, malformed snapshots, duplicate/nonsequential step IDs, unknown sources/content kinds, more than 1,000 parts/calls/results per step, or a text block above 256 KiB fail explicitly. The reader uses the existing regular-file, no-follow, Unix-owner checks and detects size/mtime changes plus the shared snapshot identity changes during reading on Unix and Windows. This detects common concurrent rewrites rather than locking the source. Reopen at zero after replacement or truncation.

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

Explicit tool statuses `pending`, `in_progress`, `completed` and `failed` are
preserved as optional `status` metadata on existing tool-linked `tool_use`,
`tool_result` and attachment-placeholder `image` blocks. The UI labels these
**Recorded status** with the tool ID, not current live activity or an approval
request. A recognized status-only update produces a **Tool status** card with
generated descriptive text such as `Recorded tool status: failed`; this text is
metadata, not output produced by the tool. Tool calls without output do not gain
a fake result. Actual arguments, output, diffs and attachment placeholders remain
unchanged. Repeated updates remain separate physical records, even for the same
tool ID; no latest-state replay or replacement is inferred.

Missing, null and unknown statuses remain unassigned; protocol default `pending`
is not materialized in this explicit-record reader. An unknown/missing-status
update with real output still preserves that output, while one with neither
recognized status nor output remains omitted. The optional field keeps schema
version 1 and existing block types, cursors, ID limits and output bounds. Older
clients ignore optional status metadata; status-only cards remain readable through
their ordinary name/text fields.

Status evidence is the existing pinned ACP schema **0.11.4** `tool_call.rs`
`ToolCallStatus` enum (lines 420–433), `ToolCallUpdateFields.status` (line 217)
and the pinned Grok disk/writer contract below; fixture provenance remains in
the Grok fixture README. Native fixtures cover all four explicit states,
status-only paging, unassigned values, unchanged outputs, linked inert media and
maximum block counts. UI and desktop/phone browser fixtures verify labels,
tool IDs, input/output preservation and absence of live controls or media fetches.
No actual provider CLI, account transcript, credential or installed-release
runtime was exercised. These statuses do not establish a current working/stop
state, pending permission, or prompt-target identity.

The modern disk envelope is `{timestamp, method, params: {sessionId, update}}`. `timestamp` is a provider-recorded unsigned UNIX-second value, converted to RFC 3339; missing/invalid/out-of-range values are skipped without substituting local time. Only `session/update` and `_x.ai/session/update` are accepted. Legacy raw notifications, unknown event types, usage/quota fields, turn-completion summaries and rewind markers are omitted while advancing the cursor. Malformed complete JSON fails. The existing regular-file, Unix owner/no-follow/nonblocking checks, 256 KiB record, 4 MiB scan, 100 messages/page and 512 KiB output budgets apply. An incomplete final line remains retryable from the returned cursor. Grok tool IDs are limited to 256 UTF-8 bytes and tool content to 999 blocks for a call or 1,000 for an update, checked before cloning identifiers; oversized records fail without truncating identity. A single normalized record exceeding the page budget fails explicitly instead of returning a non-progressing cursor.

`discover --agent grok-acp` now lists metadata-only candidates at exactly `$GROK_HOME/sessions/<cwd-folder>/<session-folder>/updates.jsonl`, using the home directory's `.grok` when `GROK_HOME` is unset or empty. Nonempty overrides are literal, including relative paths and leading/trailing whitespace; relative values use the companion process working directory. An explicit `--root` is the sessions search root itself. Only this filename at depth two is listed; custom explicit session directories outside that layout still require manual selection. Missing roots return an empty list without creation or fallback writes.

The existing depth/10,000-entry/100-result/path/regular-file/observed-symlink/Unix-owner guards and modification-time ordering apply. Discovery does not read transcript contents, `.cwd`, session metadata or sidecars; it reports file path/size/time and the parent folder as an opaque display label. It never interprets a folder ID as a live agent session ID. Results are candidates, not parsed transcripts or proven live-terminal bindings. Select a result and explicitly open it to use the existing guarded record reader; malformed or replaced files are still validated on open. No new whole-file size ceiling is implied by metadata listing.

`--view conversation` is now an explicit opt-in recorded-display reducer (see below). The UI labels it **Grok ACP records**, enables explicit metadata discovery and retains manual path entry. Grok's append-only rewind records create timeline branches; this record view can contain abandoned history and does not merge chunks, replace tool cards in place, reconstruct turns or remove rewound messages. It does not launch a Grok CLI/exporter, access account APIs, install hooks or establish that the selected file belongs to the live terminal. Records remain the default view; live terminal controls are unchanged.

#### Optional inline recorded images

In Claude Records/current branch, Codex Records or Grok **Recorded messages**, enable
**Include recorded images** before opening or starting supported Follow. This
option defaults off. The Grok companion CLI equivalent is
`lazysh-agent transcript --agent grok-acp --path /absolute/path/updates.jsonl --inline-images`;
it also composes with `--checkpointed` and its existing continuation receipt.
Claude accepts the same flag with `--agent claude --view records` or
`--agent claude --view conversation`; Codex accepts `--agent codex --view records`.
Checkpointed mode remains Grok Records only. The native `inlineImages` argument
defaults false. Other agents, Grok/Codex
conversation and transcript session selectors reject image opt-in before SSH
execution; Claude conversation also retains its zero-offset/no-checkpoint rule.
Existing manual output without the option remains unchanged.

Only top-level recorded Grok user/assistant image chunks and Claude user
`content[]` images with a `source.type=base64` PNG/JPEG payload, plus top-level
Codex user `input_image` blocks with exact PNG/JPEG base64 data-URL prefixes,
can gain a **View recorded image** action. Tool media, audio, resource/terminal
references and external URIs stay inert; no referenced file or URL is fetched.
The original base64 and on-disk transcript bytes are preserved. Invalid,
animated PNG, unsupported or oversized images retain their attachment metadata
without admitted preview bytes, so valid neighboring text remains readable.
Existing raw record limits still apply to the whole JSONL line.

Admission requires canonical standard base64 of at most 64 KiB (48 KiB decoded),
at most 2048 pixels on either axis and at most 1,048,576 total pixels. Native
static raster validation requests an advisory 8 MiB decoder allocation budget
and rejects APNG before raster decoding. This is not an enforced peak-memory
cap: JPEG progressive coefficient buffers and other decoder allocations may
exceed that setting. Encoded byte, decoded byte, axis and pixel limits above
are enforced. Existing line, scan, page, checkpoint and IPC budgets still
apply; page charging includes admitted base64. Returned preview fields are
validated again by the client before display. These checks are resource limits,
not a promise that every decoder accepts every PNG/JPEG variant.

**View recorded image** explicitly decodes one image with the browser bitmap
decoder into a canvas. JPEG EXIF orientation is respected while independently
checking raw encoded dimensions and actual oriented bitmap dimensions. No
object URL, image cache, auto decode or persistent media store is created.
Closing the preview, changing its source, losing access, evicting its row or
unmounting clears its canvas; a late bitmap is closed without painting. Only
one decode may be in flight across Chat panel remounts and source/session
changes, with no queue or automatic retry. Devices without the
required bitmap/canvas support report that preview is unavailable.

Owned native fixtures cover static PNG, ordinary/progressive JPEG admission,
placeholders, legacy output, paging and checkpoint composition. The small
progressive fixture is acceptance evidence, not a peak-memory measurement.
Chromium desktop/phone tests decode original PNG and
rectangular EXIF-rotated JPEG pixels and exercise cleanup and stale completions.
These are recorded-file tests, not provider/account execution, native Android/iOS
WebView acceptance or proof of live terminal binding. Other recorded formats,
including assistant/tool/generated media, remain separate work under issue #5.

The explicitly selected Linux owned-OpenSSH fixture executes the built companion
through product `agent_transcript` for synthetic Grok, Claude and Codex Records.
It checks exact original PNG/JPEG base64 and decoded bytes over multi-frame JSON
responses, default-off page equivalence, pagination and unchanged source files.
The temporary daemon and protected source session are cleaned up. A separate
custom-peer fixture holds channel confirmation, revokes the original lease and
verifies no command dispatch after reauthorization, late channel closure and
recovered channel capacity. That deterministic cancellation check is not proof
of cancelling an already-running remote image decoder.

The same explicitly selected SSH case also reads a synthetic Claude fork with
`view=conversation` and image opt-in. It checks the existing latest eligible
branch's exact IDs, text and original PNG/JPEG bytes, excludes the abandoned
branch's distinct image and text, and recovers the default-off page exactly after
removing preview fields. The original lease, protected SSH source session and
disk bytes are retained. There is no caller-supplied branch selector or inferred
UUID grammar. This verifies recorded reconstruction/transport composition, not
live provider branching or GUI/WebView behavior.

To reproduce the real transport case, build `cargo build -p lazysh-agent --locked`
in the same checkout, set `LAZYSH_TEST_AGENT_BIN` to the absolute path of that
checkout's private `target/debug/lazysh-agent`, then run
`cargo test -p lazysh --lib ssh::tests::openssh_recorded_images_preserve_bytes_and_default_off --locked -- --ignored --exact`.
Verify the binary's current build/dependency paths rather than using an unrelated
installed companion. This requires local OpenSSH; it creates only synthetic
files and does not start a provider or read private transcripts. Other host OSes,
native WebViews, live provider recordings and physical devices remain unverified.

Codex Records admits only `response_item` → `payload.type=message` → `role=user`
→ `content[].type=input_image` with `image_url` beginning exactly
`data:image/png;base64,` or `data:image/jpeg;base64,`. The suffix remains subject
to canonical base64 and all existing image limits. No percent-decoding,
alternate MIME parameters or image-type aliases are inferred. `file_id`, local
paths, HTTP URLs and all unknown variants remain inert; no reference is resolved.
Selecting Codex from Claude conversation establishes Records and clears image
opt-in. This does not enable Codex conversation reconstruction or Follow.

The source contract is official Codex **0.164.0**, tag `rust-v0.164.0`, pinned at
[`6aaac694803004a63c6f393d153c96d22521a6b9`](https://github.com/openai/codex/tree/6aaac694803004a63c6f393d153c96d22521a6b9).
This is selected source inspection, not execution of a provider or private
rollout. [User conversion](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/protocol/src/models.rs#L2155)
and [preparation before persistence](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/mod.rs#L3652)
establish this beyond generic API types. Image storage can retain processed data
URLs or replace them with file references; upload failure can retain inline
bytes. Retention is conditional on the originating store/configuration, not
guaranteed for every rollout. The [durable policy](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/rollout/src/policy.rs#L22)
preserves message content and the [JSONL writer](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/rollout/src/recorder.rs#L2112)
serializes it without an image scrub on that path. The inspected text-based
compaction path omits images from replacement model context and appends a
compaction checkpoint. Records can therefore contain historical images no
longer in active context; this reader does not reconstruct compaction/rollback
history or inspect nested checkpoints. Other versions/variants, live provider
recordings, provider compatibility and native WebView acceptance remain unverified;
the Linux synthetic-file SSH transport check above is a separate bounded proof.

Claude's source contract here is the **shipped npm Claude Code 2.1.81 artifact**,
not an inference from generic Anthropic API types. Its input processing creates
base64 user image blocks (possibly resized/re-encoded); its retained-record
writer serializes message content to session JSONL without an image-redaction
step on the inspected path. This does not promise images exist in every session
or survive every retention setting. Tool-result media is a separate nested
shape and remains inert. Conversation image admission occurs only during final
normalization of the existing selected chain, without changing capture, branch
selection or parallel-tool recovery. When that exact row/image disappears, its
preview selection is retired; a later branch returning it needs a new View.

The [official package](https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.81.tgz)
matches its registry SHA-512 integrity. SHA-256: tarball
`875acc67241a94a6220b559712aff0b2c226458507648c308c73c9788bc45b2f`;
`cli.js` `66d05774a73a5abea90ee27cc42f1f9c0f28302bd59c90b5bbb352cd7dff0a4e`.
Bounded REA analysis parsed 14,560 bytes of exact selected functions/classes;
parent evidence `ev_4e2e06dfb4d7e0a48d9fb9e74cbb3c9164a965490217c02319bf876df694dd42`
retains partial graph coverage and 881 explicit unknowns. Original `cli.js`
UTF-8 byte ranges supporting input/constructor/record filtering/writer/serializer
are respectively `[11674187,11676420)`, `[10998218,10998820)`,
`[10934292,10934571)`, `[10900382,10909787)` and `[54034,54176)`.
These are static observations, not provider execution, full-path runtime or
current-version compatibility proof. Current 2.1.310 persistence is uninspected.
Owned fixtures model this schema without copying vendor implementation or
accessing private transcripts.

#### Opt-in checkpointed Grok Records

Legacy Grok Records paging/output stays unchanged. Unix companions also accept
an explicit consistency mode (the client offers explicit recorded-file Follow in Records view):

```sh
lazysh-agent transcript --agent grok-acp --path /absolute/path/updates.jsonl --checkpointed --offset 0
lazysh-agent transcript --agent grok-acp --path /absolute/path/updates.jsonl --checkpointed --offset NEXT_OFFSET --checkpoint TOKEN
```

Start at zero without a token. Resume with the returned token and its exact
`nextOffset`, including zero when a file is empty or has only an unfinished
record. The canonical receipt is
`g1:SOURCE_SHA256:NEXT_OFFSET:OBSERVED_LENGTH:PREFIX_SHA256`, at most 150 ASCII
bytes with lowercase hashes and canonical decimal byte counts. It binds the
exact selected pathname bytes, Unix device/inode and the entire observed file
prefix, including unread records and any incomplete final line. It is a
consistency receipt, not an authorization credential or a live-agent identity.

A request reads at most a 16 MiB snapshot, with the existing 256 KiB line,
4 MiB scan, 512 KiB output and 100-record bounds (native requests use 50).
The selected pathname is checked against the opened file before and after
capture. Observed replacement, truncation or changed observed prefix stops with
`TranscriptChanged`; concurrent modification during capture stops with
`TranscriptBusy`. Each request makes one attempt and returns no partial page or
new receipt on failure. There is no automatic retry/reset. An explicit busy
retry must keep the original receipt; reopening from zero is a separate choice.

An unterminated final line is not parsed or consumed, even if it is valid JSON;
split UTF-8 waits for its newline. It returns `hasMore: false` and a receipt so
later appends can complete it. A malformed tail later terminated by the writer's
recovery newline fails rather than being skipped. Rewind controls retain the
existing raw-reader treatment: their bytes advance the cursor, while displayed
older records are not removed or reconstructed into an active branch.

Checkpointed mode rejects conversation view, recorded session IDs, other agents,
missing/invalid receipts and mismatched/non-boundary offsets. The optional native
`checkpointed` argument defaults false; native validation occurs before SSH
execution and keeps the original SSH session/access lease. Hosts without supported
Unix file identity return `TranscriptIdentityUnsupported`; manual Records remains
available. Antigravity `v1` receipts and Claude conversation semantics do not change.

No stateless receipt can detect an unseen truncate/regrow restoring identical
bytes/identity, or eventual inode reuse. This does not establish journal continuity,
Grok release compatibility, model replay, live prompt targeting or provider access.

#### Follow Grok recorded files

Select Grok and Recorded messages, then choose **Start following recorded file**.
The client explicitly requests a verified first page from zero. Existing manual
pages remain visible until that request succeeds with a supported receipt; only
then does the verified page replace them and following begin. An older companion
or unsupported host pauses the attempt and preserves existing pages with its raw
diagnostic. There is no version guessing, legacy fallback or automatic restart.

**Follow recorded file** pauses/resumes the original verified view. Each read uses
its exact SSH session, selected source, original access lease and receipt. Reads
start two seconds after the previous request completes, one at a time; EOF and
incomplete tails are polled even when no more complete records are reported.
Cursor/source regressions, changed same-length prefix or rows without cursor
progress stop reads without mixing records. Verified pages must also use canonical,
strictly increasing physical record IDs within the newly consumed byte range;
a forward cursor cannot replay an earlier ID and overwrite its verified text. Errors keep the last verified view
and receipt. Resume retries that receipt; **Start following recorded file** is a
separate explicit action that verifies a new view before replacing it and starting
following. Manual Next/Refresh on a paused verified view also uses its receipt and
stays paused. Explicit Open returns to manual Records only after a successful read.

Hidden pages pause automatic reads, and a response invalidated while hidden cannot
reappear after showing the page. Source/view/session changes stop following;
original-lease loss and unmount suppress late results/errors without acquiring new
authority. The display keeps at most 500 rows. Scrolling into history preserves
reader position until **Jump to latest**. Controls/status/errors are localized in
English, Brazilian Portuguese and Spanish; remote diagnostics remain verbatim.

This reads raw recorded-file appends, not reconstructed model context or a proven
live agent pane. Rewinds do not remove older displayed records. Following does not
stage/send prompts, write terminal input, execute approvals or fetch recorded media.
Browser fixtures establish UI/IPC scheduling, not actual provider or OS WebView
acceptance. The native consistency limits documented above still apply.

#### Optional Grok recorded conversation

```sh
lazysh-agent transcript --agent grok-acp --view conversation --path /absolute/path/updates.jsonl --limit 50
```

Records remain the default. Selecting Grok in the client resets its view to Records; choosing Latest conversation branch is explicit. Refresh replaces the displayed branch. Claude Follow is unchanged. Grok Follow is available only for Records, never this reconstructed conversation view. Rejected reconstruction leaves the Records selector available and displays the original diagnostic alongside an explanation; it does not silently fall back and pretend the records form a conversation.

Grok conversation reads retain bounded streaming parsing. The selected path is
checked against the opened file's original metadata before reading and again
after the read loop, before reducing/publishing the owned parsed actions.
Observed rename, truncate, rewrite or append during capture fails with
`InvalidEvent`; no partial view, retry or reset is returned. A stable incomplete
final line is still ignored without consuming it, including valid JSON without a
newline and split UTF-8. Appending before a later explicit read can complete it.
The client keeps the previous displayed view when a requested refresh fails.

Manual conversation uses the shared [snapshot identity checks](#snapshot-file-identity)
on Unix and Windows alongside its length/modification-time checks. Unavailable
identity fails closed. These per-read guards do not establish cross-request file
identity or live-agent binding. Same-file rewrites restoring all observed bytes
and metadata remain unobservable. Claude,
raw Records, recorded-file Follow, CLI combinations and existing limits do not
change; no whole-file buffer or platform-only receipt is added.


This view scans the selected file from byte zero: at most 16 MiB, 10,000 complete nonempty records and 256 KiB per line. It retains only normalized message actions and selected normalized tool patches, with a cumulative 16 MiB reconstruction budget (also charged for subsequently abandoned actions). All tool IDs retain the existing 256-byte limit; final cards allow at most 1,000 blocks and assembled text at most 256 KiB. Output is the latest 1–100 messages within 512 KiB, using schema v1 `active_branch`, `hasMore:false` and truthful `truncated`. An incomplete final line is left unconsumed for a later refresh. Bounds fail explicitly rather than returning an incorrectly reconstructed suffix.

Adjacent chunks with the same explicit UUID `messageId` combine without losing text/thinking/media ordering; repeated nonadjacent keyed messages reject reconstruction. User blocks with the same explicit `promptIndex` combine. Identifier-free adjacent chunks combine only within an uninterrupted same-role run; this is a bounded display grouping, not proof of provider message identity. Tool/response/turn/control boundaries stop that grouping. Explicit `hideFromScrollback:true` user chunks still establish prompt boundaries but are not displayed.

Tool updates apply optional fields independently. Missing/null fields leave prior values unchanged; supplied content collections replace rather than append, including empty collections. An unknown explicit status clears a previous known status rather than presenting it as current. Orphan updates and duplicate initial tool IDs reject reconstruction. Rewinds are resolved before tool reduction so discarded updates cannot contaminate retained cards.

Only contiguous explicit zero-based `promptIndex` boundaries prove a rewind target. A marker removes the target prompt and all later actions; repeated rewinds can reuse those removed indexes/tool IDs. Missing/gapped/conflicting boundaries, unclassified user prompts before a rewind, out-of-range rewinds, mixed session IDs and unknown update tags fail visibly. Supported non-display snapshots and known response/turn/compaction signals are explicit grouping barriers. This deliberately rejects unsupported files instead of guessing legacy prompt counting.

Compaction references do not replace visible transcript history with a summary. Prompt indexes continue across these markers, so a proven display rewind can cross a compaction boundary. Exact compacted **model context** lives in separate checkpoint files and is not reconstructed. Those files and every media/terminal/plan URI remain unopened. Selecting a file does not establish which agent is running in the terminal, authorize a live reply or supply a live status.

Evidence is official `xai-org/grok-build` commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (`SOURCE_REV` `559751fdcec02d413e4c57c8832ab275e4f44980`), inspected 2026-10-25: the [disk envelope and fixtures](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/mod.rs#L721), [actual JSONL writer](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs#L634), and [xAI extension definitions](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L517). Its lockfile pins ACP 0.10.4 with schema 0.11.4. [Synthetic fixture provenance](../apps/agent/tests/fixtures/grok-acp/README.md) records checksums and type anchors. These source contracts do not prove equivalence to the previously inspected Grok 1.0.70 artifact or every installed release. No provider CLI, account data or real user transcript was executed/accessed. Full Grok conversation/runtime compatibility remains [issue #5](https://github.com/mihazs/lazysh/issues/5) work.

Run the native Rust unit and CLI integration tests with `cargo test --package lazysh-agent --locked`, or `bunx turbo run test --filter=@lazysh/agent`. Tests spawn the compiled executable with isolated state directories; there is no Python runtime or test script dependency.

Companion distribution checks reuse the existing CLI, settings and WAL owners with
`LAZYSH_TEST_COMPANION_BINARY` pointing only at an explicitly prepared absolute
executable. When unset, tests retain their usual Cargo-built executable. The host
test harness uses its native ABI; on Linux its subprocesses execute the actual
static musl companion, including reads of WAL retained by the host-side library.
Prepared bytes are hashed before those owners and revalidated afterward. Candidate
checks create no publication receipt; trusted-main staging uses the existing
release manifest and publication gates. This test-only override does not change
the installed companion's configuration or behavior.

`bun run test:storage` runs the agent library and `storage_wal` integration cases through an uncached Turbo task. The existing macOS/Windows native CI matrix executes this task, including each platform's actual temporary-volume admission, migration and crash/recovery checks. The separate Linux agent job retains the full package gate. Configuration of these jobs does not itself prove a native platform pass; inspect their actual results before merging a storage change.


## Diagnose companion write contention

The CI `agent` job runs a separate native timing probe after the normal package checks, including when those checks fail. Its result never changes the preceding checks' failure status. The probe has a two-minute CI step limit and prints only fixed phase names, worker indices, durations and commit counts for a temporary synthetic database. It does not print SQL, event values, database paths or account data.

Run the same probe locally with:

```sh
cargo test --locked --package lazysh-agent --lib storage_diagnostics::profile_storage_commit_phases -- --ignored --exact --nocapture
```

SQLite's statement profile records `BEGIN`, insert, retention and commit duration. The existing busy callback is wrapped only in this fixture to measure its elapsed waiting separately; `other_wall` includes all remaining work and scheduling, not a direct measurement of filesystem synchronization. SQLite profile durations have millisecond resolution. The hosted probe injects no delay and keeps the production journal, synchronization and three-second per-locking-episode budget unchanged. This follow-up probe runs after the normal checks, so it does not reproduce all concurrent load present in an earlier failure.

A second ignored native probe, `storage_diagnostics::profile_storage_with_known_commit_hold`, deliberately holds each transaction for 250 ms in a test-only commit hook. It demonstrates that serialized write-held time can exhaust some wait budgets, while checking that every acknowledged commit remains in storage. It is not run by CI and is not evidence that hosted failures are caused by `fsync`. Neither probe replaces the strict concurrent-write acceptance tests or fixes [issue #36](https://github.com/mihazs/lazysh/issues/36).

Issue #36 now includes an actual failing subprocess trace from run `40195936923`: successful rollback-journal writers occupy the write lock for 3.174 seconds across a 3.194-second interval; five competing writers fail before acquiring it. All 48 sync calls succeed and consume 2.235 seconds elapsed under tracing. This supports lock/sync serialization in that capture, while disk versus scheduler/tracer contributions and the earlier untraced failures remain unresolved.

A bounded local baseline/WAL comparison uses the unchanged sixteen-process CLI case, separate Cargo target directories and strace 7.2. Both preserve sixteen events. The rollback baseline records 68 sync calls, 206.764 ms elapsed sync time and 249.509 ms aggregate RESERVED-lock occupancy. The FULL/WAL candidate records 43 sync calls, 86.619 ms elapsed sync time and 86.574 ms aggregate write-lock occupancy (WAL's write-lock byte plus the one-time rollback-to-WAL conversion). Last-close checkpoints/reopens mean this is not simply one sync per event. It is one local observation with an observer effect, not a statistical benchmark, CI acceptance result, power-loss test or promise that a finite wait budget handles arbitrarily slow storage.

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
the shared Unix/Windows source identity after reading to detect ordinary
concurrent writer changes. Identity errors fail the read.
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

### Same-invocation storage failure diagnostics

Set `LAZYSH_STORAGE_DIAGNOSTICS=1` explicitly to add one bounded stderr record when a Store constructor or ingest operation fails. Only the exact value `1` enables it. Successful storage operations and default stderr remain unchanged. The original error, exit status and numeric SQLite code are preserved; failure to write the extra diagnostic does not replace the original error.

The `lazysh-storage-diagnostic ` prefix is followed by a finite JSON record containing `phase`, `result` and optional numeric `sqliteCode` (null when unavailable). Phases distinguish non-SQL preparation, native bootstrap locking, SQLite open/configuration and individual constructor/ingest boundaries, including commit. Extensible error strings are classified as `OtherError`; no error text, SQL, paths, descriptors, timestamps, command arguments or lifecycle content enters this record. A phase names the call that returned the error, not an asserted underlying cause. Errors outside the instrumented Store constructor/ingest boundaries have no phase record; there is no retained last-phase state.

The existing Linux concurrent-hooks syscall fixture opts in only its traced child processes. Its bounded manifest retains at most one validated finite record per worker alongside the existing worker/PID trace association, never arbitrary child stderr. This observes the same CLI invocation; the separate ignored fresh-store profiler remains a different experiment. Diagnostics do not add retries, alter validation, increase deadlines or weaken FULL synchronization. Syscall observation can itself affect scheduling, and a new phase record does not establish the cause of earlier unobserved failures.

## Explicit local installation prerequisite

Future companion binaries expose `lazysh-agent installation inspect` and
`lazysh-agent installation install --expected-plan <planSha256>` on Linux and
macOS. This is the local operation needed by the future in-app SSH installer;
the application does not yet transfer or install the companion for you. Historical
v0.23.0 binaries and release assets remain unchanged.

Inspect does not create directories, locks, settings or event state. Its schema-v1
JSON includes `supported`, the actual running executable's `source`
(`version`, lowercase `sha256`, `bytes`), absolute `destination`, `existing`
(`state: "missing"`, or `state: "present"` with `sha256` and `bytes`), and opaque
`planSha256`. The caller must compare source identity to its trusted release
receipt and show the destination/version before explicit confirmation. The plan
hash binds all source fields, the derived destination and existing identity; a
changed user-data location or intervening installation invalidates it.

The only destination is `lazysh/companion/lazysh-agent` below the operating
system's user-local data directory (Linux uses an absolute `XDG_DATA_HOME` or
`~/.local/share`; macOS uses `~/Library/Application Support`). There is no arbitrary
destination flag and `LAZYSH_STATE_DIR` does not redirect installation. Custom
symlink routes, shared/private-file violations, nonlocal or unknown filesystems,
nonregular files, and executables larger than 64 MiB are refused. An existing
managed executable must be owned, single-linked and mode 0700.

Install rechecks the plan under a kernel file lock, copies the retained actual
executable into a private same-directory temporary file, verifies its exact hash
and size, synchronizes it, and renames within the retained directory descriptor.
Schema-v1 result JSON contains `status`, `committed` and the resulting `plan`.
`installed` means replacement and directory synchronization succeeded; `reused`
means the exact executable already existed without replacement. Ordinary
rejections exit nonzero with a redacted finite error class and no success JSON.
`committedDurabilityUnknown` with `committed: true` means the rename happened but
its subsequent directory synchronization or identity readback was inconclusive:
inspect again before retrying, and never assume rollback. A killed process can
leave an operation-owned `.install-*` temporary file; cancellation must never
remove the installed destination. Installation does not update PATH, hooks,
settings, database contents or running agents.

Windows inspect returns `supported: false` and
`reason: "windowsInstallerUnsupported"`; install rejects before filesystem
inspection or mutation. Windows binary downloads and normal CLI/storage checks
remain supported. Native SID/DACL ownership, busy-executable replacement and a
Windows OpenSSH shell adapter remain tracked in issue #490; the complete in-app
installer remains issue #476.

## Live Herdr discovery

The Agents view also reads live agent metadata directly from Herdr through the
connected SSH session. This does not need companion lifecycle hooks and can show
Codex panes even when the companion report list is empty or unavailable. A single
running Herdr server is selected automatically. If several are running, choose a
server; only the selected server is queried, not every server in the list.

Herdr statuses retain their meaning, including Idle and Unknown. They are separate
from companion lifecycle reports and do not establish approval, input or transcript
authority. Search the live Herdr section by agent, project or pane. Discovery stops
while the Agents view is hidden. Failed reads remove the previous live results;
check the terminal when a status cannot be read.
