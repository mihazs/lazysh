# Agent view design

Status: slices 1 (conversation) and 2 (work rows) shipped; the rest is planned. Tracked by
[#1452](https://github.com/mihazs/lazysh/issues/1452) under the Agent view epic
[#1277](https://github.com/mihazs/lazysh/issues/1277). Behaviour lives in [Agent view](../agent-view.md); the feature
gaps against other clients live in [Agent view parity](agent-view-parity.md). This page is the visual and interaction
design the Agent view follows, so a new card, state or setting looks like it belongs.

## Brief

The Agent view is where a person reads what a coding agent did and answers it, mostly on a phone, often in short
bursts. It had every function but looked like a debugging panel: bordered boxes, a heavy header, content that was
cropped or squeezed, and every kind of record drawn with its own chrome.

The redesign takes its cues from how the Claude and ChatGPT mobile apps read. Only the general, public interaction
patterns are used (the apps' own screens, copy, icons, fonts and brand are not copied):

| Pattern | What lazysh takes from it |
| --- | --- |
| The answer is the page | An assistant message has no box, border or avatar. It is text on the page, full width, with a comfortable measure and line height. |
| The prompt is a bubble | Your message is a compact rounded bubble on the trailing edge, with a smaller corner where it points. |
| Work is quiet | Thinking, tool calls, sub-agents and plans are one-line rows that open on a tap, with a status mark. They never compete with the answer. |
| Code is a block with tools | A fenced block names its language, copies in one tap and scrolls sideways instead of wrapping. |
| One input, one primary action | The composer is one rounded field that grows. Its single round action is Send, then Stop while the agent works. |
| Jump back to the present | A floating button appears only while you read earlier text. |
| Calm motion | Short fades and one spinner. Nothing moves when the user asked for reduced motion, and nothing shifts the text that is being read. |

lazysh adds what a general chat app has no need for: the terminal is one tap away, the agent's state and model are
always visible, and every card has a plain text fallback.

## Rules

1. **Phone first.** Design at 415 x 900 (also 390 x 844). A wider window gets the same column, centred at
   40 rem, never a second layout.
2. **Tokens, not colours.** Every colour derives from the theme tokens (`--theme-*`, `--accent`, `--muted`), so bundled
   and imported themes, dark and light, work without a rule of their own. Text must reach 4.5:1 against what it sits
   on; `agent-view-design.spec.ts` measures this in the three bundled themes.
3. **No box without a reason.** A border or fill marks something you can act on or something that is not prose
   (code, a table, a card). Prose is never boxed.
4. **Taps are 44 px.** A control may look smaller, but its tap area is at least 44 px; it overlaps empty space only.
5. **Nothing moves under the thumb.** Streaming text, a running mark or a late result must not shift content above the
   reading position. Rows have a fixed height; a spinner replaces an icon in place.
6. **Text stays text.** Everything drawn is also text: a screen reader reads a message, a code block (with its language),
   a table and a time without any gesture. Colour is never the only signal.
7. **Motion is optional.** Every animation sits behind `prefers-reduced-motion: no-preference`.

## Conversation (slice 1)

The scale below is set on `.agent-view` in `AgentView.css`.

| Part | Value |
| --- | --- |
| Column | `max-width: 40rem`, centred, 16 px gutters |
| Turn gap | 14 px between the parts of a turn, 28 px between turns |
| Assistant text | 15 px / 1.62, `--theme-text`, block gap 0.75 em, 1.4 em above a heading |
| Headings | `h1` 1.35 em, `h2` 1.2 em, `h3` 1.08 em, weight 650, no capitals |
| Prompt bubble | trailing edge, at most 88% of the column or 34 rem, radius 20 px with a 6 px point, 15 px / 1.5 |
| Inline code | 0.88 em, a tint of the text colour on the page, radius 6 px |
| Code block | radius 12 px, a 36 px bar with the language (left) and **Copy code** (right), 13 px / 1.55, scrolls sideways, syntax colours from the theme (`--theme-accent`, `-warning`, `-blue`, `-purple`) |
| Quote | a 3 px accent bar, text one step quieter |
| Table | rounded frame, header row tinted, 0.9 em, scrolls inside the message (focusable region) |
| Time | under the message after a tap, always present for a screen reader |

Behaviour:

- Markdown follows GitHub's flavour (`remark-gfm`): tables, strikethrough, task lists and bare links work in addition
  to CommonMark. The HTML an agent writes still goes through the sanitized allow-list described in
  [HTML in messages](../agent-view.md#html-in-messages).
- A fenced block with a known language (`ts`, `js`, `py`, `rs`, `go`, `sh`, `json`, `css`, `html`, `yaml`, `sql`,
  `diff`, `toml` and a few more) is coloured by `lowlight`, loaded on the first block that needs it. Without a language,
  or past 100,000 characters, it stays plain. The colours only wrap the text in spans, so **Copy code** copies exactly
  the source and nothing in a block can become markup.
- Tapping a message shows when it was sent (`Sent Nov 13, 10:30 AM`) and **Copy message** (a 44 px button under the message, instead of one over its text); tapping again hides them. The button is always in the page for a screen reader and the keyboard. A tap that ends a text
  selection, or lands on a link, button, summary or code block, does not toggle it. On a pointer device, hovering shows
  it.

## Work rows (slice 2)

Everything the agent does besides talking is one row, in the same shape, so a long turn is a quiet list that opens where
you tap. The tokens (`--av-row`, `--av-row-hover`, `--av-code`, `--av-rule`, `--av-quiet`, `--av-add`) live in
`AgentTokens.css`; the rows in `AgentRows.css`.

| Part | Value |
| --- | --- |
| Row | tonal bar (`--av-row`), radius 12 px, no border, 44 px tall, 13.5 px text, a chevron at the end that turns when it is open |
| Tool call | tool icon, name (600), one line of what it did (monospace, ellipsis), then its outcome |
| Outcome | a call that went well is one check mark (its word, *Done*, stays for a screen reader); *Running* has a spinner in the accent colour; *Failed* (with the exit code) is danger red; *Declined* is the warning colour |
| Folded activity | the row that opens a turn's work (`Ran 2 commands · Made 1 edit · 1 failed`); open, it is a list of rows 6 px apart |
| Open tool row | the input and the last 20 lines of output on a darker fill, **Show earlier lines** and **Copy output** as quiet text buttons; an edit shows its lines with green and red tints |
| Thinking | the same row; its text sits under a 2 px rule instead of in a box |
| Plan, question, failure | a tonal card with a small title; a plan is a checklist (a mark per step: empty, dotted for the current one, filled with a tick when done; the step's state is still read aloud); a failure is tinted with the danger colour |
| Chips above the composer | one tonal pill each for running work (**2 running**, **1 shell**, **1 monitor**) and the plan (**1 of 3** with the pill filling from the start as steps finish) |

The result of a plan call (*Todos have been modified successfully*) is not a row of its own: the plan chip already shows it.

## Planned slices

| Slice | Covers | Status |
| --- | --- | --- |
| 1. Conversation | Column, bubbles, typography, Markdown, code blocks, tables, quotes, time on tap | Shipped |
| 2. Work rows | Tool, thinking, sub-agent, background-task and plan rows with status marks and a chevron | Shipped |
| 3. Composer | Rounded growing field, attach, send and stop states, slash and mention affordances | Planned |
| 4. Header and states | Header chip, floating jump to latest, streaming indicator, empty and error states, compact mode | Planned |
