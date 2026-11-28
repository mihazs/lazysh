# Agent view

Status: specification. Tracked by the Agent view epic
[#1119](https://github.com/mihazs/lazysh/issues/1119) and its slice issues #1120–#1125
on the [GitHub Project](https://github.com/users/mihazs/projects/2). It extends the native
Chat umbrella ([#5](https://github.com/mihazs/lazysh/issues/5)); nothing here is
released until the slice that implements it ships.

The Agent view is a second way to look at a terminal session that runs a coding
agent (Claude Code, Codex, OpenCode, Grok Build and others). Instead of the agent's
text UI, it shows the same conversation as native components: messages, thinking,
tool calls, diffs, plans, questions, approvals, sub-agents, state, usage and a
composer. It improves reading and answering on a phone and a desktop. It does not
replace the terminal.

The first part of slice 1 ([#1120](https://github.com/mihazs/lazysh/issues/1120))
ships the **Terminal | Agent | Both** switch, hook-report binding for Claude Code and
Codex on native tmux, the turn timeline, the header strip and the fallbacks; see
[Agent view in the companion guide](companion.md#agent-view). The later sections
describe the remaining slices.

## Co-existence contract

This is the governing rule. Every slice must keep it and prove it in tests.

1. **One session, two views.** The agent keeps running in its real PTY or
   multiplexer pane, unchanged. The Agent view is another view of that same live
   session. lazysh never starts a second agent, a headless re-run, an SDK/ACP
   subprocess or a replacement process to feed the Agent view.
2. **The user chooses.** Each session has a **Terminal | Agent** switch. Terminal is
   the default. lazysh never switches the view on its own; when the Agent view
   cannot show something, it says so and offers the terminal.
3. **Instant, lossless and reversible.** Switching never reconnects, never detaches
   the PTY, never clears or trims terminal scrollback and never drops, replays or
   duplicates input. `TerminalPane` stays mounted while the Agent view is shown, and
   the Agent view stays mounted (with scroll, draft and follow state) while the
   terminal is shown.
4. **Remembered per session.** The chosen view is stored per device under the
   session's stable key (saved host plus multiplexer target) and restored when the
   session is reopened or reconnects. It is a per-device convenience, not synced.
5. **Phone and desktop.** Both platforms get the switch. On wide desktop layouts
   (at least 1100 px of session width) a third choice, **Both**, shows the terminal
   and the Agent view side by side over the same session.
6. **One writer, two inputs.** Input from either view reaches the same PTY through
   one ordered path. Keys typed in the terminal and actions taken in the Agent view
   are reflected in the other view: what the Agent view sends is visible in the
   terminal, and turns started from the terminal appear in the Agent view.

## What exists today

The Agent view is built on these; it is not a parallel implementation.

| Piece | Where | Today |
| --- | --- | --- |
| Recorded conversation reader | `ChatPanel.tsx`, `ChatInteraction.tsx`, `ChatMarkdown`, `transcriptSources.ts` | A **chat** tool view. The user picks agent, transcript and Records/Conversation; follow polls every 2 s and replaces the page. |
| Transcript adapters | `apps/agent/src/transcript.rs`, `transcript/*.rs` | `TranscriptPage` schema 1: typed blocks (text, thinking, tool_use, tool_result, image), cards (plan, proposed plan, question), recorded activity. Conversation views for Claude, Codex, OpenCode, Gemini CLI and Grok; other agents are records-only. |
| Confirmed terminal input | `ChatTerminalInput.tsx`, `src-tauri/tmux_chat.rs`, `herdr_guard.rs`, [Confirmed terminal input](chat-terminal-input.md) | After an explicit bind: `send` (text plus CR, at most 4096 bytes), `send_long` (tmux only, 4097 to 65,536 bytes as one bounded paste plus CR) and `request_stop` (Escape). tmux and guarded Herdr on native builds only. |
| Stage | `lazysh-prompt-draft` event, `TerminalComposer` | Puts a draft, with `[Image #n]`/`[File #n]` tokens, into the terminal composer sheet. |
| Hooks and board | `apps/agent/src/hooks.rs`, `AgentPanel.tsx`, `AgentStatus.tsx`, `HerdrAgentsPanel` | Hook-reported state (needs attention, working, done) and Herdr live status (idle, working, blocked, done). |
| Approvals | `ApprovalPanel.tsx`, `apps/agent/src/approvals.rs`, [Remote decisions](approvals.md) | Hash-bound allow/deny for the Claude Code and Codex `PermissionRequest` hooks and the Copilot CLI `permissionRequest` hook, plus the permission updates Claude suggests (each behind a confirmation showing the exact rule) and deny with a message. |
| Mounting | `App.tsx` `View` union, `keptChat` | Every `TerminalPane` stays mounted; ChatPanel is kept alive behind other views. |

## Architecture

```text
 agent TUI in PTY/pane  ──writes──▶ transcript files / DB ─┐
        ▲      │                                          │
        │      └── hooks ─▶ lazysh-agent (host companion) ◀┘ ◀── live protocol
        │                        │ watch stream (cursor + upserts)   (Codex daemon,
        │                        ▼                                    OpenCode service)
   one ordered input path ◀── client: AgentSession model ──▶ Terminal view (xterm)
   (guarded tmux/Herdr,          │                          Agent view (native)
    protocol answer, hook        └── xterm buffer (read-only dialog lift, fail-closed)
    decision)
```

### Session binding

The Agent view needs to know which agent and which conversation run in the pane.
Binding is automatic only on evidence, in this order:

1. A hook report that carries the pane identity (tmux pane, Herdr pane) and the
   agent's session id (`agent_reported_history` already does this for Claude).
2. Herdr `agent_session` reported for the pane (`pane.report_agent_session`).
3. A live protocol that lists the thread for the pane's working directory
   (Codex daemon, OpenCode service).

The companion resolves the session id to a transcript inside the agent's own data
roots and returns an opaque reference. Paths stay on the host. When no evidence
exists, the Agent view shows the existing manual picker. A manual choice is labelled
as not proven to be this pane's agent, as Chat does today.

### Sources and authority

Each item in the model records its source. Higher authority wins when the same turn,
tool call or dialog arrives from two sources.

| Rank | Source | Supplies |
| --- | --- | --- |
| 4 | Live protocol attached to the same running session (Codex app-server daemon via `thread/resume`, OpenCode background service via SSE) | Streaming deltas, items, plan/diff updates, status, pending approvals and questions with ids, model and mode. |
| 3 | Agent transcript (existing adapters) | Durable turns, tool calls and results, plans, questions, usage, sub-agent records. |
| 2 | Hooks (existing `hooks.rs`, approval hook) | Working/waiting/idle edges, pending permission with exact input, session identity. Hints only: a hook never causes input. |
| 1 | Terminal screen (xterm.js buffer of the same pane) | Only what nothing above shows: an open TUI menu or dialog, the input-box draft. Never history. |

Live protocols are used only when they attach to the session the TUI already uses.
Their APIs are experimental, so features are gated on the schema the installed
agent reports, never on its version string.

### Live updates

The companion gains a `transcript watch` command on one long-lived SSH exec channel.
It emits upserts keyed by entry id, each with a monotonic `rev`; a `gen` change
means the window was rebuilt and the client replaces it. A tool result or plan update
that lands on an older turn patches that card in place, without moving the reader's
scroll. The window is bounded (500 entries, as today). When the channel cannot be
opened, the client falls back to the existing 2 s page polling.

The first client slice (Claude Code and Codex, [#1124](https://github.com/mihazs/lazysh/issues/1124)) follows this design with the companion's `transcript-watch` command: see [Live conversation stream](companion.md#live-conversation-stream) for the frames. It patches cards in place, shows the delayed, stale and old-companion states, and leaves model, mode and context usage to [#1224](https://github.com/mihazs/lazysh/issues/1224) and the Codex daemon to a later slice. OpenCode uses the same command on its database session (`--database-session`), watching the write-ahead log where the newest rows sit.

### Data model

`TranscriptPage` schema 2 adds, without changing schema 1 readers:

- **Entry** `{id, rev, role: user|assistant|summary|note, parts[], partial?, source}`.
- **Part** `text | thinking | image | tool`. A tool part has `name`, a one-line
  `summary`, a status (`running|ok|error|denied`, denied is not error) and an optional
  typed `call` from a closed set: `edit{path, added, removed, hunks, created}`,
  `execute{command, exitCode, background}`, `read{path, range}`,
  `search{query, hits}`, `fetch{url}`, `task{agent, agentId, ongoing}`,
  `plan{items[{text, state: pending|in_progress|done|cancelled}]}`,
  `question{questions[{header, text, multiple, options[]}], answers?}`, `other`.
  Kinds come from a per-agent tool-name table in the companion; unknown tools are
  `other` and still render name, input and result.
- **Session state** beside the thread: `activity` (working, waiting, idle, stopped,
  unknown, with its source), `model`, `mode` (permission or plan mode), `usage`
  (tokens and context remaining when recorded), `subagents[]`, `lastPrompt`,
  `queued[]` and `pending[]`.
- **Pending interaction** `{id, revision, kind: approval|question|menu, options[],
  source, answerPath}`. `answerPath` is the one way it can be answered (see below).

The client validates every field strictly, as ChatPanel does for schema 1.

## UX

### Phone

- The session header shows a two-segment **Terminal | Agent** switch. The terminal
  toolbar and gestures belong to the terminal view only.
- The Agent view is full screen: a header strip (agent, model, mode, state dot and
  word, elapsed time, **Terminal** shortcut), the timeline, a dock for the pending
  interaction, a pinned plan chip, and the composer.
- A turn that ended is not a finished session. When the companion's report says the session still runs
  background work (`background` on its snapshot row: sub-agents, workflows, shell commands and monitors), the
  header and the row above the composer read **Working in the background** with what runs ("2 sub-agents, 1
  shell or monitor"), the board row lists the same under its summary, and a Herdr pane status of idle or done
  does not outrank it. A companion that sends no `background` changes nothing.
- Each turn is one block: the user prompt, then a folded activity row
  ("Ran 3 commands, edited 2 files, 1m 12s") that expands to tool cards, then the
  answer. A finished turn collapses to its answer. Long prompts collapse.
- Tool cards show input and result; edit cards show `+N −M` per file and expand to a
  diff; execute cards show command, exit code and output.
- The dock above the composer is the **only** place where a live question, menu or
  approval is answered, with large option buttons and, for approvals, the full tool
  input. Timeline question cards are receipts and show the chosen answer.
- New dock buttons ignore taps for 400 ms after they appear.
- Android back from the Agent view returns to the terminal view of the same session.
  The keyboard, IME composition and attachments follow the existing composer rules.
  A touch keyboard can keep the last word as an open composition with no `compositionend`
  (seen on an Android 13 WebView, #1840): Send, Stage in terminal and Stop stay enabled and
  first leave the field, which ends the composition, then act once on the committed draft.
  Enter on a hardware keyboard is still ignored while composing.
- The composer is always under a followed conversation (`AgentComposer`). On tmux it
  binds itself to the pane a hook report names: the destination returned by the guarded
  `snapshot` must carry that exact pane ID before the guarded `bind` is sent, so no
  Choose or Confirm step is shown. A mismatch is never confirmed; the composer says the
  agent does not run in this pane and offers Stage. Under a guarded Herdr terminal the
  same rule applies to the conversation Herdr links to the focused pane: the prepared
  destination must carry that pane and terminal. A conversation picked by hand keeps
  the explicit confirmation (tmux) or has no composer (Herdr). Enter sends on a hardware keyboard, Shift+Enter inserts a
  line, a coarse-pointer keyboard keeps Enter as a line break and sends with the button,
  and Enter is ignored during IME composition. Drafts are kept per conversation
  (agent session) for the lifetime of the page.
- The composer helps without adding a way to send anything the guarded input would refuse.
  Typing `/` as the first word opens a palette of the agent's common slash commands
  (`agentSlashCommands.ts`; the agent's own `/help` stays the authority). Choosing one
  inserts its text and does not send it; a command that opens a dialog in the terminal UI
  (for example `/model`) says so, and its dialog is answered in the dialog card above the
  composer when the screen lift can read it exactly, otherwise in the terminal. A leading `!`
  or `#` shows a **Shell command** or **Memory note** chip; the text is sent unchanged.
  Up and Down recall the prompts sent from this conversation, only from an empty field or
  while the text is still exactly the recalled prompt. Each sent message has a receipt
  that settles from the conversation itself: **Sending**, **Sent** when the transcript
  holds one more identical prompt than before the send, **Not in the conversation yet**
  after 8 s, **Not sent** with **Retry** (bind again, send once) when nothing was written,
  and **Delivery is unknown** with no Retry once writing began. **Request stop** needs a
  second press within 4 s, because Escape interrupts a running turn.
- `@` in the composer opens a picker of the files and folders of the folder the agent works
  in (the project the hook report names, listed over the same SFTP read the Files explorer
  uses, at most 150 ms after the last key, one listing per folder per conversation). A
  mention may only name a path below that folder: an absolute path, `..`, `.`, a backslash or
  a control character in it is refused before any listing is requested. Dot files appear only
  when the typed name starts with a dot, and names with whitespace cannot be mentioned. Picking
  a file inserts `@path ` and picking a folder goes one level deeper; nothing is sent by it.
  A conversation without a known folder, or a listing that fails, offers no picker and the
  text is still sent as typed.
- Files join a message as the terminal composer does. The paperclip, a paste of a file or
  image from the clipboard, or a drop on the composer uploads it through the existing
  attachment path (a private copy under the host's `/tmp`, at most 10 MiB) and inserts a
  numbered `[Image #n]` or `[File #n]` token at the caret, with one chip per file to remove
  it. A token is never split: an edit that touches part of it removes the whole token and
  the file, and numbering restarts with each draft. On send each token becomes the
  shell-quoted host path the upload returned, so the agent reads the file by its path (typed
  text, not an attachment drop: the agent decides whether to open it). The expanded text is
  what must fit the send limit below; Send is disabled while an upload runs. Pasting
  text is unchanged. On desktop builds the webview must deliver HTML drops: where the shell
  swallows file drops, use the paperclip.
- A message may be longer than a screen. Up to 4,096 bytes it is sent as before; on tmux a
  longer one (up to 65,536 bytes) goes as one guarded paste and one Enter, so it is one
  message and never several turns. Past the bound, or on a guarded Herdr pane (4,096
  bytes), Send is disabled and the note names the limit; **Stage in terminal** remains.

### HTML in messages

Agent output and pasted text are Markdown that may carry HTML (`ChatRich.tsx`, `chatHtml.ts`).

**Why HTML showed as text.** The reader used `react-markdown` alone. It parses an HTML tag
in Markdown into a raw node and, with no HTML plugin, draws that node as escaped text, so
`<table>` or `<details>` appeared as typed (an unlisted `<script>` was never run, which
is why this was safe but unhelpful). Rendering it takes `rehype-raw` to parse the markup
and `rehype-sanitize` to keep only what is safe.

**What renders.** The pipeline is `literalTags` → `rehype-raw` → `rehype-sanitize` (own
allow-list, not the GitHub default) → depth and count caps:

- Elements: headings, `p`, `br`, `hr`, `div`, `span`, lists and definition lists,
  `blockquote`, `pre`, `code`, emphasis (`em`, `strong`, `b`, `i`, `u`, `s`, `del`, `ins`,
  `mark`, `small`, `sub`, `sup`, `kbd`, `samp`, `abbr`, `cite`, `q`), `details` and
  `summary`, `figure`, tables, `a` and `img`.
- Attributes: `href` and `title` on a link, `src`, `alt` and `title` on an image,
  `colspan` and `rowspan`, `start`, `open`, and a `language-*` class on `code`. No `id`,
  `class`, `style`, `srcset`, `target`, event handler or `data-*`, so a message cannot
  restyle, overlay or script the app.
- Never: `script`, `style`, `iframe`, `object`, `embed`, `form` and its controls, `meta`,
  `link`, `base`, `svg`, `math`. A tag outside the list is shown as typed (`Vec<String>`,
  `<file>`, a harness tag), not dropped.
- Code fences and inline code are never interpreted. Text past 512,000 characters is
  Markdown without HTML. Elements nest 32 deep and number 4,000 per message at most; what
  exceeds that is kept as text.
- Links: http(s) only, no credentials, no control characters. A tap asks first and then
  opens the system browser (a new tab on the web) with `noopener`. Other links are text.
- Images: an embedded PNG, JPEG, GIF or WebP up to 256 KiB shows. A remote image is never
  requested (the request would tell its host when the message was read, and the app's
  content security policy does not allow it): a placeholder with the alt text and an
  **Open image in browser** button, which asks like a link. Everything else is a placeholder.
- A table sits in a focusable scroll region, so a wide table scrolls inside the message.
- A message that contains rendered HTML has **Show source** and **Show rendered**.
- Harness records (`<system-reminder>`, `<task-notification>`, command echoes) are
  classified by `chatInjected.ts` before a message reaches this pipeline, so they keep
  their event rows and are not treated as the person's HTML.

Markdown follows GitHub's flavour (`remark-gfm`), so pipe tables, strikethrough and task
lists render; a fenced block is a code block with its language, **Copy code** and syntax
colours (see [Agent view design](reference/agent-view-design.md)). Files and repository
previews keep the inert renderer (`ChatMarkdown`) because they show untrusted file contents.

### Desktop

- Same switch plus **Both** on wide layouts, with the terminal on one side and the
  Agent view on the other, splitting the session area. Focus decides which view
  receives keystrokes; both stay live.
- Keyboard: a shortcut toggles the view, digits 1–9 pick dock options, Enter
  confirms, Esc closes the dock card without answering.

### State and fallbacks

| Situation | Agent view shows |
| --- | --- |
| No agent detected in the pane (tmux, Zellij or a plain shell) | "No agent conversation for this terminal", **Show terminal**, **Start Claude Code** and **Start Codex**, which stage the command in the terminal composer, and **New agent** under tmux or Zellij (see [New agent](#new-agent)) or **Start in a folder** in a plain shell (see [Starting an agent from the empty state](#starting-an-agent-from-the-empty-state)); the last-reported list when other panes have agents. |
| Herdr: the focused pane runs an agent with one reported conversation | That conversation, opened by itself and re-linked when focus or the agent changes. |
| Herdr: the focused pane runs no agent, others do | The live agents of the server, with the reason; a pick is marked **Not this pane** and dropped when focus moves. |
| Herdr: no agent runs | "No agent is running in this session", **Start Claude Code**, **Start Codex**, **Start an agent** (the workspace launcher), **Start in a new worktree** and **Show terminal**. Without the launcher (a host companion that predates it), **Start in a folder** replaces the last two launcher buttons. |
| Agent detected, a records-only adapter whose records name the reported session (GitHub Copilot CLI, Kimi CLI, Droid) | The records of that session, read-only in the timeline under a partial label ("Partial: these are the records Kimi CLI wrote for this pane, read-only, so they can lag behind the terminal and leave out what it does not record. Answer in the terminal."), the agent's last reported hook state in the header, and **Show terminal**. No composer and no dialog answers; the records are read again every 5 seconds, straight away while pages remain. The adapter's discovery has to name the session id the hook reported, exactly once: when it names none, or two files claim it, the row below applies. Tmux and Zellij panes only: under Herdr the view follows Herdr's own agent list, which has no records-only conversations. |
| Agent detected, no reader in this view (Grok Build, every other records-only adapter, hook-only agents) | The agent's name and last reported hook state, labelled as state only ("This view shows only the last reported state of Pi. Its conversation stays in the terminal."), with **Show terminal**, no composer and no transcript read. An agent the view can read whose history is not reported says to turn on reported history in the companion instead. Records of an adapter not named above stay in the Chat tool view. |
| A TUI dialog is open that no source can lift | A banner "The agent is waiting for you in the terminal" with **Show terminal**. The view does not switch by itself. |
| Session cannot accept confirmed input (a Zellij older than 0.45.1, plain PTY, rmux until #1675, web build; local sessions follow the same rules, see [Local workspace](local-workspace.md)) | Read-only Agent view; the composer offers **Stage in terminal**. |
| Zellij 0.45.1 or newer, the agent's pane named by its own hook report | One report of the attached session binds by itself; with several, the list asks which, and the pick takes input to its own pane. See [Zellij input](#zellij-input). |
| Watch stream unavailable | Polling, with a "delayed" hint. |
| Transcript lags (Claude writes asynchronously) | State comes from hooks or protocol, not from transcript recency. |

### Session names

Two sessions in one folder, or of one vendor, used to look the same. A session the companion has named shows that **name first** on the Agents board, the all-hosts board, the selected report and the Agent view header; its latest summary, folder and agent stay beside it as secondary detail. Search matches the name. A session with no name shows the row as before: summary, folder and agent.

**Where the name comes from.** The companion cuts it from the first prompt of the session, with no model call. It reads the prompt from the hook the agent already runs:

| Agent | Hook field | Name |
| --- | --- | --- |
| Claude Code, Codex, Droid, Kimi CLI, Copilot CLI | `UserPromptSubmit`, `prompt` | First usable prompt |
| Grok Build | `UserPromptSubmit`, `prompt` | First usable prompt |
| Gemini CLI | `BeforeAgent`, `prompt` | First usable prompt |
| Cursor CLI | `beforeSubmitPrompt`, `prompt` | First usable prompt |
| Any agent that reports through the generic event | `title` | The title it reports, which replaces a prompt name |
| OpenCode, Amp, Cline, Aider, Kimi Code | none: their hooks carry no prompt | No name; the row is unchanged |

The first usable prompt names the session once; later prompts never replace it. A prompt that is a bare slash command (`/clear`) says nothing about the session, so it is skipped and the next prompt is used. A name is one line: whitespace collapsed, control characters removed, at most 80 characters, ending in `…` when cut. The vendor's own session title (Claude Code's `ai-title`, Codex's thread name, OpenCode's title) is not read yet; it will replace the prompt name when it is ([#2949](https://github.com/mihazs/lazysh/issues/2949)).

**Rename.** **Rename** in the selected report gives a session your own name. It is kept on this device under the saved host, like **Archive**, and is not synced or written to the host. It wins over any reported name, survives restarts and every new report, and saving it empty brings the reported name back. A device that never renamed a session shows the companion's name.

**What is stored and sent.** The companion keeps only the bounded name, in its private state beside the session's report, and sends it to the app in the snapshot over the authenticated session channel that already carries the report. The rest of a prompt, tool arguments and transcript paths are still discarded, and the push notification relay still carries no text. A companion that predates names omits the field and an app that predates them ignores it, so either side can be updated first.

Not covered: names for the notification inbox rows (they come from their own journal), a rename that follows the session across devices, and model-generated names.

### Starting an agent from the empty state

- **Start in a new worktree** (Herdr, when no agent runs and a workspace reported a pane directory):
  opens the Herdr **New worktree from …** dialog for the focused workspace (the first workspace that
  reported a directory when the focused one has none) with **Start an agent in it?** already set to
  yes. It shows the exact commands for review before anything runs; once created, the Agent view
  focuses the new workspace and links to its agent as soon as Herdr reports the session. See
  [Herdr spaces](multiplexers.md#create-workspaces-worktrees-and-agents) for the dialog's branch, base and path rules.
- **Start in a folder** (plain shells, and Herdr without the launcher; tmux and Zellij offer [New agent](#new-agent) instead): choose Claude
  Code or Codex and a host folder (typed, a known folder, or browsed over SFTP). The review step shows
  the exact command, `cd '<folder>' && claude` or `… && codex` with the folder shell-quoted, and
  **Stage in the terminal** puts it in the terminal composer and shows the terminal. Nothing runs
  until you send it there; no multiplexer window or pane is created, so this starts the agent in the
  pane you are in.

  The dialog also takes **Arguments** (optional) and offers **YOLO**. Spaces separate arguments, quotes
  group one that holds spaces and a backslash escapes the next character; at most 32 arguments of 512
  bytes, without line breaks or control characters. Every argument is quoted again in the staged
  command, so `;`, `&&`, `$(…)` and `*` reach the agent as text and never run. **YOLO** is off every time
  and is not remembered; ticking it adds the agent's own flag that turns its approval prompts off, in
  front of your arguments, and the review step shows it in the command and says what it does. It is
  offered only for an agent whose flag was read from that agent's `--help`:

  - Claude Code: `--dangerously-skip-permissions` (Claude Code 2.1.326).
  - Codex: `--dangerously-bypass-approvals-and-sandbox`, which also turns off Codex's sandbox
    (codex-cli 0.172.0, which has no `--yolo` alias).
  - OpenCode: `--auto`, "Auto-approve permissions that are not explicitly denied" (OpenCode 2.3.2; the
    1.x releases do not list it). Offered in [New agent](#new-agent) only.

### New agent

**New agent** starts a coding agent without typing a command. It is the plus button in the Agent
view's header (always there when the session's multiplexer can launch) and a button in the empty
states, on phone and desktop. It opens a dialog that follows the session's multiplexer:

| Session | Under the hood |
| --- | --- |
| tmux | a new window of the attached session, running the agent (`tmux new-window -c <folder> -- <agent> [<prompt>]`), which becomes the session's current window |
| Zellij | a new pane of the attached session, running the agent (`zellij run --cwd <folder> -- <agent> [<prompt>]`) |
| Herdr (host companion with the launcher) | a new workspace plus `herdr agent start`, as in [Herdr spaces](multiplexers.md#create-workspaces-worktrees-and-agents), then the Agent view focuses the new workspace |
| No multiplexer | not offered yet: **Start in a folder** stages `cd <folder> && <agent>` for review |

The dialog asks for, in this order:

1. **Agent.** Every supported agent is listed, with the ones whose executable `command -v` finds on the
   host selectable and the others marked "not installed". An optional initial prompt appears for
   Claude Code and Codex, the agents that take one; under tmux and Zellij it may span lines.
2. **Where it runs.** **An existing folder** (typed, a known folder, or browsed over SFTP; a folder that
   does not exist stops the launch before anything starts), **A new folder** (created with its
   parents by `mkdir -p`; the path must be absolute without `.` or `..`) or **A new Git worktree**
   (a folder inside the repository, read with **Read the repository**; the branch, base revision
   and worktree path are suggested the way the Herdr dialog suggests them and stay editable).
3. **Label (optional)** for a folder: the window, pane or workspace name; the folder's name by default.

The agent step also takes **Arguments** (optional) and offers **YOLO**, the same field and toggle as
**Start in a folder** (same splitting, quoting and limits, and the same YOLO flags, listed there).
The words reach the host as separate argv entries after the agent's name and before the prompt,
never through a shell, and a word that is empty or holds a backslash is refused before anything
is planned (the launcher counts the YOLO flag among the 32 words). OpenCode 2.x also has a YOLO
flag here, `--auto`. **YOLO** is off every time, is not remembered and resets when you pick another
agent; the review step shows the exact words and says what it turns off. An older client sends no
arguments, so its launches are unchanged.

**Review commands** then shows the exact commands, in order, as the host will run them, and nothing
runs until **Create and start agent** is confirmed. Every path, label and prompt reaches the host as
one literal argument, never through a shell, and the prompt is never run as a command. A failure
before anything was created is reported as such; a later one says what was kept (the folder,
worktree or workspace) and that nothing was removed.

After a launch the Agent view stays where it is and follows the new agent as soon as it reports
(under tmux and Zellij through its hook report for the new pane, within the view's polling
interval; under Herdr the new workspace is focused and linked). The terminal keeps running and is
one tap away; the launcher never types into an existing pane.

Not covered yet: opening a plain terminal session in the folder when no multiplexer runs, resuming
an earlier session through the launcher ([#1545](https://github.com/mihazs/lazysh/issues/1545)),
rmux ([#1679](https://github.com/mihazs/lazysh/issues/1679)), local sessions
([#1133](https://github.com/mihazs/lazysh/issues/1133)) and an Android runtime case.

## Per-agent capabilities

Target capability once the slices ship. "Keys" means a send through the guarded
input path, using the agent's profile, with read-back verification.

| Agent | Timeline | Live | State | Questions and menus | Approvals | Interrupt | Model / mode / usage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Transcript | Watch | Hooks | Keys (AskUserQuestion, plan approval) from hook or screen lift | Existing `PermissionRequest` hook decision | Keys (Esc) | Transcript (model, usage); mode from screen lift |
| Codex | Transcript; daemon when attachable | Daemon deltas, else watch | Hooks, daemon status | Daemon `requestUserInput` answer, else keys | Daemon approval answer, else keys | Daemon `turn/interrupt`, else keys | Transcript, daemon settings |
| OpenCode | Database transcript; service when attachable | Service SSE, else watch | Plugin, service status | Service form reply, else keys | Service permission reply, else keys | Service abort, else keys | Service, transcript |
| Grok Build | ACP session log | Watch | Hooks | Keys with screen lift | Keys | Keys | Transcript |
| Gemini CLI | New transcript reader | Watch | Hooks | Keys with screen lift | Keys | Keys | Transcript |
| GitHub Copilot CLI, Kimi CLI, Droid | Records, read-only, partial | Poll from the cursor | Hooks | Show terminal | Show terminal | Show terminal | — |
| Other records-only adapters (Pi, OMP, Hermes, Cursor, Amp, others) | Records stay in the Chat tool view until their records name the reported session | Watch | Hooks where installed | Show terminal | Show terminal | Keys | — |

A capability ships for an agent only with the fixtures and runtime test listed under
Test strategy. Until then the table cell falls back to **Show terminal**.

### What is shipped per agent

Status on 2026-11-14, `main` at `744e3bbb`. The table above is the target; this one says what a person gets today, and the
evidence. [Agent view parity](reference/agent-view-parity.md) has the element-by-element status.

| Agent | In the Agent view today | Falls back to the terminal for |
| --- | --- | --- |
| Claude Code | The whole table: timeline, live stream, hook state, questions, menus and approvals (docks), interrupt, header pills (model, mode, context, branch), work panel with sub-agents and workflows, send, queue, attachments, slash palette, copy, search and history ([#1293](https://github.com/mihazs/lazysh/pull/1293), [#1276](https://github.com/mihazs/lazysh/pull/1276), [#1351](https://github.com/mihazs/lazysh/pull/1351), [#1356](https://github.com/mihazs/lazysh/pull/1356), [#1377](https://github.com/mihazs/lazysh/pull/1377), [#1431](https://github.com/mihazs/lazysh/pull/1431)) | A dialog with a text field |
| Codex | Timeline, live stream, hook state, header from the transcript, send and Stop, the approval prompt and list dialogs answered through keys read back from the screen ([#1490](https://github.com/mihazs/lazysh/pull/1490)), permission requests answered through the `PermissionRequest` hook decision in the dock on tmux ([#1796](https://github.com/mihazs/lazysh/issues/1796)), sub-agents in the work panel ([#1480](https://github.com/mihazs/lazysh/pull/1480)) | The notes box of a Codex question, the Codex app-server daemon |
| OpenCode | Timeline from its database, header (model, context in use, cost), send and Stop on tmux ([#1491](https://github.com/mihazs/lazysh/pull/1491)), sub-agents ([#1480](https://github.com/mihazs/lazysh/pull/1480)), and, when the OpenCode 2.x background service runs on the host, its permission requests (allow once, always allow behind a confirmation, reject with a message), question forms and Stop answered through that service ([#1656](https://github.com/mihazs/lazysh/issues/1656), [the contract and its limits](opencode-service.md)) | Every dialog the service does not hold: OpenCode marks the highlighted choice by colour only, which a read of the screen's text cannot see, so `/models` and the other lists stay in the terminal; a permission request or question form with a field the app cannot show; every prompt when no OpenCode 2.x service is usable (OpenCode 1.x has none); Herdr and Zellij panes (Herdr's session reference is not a transcript the view can read) |
| Gemini CLI | Timeline, hook state, header model and tokens, plan, sub-agent and background-shell cards, send on tmux ([#1568](https://github.com/mihazs/lazysh/pull/1568)) | Questions, approvals and dialogs |
| Grok Build | Timeline from its session log (turns, tool calls with their output, thinking), the plan card, hook state, send on tmux. The pane is bound by a hook report that names it, so it needs the opted-in hook fragment (`lazysh-agent grok-config --reported-history`), or the Claude Code hooks (Grok Build runs those too) | Questions, approvals (the view says the agent waits in the terminal and holds the draft), dialogs, Stop, header pills (the log records no model or usage), sub-agents and background work |
| GitHub Copilot CLI, Kimi CLI, Droid | The records of the reported session, read-only in the timeline under a partial label, with the hook state in the header, **Show terminal** and no composer ([#1658](https://github.com/mihazs/lazysh/issues/1658)). Found by the session id the adapter's discovery names: Copilot's and Kimi's session directory, Droid's UUID file name | Everything else: sending, dialogs, approvals and Stop. Not run against a real Copilot CLI, Kimi CLI or Droid: the format cases use records written to each adapter's documented layout, so that each agent's hook `session_id` equals the id in its record path is documented behaviour, not observed here |
| The other records-only adapters (Pi, OMP, Hermes, Cursor, Amp and others) | The agent's name and last reported hook state, labelled as state only, with **Show terminal** and no composer (Pi, OMP and Hermes have no hook setup, Cursor's records are the IDE's export and Amp's an explicit JSON export, and neither names the CLI's reported session). Their records stay in the Chat tool view | Everything else |

Each claimed adapter is held by a companion discovery case (`apps/agent/tests/additional_adapters.rs`: the id is named exactly where the path carries it and nowhere
else) and, per adapter, by recorded companion output in `src/test/recordsOnlyRecorded.ts` driving a Vitest case (`AgentView.test.tsx`: the turn, the hook state, the
partial label, **Show terminal**, no composer, growth read from the cursor, an id that matches nothing or two files, and records that disappear) and a Playwright case
(`e2e/agent-view.spec.ts`, phone 390×844 and desktop 1280×850). The state-only label is held by a Vitest case per unclaimed adapter (Pi, Cursor CLI, Amp: the label,
**Show terminal**, no composer, and no transcript, history or discovery read) and by `e2e/agent-view.spec.ts` ("an agent the view cannot read yet").

Grok Build is bound to its pane by evidence it reports itself: its hooks pass the session id and the path of the session's
`updates.jsonl`, and the companion records them with the pane the hook ran in (`TMUX_PANE`). A report without a path
(a session whose file is not written yet) binds nothing, and a sub-agent's own events are ignored. Nothing is guessed from a
process or from the newest file of a folder. The record format and the hook input are verified against the pinned source
snapshot and synthetic fixtures only: the development host has no Grok Build binary and no account, so the runtime case
against a real agent is still open ([#1842](https://github.com/mihazs/lazysh/issues/1842)).

### Header mode chips

The header always shows the mode, and the approval policy and sandbox, that the agent last reported in the `session` object of its
conversation page; the view re-reads it with each transcript poll, so a change made in the terminal appears at the next read. A field the agent
does not report is not drawn, never guessed from the last message.

| Agent | Chips | Source | Changed by |
| --- | --- | --- | --- |
| Claude Code | Mode: Default, Plan mode, Accept edits, Auto, Bypass permissions | `permission-mode` transcript record, written at the next prompt after a change | Shift+Tab in the terminal, or **Permission mode** in the options |
| Codex | Mode (collaboration mode), then approval policy and sandbox, such as `never · danger-full-access` | `turn_context` record: `collaboration_mode`, `approval_policy`, `sandbox_policy` | Codex's own `/approvals` and `/plan` commands |
| OpenCode | Agent name as the mode (`build`, `plan`) | `agent` of the newest assistant message | OpenCode's agent switch (Tab) |
| Gemini CLI, Grok Build, Copilot CLI, Kimi CLI, Droid | None | Their records carry no mode | Not shown |

## Input and control mapping

All input goes through one ordered path per session. The Agent view never writes to
the PTY directly.

| Action | Answer path, first available |
| --- | --- |
| Send prompt | Guarded `send` (exists), held while the agent has a dialog open (the report says it waits for an approval, a question, a plan or a menu, or the screen lift shows a dialog): the text and its Enter would go into the dialog, so the draft waits. Else Stage in terminal. |
| Send while the agent works | Per-agent profile: queue (shown as a queued card until the transcript shows it) or steer. |
| Interrupt | Live protocol interrupt. Else guarded `request_stop`. Two taps on phone. |
| Approval | Agent's own decision channel (Claude hook decision, Codex/OpenCode protocol reply). Else keys. |
| Question or menu option | Live protocol answer. Else a new guarded `select` input that sends the profile's keys for that option. |
| Slash command | Guarded `send` of the command text, picked from a palette built from the agent's documented commands. A command that opens a TUI list dialog is answered through the dialog card (see **List dialogs** below). |
| Attachment | Existing upload, then `[Image #n]`/`[File #n]` tokens in the sent text. |
| Permission mode | Guarded `cycle_mode` (tmux, Claude Code only): one Shift+Tab, `1b 5b 5a`, then a read of the pane's last six lines for the status line (`⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`, `⏵⏵ auto mode on`, `⏵⏵ bypass permissions on`; profile `claude-2.1`, verified on 2.1.318). The reply names the mode or `unconfirmed`. The transcript records the mode only at the next prompt, so it cannot be the read-back. Herdr and every other agent refuse the kind. |
| Model | No key profile: measured on Claude Code 2.1.318, `/model` (even `/model sonnet`) opens a "Switch model?" dialog on a session with history and saves the choice as the default for new sessions, so it is a picker flow. **Switch model (/model)** in the options (tmux, Claude Code, a conversation bound to this pane) sends the guarded `send` of `/model` and the agent's list opens as the dialog card of **List dialogs** below when the screen can be read exactly, else in the terminal. The view never picks a model itself: the card's tap is the same guarded `pick` as for any list dialog. |

Per-agent keys (option selection, submit, queue, steer, interrupt, cancel) live in a
versioned data profile per agent, not in code. Each send gets a receipt shown on the
message: **Sending**, **Sent**, **Still in the input box**, **Not sent** with a
reason, and **Retry** only when nothing was delivered. A receipt is settled by the
transcript, the protocol or a read-back of the input box, never assumed.

Every answer carries the pending item's `id` and `revision`. A stale revision, an
item answered in the terminal first, an expired approval or a closed dialog fails
closed and shows a note ("Answered in the terminal", "Expired"). The terminal stays
usable for the same answer at all times; the first answer wins.

### Herdr panes

For the Claude Code agent of the focused Herdr pane (the conversation Herdr links to it) the view answers what waits for the user without a tmux pane:

- **Permission requests** through the approval hook, exactly as on tmux, matched by the session id the request names.
- **The open `AskUserQuestion`** with the keys a person presses (an option's digit; the Submit row for a multi-select; the review page's **Submit answers**), sent through Herdr's own `agent send-keys` after the live tree is read again and the agent's report still says it needs the user. A typed free-text answer picks the free-text row and then goes to the pane as one literal line and its Enter (`herdr pane send-text`, checked the same way), because Herdr's `agent prompt` refuses an agent that waits for an answer.

- **List dialogs** (see below) of Claude Code and Codex, a question Codex asks included. The xterm buffer of a Herdr terminal is Herdr's own screen with its sidebar and borders, not the agent's, so the dialog card reads the agent pane's visible rows from the host instead (`herdr agent read PANE --source visible`, display only, at most 200 rows of 400 characters), every 3 seconds while the view is shown and Herdr does not report the agent working, and again before and between the keys of an answer. The same lift, the same read-back and the same `pick` keys apply, sent through Herdr's own `agent send-keys`; the agent's own profile reads its own screen, and a dialog it cannot read exactly shows the banner **The agent is waiting for you in the terminal**.

A conversation picked by hand from the list has no input authority and no dialog card. The companion's report of the followed session names what it waits for (Herdr's own status has the wait but not its kind), so a permission request or a question keeps its own card and the dialog card adds no second one, and the header of a blocked agent names the wait and how long it has lasted (**Waiting for your approval · 5 min. ago**) instead of Herdr's **Needs attention**.

### List dialogs

A TUI list dialog the agent opens (Claude Code's `/model`, `/resume`, `/rewind` lists, the folder trust prompt, the plan decision) is
shown above the composer as a **dialog card**: its title, the text that explains it, each option and the footer that says what Enter does,
with the highlighted option marked. It is read from the rows of the session's own terminal screen (`agentDialogLift.ts`), not from the
transcript, so it works for dialogs no hook or transcript record describes.

- **Fail closed.** The lift returns a dialog only for one whole, simple list that has a full-width frame row above it (a `─` rule, or the row of `▔` that Claude Code 2.1.326 draws, also when a tip is drawn over it), exactly one highlighted
  row, a footer that says Enter takes the highlighted row and how to leave, and no check boxes, second list or tabs. Anything else (a tabbed
  dialog, a multi-select, a text field, a dialog whose footer this profile does not know) shows **The agent is waiting for you in the
  terminal** with **Show terminal**, and sends nothing. The view never switches by itself. The banner carries the dialog's own rows as read-only
  text (`agentDialogScreen.ts`: from the frame Claude Code draws above a dialog, or from the text above Codex's options or the first row of its
  full-screen table, down to the footer; at most 40 rows of 200 characters), so the user sees what the agent asks even where the card cannot
  answer (`/permissions`, `/config`, `/login`, Codex's `/resume`). Nothing is inferred from those rows and nothing is sent from them; a screen
  without a footer that says how to leave (an idle prompt, a working agent's `esc to interrupt` row) shows nothing. Claude Code's `Esc to clear`
  footer (`/config`'s search box) counts as a dialog footer, so the composer is held while that dialog is open.
- **Choosing is what a person presses.** The card reads the screen again, checks the bound pane is still the one the agent's report names,
  then sends the guarded `pick` input: arrow keys that move the highlight to the chosen option. It reads the screen back and presses Enter
  (a second `pick`) only once the dialog shows the chosen option highlighted. Nothing is sent when the screen no longer shows the dialog
  that was tapped, and a dialog that does not move gets no Enter. **Cancel the dialog** sends Escape. On a desktop keyboard the digits 1 to 9 choose.
- **The host captures the pane again before each key.** Reading the app's copy of the screen is not enough for a key that cannot be recalled,
  so each `pick` carries the rows of the dialog it was read from (the tap's read for the move, the read-back for the Enter) and the tmux
  connection captures the pane right before pressing it ([Confirmed terminal input](chat-terminal-input.md)). It sends nothing unless those rows
  appear exactly once: a dialog answered at the terminal first, another prompt in the same pane, a pane whose process was replaced, a
  prompt drawn twice and a dialog that is gone all get no key. The card then says "The dialog changed. Nothing was sent." (or "The answer was
  not sent" while this screen still shows the dialog), and the connection stays bound. The request this answers is the dialog on the pane, so
  there is no listed record to expire: a card is read again at each tap, and the Enter is sent to a read-back that is at most the 3 second
  read-back window old. The result is the card's note and the pane itself; nothing is stored.
  The capture is tmux's check: a pane followed through Herdr or Zellij gets the same keys after that backend's own destination check, without it.
- **Which agents.** Exactly those with a recorded profile below, Claude Code and Codex, through the one reader this card already has (there is no
  second reader). An agent with no profile has no reader, so its prompt is not answered from here and stays in the terminal: OpenCode (colour-only
  highlight; its own channel is [#1656](https://github.com/mihazs/lazysh/issues/1656)), Grok Build, Gemini CLI and the records-only agents wait for
  a captured corpus from a real session.
- **Authority.** Terminal output never grants authority: `pick` has no key path other than Up, Down and Enter, at most 30 rows, tmux only
  (the Herdr guard rejects it, so a Herdr pane shows the card read-only with **Show terminal**; see **Herdr panes** below for what a Herdr pane can answer). A dialog an approval or question card
  already answers shows no second card (Claude's permission request and every agent's question); Codex has no approval hook here, so its
  approval prompt is answered by this card.
- **Profile and corpus.** Each agent reads its own screen, and no agent's dialog is guessed from another's layout. The Claude Code 2.1.x
  footers and layout are data in `agentDialogLift.ts`, verified against screens captured from Claude Code 2.1.318 and 2.1.326 in a real tmux
  pane and, for `/model` on 2.1.326, a Herdr pane (`apps/client/src/test/agentDialogs`). Claude Code 2.1.326 redrew its dialogs: a row of `▔`
  instead of the `─` rule above them, digits followed by two spaces (`4.  Sonnet 5.5`), a `▸  More models` row (an option whose Enter opens the
  next list, which is read again) and footers wrapped at the pane width (`Esc to` and `cancel` on two rows, read as one footer); both layouts
  are read. A list of one item under its heading (a project with one saved session in `/resume`) is one choice, not a list, and shows the banner. The Codex profile (`agentDialogLiftCodex.ts`) reads the dialogs Codex 0.167.0 draws inline: a
  title, numbered options with `›` before the highlighted one, and one of the three footers captured (`enter select · esc back`,
  `enter default · s session · esc back`, `Press enter to confirm or esc to cancel`). That covers `/model` and its reasoning page,
  `/permissions`, `/review`, the rate-limit prompt and **the approval prompt** (Yes, proceed; Yes and don't ask again; No and tell Codex),
  checked live with Down, Up and Enter on a real Codex in tmux. Codex 0.172.0 draws a list of more than eight rows (`/model` lists ten models) as a
  window of eight rows, with a `↑` or `↓` row where rows are hidden and a number only on the first nine rows: the card reads the window it sees
  (screens recorded in a tmux pane), says **More options are in the terminal.**, and a choice moves the highlight inside the window, as the
  scrolled window is read back by what the option says; a row the window hides is not offered. **A question Codex asks** (`request_user_input`, drawn as `Question 1/2`, the
  question and its options, footer `tab to add notes | enter to submit answer | esc to interrupt`, wrapped by a narrow terminal) is read the same
  way, so it is answered from the card with the arrows and Enter whatever the transcript or hook says: Enter takes the highlighted option and Codex
  goes on to the next question, which is its own card. Esc interrupts Codex's turn there, so that card offers no **Cancel the dialog**. The notes box
  (Tab) is a text field that no guarded input opens, so a question that has its notes open, Codex's `/resume` table and any other footer fall
  back to the banner. OpenCode, Grok and Gemini have no captured corpus yet and fall back to the banner. An option that keeps a permission
  rule (Codex's **Yes, and don't ask again for commands that start with …**) is never one tap: the card first shows the option's exact text
  and what it keeps, and **Back** sends nothing.
- **Vendor redraws.** Claude Code and Codex update themselves and redraw their dialogs without notice, and a redraw turns a card into the banner.
  `bun run --cwd apps/client agent-dialogs:check` (`apps/client/src/test/agentDialogDrift.ts`) runs each installed agent in a private tmux pane in a
  throwaway directory, opens the dialogs of `/model`, `/theme`, `/permissions`, `/review`, `/resume` and others (no model call), reads the pane
  with the same lifts as the card and prints the agent's version and one line per dialog, `ok` or `FAIL /model unliftable (expected dialog)`. It
  exits 1 when a dialog that must lift does not, or when the card sees a dialog not at all (`none`). `--agent claude|codex` limits it and
  `--record DIR` writes each screen, sanitized (working directory, home directory, user name and e-mail addresses replaced), as
  `AGENT-VERSION-COMMAND.txt`: review one, then add it to `apps/client/src/test/agentDialogs` with the change to the profile. It starts the
  real agents with their accounts, so it runs on a development host and not in CI; its own test drives a fake agent in a real tmux pane (skipped
  where tmux is not installed).
- **Not covered.** `/rewind`'s confirmation page has no footer line, so it is not provable as a list dialog: after the choice that opens it
  the card says **The agent is waiting for you in the terminal**. Dialogs that read text (login codes, the "Tell Claude what to change" field) stay in the terminal.

## Security and privacy

- Terminal output never grants authority. A screen lift is display-only until its
  agent profile reaches the interactive tier: a fixture corpus, a keystroke recipe,
  read-back checks and a maintainer's live verification. Detectors return nothing
  unless certain.
- The guarded input contract stays closed. New inputs (`select`, `interrupt`) are
  bounded, reviewed kinds; there is still no arbitrary key sequence.
- Hook and protocol data identify sessions and set state. They never trigger input.
- Approvals keep the existing guarantees: exact id, hash, session and pane, expiry,
  one winner, full tool input displayed before a decision. Protocol-based approvals
  carry the same checks.
- Transcript and session paths reported by agents are resolved on the companion and
  confined to the agent's data roots. The client receives opaque references.
- Protocol endpoints (Codex daemon socket, OpenCode service) are reached on the host
  over the existing SSH connection, loopback only, with the service's own
  credentials read on the host. lazysh never exposes them publicly or stores them on
  the client.
- No third-party relay, provider account or API key is used. Notifications never
  contain command text or tool input.

## Test strategy

Tests assert behaviour, not source text.

- **Companion**: format fixtures per agent for schema 2 entries, tool kinds and
  pending items; watch-stream ordering, upserts and `gen` rebuilds; path containment.
- **Client Vitest**: model reducers (upserts, folding, source ranking, receipts,
  stale revisions) and rendering of every part and card.
  `AgentParity.test.tsx` is the card checklist: every kind of the `Card` schema needs a
  row, a card in the companion-generated fixtures and a component that draws it with its
  title, so a new kind fails the type check and then the tests until all three exist.
- **Playwright, phone (390×844) and desktop (1280×800)**: switch, remember, Both
  layout, timeline, dock, composer and fallbacks against a mocked companion.
- **Native Linux** (`native-e2e`, real OpenSSH, tmux and guarded Herdr): a fixture
  agent that draws a TUI in a real pane and writes a real transcript.
  `ssh::tmux_jump_fixture::agent_session` (CI step "Run a scripted agent session",
  tmux 3.4) is the first part: a bash stand-in TUI
  (`apps/client/src-tauri/src/tmux_agent_session_agent.sh`) runs in a real tmux pane
  behind an owned OpenSSH server and writes Claude Code format records. The test
  sends only the guarded inputs the Agent view sends (`send`, `select`, `cycle_mode`,
  `send_long`, `request_stop`) and asserts that the pane's process received each
  exactly once and in order (a replayed operation reaches the pane nowhere), that the
  mode read-back names the mode the pane drew, and that the real `lazysh-agent
  transcript` reads the same records back as messages, a question card and a
  background command that goes from `running` to `done`. The agent also runs its
  real `PermissionRequest` hook through `lazysh-agent approval-request`; the client lists
  the request over the same SSH session, a decision naming another pane is refused, the
  exact one releases the agent once and a second decision fails. A background sub-agent and a
  dynamic workflow are written the way Claude Code 2.1 does (`subagents/agent-*.jsonl` with its meta
  file, `workflows/wf_*.json` and its journal): the companion lists each as running with the child
  file or the agent tree, the child opens as a conversation of its own, and both end by
  themselves. The WebView-level run is `apps/client/native-e2e/agentViewReportingAgent.spec.ts`
  (`bun run test:native-gui`, Xvfb and `tauri-driver`): the same stand-in, started with a fifth
  argument, also runs the real companion's `ingest --reported-history` hook with its pane's
  `TMUX_PANE` on each lifecycle event, shows each submitted prompt in its pane and logs every key it
  reads, in an owned OpenSSH server that also holds the companion and a real tmux (the pinned 3.4 in
  CI). It covers co-existence cases 1 to 3 below on tmux: the view binds from the hook report; a
  Terminal, Agent, Terminal round trip while a `hold ...` turn runs keeps the terminal node, the
  pane (id, PID, tty, scrollback, cursor), the one tmux client and the agent's key log; a prompt
  sent from the composer reaches the pane once (one submission, its bytes and one Enter) and becomes
  a turn; a prompt typed in the terminal becomes a turn within 5 s while **Both** shows the two
  views (the window is 1500 px wide because the sessions list takes 300 px of the 1100 px Both
  needs). The same three cases run in `agentViewHerdrAgent.spec.ts` against a real guarded Herdr
  (`LAZYSH_TEST_HERDR`): the stand-in runs in the focused pane under a process named `claude`
  (Herdr detects an agent by that name), prints enough output first for the pane to have scrollback,
  and draws `esc to interrupt` on its mode line while a `hold ...` turn runs, which Herdr's own
  Claude detection reads as working. The fixture reports the session with
  `herdr pane report-agent-session --source herdr:claude` once Herdr detects the process, and the
  transcript sits where `lazysh-agent herdr-conversation` resolves that id
  (`$HOME/.claude/projects/<folder>/<id>.jsonl`), so the Agent view links the focused pane's
  conversation by itself and its composer binds to the guarded pane with no confirmation step. The
  round trip keeps the terminal node, the pane (id, terminal, tab, scrollback length), the one SSH
  connection (the sshd side's socket, to the inode), the agent's key log and the fixture's original
  receiver pane, which stays empty; the prompt sent from the composer reaches the pane once (one
  submission, its bytes and one Enter) and shows once in it; the prompt typed in the terminal
  becomes a turn in **Both** within 5 s (about 0.2 s measured). `agentViewOpenCodeAgent.spec.ts`
  runs the same three cases for OpenCode in a real tmux pane. The stand-in, started with the value
  `opencode`, writes what OpenCode 2.2 writes instead of a transcript file (its database under
  `$XDG_DATA_HOME/opencode`: a `session_v2` row, a `session_message` row per message with the
  assistant's parts inline, and `session_inbox`, written with `sqlite3`, which `native-linux`
  installs) and reports only `session.status` (busy while a turn runs, idle before and after)
  through the real companion's `ingest --agent opencode` with its pane's `TMUX_PANE`. The view
  binds the way it does for a real OpenCode pane: the pane's report names a session, the
  companion's discovery of the database finds it, and the conversation is read from the database.
  The round trip keeps the terminal node, the pane, the one tmux client and the key log, as above. A
  prompt sent from the composer reaches the pane once in the form OpenCode takes (the key log is
  Escape, the prompt's bytes, Escape, Enter: one bracketed paste and Enter, not a burst of keys),
  shows once in the pane and becomes a turn; a prompt typed in the terminal becomes a turn in
  **Both** within 5 s over the 2 s polling OpenCode has today (no live stream yet; 1.7 s measured). The three
  specs share their cases (`agentViewScenarios.ts`) and differ only in the multiplexer and the
  agent (`reportingAgent.ts`). The agents are stand-ins, not Claude Code or OpenCode (no real
  OpenCode runs in CI, which does not have the binary; its own screen, dialogs and database writes
  are not reproduced), and Herdr's state for the Herdr one comes from the drawn hint, not from
  Claude's own hooks: provider behaviour, macOS, Windows and Android are not covered by these
  specs. Still to add: the Android instrumentation case, for the Claude-style agent and for
  OpenCode.
- **Android** (`NativeWorkspaceTest`): the same fixture over the real UI whenever
  native input, back navigation, IME or attachments are involved.
- **Co-existence cases, required in every slice**:
  1. Switch Terminal → Agent → Terminal while a turn is running; the connection id,
     PTY and scrollback length are unchanged and no bytes were written by the switch.
  2. Send a prompt or answer from the Agent view; the terminal shows exactly that
     input once and the TUI state that results (dialog closed, turn running).
  3. Type or answer in the terminal; the Agent view shows the new turn or marks the
     pending item as answered in the terminal.
  4. Reopen the session; the remembered view is restored, and a new session opens
     in Terminal.
  5. On desktop **Both**, the two views update together during a turn.
- Every new row lands in the [parity matrix](reference/parity-matrix.md) "Native
  chat" section with its evidence.

## Out of scope

- Launching agents in headless, SDK, stream-json or ACP mode to drive the Agent
  view. These run a separate process and would break the co-existence contract.
- Claude Code channels and peer-message sockets as an input path.
- Rewind, fork and resume-into-a-new-session logic of lazysh. The agent's own `/rewind` and `/resume` lists are shown and answered as list dialogs; lazysh adds no fork or resume of its own.
- Line-comment review of diffs sent back as prompts.
- Pixel-level re-rendering of arbitrary TUI screens. Anything the model cannot
  represent stays in the terminal.
- Syncing the chosen view between devices.

## References

[Agent view parity](reference/agent-view-parity.md) lists every screen element of Claude Code and
Codex against the reference apps and the open gaps.

Interaction patterns were studied from public projects and documentation (Collie,
Warp, herdr-app, Orca, and the Claude Code, Codex, OpenCode and Agent Client Protocol
docs). lazysh re-implements behaviour only; it copies no code, assets, names or UI
copy from them.

## Zellij input

Zellij has no guard on the host and no "destination of this terminal" to confirm, so the Agent view does
not bind to what the terminal shows. The evidence is the agent's own hook report: with the updated
companion, a hook that runs in a Zellij pane reports `zellij:<session>:<pane>` (from `ZELLIJ_SESSION_NAME`
and `ZELLIJ_PANE_ID`; `TMUX_PANE` still wins when both exist). The Agent view of a terminal attached to
that Zellij session follows the one report that names one of its panes, or lists them when several do, and
a conversation another report also claims, or one of another session, gets no input.

Send and Stop go through `zellij_agent_input`, one host call each, with the pane and the agent as typed
fields (no key path and no free text besides the prompt). The host lists the session's panes as JSON and
refuses (`stale`, nothing sent) unless the pane is a live terminal pane whose foreground command is the
agent, so a prompt is never typed at a shell. A line is typed with `write-chars --pane-id terminal_N` and
Enter is the byte 13; text with a line break or tab goes in as one bracketed `paste`; Stop is the byte 27.
The first write failing is a plain refusal; a failure after it, or a lost connection, reads as unconfirmed
and is never resent. The listing and the write are separate host calls, so a pane replaced between them is
the one window left open, as for stock Herdr; Zellij's CLI has no atomic check.

A dialog the followed agent has open (Claude Code's or Codex's list dialogs, an AskUserQuestion, a Codex question) is answered from the
Agent view like on tmux and Herdr. The host reads the agent's own pane with `zellij action dump-screen --pane-id` (`zellij_agent_screen`;
the terminal shows Zellij's composite screen, so its buffer is not what the dialog card reads), only while the report names the agent as not
working, and the answer is the keys a person presses sent with `zellij action send-keys --pane-id`: a digit, Up, Down and Enter, which Zellij
encodes for the cursor-key mode of that pane, or one typed line and its Enter. The pane is listed and proven to run the agent before every
call, the card reads the screen again between the arrows and Enter, and the report must still name the same session in the same pane.

Limits: a prompt is at most 4,096 bytes (no long paste), the mode key stays in the terminal, a permission request of a Zellij pane is
answered from the Agents board (the Agent view's approval dock needs the exact-pane binding of #1536), and the pane test reads only the first two words
of the pane's command line. A
stale report of an agent that has since exited leaves a shell in its pane, which the foreground check
refuses. rmux (Limited until its confirmed input is verified, #1675) and plain PTY or local sessions (no proof that the
agent is the foreground process of the session's PTY, #1133) keep Stage in terminal.

## Terminals lazysh starts

A terminal with no multiplexer has no pane to name, so a hook report from it carries no pane identity. For a
terminal that lazysh starts itself, the companion reads one more variable: when `LAZYSH_TERMINAL` holds exactly 32
lowercase hexadecimal characters, `lazysh-agent hook` reports `lazysh:<id>` as the pane identity. A value of any
other shape is ignored and the report carries no identity; the hook never fails over it. The identity comes last:
`TMUX_PANE` wins, then Zellij's session and pane, so a multiplexer started inside such a terminal still names its own
panes. The id is a random launch identifier, not a secret and not input authority.

Status: the companion side ships first (#1867). Nothing exports `LAZYSH_TERMINAL` yet and the Agent view does not bind
by it, so no behaviour changes on its own; the launcher that exports it and the binding follow with the New agent flow
for sessions with no multiplexer (#1684). A companion that predates this reports no identity for these terminals, and
a client that predates it reads `lazysh:<id>` like any other identity it does not know (neither tmux nor Zellij) and
binds nothing by it, so the manual picker stays.
