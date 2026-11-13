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
| Transcript adapters | `apps/agent/src/transcript.rs`, `transcript/*.rs` | `TranscriptPage` schema 1: typed blocks (text, thinking, tool_use, tool_result, image), cards (plan, proposed plan, question), recorded activity. Conversation views for Claude, Codex, OpenCode and Grok; other agents are records-only. |
| Confirmed terminal input | `ChatTerminalInput.tsx`, `src-tauri/tmux_chat.rs`, `herdr_guard.rs`, [Confirmed terminal input](chat-terminal-input.md) | After an explicit bind: `send` (text plus CR, at most 4096 bytes), `send_long` (tmux only, 4097 to 65,536 bytes as one bounded paste plus CR) and `request_stop` (Escape). tmux and guarded Herdr on native builds only. |
| Stage | `lazysh-prompt-draft` event, `TerminalComposer` | Puts a draft, with `[Image #n]`/`[File #n]` tokens, into the terminal composer sheet. |
| Hooks and board | `apps/agent/src/hooks.rs`, `AgentPanel.tsx`, `AgentStatus.tsx`, `HerdrAgentsPanel` | Hook-reported state (needs attention, working, done) and Herdr live status (idle, working, blocked, done). |
| Approvals | `ApprovalPanel.tsx`, `apps/agent/src/approvals.rs`, [Remote decisions](approvals.md) | Hash-bound allow/deny for Claude `PermissionRequest`, plus the permission updates Claude suggests (each behind a confirmation showing the exact rule) and deny with a message. |
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

The first client slice (Claude Code and Codex, [#1124](https://github.com/mihazs/lazysh/issues/1124)) follows this design with the companion's `transcript-watch` command: see [Live conversation stream](companion.md#live-conversation-stream) for the frames. It patches cards in place, shows the delayed, stale and old-companion states, and leaves model, mode and context usage to [#1224](https://github.com/mihazs/lazysh/issues/1224) and the Codex daemon to a later slice.

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

Markdown pipe tables are not rendered (no GFM plugin); Files and repository previews keep
the inert renderer (`ChatMarkdown`) because they show untrusted file contents.

### Desktop

- Same switch plus **Both** on wide layouts, with the terminal on one side and the
  Agent view on the other, splitting the session area. Focus decides which view
  receives keystrokes; both stay live.
- Keyboard: a shortcut toggles the view, digits 1–9 pick dock options, Enter
  confirms, Esc closes the dock card without answering.

### State and fallbacks

| Situation | Agent view shows |
| --- | --- |
| No agent detected in the pane (tmux) | "No agent conversation for this terminal", **Show terminal**, **Start Claude Code** and **Start Codex**, which stage the command in the terminal composer; the last-reported list when other panes have agents. |
| Herdr: the focused pane runs an agent with one reported conversation | That conversation, opened by itself and re-linked when focus or the agent changes. |
| Herdr: the focused pane runs no agent, others do | The live agents of the server, with the reason; a pick is marked **Not this pane** and dropped when focus moves. |
| Herdr: no agent runs | "No agent is running in this session", **Start Claude Code**, **Start Codex**, **Start an agent** (the workspace launcher) and **Show terminal**. |
| Agent detected, no adapter (records-only or hook-only) | Records or hook state, labelled as partial, with **Show terminal**. |
| A TUI dialog is open that no source can lift | A banner "The agent is waiting for you in the terminal" with **Show terminal**. The view does not switch by itself. |
| Session cannot accept confirmed input (a Zellij older than 0.45.1, plain PTY, rmux, web build; local sessions follow the same rules, see [Local workspace](local-workspace.md)) | Read-only Agent view; the composer offers **Stage in terminal**. |
| Zellij 0.45.1 or newer, the agent's pane named by its own hook report | One report of the attached session binds by itself; with several, the list asks which, and the pick takes input to its own pane. See [Zellij input](#zellij-input). |
| Watch stream unavailable | Polling, with a "delayed" hint. |
| Transcript lags (Claude writes asynchronously) | State comes from hooks or protocol, not from transcript recency. |

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
| Other records-only adapters (Pi, OMP, Hermes, Kimi, Copilot, Cursor, Droid, Amp, others) | Records | Watch | Hooks where installed | Show terminal | Show terminal | Keys | — |

A capability ships for an agent only with the fixtures and runtime test listed under
Test strategy. Until then the table cell falls back to **Show terminal**.

## Input and control mapping

All input goes through one ordered path per session. The Agent view never writes to
the PTY directly.

| Action | Answer path, first available |
| --- | --- |
| Send prompt | Guarded `send` (exists). Else Stage in terminal. |
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

### List dialogs

A TUI list dialog the agent opens (Claude Code's `/model`, `/resume`, `/rewind` lists, the folder trust prompt, the plan decision) is
shown above the composer as a **dialog card**: its title, the text that explains it, each option and the footer that says what Enter does,
with the highlighted option marked. It is read from the rows of the session's own terminal screen (`agentDialogLift.ts`), not from the
transcript, so it works for dialogs no hook or transcript record describes.

- **Fail closed.** The lift returns a dialog only for one whole, simple list that has a full-width rule above it, exactly one highlighted
  row, a footer that says Enter takes the highlighted row and how to leave, and no check boxes, second list or tabs. Anything else (a tabbed
  dialog, a multi-select, a text field, a dialog whose footer this profile does not know) shows **The agent is waiting for you in the
  terminal** with **Show terminal**, and sends nothing. The view never switches by itself.
- **Choosing is what a person presses.** The card reads the screen again, checks the bound pane is still the one the agent's report names,
  then sends the guarded `pick` input: arrow keys that move the highlight to the chosen option. It reads the screen back and presses Enter
  (a second `pick`) only once the dialog shows the chosen option highlighted. Nothing is sent when the screen no longer shows the dialog
  that was tapped, and a dialog that does not move gets no Enter. **Cancel the dialog** sends Escape. On a desktop keyboard the digits 1 to 9 choose.
- **Authority.** Terminal output never grants authority: `pick` has no key path other than Up, Down and Enter, at most 30 rows, tmux only
  (the Herdr guard rejects it, so a Herdr pane shows the card read-only with **Show terminal**). A dialog an approval or question card
  already answers shows no second card (Claude's permission request and every agent's question); Codex has no approval hook here, so its
  approval prompt is answered by this card.
- **Profile and corpus.** Each agent reads its own screen, and no agent's dialog is guessed from another's layout. The Claude Code 2.1.x
  footers and layout are data in `agentDialogLift.ts`, verified against screens captured from Claude Code 2.1.318 in a real tmux pane
  (`apps/client/src/test/agentDialogs`). The Codex profile (`agentDialogLiftCodex.ts`) reads the dialogs Codex 0.167.0 draws inline: a
  title, numbered options with `›` before the highlighted one, and one of the three footers captured (`enter select · esc back`,
  `enter default · s session · esc back`, `Press enter to confirm or esc to cancel`). That covers `/model` and its reasoning page,
  `/permissions`, `/review`, the rate-limit prompt and **the approval prompt** (Yes, proceed; Yes and don't ask again; No and tell Codex),
  checked live with Down, Up and Enter on a real Codex in tmux. Codex's `/resume` table, a question with notes and any other footer fall
  back to the banner. OpenCode, Grok and Gemini have no captured corpus yet and fall back to the banner. An option that keeps a permission
  rule (Codex's **Yes, and don't ask again for commands that start with …**) is never one tap: the card first shows the option's exact text
  and what it keeps, and **Back** sends nothing.
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
  background command that goes from `running` to `done`. Still to add: permission
  decisions through the approval hook, a sub-agent child conversation and a workflow
  journal, guarded Herdr, the WebView-level GUI run (`native-e2e` needs Xvfb and
  `tauri-driver`) and the Android instrumentation case.
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

Limits: a prompt is at most 4,096 bytes (no long paste), dialog answers (`select`, `submit`) and the mode
key stay in the terminal, and the pane test reads only the first two words of the pane's command line. A
stale report of an agent that has since exited leaves a shell in its pane, which the foreground check
refuses. rmux (not yet a supported multiplexer, #1140) and plain PTY or local sessions (no proof that the
agent is the foreground process of the session's PTY, #1133) keep Stage in terminal.
