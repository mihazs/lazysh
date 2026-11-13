# @lazysh/client

## 1.52.0

### Minor Changes

- fc4e7e8: Show each tool call of the Agent view as one card with its result and each file edit as a diff card.

### Patch Changes

- @lazysh/account-usage@1.52.0
  - @lazysh/common@1.52.0
  - @lazysh/display-idle@1.52.0
  - @lazysh/et-transport@1.52.0
  - @lazysh/mosh-transport@1.52.0

## 1.51.0

### Minor Changes

- 7374c3b: Fix the phone gestures colliding with Android and Samsung One UI navigation gestures. On Android gesture navigation each gesture now starts from a visible handle placed from the live system gesture zones instead of the screen edge, edge swipes remain as an optional Gesture style (and as the default with three-button navigation), and a Test gestures page shows the zones. A swipe also starts in a band just beyond the system's Back and Home zones (inset + 4 dp up to inset + the zone width), so it does not compete with the system's edge gestures. Changed defaults: handles and bands instead of edge swipes on gesture navigation, and the edge zone width defaults to 40 dp (was 24) with a 96 dp maximum (was 48).
- 78ae7c6: Show the working state, elapsed time, turn tokens and running tool on one line above the Agent view composer.
- 587b2c7: Send from the Agent view to an agent that runs in a Zellij pane. The updated companion reports the Zellij session and pane of an agent's hooks, the Agent view of a terminal attached to that session follows (or lists) the agents that name one of its panes, and Send and Stop write to that exact pane through Zellij's own commands, only while it still runs the agent. Needs Zellij 0.45.1 or newer.

### Patch Changes

- 03c8b6d: Changed default: the toolbar page indicator is hidden until you change page, then fades in as three dots for two seconds inside the toolbar's bottom padding.
- @lazysh/account-usage@1.51.0
  - @lazysh/common@1.51.0
  - @lazysh/display-idle@1.51.0
  - @lazysh/et-transport@1.51.0
  - @lazysh/mosh-transport@1.51.0

## 1.50.0

### Minor Changes

- 9d7fb30: Show a failed Claude Code API call (usage limit, unreachable API, refused request) as an error card that says what to do next, from the recorded `isApiErrorMessage` assistant record.

### Patch Changes

- 54776ce: On phones, the side menu is now the one full-screen navigation page (hosts, Workspaces, Agents) instead of a separate partial-width Menu drawer; its tabs read Agents, Workspaces, Connections and a connected remote session opens on Agents instead of Connections.
- b7e63b5: Fix the client build after two merged Agent view changes both defined the permission-mode strings.
- a594aa6: Keep **Load earlier messages** available in the Agent view when live updates push the oldest loaded messages out of its 400-message window, instead of showing a false **Start of the session** marker, and prove that loading an older page keeps the line being read in place while a live update arrives.
- @lazysh/account-usage@1.50.0
  - @lazysh/common@1.50.0
  - @lazysh/display-idle@1.50.0
  - @lazysh/et-transport@1.50.0
  - @lazysh/mosh-transport@1.50.0

## 1.49.0

### Minor Changes

- b2a9d62: Switch Claude Code's permission mode from the Agent view on tmux: a new button sends one guarded Shift+Tab per tap and names the mode the terminal's own status line showed afterwards.
- deef2a8: Add a Floating composer view as a per-device option next to Docked: a small movable, collapsible panel over the terminal that keeps the terminal grid and toolbar in place and sits above the soft keyboard, with Send, Insert, attachments and the draft.
- 4f882e7: Show the agent's model, permission mode, context left, git branch and worktree in the Agent view header, from a new additive `session` object of the Claude Code and Codex conversation pages and watch frames.
- ecaf908: Open, view, download or copy a host file path printed in the terminal: absolute, `~/` and `./` paths (and relative ones once the shell reports its directory with OSC 7), with `:line:col`, become links only when the host confirms the file exists.

### Patch Changes

- b2a9d62: Allow the stock Herdr send command of the Agent view composer in the app capability, so a send on a stock Herdr host is no longer refused by the app before it reaches the host.
- @lazysh/account-usage@1.49.0
  - @lazysh/common@1.49.0
  - @lazysh/display-idle@1.49.0
  - @lazysh/et-transport@1.49.0
  - @lazysh/mosh-transport@1.49.0

## 1.48.0

### Minor Changes

- 16c4800: Read the Agent view's background work (sub-agents, background commands, monitors, workflows) from the host companion so the panel covers the whole conversation, shows a shell or monitor's output and flags launches with no recorded end as not confirmed.

### Patch Changes

- c191de9: Fix the Agent view composer on a stock Herdr host: Send now goes through Herdr's own agent prompt command to the followed agent's exact pane, and a failed send shows one compact notice that keeps the draft.
- @lazysh/account-usage@1.48.0
  - @lazysh/common@1.48.0
  - @lazysh/display-idle@1.48.0
  - @lazysh/et-transport@1.48.0
  - @lazysh/mosh-transport@1.48.0

## 1.47.0

### Minor Changes

- 4a816a8: Paste, drop or pick files in the Agent view composer as numbered `[Image #n]` / `[File #n]` tokens that expand to the uploaded host paths on send.
- fb9d5b7: Pin the latest plan or todo list of the agent above the composer in the Agent view as one chip with progress and the current step, expanding to the full list.
- 4a816a8: Send prompts of up to 64 KiB from the Agent view composer on tmux as one bounded, guarded paste.

### Patch Changes

- @lazysh/account-usage@1.47.0
  - @lazysh/common@1.47.0
  - @lazysh/display-idle@1.47.0
  - @lazysh/et-transport@1.47.0
  - @lazysh/mosh-transport@1.47.0

## 1.46.0

### Minor Changes

- f6e5dbb: Add a Show/Hide keyboard button for touch devices: one tap focuses the terminal input and asks Android for its keyboard, the next hides it without sending input, and the icon follows the real keyboard, including a system back dismissal. The toolbar keyboard key shares the same toggle.
- 52592f7: On phones in a connected session the top bar and the hamburger are gone: a swipe from the left edge opens a side menu that holds everything the top bar offered, and the terminal gains the freed height.
- 6ebb3d8: Show the PNG and JPEG images a user attached as a bounded preview control in the Agent view bubble, for Claude Code and (new in the companion) Codex conversations.

### Patch Changes

- @lazysh/account-usage@1.46.0
  - @lazysh/common@1.46.0
  - @lazysh/display-idle@1.46.0
  - @lazysh/et-transport@1.46.0
  - @lazysh/mosh-transport@1.46.0

## 1.45.0

### Minor Changes

- 268c2da: The status bar's usage item follows the agent in the current pane (Claude Code shows Claude, Codex shows Codex, and so on), falls back to the chosen default account when no agent is detected, and can be pinned to one account or hidden in Preferences. Changed default: it follows the agent instead of showing one fixed account.
- e88a7d1: Show a compact background-work panel above the Agent view composer for Claude Code: counts of running shells, monitors, sub-agents and workflows, a list for each counter, and a tree of sub-agents and workflows with elapsed time and tokens.

### Patch Changes

- @lazysh/account-usage@1.45.0
  - @lazysh/common@1.45.0
  - @lazysh/display-idle@1.45.0
  - @lazysh/et-transport@1.45.0
  - @lazysh/mosh-transport@1.45.0

## 1.44.0

### Minor Changes

- b76c8c7: Open or download the selected file from Files: Open with, Download and (Android) Share, with SFTP streaming, progress and cancel, confirmation for symbolic links and files over 50 MiB, no silent overwrite, and no system open of programs or scripts.
- cf8a0bf: Answer the open Claude Code question (single or multi-select, several questions, or typed text) from the Agent view on a tmux session, through a new bounded dialog-answer input of the confirmed terminal input.

### Patch Changes

- d770c55: Fix the agent job's moon base revision on pushes to main, which resolved to an empty ref and failed the job. Pull requests are unchanged.
- @lazysh/account-usage@1.44.0
  - @lazysh/common@1.44.0
  - @lazysh/display-idle@1.44.0
  - @lazysh/et-transport@1.44.0
  - @lazysh/mosh-transport@1.44.0

## 1.43.0

### Minor Changes

- e8d624f: Add the phone bottom menu opened by swiping up from the bottom edge, with composer and toolbar show/hide.
- f94c597: Add `@` file and folder completion to the Agent view composer, listing only paths below the folder the agent works in.
- 2eecf76: Switch between the terminal and the Agent view with a swipe on a phone in a connected session: swipe from the right edge toward the left to show the Agent view, and while it is shown swipe from the centre toward the right to return to the terminal. The two views slide as one page that follows the finger and settles on release; a short or interrupted swipe leaves the view unchanged. The swipe never starts while typing or editing text, nor inside horizontally scrollable content such as code blocks, diffs and tables. The Terminal | Agent buttons stay, and the choice is still remembered per saved host and multiplexer target.

### Patch Changes

- @lazysh/account-usage@1.43.0
  - @lazysh/common@1.43.0
  - @lazysh/display-idle@1.43.0
  - @lazysh/et-transport@1.43.0
  - @lazysh/mosh-transport@1.43.0

## 1.42.0

### Minor Changes

- d356489: Read the whole session in the Agent view: scroll up to load earlier messages without losing your place, Jump to start for the first message, read forward again from there, with at most 400 messages held at a time. Needs the new host companion; an older one keeps the latest messages and asks you to update.

### Patch Changes

- @lazysh/account-usage@1.42.0
  - @lazysh/common@1.42.0
  - @lazysh/display-idle@1.42.0
  - @lazysh/et-transport@1.42.0
  - @lazysh/mosh-transport@1.42.0

## 1.41.0

### Minor Changes

- 81297de: Add a slash-command palette, prompt-mode chips, prompt history, send receipts with Retry and a two-press Request stop to the Agent view composer.

### Patch Changes

- 739e91c: Run the workspace build, check, lint, test and acceptance tasks with moon instead of Turborepo. The `bun run` task names, the CI job names and the published artifacts are unchanged.
- @lazysh/account-usage@1.41.0
  - @lazysh/common@1.41.0
  - @lazysh/display-idle@1.41.0
  - @lazysh/et-transport@1.41.0
  - @lazysh/mosh-transport@1.41.0

## 1.40.0

### Minor Changes

- 65eaa38: Show the prompts typed while Claude Code works as read-only Queued cards in the Agent view, from a new bounded `queued` list in the companion's Claude conversation page and transcript-watch frames.

### Patch Changes

- @lazysh/account-usage@1.40.0
  - @lazysh/common@1.40.0
  - @lazysh/display-idle@1.40.0
  - @lazysh/et-transport@1.40.0
  - @lazysh/mosh-transport@1.40.0

## 1.39.0

### Minor Changes

- 68631cf: Add an Android-only Private keyboard in the terminal setting (off by default, saved on this device only) for keyboards that drop or change typed characters: while the terminal has focus, the keyboard is asked for private typing with no learning and no suggestions, so predictive text, autocorrect and swipe typing stop working there.

### Patch Changes

- e98336b: Fix the Herdr switch button disappearing while scrolling or with the keyboard open: Herdr sessions now show a switch button in the session header, outside the scrolling terminal, that opens Herdr Spaces.
- @lazysh/account-usage@1.39.0
  - @lazysh/common@1.39.0
  - @lazysh/display-idle@1.39.0
  - @lazysh/et-transport@1.39.0
  - @lazysh/mosh-transport@1.39.0

## 1.38.0

### Minor Changes

- 2a5bcf8: Bring the message box back to the Agent view as an always-present composer that binds itself to the terminal pane of the followed agent, so sending needs no Choose and Confirm steps.
- 6f7cd9e: Answer Claude Code permission requests from the Agent view: the pane agent's pending request appears above the conversation and Allow or Deny sends the hash-bound approval decision after the pane is re-verified.

### Patch Changes

- @lazysh/account-usage@1.38.0
  - @lazysh/common@1.38.0
  - @lazysh/display-idle@1.38.0
  - @lazysh/et-transport@1.38.0
  - @lazysh/mosh-transport@1.38.0

## 1.37.0

### Minor Changes

- 20f02cc: Name what an agent waits for (approval, question, plan decision or unknown) and since when: the companion records it from hook payloads, and the Agent view shows it in its header and session list, lists waiting sessions first and opens from a needs-you notification.

### Patch Changes

- b628dd7: Fix terminal URLs that wrap over several rows: soft-wrapped and conservatively detected hard-wrapped URLs (including inside boxed TUIs) are tapped as one whole address, trailing punctuation and unbalanced closing brackets are trimmed, OSC 8 hyperlinks use the same Open in browser / Copy URL confirmation and win over detection.
- @lazysh/account-usage@1.37.0
  - @lazysh/common@1.37.0
  - @lazysh/display-idle@1.37.0
  - @lazysh/et-transport@1.37.0
  - @lazysh/mosh-transport@1.37.0

## 1.36.0

### Minor Changes

- 5f13c20: Add an Arrows toolbar component that draws the four arrow keys as one inverted-T cluster in the toolbar's two rows, placeable as one chip in the toolbar editor and included in the default layout, and send the unmodified cursor keys as application cursor keys (ESC O A) while a program has that mode on. Changed default: the default toolbar's four separate arrow keys are now the Arrows component; saved layouts keep their separate arrow keys.
- e792eaa: Add an Insert button next to Send in the terminal composer: Send puts the draft on the input line and presses Enter, Insert puts it there without Enter (same bracketed-paste delivery), Ctrl+Enter sends and Ctrl+Shift+Enter inserts, and a failed write keeps the draft and the composer open.
- 0148fc9: The Agent view follows the agent of the current pane: under Herdr it opens the focused pane's conversation by itself and re-links when focus or the agent changes, lists the live agents when the pane has none, and offers Start Claude Code, Start Codex and the Herdr launcher when nothing runs. Changed default: it opens the current pane's chat instead of the last pick.

### Patch Changes

- 848a370: Add a developer-only prototype of the host browser: a hidden companion command that starts a throwaway Chrome-family browser on the host and a viewer page that only the Vite development server serves, with a real-browser CI test and a protocol-client unit test. It is off by default, absent from release builds and changes no default.
- f37cb2d: Fix moving between Herdr terminals opening the Android soft keyboard and shrinking the terminal: on touch screens no navigation focuses a terminal input any more, and a keyboard that is already open passes to the terminal you move to without closing.
- @lazysh/account-usage@1.36.0
  - @lazysh/common@1.36.0
  - @lazysh/display-idle@1.36.0
  - @lazysh/et-transport@1.36.0
  - @lazysh/mosh-transport@1.36.0

## 1.35.0

### Minor Changes

- 91e6abf: Add the edge-swipe gesture engine for phone sessions: swipes that start in a thin edge zone follow the finger and settle, and never run while you type, select text or scroll. The side menu, bottom menu and view-switch gestures build on it.

### Patch Changes

- 2870a04: Fix Backspace and word corrections from the phone keyboard (reported with SwiftKey) being skipped after a toolbar key or a mouse report: Backspace over typed text now always reaches the terminal, and wheel scrolling in a mouse-tracking program no longer ends the keyboard edit record.
- @lazysh/account-usage@1.35.0
  - @lazysh/common@1.35.0
  - @lazysh/display-idle@1.35.0
  - @lazysh/et-transport@1.35.0
  - @lazysh/mosh-transport@1.35.0

## 1.34.0

### Minor Changes

- d5a8ca9: Update the Agent view in real time. A bound Claude Code or Codex conversation now streams over one host companion channel (`lazysh-agent transcript-watch`) instead of a full page read every 2 seconds: new messages, a reply that grows and a tool result that lands on an older turn change their card in place, without a page replace or a jump of the reading position. The thread shows Agent is working or waiting from the recorded turn state, polls every 2 seconds with a note when the stream cannot open, marks the thread stale while it reconnects, and asks you to update an older host companion.

### Patch Changes

- d455f37: Restore sliding between the toolbar pages in the compact terminal toolbar without making it taller: swipe sideways, or use the page indicator, between the keys, a Tools page with Find and Copy, and a Snippets page with saved snippets and chords. Changed default: the More keys key is removed and the default toolbar's second row gains an enter key in its place; saved layouts keep every key.
- @lazysh/account-usage@1.34.0
  - @lazysh/common@1.34.0
  - @lazysh/display-idle@1.34.0
  - @lazysh/et-transport@1.34.0
  - @lazysh/mosh-transport@1.34.0

## 1.33.4

### Patch Changes

- a653d76: Fix the Files view not resolving paths that start with `~`: `~`, `~/x`, `$HOME/x` and `${HOME}/x` now expand to the SSH user's home as reported by the host's SFTP server, the resolved absolute path is shown, and `~otheruser` is refused with a clear message.
- @lazysh/account-usage@1.33.4
  - @lazysh/common@1.33.4
  - @lazysh/display-idle@1.33.4
  - @lazysh/et-transport@1.33.4
  - @lazysh/mosh-transport@1.33.4

## 1.33.3

### Patch Changes

- 7f16dce: Fix the Agent view header spending a third of a phone screen on chrome: the header, Back and Enter buttons and unverified notices are one compact row with an options button, token counters leave the message flow, harness-injected records such as task notifications show as compact event lines instead of raw tags in a user bubble, and the composer is one line with a visible Stage in terminal button.
- @lazysh/account-usage@1.33.3
  - @lazysh/common@1.33.3
  - @lazysh/display-idle@1.33.3
  - @lazysh/et-transport@1.33.3
  - @lazysh/mosh-transport@1.33.3

## 1.33.2

### Patch Changes

- f8c530b: Make the terminal fill all the free screen area: no margin above it, no side gutter, and one or two more columns of text on a phone, so it sits edge to edge like other mobile SSH clients.
- @lazysh/account-usage@1.33.2
  - @lazysh/common@1.33.2
  - @lazysh/display-idle@1.33.2
  - @lazysh/et-transport@1.33.2
  - @lazysh/mosh-transport@1.33.2

## 1.33.1

### Patch Changes

- 59b5cf0: Resize Mosh sessions for the soft keyboard so responsive programs can redraw their prompts above it.
- @lazysh/account-usage@1.33.1
  - @lazysh/common@1.33.1
  - @lazysh/display-idle@1.33.1
  - @lazysh/et-transport@1.33.1
  - @lazysh/mosh-transport@1.33.1

## 1.33.0

### Minor Changes

- d837a6b: Let you resize the terminal toolbar with a Toolbar key height slider (28 to 56 px, default 32 px) in Preferences, saved on this device and applied live.

### Patch Changes

- @lazysh/account-usage@1.33.0
  - @lazysh/common@1.33.0
  - @lazysh/display-idle@1.33.0
  - @lazysh/et-transport@1.33.0
  - @lazysh/mosh-transport@1.33.0

## 1.32.0

### Minor Changes

- fc027c4: Make the terminal toolbar a compact, fixed grid of equal-width keys like other mobile SSH clients: no sliding pages, 32 px keys, a status bar that yields its height on a short phone window, and a More keys list for Find, Copy and saved snippets and chords. Changed default: two rows of nine keys with the arrows in an inverted T; saved layouts keep every key.

### Patch Changes

- @lazysh/account-usage@1.32.0
  - @lazysh/common@1.32.0
  - @lazysh/display-idle@1.32.0
  - @lazysh/et-transport@1.32.0
  - @lazysh/mosh-transport@1.32.0

## 1.31.2

### Patch Changes

- 8be56c4: Make Android notification settings reachable after notification permission is denied, and ask for the permission after the first session opens instead of during its connection.
- @lazysh/account-usage@1.31.2
  - @lazysh/common@1.31.2
  - @lazysh/display-idle@1.31.2
  - @lazysh/et-transport@1.31.2
  - @lazysh/mosh-transport@1.31.2

## 1.31.1

### Patch Changes

- ad04578: Keep the verified stable tag and GitHub release writable when other workflow changes merge while a release builds.
- @lazysh/account-usage@1.31.1
  - @lazysh/common@1.31.1
  - @lazysh/display-idle@1.31.1
  - @lazysh/et-transport@1.31.1
  - @lazysh/mosh-transport@1.31.1

## 1.31.0

### Minor Changes

- 4a8f4b3: Browse this device's files and review its Git repositories from a local desktop session.

### Patch Changes

- 4c075b5: Fix finger scrolling in Herdr sessions whose host cannot serve guarded history, which showed Unavailable on every swipe.
- 7a1168b: Fix Chat's View choice snapping back to Recorded messages in WebKit apps after switching Agent to Codex, and run the native Chat recorded-conversation and card cases on Linux and Android.
- @lazysh/account-usage@1.31.0
  - @lazysh/common@1.31.0
  - @lazysh/display-idle@1.31.0
  - @lazysh/et-transport@1.31.0
  - @lazysh/mosh-transport@1.31.0

## 1.30.5

### Patch Changes

- a738e6f: List only live Herdr agents in Agent view, open the selected agent's conversation as native chat, and say so when the host companion must be updated.
- @lazysh/account-usage@1.30.5
  - @lazysh/common@1.30.5
  - @lazysh/display-idle@1.30.5
  - @lazysh/et-transport@1.30.5
  - @lazysh/mosh-transport@1.30.5

## 1.30.4

### Patch Changes

- a0b0603: Dismiss a boot-time system error dialog on the Android CI emulator before native acceptance starts, so the app window keeps focus.
- @lazysh/account-usage@1.30.4
  - @lazysh/common@1.30.4
  - @lazysh/display-idle@1.30.4
  - @lazysh/et-transport@1.30.4
  - @lazysh/mosh-transport@1.30.4

## 1.30.3

### Patch Changes

- c2aa152: Print the failed case, its message and first app frame when Android CI instrumentation fails, and name the failing touch-receipt flags of the D-pad acceptance.
- @lazysh/account-usage@1.30.3
  - @lazysh/common@1.30.3
  - @lazysh/display-idle@1.30.3
  - @lazysh/et-transport@1.30.3
  - @lazysh/mosh-transport@1.30.3

## 1.30.2

### Patch Changes

- 933719e: Fix finger scrolling in Herdr sessions on hosts without the guarded Herdr build, which showed Unavailable on every swipe.
- @lazysh/account-usage@1.30.2
  - @lazysh/common@1.30.2
  - @lazysh/display-idle@1.30.2
  - @lazysh/et-transport@1.30.2
  - @lazysh/mosh-transport@1.30.2

## 1.30.1

### Patch Changes

- dc223b5: Show app language choices as a checked list.
- @lazysh/account-usage@1.30.1
  - @lazysh/common@1.30.1
  - @lazysh/display-idle@1.30.1
  - @lazysh/et-transport@1.30.1
  - @lazysh/mosh-transport@1.30.1

## 1.30.0

### Minor Changes

- f39e536: Show each detected multiplexer's version with a Supported or Limited badge, hide Jump To on tmux older than 3.4, import synced hosts whose default multiplexer kind is unknown, and report non-POSIX host shells explicitly.

### Patch Changes

- @lazysh/account-usage@1.30.0
  - @lazysh/common@1.30.0
  - @lazysh/display-idle@1.30.0
  - @lazysh/et-transport@1.30.0
  - @lazysh/mosh-transport@1.30.0

## 1.29.3

### Patch Changes

- 0e794d4: Use a segmented cursor-shape picker in terminal preferences.
- @lazysh/account-usage@1.29.3
  - @lazysh/common@1.29.3
  - @lazysh/display-idle@1.29.3
  - @lazysh/et-transport@1.29.3
  - @lazysh/mosh-transport@1.29.3

## 1.29.2

### Patch Changes

- 020ce44: Wait for a free SSH channel opening instead of failing extra preview connections, so discovery marks every HTTP listener and pages with many requests load through a forward.
- @lazysh/account-usage@1.29.2
  - @lazysh/common@1.29.2
  - @lazysh/display-idle@1.29.2
  - @lazysh/et-transport@1.29.2
  - @lazysh/mosh-transport@1.29.2

## 1.29.1

### Patch Changes

- 0b0f52e: Detect attached Herdr agents in Agent view and keep finger scrolling separate from agent question input.
- @lazysh/account-usage@1.29.1
  - @lazysh/common@1.29.1
  - @lazysh/display-idle@1.29.1
  - @lazysh/et-transport@1.29.1
  - @lazysh/mosh-transport@1.29.1

## 1.29.0

### Minor Changes

- 2b1358f: Toggle the Agent view with a keyboard shortcut.

### Patch Changes

- @lazysh/account-usage@1.29.0
  - @lazysh/common@1.29.0
  - @lazysh/display-idle@1.29.0
  - @lazysh/et-transport@1.29.0
  - @lazysh/mosh-transport@1.29.0

## 1.28.2

### Patch Changes

- c3798f6: Organize guides, reference and explanations for easier navigation.
- @lazysh/account-usage@1.28.2
  - @lazysh/common@1.28.2
  - @lazysh/display-idle@1.28.2
  - @lazysh/et-transport@1.28.2
  - @lazysh/mosh-transport@1.28.2

## 1.28.1

### Patch Changes

- 0958675: Pin the Parakeet model archive the publisher re-uploaded on 2026-11-07, verify all four extracted files, and report a replaced archive clearly.
- @lazysh/account-usage@1.28.1
  - @lazysh/common@1.28.1
  - @lazysh/display-idle@1.28.1
  - @lazysh/et-transport@1.28.1
  - @lazysh/mosh-transport@1.28.1

## 1.28.0

### Minor Changes

- 94b17c9: Switch a session between its terminal and a live Agent view, with Both side by side on wide desktop layouts; Codex hooks can report their conversation for automatic binding.

### Patch Changes

- @lazysh/account-usage@1.28.0
  - @lazysh/common@1.28.0
  - @lazysh/display-idle@1.28.0
  - @lazysh/et-transport@1.28.0
  - @lazysh/mosh-transport@1.28.0

## 1.27.1

### Patch Changes

- ac467c1: Support Herdr 0.9.3 through 0.9.5, and explain a Herdr workspace, tab or pane that was closed on the host instead of showing Herdr's raw error.
- @lazysh/account-usage@1.27.1
  - @lazysh/common@1.27.1
  - @lazysh/display-idle@1.27.1
  - @lazysh/et-transport@1.27.1
  - @lazysh/mosh-transport@1.27.1

## 1.27.0

### Minor Changes

- 6f06a27: Group agent board reports by project on the connected host, and archive reports on this device until the agent reports again or the report ages out.

### Patch Changes

- @lazysh/account-usage@1.27.0
  - @lazysh/common@1.27.0
  - @lazysh/display-idle@1.27.0
  - @lazysh/et-transport@1.27.0
  - @lazysh/mosh-transport@1.27.0

## 1.26.1

### Patch Changes

- 395dde1: Keep a wheel or trackpad scroll that lands in the same frame as new terminal output: the terminal now moves to the history the scroll reached instead of staying on the live screen.
- @lazysh/account-usage@1.26.1
  - @lazysh/common@1.26.1
  - @lazysh/display-idle@1.26.1
  - @lazysh/et-transport@1.26.1
  - @lazysh/mosh-transport@1.26.1

## 1.26.0

### Minor Changes

- aea6aab: Save attachments to a private, uniquely named file under the host's `/tmp` by default instead of the login directory; an explicit destination path still saves there.

### Patch Changes

- @lazysh/account-usage@1.26.0
  - @lazysh/common@1.26.0
  - @lazysh/display-idle@1.26.0
  - @lazysh/et-transport@1.26.0
  - @lazysh/mosh-transport@1.26.0

## 1.25.1

### Patch Changes

- bcec7e8: Keep the Android soft keyboard closed after tapping a Herdr workspace, tab or pane switch, also on wide layouts such as a phone in landscape or a tablet; tapping the terminal or the keyboard toolbar key still opens it.
- @lazysh/account-usage@1.25.1
  - @lazysh/common@1.25.1
  - @lazysh/display-idle@1.25.1
  - @lazysh/et-transport@1.25.1
  - @lazysh/mosh-transport@1.25.1

## 1.25.0

### Minor Changes

- a89a721: Deliver relay events through an Apprise API stateful key with `--destination-format apprise`, optional proxy Bearer token, repeatable `--apprise-tag`, and finite `partial` and `rejected` receipts that the host companion also accepts on replay; push setup help now names the relay destinations and links the relay guide.

### Patch Changes

- 5dd1d1d: Detach the tmux navigation control client cleanly before closing its SSH channel or transport. On tmux older than 3.8, closing the transport while tmux still had output queued for that client left the client, and therefore the tmux server, running forever after lazysh disconnected. lazysh now ends control mode first, waits up to 500 ms for tmux to confirm, and only then closes the channel.
- 0ebee54: Keep the newest Mosh output and the cursor line on screen when the soft keyboard opens: the remote screen keeps its rows and the terminal pans to the cursor instead of shrinking.
- @lazysh/account-usage@1.25.0
  - @lazysh/common@1.25.0
  - @lazysh/display-idle@1.25.0
  - @lazysh/et-transport@1.25.0
  - @lazysh/mosh-transport@1.25.0

## 1.24.0

### Minor Changes

- e508487: Add Ctrl/Cmd+Shift+A and Ctrl/Cmd+Shift+W, gesture actions and toolbar keys that open Agents and Workspaces and return to the terminal; plain-terminal two-finger swipes up and down now open them by default.
- 1eb11f5: Detect lost SSH, Mosh and ET connections, retry automatically with saved credentials and backoff, reattach tmux or Herdr on success, and close the session when the lost-connection banner is dismissed.

### Patch Changes

- @lazysh/account-usage@1.24.0
  - @lazysh/common@1.24.0
  - @lazysh/display-idle@1.24.0
  - @lazysh/et-transport@1.24.0
  - @lazysh/mosh-transport@1.24.0

## 1.23.0

### Minor Changes

- 1bd1e51: Rebuild Preferences as a grouped settings list with section headers, value previews, sub-pages, action rows for related surfaces and a settings search.

### Patch Changes

- @lazysh/account-usage@1.23.0
  - @lazysh/common@1.23.0
  - @lazysh/display-idle@1.23.0
  - @lazysh/et-transport@1.23.0
  - @lazysh/mosh-transport@1.23.0

## 1.22.0

### Minor Changes

- 201c558: Show Workspace tools as swipeable, labelled carousel pages that size to the page in view and remember the last page across reconnects and restarts.

### Patch Changes

- @lazysh/account-usage@1.22.0
  - @lazysh/common@1.22.0
  - @lazysh/display-idle@1.22.0
  - @lazysh/et-transport@1.22.0
  - @lazysh/mosh-transport@1.22.0

## 1.21.0

### Minor Changes

- ae09622: Redesign the app chrome as subtle borderless controls with glass surfaces and a restrained accent that replaces the default cyan.
- b79a85b: Show images and files attached from the terminal composer as numbered inline `[Image #n]` and `[File #n]` chips that delete atomically and expand to the uploaded paths on send.

### Patch Changes

- @lazysh/account-usage@1.21.0
  - @lazysh/common@1.21.0
  - @lazysh/display-idle@1.21.0
  - @lazysh/et-transport@1.21.0
  - @lazysh/mosh-transport@1.21.0

## 1.20.0

### Minor Changes

- fcd7063: Split the terminal toolbar into a Tools page and a Snippets page that slide horizontally, with page indicators, overscroll-to-next-page and a remembered last page.

### Patch Changes

- @lazysh/account-usage@1.20.0
  - @lazysh/common@1.20.0
  - @lazysh/display-idle@1.20.0
  - @lazysh/et-transport@1.20.0
  - @lazysh/mosh-transport@1.20.0

## 1.19.0

### Minor Changes

- 1695c0c: Declutter the Herdr Spaces tree: compact space cards with one status summary, tabs and panes one indentation step in, single-line rows with `~` paths, pane counts on collapsed tabs and space actions in an overflow or long-press menu.
- 4bb1b92: Show an ongoing Android notification with the active session count while lazysh keeps terminal sessions running in the background; tapping it returns to the workspace, and it is removed after the last session ends. Android 13+ asks for notification permission once on the first session.

### Patch Changes

- @lazysh/account-usage@1.19.0
  - @lazysh/common@1.19.0
  - @lazysh/display-idle@1.19.0
  - @lazysh/et-transport@1.19.0
  - @lazysh/mosh-transport@1.19.0

## 1.18.2

### Patch Changes

- 942bb91: Keep finger scrolling responsive after a pause in history while the on-screen keyboard holds a word in composition, including full-screen agents with mouse reporting, and stop a toolbar key that sends the composed word from blocking later drags and long-presses.
- @lazysh/account-usage@1.18.2
  - @lazysh/common@1.18.2
  - @lazysh/display-idle@1.18.2
  - @lazysh/et-transport@1.18.2
  - @lazysh/mosh-transport@1.18.2

## 1.18.1

### Patch Changes

- 4fa31f0: Keep the phone Preferences heading and its Close button on screen after adding toolbar keys from Available keys.
- @lazysh/account-usage@1.18.1
  - @lazysh/common@1.18.1
  - @lazysh/display-idle@1.18.1
  - @lazysh/et-transport@1.18.1
  - @lazysh/mosh-transport@1.18.1

## 1.18.0

### Minor Changes

- 9b63d05: Add a pinch that zooms the multiplexer pane, short and long header pulls, long-press toolbar key actions and level-aware gesture defaults for tmux, Herdr, Zellij and plain terminals.

### Patch Changes

- @lazysh/account-usage@1.18.0
  - @lazysh/common@1.18.0
  - @lazysh/display-idle@1.18.0
  - @lazysh/et-transport@1.18.0
  - @lazysh/mosh-transport@1.18.0

## 1.17.1

### Patch Changes

- 46c4f00: Find the documented per-user Herdr installation on supported Unix hosts while preserving command PATH precedence.
- @lazysh/account-usage@1.17.1
  - @lazysh/common@1.17.1
  - @lazysh/display-idle@1.17.1
  - @lazysh/et-transport@1.17.1
  - @lazysh/mosh-transport@1.17.1

## 1.17.0

### Minor Changes

- 8c15fb0: Redesign the phone-first surfaces: agent lists with status rings, collapsible status sections and tags shared with the agent inbox, compact host rows, a floating tab bar, grouped settings lists and a true-black default theme.

### Patch Changes

- 2f4a19d: Keep the software keyboard's editor connection when arming a terminal toolbar modifier.
- @lazysh/account-usage@1.17.0
  - @lazysh/common@1.17.0
  - @lazysh/display-idle@1.17.0
  - @lazysh/et-transport@1.17.0
  - @lazysh/mosh-transport@1.17.0

## 1.16.0

### Minor Changes

- c671436: Read theme JSON or share codes from the Android clipboard through the native clipboard path, with validation and an explicit preview, and add the Amber Android launcher icon through launcher aliases that keep the running workspace open.
  
  Updating an existing Android install changes the launcher component from `.MainActivity` to `.LauncherDefault`, so some launchers may move or drop a home-screen icon pinned under the previous version.

### Patch Changes

- 16c8b45: Return the terminal to the live screen after toolbar keys and chord buttons, as keyboard input does.
- @lazysh/account-usage@1.16.0
  - @lazysh/common@1.16.0
  - @lazysh/display-idle@1.16.0
  - @lazysh/et-transport@1.16.0
  - @lazysh/mosh-transport@1.16.0

## 1.15.0

### Minor Changes

- af98930: Create Herdr workspaces and Git worktrees from Spaces, optionally starting a detected agent in the new workspace's first pane after the user reviews the exact remote commands.
- 75166b8: Add opt-in keyboard dismissal when scrolling past the bottom of local terminal history, preserving remote scrolling and requiring positively idle input.

### Patch Changes

- dc18c14: Show focused mobile agent activity details with contextual Back and list-position restoration.
- e054793: Fix Android biometric-protected credentials failing to save or unlock after a successful fingerprint, and the biometric resume lock stalling on its second prompt.
- @lazysh/account-usage@1.15.0
  - @lazysh/common@1.15.0
  - @lazysh/display-idle@1.15.0
  - @lazysh/et-transport@1.15.0
  - @lazysh/mosh-transport@1.15.0

## 1.14.0

### Minor Changes

- 61371ba: Add terminal text selection with touch handles, edge auto-scroll through local history for multi-screen selections, and floating Copy, Select all and Copy screen actions; raw buffer text is copied.

### Patch Changes

- 31a5fc0: Keep the opened Chat transcript reader, its reading position and unsent draft when returning from the terminal or another session view. Following pauses while hidden, confirmed terminal destinations are still released on leaving, and reported-history readers still retire.
- 7ad3229: Find the owned Android recorded Conversation Refresh control by its accessible name, matching the icon-only Refresh button, so the Refresh observation reaches the real control instead of finding no text-labelled button. This test-only repair keeps the single-button, enabled, started-then-settled and exact-message assertions and does not change application behavior.
- @lazysh/account-usage@1.14.0
  - @lazysh/common@1.14.0
  - @lazysh/display-idle@1.14.0
  - @lazysh/et-transport@1.14.0
  - @lazysh/mosh-transport@1.14.0

## 1.13.0

### Minor Changes

- 2dd690e: Arrange terminal toolbar keys by drag and drop, with keyboard and single-tap alternatives, and lay the toolbar out in one to three rows. The default stays one row with the same keys, and older clients read multi-row toolbars as one row.
- 6c02544: Redesign pending approval cards and the agent inbox: approvals show the agent and tool, project and request age, the full tool input, a live expiry countdown, a side-by-side Deny/Allow pair and a project/session/pane summary; the inbox groups events into foldable Needs you, Working and Done sections with status rings, relative times and icon actions, and moves monitoring controls into a collapsible settings group.
- 2b4841e: Show a live Herdr agent's lifecycle state when Herdr reports Unknown, as Herdr 0.9.3 does for an idle Codex prompt. If the pane's Herdr-reported session ID is unique among live panes and matches exactly one companion report from the same connection, the pane shows Working, Needs attention or Done. Herdr's own states take precedence, workspace and tab summaries stay Herdr's, and a pane without an exact match stays Unknown.
- 4b44d33: Extend the Ctrl/Cmd+K palette into a keyboard-operable command palette over hosts, open sessions, workspace tools and application actions, also opened by Ctrl/Cmd+Shift+P from a focused terminal. Files previews PNG, JPEG, GIF and WebP images up to 2 MiB, shows SVG only as an image from a blob URL so its scripts never run, and renders Markdown through the Chat renderer without raw HTML, links or remote images.
- 3c65f15: Redesign the terminal composer as a full-height sheet over the unchanged terminal and make its primary Send action paste the draft, then press Enter once. A new Input preference, on by default, restores paste-only behavior when turned off.

### Patch Changes

- 9164118: Fully reveal each owned Android native select inside its scroll panel before the unchanged centre hit-test and native tap, so a recorded-source selector left partly clipped under the context navigation by an earlier keyboard scroll is no longer tapped through the navigation. This test-only repair keeps every geometry, ownership and chooser assertion and does not change application behavior.
- @lazysh/account-usage@1.13.0
  - @lazysh/common@1.13.0
  - @lazysh/display-idle@1.13.0
  - @lazysh/et-transport@1.13.0
  - @lazysh/mosh-transport@1.13.0

## 1.12.0

### Minor Changes

- abe7b15: Import SSH private keys from a file, reject public-key files with a specific error at inspection and connection, and document host-key pin custody.
- 62fe53b: Add an opt-in per-host option that asks the SSH server to set `LC_TERMINAL=lazysh` for new SSH terminals and multiplexer attachments. It is off by default, needs the server's `AcceptEnv` to admit `LC_TERMINAL`, and is not sent by Mosh or ET sessions.
- 86e89e4: Show plan, question and turn-state cards in native Chat. The companion projects recorded Claude Code `TodoWrite`, `AskUserQuestion` and `ExitPlanMode` calls, Codex `update_plan`, `request_user_input` and plan-mode items, and OpenCode `todowrite` and `question` parts into display-only cards. Conversation views for Claude Code, Codex and OpenCode V1 report a working, waiting, idle or stopped turn derived from recorded lifecycle records; anything else stays unknown. Question cards list the options and send the user to the terminal to answer, because Chat cannot choose options in an agent prompt. Existing tool cards, cursors and prompt targets are unchanged.

### Patch Changes

- 8826db9: Make recorded conversation draft controls compact and show attachments in a focused mobile view while retaining explicit staging, upload and confirmed-input behavior.
- b765278: Add support, security and code-of-conduct policies and a first-contribution walkthrough without changing runtime behavior.
- 7dab9a5: Admit each owned Android Mosh resize acceptance phase only after its observation stays unchanged, so a Mosh frame drawn before Herdr repaints or an intermediate keyboard layout no longer becomes the phase baseline. This test-only repair keeps every original resize, keyboard-crossing and guarded Herdr Chat receiver assertion and does not change terminal behavior.
- 9c5fa30: Display provider-reported prepaid spend-cap percentages without estimating unknown quotas or changing uncapped balances.
- f86dd1a: Keep a terminal reader in history while output streams and across width, height and Mosh viewport resizes, and keep bottom-following Mosh sessions following after the viewport grows.
- 19998d0: Reduce workspace clutter around the session manager action.
- Updated dependencies [5406843]
- Updated dependencies [816f09b]
  - @lazysh/account-usage@1.12.0
  - @lazysh/common@1.12.0
  - @lazysh/display-idle@1.12.0
  - @lazysh/et-transport@1.12.0
  - @lazysh/mosh-transport@1.12.0

## 1.11.0

### Minor Changes

- aa1e2f3: Add explicitly selected OpenCode recorded conversations with current projection refresh and unchanged confirmed terminal input boundaries.

### Patch Changes

- 24123ed: Never pause terminal typing when a keyboard edit cannot be sent safely; skip that edit and show a fading, non-blocking review notice instead.
- cd197f9: Preserve terminal Enter input delivered as an input-only line break, including the explicit toolbar Shift modifier.
- f05a3ce: Preserve owned terminal corrections delivered as paired keyless composition-text input events.
- @lazysh/account-usage@1.11.0
  - @lazysh/common@1.11.0
  - @lazysh/display-idle@1.11.0
  - @lazysh/et-transport@1.11.0
  - @lazysh/mosh-transport@1.11.0

## 1.10.4

### Patch Changes

- 8e3f647: Keep the visible scrollback line anchored when the terminal height changes.
  Keep validated forward deletions synchronized with subsequent terminal input without changing the deferred composition fallback.
  Preserve zero-code Process corrections and order subsequent hardware keypresses without duplicate input.
- 1ebc76a: Reclaim unused host .NET and Haskell toolchains before Google ntfy APK and system-image provisioning, preserving the active Android SDK/NDK and native acceptance gates.
- @lazysh/account-usage@1.10.4
  - @lazysh/common@1.10.4
  - @lazysh/display-idle@1.10.4
  - @lazysh/et-transport@1.10.4
  - @lazysh/mosh-transport@1.10.4

## 1.10.3

### Patch Changes

- 8ac0833: Replace competing workspace navigation layers with focused Workspaces and Agents destinations, compact session context and contextual desktop tools. Preserve the compact phone terminal, mounted sessions and input authority while refining branded glass navigation and readable work-state rows.
- ba14491: Bound the ntfy Android CI fixture userdata partition to 4 GiB so emulator startup fits hosted runner disk space.
- 0465ecb: Measure the existing synthetic Windows companion writer phases after native acceptance, including failed owners, while retaining mandatory acceptance and release receipt gates.
- @lazysh/account-usage@1.10.3
  - @lazysh/common@1.10.3
  - @lazysh/display-idle@1.10.3
  - @lazysh/et-transport@1.10.3
  - @lazysh/mosh-transport@1.10.3

## 1.10.2

### Patch Changes

- a706336: Preserve validated owned ASCII edits across Android IME fallback transactions without replaying the previous text or losing multi-character deletion. Retain input ownership, cancellation and unsupported-edit review.
- 20fa847: Keep Mosh repaint geometry synchronized with each complete server frame so keyboard, composer and viewport resizes do not duplicate the screen into local scrollback. Preserve existing history cells without reflow; narrow views can clip old history until widened.
- @lazysh/account-usage@1.10.2
  - @lazysh/common@1.10.2
  - @lazysh/display-idle@1.10.2
  - @lazysh/et-transport@1.10.2
  - @lazysh/mosh-transport@1.10.2

## 1.10.1

### Patch Changes

- e05e4a2: Make terminal composition compact, put uploaded attachment paths before secondary tools, guide notification setup, and separate live agents from reported activity while keeping pending approvals reachable.
- 3207d0c: Keep custom theme text readable on translucent navigation and short sheets by increasing backing opacity only when the palette needs it. Preserve bundled glass and solid reduced-transparency/forced-colors rendering.
- @lazysh/account-usage@1.10.1
  - @lazysh/common@1.10.1
  - @lazysh/display-idle@1.10.1
  - @lazysh/et-transport@1.10.1
  - @lazysh/mosh-transport@1.10.1

## 1.10.0

### Minor Changes

- f1d7feb: Add a recorded Codex Conversation reader with mode-aware turn replay, bounded protected fork/revert prefixes, explicit refresh and opt-in Follow. Records remains the default; recorded history does not establish a live agent or authorize requests.

### Patch Changes

- @lazysh/account-usage@1.10.0
  - @lazysh/common@1.10.0
  - @lazysh/display-idle@1.10.0
  - @lazysh/et-transport@1.10.0
  - @lazysh/mosh-transport@1.10.0

## 1.9.11

### Patch Changes

- f164bfc: Retain one closed, passive native finger-landing observation to distinguish terminal geometry and hit-target failures without changing gesture admission, deadlines or scrolling behavior.
- @lazysh/account-usage@1.9.11
  - @lazysh/common@1.9.11
  - @lazysh/display-idle@1.9.11
  - @lazysh/et-transport@1.9.11
  - @lazysh/mosh-transport@1.9.11

## 1.9.10

### Patch Changes

- b7aeb55: Extend owned Android SSH acceptance to verify toolbar Shift one-shot and pending-composition toggling, modified Enter, and momentary key appearance against the exact receiver stream.
- 9869796: Prevent the browser touch default only on admitted expanded D-pad direction gestures, preserving ordinary clicks, corner shortcuts and accessibility controls. Native Android long-press and IME behavior remain subject to the original acceptance case.
- f39cd05: Retain only closed native registration and enrollment phases after an unchanged ntfy challenge-confirmation failure. Preserve the original failure, deadlines and privacy guards; this is diagnostic evidence, not a confirmation or delivery fix.
- @lazysh/account-usage@1.9.10
  - @lazysh/common@1.9.10
  - @lazysh/display-idle@1.9.10
  - @lazysh/et-transport@1.9.10
  - @lazysh/mosh-transport@1.9.10

## 1.9.9

### Patch Changes

- 657ee0b: Qualify standalone Android Mosh interoperability independently from guarded client UI acceptance while preserving their existing deadlines and assertions.
- @lazysh/account-usage@1.9.9
  - @lazysh/common@1.9.9
  - @lazysh/display-idle@1.9.9
  - @lazysh/et-transport@1.9.9
  - @lazysh/mosh-transport@1.9.9

## 1.9.8

### Patch Changes

- 38bba29: Make toolbar Shift one-shot after the next key while retaining Shift throughout an already-held arrow or D-pad gesture. Allow turning Shift off without committing pending IME text; preserve explicit Control and Alt locks.
- @lazysh/account-usage@1.9.8
  - @lazysh/common@1.9.8
  - @lazysh/display-idle@1.9.8
  - @lazysh/et-transport@1.9.8
  - @lazysh/mosh-transport@1.9.8

## 1.9.7

### Patch Changes

- c525664: Add bounded passive native D-pad IME/geometry and final context-menu observations for Android acceptance diagnostics. This does not qualify or change D-pad behavior.
- 0c12b4c: Keep locale workflow acceptance aligned with compact native status recovery while preserving the visible case-sensitive untranslated reason.
- 82bfca4: Keep mobile Workspaces focused on Spaces with compact selected-session context and an explicit connected-session disclosure. Preserve the expanded desktop list, session selection and navigation state.
- @lazysh/account-usage@1.9.7
  - @lazysh/common@1.9.7
  - @lazysh/display-idle@1.9.7
  - @lazysh/et-transport@1.9.7
  - @lazysh/mosh-transport@1.9.7

## 1.9.6

### Patch Changes

- 9d70b38: Exercise repeated short Android finger drags and a continuous held drag against the existing owned Herdr receiver in the packaged native acceptance owner.
- 5b621d3: Retain bounded passive finger-scroll geometry and wheel metadata, plus closed owned-host history failure stages, without changing native gesture verdicts or input routing.
- b2574a4: Add native Linux acceptance for an isolated GTK reduced-motion preference, preserved keyboard focus and the original local terminal.
- 455bb4f: Retain bounded, closed native IME switch and terminal-tap ordering observations after editor admission fails, without changing input state, acceptance guards or deadlines.
- f8d9836: Retain only the HTTP status when release tag creation fails, preserving private response data and all publication guards.
- 9af806c: Preserve short finger-scroll distance across admitted gestures in the same active terminal while matching normal scrollback, mouse-report and alternate-buffer wheel semantics.
- @lazysh/account-usage@1.9.6
  - @lazysh/common@1.9.6
  - @lazysh/display-idle@1.9.6
  - @lazysh/et-transport@1.9.6
  - @lazysh/mosh-transport@1.9.6

## 1.9.5

### Patch Changes

- a539963: Add native Linux acceptance for public appearance settings, rendered text contrast, keyboard category navigation and focus restoration while preserving the original local terminal.

  Keep unavailable icon settings compact with explicit recovery, and prevent sidebar mode labels from breaking mid-word across narrow and enlarged-text layouts.
- 822ae17: Route vertical finger drags with selected terminal text through xterm’s ordinary wheel handling, including mouse-tracking multiplexers.
- @lazysh/account-usage@1.9.5
  - @lazysh/common@1.9.5
  - @lazysh/display-idle@1.9.5
  - @lazysh/et-transport@1.9.5
  - @lazysh/mosh-transport@1.9.5

## 1.9.4

### Patch Changes

- @lazysh/account-usage@1.9.4
  - @lazysh/common@1.9.4
  - @lazysh/display-idle@1.9.4
  - @lazysh/et-transport@1.9.4
  - @lazysh/mosh-transport@1.9.4

## 1.9.3

### Patch Changes

- 50b1569: Preserve slow sub-row finger movement in normal terminal scrollback without changing gesture sensitivity or mouse-report routing.
- @lazysh/account-usage@1.9.3
  - @lazysh/common@1.9.3
  - @lazysh/display-idle@1.9.3
  - @lazysh/et-transport@1.9.3
  - @lazysh/mosh-transport@1.9.3

## 1.9.2

### Patch Changes

- 0bc9cc4: Retain closed terminal review, ended-session, modal and pane-display context when Android IME editor admission fails.
- 42c2134: Suppress browser context menus on expanded D-pad controls while preserving their normal terminal input.
- 7dadc4e: Bind native companion installation acceptance to the installer panel rather than the shared hook styling class; retain strict action and outcome checks.
- e3e0e63: Dispatch complete Google/FOSS ntfy native-acceptance commands through the pinned emulator runner without changing provider guards or deadlines.
- e0f7115: Retain closed failure-only observations when owned native SSH control prompts fail admission, preserving the original deadline and failure.
- @lazysh/account-usage@1.9.2
  - @lazysh/common@1.9.2
  - @lazysh/display-idle@1.9.2
  - @lazysh/et-transport@1.9.2
  - @lazysh/mosh-transport@1.9.2

## 1.9.1

### Patch Changes

- dce0ea9: Retain bounded focus, viewport, touch-action and context-menu evidence in Android D-pad failure diagnostics without changing input behavior.
- @lazysh/account-usage@1.9.1
  - @lazysh/common@1.9.1
  - @lazysh/display-idle@1.9.1
  - @lazysh/et-transport@1.9.1
  - @lazysh/mosh-transport@1.9.1

## 1.9.0

### Minor Changes

- eb37ec3: Offer Firebase-free UnifiedPush enrollment and authenticated event display in Google Android builds with explicit provider selection, and add opt-in Gotify delivery through the self-hosted notification relay.

### Patch Changes

- 86ef821: Make Android protected-receiver changed-read checks deterministic by restoring the original fixture size before each observation.
- e9c15fc: Align browser acceptance with dedicated Preferences screens and settle pointer hover transitions before checking attachment control styling.
- fb3388c: Persist the selected Android push provider before explicit controls so late Firebase cleanup markers cannot change the chosen transport after restart.
- @lazysh/account-usage@1.9.0
  - @lazysh/common@1.9.0
  - @lazysh/display-idle@1.9.0
  - @lazysh/et-transport@1.9.0
  - @lazysh/mosh-transport@1.9.0

## 1.8.4

### Patch Changes

- b6487ee: Add bounded passive pointer/capture and rendered-direction evidence to Android D-pad acceptance without changing production input or gesture budgets.
- e882bae: Retain a closed failure-only summary of cached completed native Window dispatch events and relative timings without changing Android D-pad input or acceptance budgets.
- 3ea1476: Navigate Preferences through focused category screens, simplify workspace and agent chrome, and refine accessible glass and motion treatments.
- af07d0f: Identify failed Herdr host teardown stages using closed post-stop observations and preserve the original test failure when cleanup also fails.
- f77f54f: Retain a bounded failure-only comparison of the owned Android IME receiver wire without exporting input or changing runtime assertions.
- 05e9410: Keep owned Android autocomplete corrections editable when the keyboard leaves its caret inside the composing range.
- 8ee297e: Preserve a previously admitted raw SSH fixture receiver's normal exit between process-identity observations while retaining replacement, live ownership and exact-byte checks.
- cd99c29: Admit vertically dominant terminal finger drags and preserve coalesced native scroll distance before finger lift.
- 1330e4c: Preserve physical and toolbar Shift+Enter as a modified Enter key so agent terminals can insert a newline without ordinary Enter submission.
- @lazysh/account-usage@1.8.4
  - @lazysh/common@1.8.4
  - @lazysh/display-idle@1.8.4
  - @lazysh/et-transport@1.8.4
  - @lazysh/mosh-transport@1.8.4

## 1.8.3

### Patch Changes

- 408e4a8: Retain closed failure-local D-pad phase and last validated receiver counts in Android native acceptance without changing gestures, budgets or input behavior.
- 2d4bab7: Use a minimum-sized standard Space for the house-owned Android test IME and cover its real framework measurement without changing packaged terminal input behavior.
- 1eda85b: Calibrate the ntfy acceptance release-assembly build allowance from two to four minutes after a measured two-worker build exceeded two minutes, preserving APK/trust checks, native assertions and outer test limits.
- 1e05652: Align the opt-in Android raw SSH receiver fixture with the existing bounded UI-host lifetime while preserving ordinary SSH and Mosh lifetimes and all input acceptance deadlines.
- eb70476: Give each owned SSH/SFTP fixture launch a private host-trust file so concurrent clients cannot rewrite another client's pin, preserving strict verification and cleanup.
- @lazysh/account-usage@1.8.3
  - @lazysh/common@1.8.3
  - @lazysh/display-idle@1.8.3
  - @lazysh/et-transport@1.8.3
  - @lazysh/mosh-transport@1.8.3

## 1.8.2

### Patch Changes

- 17ce060: Remeasure the Android native D-pad target after its initial keyboard-opening tap, preserving owned-window injection and exact receiver-byte acceptance.
- 1d4c8c5: Retain closed owned-tool failure observations and explicit validated native-receipt progress in ntfy acceptance failures, without changing process cleanup, deadlines or trust checks.
- 99422b0: Use the visible workspace Preferences action in Android D-pad acceptance and retain closed failure-only IME editor-clause diagnostics without changing input or acceptance behavior.
- @lazysh/account-usage@1.8.2
  - @lazysh/common@1.8.2
  - @lazysh/display-idle@1.8.2
  - @lazysh/et-transport@1.8.2
  - @lazysh/mosh-transport@1.8.2

## 1.8.1

### Patch Changes

- d36533a: Retain fixed test-only startup stage breadcrumbs when owned Mosh multiplexer acceptance fails, without changing connection errors or runtime behavior.
- f9150ac: Forward the pinned disposable Secret Service executable through the native GUI Turbo task and give Android raw-input acceptance fixtures an owned SSH root, preserving strict environment filtering and receiver ownership checks.
- 14597f5: Retain one closed distributor UI snapshot only after the native ntfy trust-topic flow fails, preserving the original navigation timing, action, deadline and failure.
- @lazysh/account-usage@1.8.1
  - @lazysh/common@1.8.1
  - @lazysh/display-idle@1.8.1
  - @lazysh/et-transport@1.8.1
  - @lazysh/mosh-transport@1.8.1

## 1.8.0

### Minor Changes

- 35722cf: Add held-pointer panning and paced arrow repeats to the expanded terminal D-pad, preserving single taps and stopping input on interruption or session replacement.

### Patch Changes

- @lazysh/account-usage@1.8.0
  - @lazysh/common@1.8.0
  - @lazysh/display-idle@1.8.0
  - @lazysh/et-transport@1.8.0
  - @lazysh/mosh-transport@1.8.0

## 1.7.8

### Patch Changes

- d015653: Prepare and independently verify a bounded positive-offset clock state only in the attested disposable Android ntfy fixture, restoring automatic time after verified app-state teardown.
- @lazysh/account-usage@1.7.8
  - @lazysh/common@1.7.8
  - @lazysh/display-idle@1.7.8
  - @lazysh/et-transport@1.7.8
  - @lazysh/mosh-transport@1.7.8

## 1.7.7

### Patch Changes

- 019bc6a: Add an owned Android packaged-terminal SSH checkpoint for fixed native IME correction/repeat transactions and stale InputConnection rejection; physical keyboard qualification remains separate.
- @lazysh/account-usage@1.7.7
  - @lazysh/common@1.7.7
  - @lazysh/display-idle@1.7.7
  - @lazysh/et-transport@1.7.7
  - @lazysh/mosh-transport@1.7.7

## 1.7.6

### Patch Changes

- 85195e3: Record closed native companion action-readiness diagnostics without changing install/reuse acceptance or its deadlines.
- @lazysh/account-usage@1.7.6
  - @lazysh/common@1.7.6
  - @lazysh/display-idle@1.7.6
  - @lazysh/et-transport@1.7.6
  - @lazysh/mosh-transport@1.7.6

## 1.7.5

### Patch Changes

- efb451e: Organize documentation around guided learning, task guides, reference and explanation, with a first SSH session and preserved security and platform limits.
- @lazysh/account-usage@1.7.5
  - @lazysh/common@1.7.5
  - @lazysh/display-idle@1.7.5
  - @lazysh/et-transport@1.7.5
  - @lazysh/mosh-transport@1.7.5

## 1.7.4

### Patch Changes

- c398f06: Verify session-first Workspaces, explicit Herdr setup disclosure and retained terminal navigation through the real Linux native app and owned SSH servers.
- @lazysh/account-usage@1.7.4
  - @lazysh/common@1.7.4
  - @lazysh/display-idle@1.7.4
  - @lazysh/et-transport@1.7.4
  - @lazysh/mosh-transport@1.7.4

## 1.7.3

### Patch Changes

- 2e41ca2: Prioritize existing app sessions in Workspaces, disclose healthy Herdr server setup, and refine compact themed navigation while preserving shared-focus warnings and session identity.
- a95d903: Prevent delayed terminal controls from taking focus away from an open credential dialog.
- @lazysh/account-usage@1.7.3
  - @lazysh/common@1.7.3
  - @lazysh/display-idle@1.7.3
  - @lazysh/et-transport@1.7.3
  - @lazysh/mosh-transport@1.7.3

## 1.7.2

### Patch Changes

- f9b908e: Add an owned Linux native GUI saved-credential reconnect checkpoint using a disposable Secret Service, with explicit trust/save/reconnect/forget and private-process cleanup.
- @lazysh/account-usage@1.7.2
  - @lazysh/common@1.7.2
  - @lazysh/display-idle@1.7.2
  - @lazysh/et-transport@1.7.2
  - @lazysh/mosh-transport@1.7.2

## 1.7.1

### Patch Changes

- 45c8b2f: Follow the visible Appearance disclosure before native iOS app-icon acceptance. Preserve actual icon confirmation, readback, restoration and existing wait limits.
- 222c1e2: Retain bounded host/device clock comparison diagnostics in owned Android ntfy acceptance receipts without changing notification admission or clock settings.
- @lazysh/account-usage@1.7.1
  - @lazysh/common@1.7.1
  - @lazysh/display-idle@1.7.1
  - @lazysh/et-transport@1.7.1
  - @lazysh/mosh-transport@1.7.1

## 1.7.0

### Minor Changes

- bcc7feb: Add opt-in V3 managed Amp system-plugin setup with protected ownership, shadow-aware removal and bounded V2 metadata compatibility.

### Patch Changes

- b988e84: Qualify manual Android Mosh attachment uploads with a valid image spanning multiple chunks and an unchanged pre-existing destination. This checkpoint does not establish closed-control recovery, file-picker/camera or Samsung device compatibility.
- @lazysh/account-usage@1.7.0
  - @lazysh/common@1.7.0
  - @lazysh/display-idle@1.7.0
  - @lazysh/et-transport@1.7.0
  - @lazysh/mosh-transport@1.7.0

## 1.6.0

### Minor Changes

- aad0990: Add opt-in version-2 hook discovery and inspected, profile-scoped Copilot hook setup while preserving version-1 compatibility, foreign settings and provider trust.

### Patch Changes

- b6c3bd3: Keep a held touch scroll on the stable terminal screen when output redraws its text spans. Preserve screen-reader mode and desktop hit testing.
- b6c3bd3: Normalize mouse-tracking touch scroll by finger travel instead of event frequency, retaining partial distance, original targeting and bounded wheel batches until the gesture ends. Keep the outer terminal canvas anchored during keyboard-sized resize and input visibility requests. Plain terminal history and physical wheel behavior remain unchanged.
- @lazysh/account-usage@1.6.0
  - @lazysh/common@1.6.0
  - @lazysh/display-idle@1.6.0
  - @lazysh/et-transport@1.6.0
  - @lazysh/mosh-transport@1.6.0

## 1.5.5

### Patch Changes

- da17fde: Qualify closing one SSH relay stream through its owned server subtree for Android upload-recovery testing. Refuse stale, missing or ambiguous server attribution and preserve the original Mosh UDP daemon. Android recovery UI acceptance remains separate.
- @lazysh/account-usage@1.5.5
  - @lazysh/common@1.5.5
  - @lazysh/display-idle@1.5.5
  - @lazysh/et-transport@1.5.5
  - @lazysh/mosh-transport@1.5.5

## 1.5.4

### Patch Changes

- @lazysh/account-usage@1.5.4
  - @lazysh/common@1.5.4
  - @lazysh/display-idle@1.5.4
  - @lazysh/et-transport@1.5.4
  - @lazysh/mosh-transport@1.5.4

## 1.5.3

### Patch Changes

- cd969ee: Correct native Android fixture Setup-state reads and whole-value clipboard replacement, and retain bounded visual-readiness observations without changing gesture or transport acceptance.
- @lazysh/account-usage@1.5.3
  - @lazysh/common@1.5.3
  - @lazysh/display-idle@1.5.3
  - @lazysh/et-transport@1.5.3
  - @lazysh/mosh-transport@1.5.3

## 1.5.2

### Patch Changes

- 11187d3: Refine mobile connected navigation with full-width agent/workspace views, compact accessible Herdr actions and progressive activity details while preserving terminal and session behavior.
- @lazysh/account-usage@1.5.2
  - @lazysh/common@1.5.2
  - @lazysh/display-idle@1.5.2
  - @lazysh/et-transport@1.5.2
  - @lazysh/mosh-transport@1.5.2

## 1.5.1

### Patch Changes

- @lazysh/account-usage@1.5.1
  - @lazysh/common@1.5.1
  - @lazysh/display-idle@1.5.1
  - @lazysh/et-transport@1.5.1
  - @lazysh/mosh-transport@1.5.1

## 1.5.0

### Minor Changes

- f0b0b94: Show optional read-only Herdr reported-session details with same-connection companion matches and explicit unverified/shared-reference labels. Path references remain private; input and Chat authority are unchanged.
- 8db8a98: Detect installed host agents and known profile locations before explicit hook setup. Let users select a target while preserving inspected installation plans, manual profile selection and provider trust decisions. Discovery never installs hooks or creates missing profiles.
- afc27ec: Add explicit managed Cline root lifecycle plugin setup and profile discovery. Preserve existing plugin restrictions and require inspected install/remove plans; configuration does not establish live reporting.

### Patch Changes

- 9f2c42f: Make reported agent activity reachable from the top of the Agents drawer without changing readers or navigation state.
- 8811c8a: Retain the mobile Agents drawer reading position when returning from a tool without changing navigation or provider state.
- a422338: Reveal the current Agents Setup through its visible public button before native keep-awake acceptance toggles the checkbox. Preserve the ownership checks, deadlines and strict gesture oracle; this test precondition repair does not establish Android gesture acceptance.
- b190865: Correct download and public roadmap guidance, and document Obtainium as the preferred Android installation method with explicit APK flavor selection and verification limits.
- @lazysh/account-usage@1.5.0
  - @lazysh/common@1.5.0
  - @lazysh/display-idle@1.5.0
  - @lazysh/et-transport@1.5.0
  - @lazysh/mosh-transport@1.5.0

## 1.4.2

### Patch Changes

- cf4b9f3: Qualify compact settings and workspace navigation through visible browser acceptance preconditions while retaining existing locale, display ownership, QR privacy and stale dictation assertions.
- 8d7a15d: Show concise provider-specific verification guidance after inspected hook configuration without changing trust, loading or reporting status.
- 0844aa3: Keep Workspace tools short by default with explicit session-tool, connection and application disclosures, preserving existing guarded actions and touch targets.
- @lazysh/account-usage@1.4.2
  - @lazysh/common@1.4.2
  - @lazysh/display-idle@1.4.2
  - @lazysh/et-transport@1.4.2
  - @lazysh/mosh-transport@1.4.2

## 1.4.1

### Patch Changes

- 137bb78: Keep the native branded cover until the current renderer acknowledges its workspace commit when app lock is disabled, including after recreation. Preserve native unlock controls for confirmed locks. Physical-device launch-frame qualification remains pending.
- 4c31c91: Return from usage and workspace tools to their opening context without replacing the terminal session, and dismiss local overlays before Android Back navigates.
- 16460c7: Open the existing hook inspection workflow directly from empty Activity without automatically installing hooks or asserting live reporting.
- 08210fc: Prioritize agents over optional setup in healthy workspaces, retaining visible repairs and pending approvals.
- 8bc9f45: Collapse healthy selected Herdr setup even when other servers are available. Preserve explicit alternate selection and automatic setup for missing or unhealthy selections.
- fb2b45d: Refine frosted navigation and short action sheets using the active theme colors. Keep long forms and terminal output opaque and preserve reduced-transparency and forced-color fallbacks.
- 8d9f8b7: Publish the Android workspace UX critique and fresh Moshi/Termish benchmark, with inspected screenshots, issue links and observable redesign acceptance criteria. This research checkpoint does not claim the reported UX or agent-activity failures are fixed.
- dd2c945: Retain the one native notification-permission action budget separately from later menu queries and record only the first measured expiry operation, without changing deadlines, input or permissions.
- c9265d1: Start Preferences at a compact category list without focusing text input, preserving settings drafts and operations.
- 8fb1c57: Collapse saved-host connection options and focus credentials or Connect without opening advanced Mosh fields.
- a928587: Distinguish terminal input queue saturation from channel closure and add bounded, content-free caller/ownership diagnostics. This improves diagnosis; it does not claim the Android navigation failure is fixed.
- @lazysh/account-usage@1.4.1
  - @lazysh/common@1.4.1
  - @lazysh/display-idle@1.4.1
  - @lazysh/et-transport@1.4.1
  - @lazysh/mosh-transport@1.4.1

## 1.4.0

### Minor Changes

- 54796e0: Browse Herdr spaces and live agent panes from workspace navigation. Reuse or explicitly attach the exact server display, then use stock shared workspace/tab focus or the companion's exact shell/agent pane focus. Disclose shared focus and require fresh Chat confirmation after navigation.
- 730cb2a: Add explicit inspected-plan lifecycle hook setup for Claude Code, Codex and OpenCode, with an SSH-connected Agents setup flow and companion CLI.

  Preserve foreign profile values and ordinary file mode/group metadata, refuse unhandled ACLs or ownership conflicts, and keep configured state distinct from trust and live reporting. Managed writes initially support qualified Linux filesystems; other platforms retain preview-only capability.
- 7218f34: Add inspected-profile managed Droid hooks for an already-existing standalone hooks.json, including the connected Agents selector.

  Preserve foreign groups and fallback policy; refuse absent configuration rather than shadowing settings/legacy declarations. No automatic trust changes, fresh-profile migration or native Droid lifecycle claim.
- 7477209: Extend explicit inspected-profile lifecycle hook setup to Gemini CLI and Cursor CLI, including the SSH-connected Agents setup selector.

  Preserve Gemini millisecond deadlines and disable flags, Cursor version-1/fail-open observer semantics, foreign policy and the existing retained filesystem transaction. Other managed providers, macOS writes and actual provider-trusted reporting remain separate gaps.
- 8b5770c: Enter the saved named multiplexer through Mosh without forcing SSH, retain exact transport and attachment restoration intent, and preserve native display admission before exposing the connection.

### Patch Changes

- bc6c84d: Recover built-in account quotas from empty external reports and offer companion setup when a remote usage command is missing or outdated.
- b42a598: Fence Android and desktop IME composition completion and Enter against replay; apply owned trailing ASCII corrections without enabling private keyboard mode. Flush preedit before toolbar modifier changes. Complete the Android terminal no-autocorrect policy with autocomplete off; Compose hints remain unchanged. Preserve upstream handling for unsupported replacement spans pending remote editor compatibility.
- 6026586: Show branded Android startup content until the native access policy is known.
- b3d7262: Keep Android system bar icons readable over the native navy background.
- ad7e576: Reduce repeated mobile guidance and compact unavailable Apple status without hiding active sharing controls or safety limits.
- fd3a0aa: Free the terminal control row and prevent composer action overlap; give long mobile dialogs a fullscreen layout while preserving trust, authentication and dismissal protections.
- 34d9ba1: Compact and align the workspace restore notice, retaining restoration limitations in an accessible details disclosure and preserving explicit restore and dismissal behavior.
- 19e9da2: Verify companion files with a fixed, bounded window of SFTP reads while retaining ordered full-file hashing, legal partial-read handling, explicit EOF and metadata checks. Preserve existing time limits, conservative residue warnings and deletion guards; closed cleanup stage/reason observations distinguish incomplete cleanup from installation outcomes.
- f573077: Classify failed companion installer tag rechecks without exposing request or response text or changing verification rules.
- c0eaf57: Keep a continuous terminal touch drag routed to its original pane until the finger lifts or the gesture is cancelled.
- 693d31d: Keep Herdr navigation and agent reports reachable within one scrollable drawer on short screens.
- 1af65c3: Display structured native terminal error messages and preserve localized failures instead of rendering `[object Object]`.
- c6871fd: Clear sticky touch hover from momentary terminal keys while retaining intentional modifiers, held-key feedback, fine-pointer hover and accessible keyboard focus.
- 975d88e: Hold unsupported terminal IME corrections for bounded inline review and explicit copy without replaying text, guessing erase units or submitting deferred Enter. Preserve Compose drafts and clear local context at session/access lifecycle boundaries.
- Updated dependencies [bc6c84d]
  - @lazysh/account-usage@1.4.0
  - @lazysh/common@1.4.0
  - @lazysh/display-idle@1.4.0
  - @lazysh/et-transport@1.4.0
  - @lazysh/mosh-transport@1.4.0

## 1.3.3

### Patch Changes

- 7ea9c70: Accept Herdr encoded public identifiers so valid live agents are not rejected.
- @lazysh/account-usage@1.3.3
  - @lazysh/common@1.3.3
  - @lazysh/display-idle@1.3.3
  - @lazysh/et-transport@1.3.3
  - @lazysh/mosh-transport@1.3.3

## 1.3.2

### Patch Changes

- 5fd13cf: Retain closed last-poll selector counts and timing for public Android APK readiness failures without adding accessibility queries or changing acceptance actions and deadlines.
- @lazysh/account-usage@1.3.2
  - @lazysh/common@1.3.2
  - @lazysh/display-idle@1.3.2
  - @lazysh/et-transport@1.3.2
  - @lazysh/mosh-transport@1.3.2

## 1.3.1

### Patch Changes

- 9b7be20: Start live agent discovery on the attached Herdr session while preserving explicit server selection and refusing to substitute an absent attached target.
- @lazysh/account-usage@1.3.1
  - @lazysh/common@1.3.1
  - @lazysh/display-idle@1.3.1
  - @lazysh/et-transport@1.3.1
  - @lazysh/mosh-transport@1.3.1

## 1.3.0

### Minor Changes

- e5a32d9: Keep Android terminal sessions active while switching apps, with worker-owned background execution and paused renderer output deadlines.
- 9565f8a: Add compact AI account quotas and built-in host collectors when ai-usagebar is unavailable, keeping credentials on the session machine.
- 6c2657a: Keep Agents results, counts and empty states stable during periodic refreshes. Preserve read failures until a replacement completes; a failed live read clears its rows and count. This fixes polling flicker without claiming that the reported missing Herdr agents are resolved.
  
  Preserve whether a Herdr snapshot supplies live agent metadata. Show an explicit compatibility warning instead of a healthy zero-agent count when that metadata is missing; legacy Sessions trees remain supported.
  
  Add explicit host-tools SSH recovery for eligible Mosh sessions with a closed command connection. Authenticate for the original verified host while keeping the terminal and the independent upload connection; no authentication runs automatically.
- 54197d2: Open the current host's Default multiplexer setting directly from More, with the selector focused. Saving keeps the running terminal and saved transport preference intact; the named default applies to future connections.
  
  Select Use saved credentials by default when the native vault confirms they are available. Preserve explicit manual authentication choices and credentials entered before the availability check finishes; connecting remains explicit and secrets stay in the native vault.
  
  Expand terminal keys with Shift, Alt/AltGr, attachment, function/navigation/symbol keys, modifier locking and repeat. Preserve custom layouts and migrate the old default row. Make Compose and terminal-key visibility branded icon buttons and reduce terminal side padding.

### Patch Changes

- e92681c: Preserve the file-transfer closure warning and its partial-file guidance when uploads need reauthentication. Distinguish host-tools SSH closure so Agents only offers command recovery for the correct connection purpose; quota reads continue to classify a closed command connection as disconnected.
- Updated dependencies [9565f8a]
  - @lazysh/account-usage@1.3.0
  - @lazysh/common@1.3.0
  - @lazysh/display-idle@1.3.0
  - @lazysh/et-transport@1.3.0
  - @lazysh/mosh-transport@1.3.0

## 1.2.0

### Minor Changes

- 87aca79: Install or update the published host companion from the existing SSH connection, including when it is missing, with verified transfer, explicit progress and conservative uncertain outcomes. Prefer a valid managed Unix executable while preserving legacy PATH behavior when absent; installation and host permission changes remain explicit.

### Patch Changes

- @lazysh/common@1.2.0
  - @lazysh/display-idle@1.2.0
  - @lazysh/et-transport@1.2.0
  - @lazysh/mosh-transport@1.2.0

## 1.1.7

### Patch Changes

- b835cbd: Show live Herdr-reported Codex and other agent panes even when companion lifecycle reports are empty or unavailable, with explicit server selection and distinct live statuses.
- @lazysh/common@1.1.7
  - @lazysh/display-idle@1.1.7
  - @lazysh/et-transport@1.1.7
  - @lazysh/mosh-transport@1.1.7

## 1.1.6

### Patch Changes

- efa13fd: Enable terminal touch scrolling in Herdr and other full-screen apps, and give active phone terminals one compact header with secondary controls in More.
- @lazysh/common@1.1.6
  - @lazysh/display-idle@1.1.6
  - @lazysh/et-transport@1.1.6
  - @lazysh/mosh-transport@1.1.6

## 1.1.5

### Patch Changes

- Updated dependencies [3c1171d]
  - @lazysh/mosh-transport@1.1.5
  - @lazysh/common@1.1.5
  - @lazysh/display-idle@1.1.5
  - @lazysh/et-transport@1.1.5

## 1.1.4

### Patch Changes

- 9fd91c6: Use protected foreground Android clipboard reads for explicit terminal text paste and PNG/JPEG attachment preview, preserving literal paste and separate manual upload.
- @lazysh/common@1.1.4
  - @lazysh/display-idle@1.1.4
  - @lazysh/et-transport@1.1.4
  - @lazysh/mosh-transport@1.1.4

## 1.1.3

### Patch Changes

- 6e6c9cd: Fix mobile settings, checkbox and attachment layout and expose existing per-host multiplexer preferences.
- @lazysh/common@1.1.3
  - @lazysh/display-idle@1.1.3
  - @lazysh/et-transport@1.1.3
  - @lazysh/mosh-transport@1.1.3

## 1.1.2

### Patch Changes

- 8e3b293: Grant the local native app access to the existing upload recovery and host companion settings commands, preserving unlock, verified-host, authentication and settings revision guards. Other windows and remote pages remain denied.
- @lazysh/common@1.1.2
  - @lazysh/display-idle@1.1.2
  - @lazysh/et-transport@1.1.2
  - @lazysh/mosh-transport@1.1.2

## 1.1.1

### Patch Changes

- 81f0e63: Add bounded failure-only diagnostics for the already captured fresh-SSH tmux control client: fenced ancestry to the owned SSH daemon and closed descriptor-kind categories. Product behavior, acceptance predicates and retirement deadlines remain unchanged; the hosted teardown cause remains unproven until actual evidence is captured.
- cafea79: Retain bounded driver stage entry/exit progress on failed published Android APK qualification commands without changing public APK bytes, UI operations, deadlines or success requirements.
- 2739871: Observe the existing Windows concurrent Store initialization case with bounded, closed storage phases before the unchanged native host harness. Raw output is not published, the original failure remains primary, and storage behavior, write semantics and wait budgets remain unchanged pending actual phase evidence.
- @lazysh/common@1.1.1
  - @lazysh/display-idle@1.1.1
  - @lazysh/et-transport@1.1.1
  - @lazysh/mosh-transport@1.1.1

## 1.1.0

### Minor Changes

- 0ad69a5: Add explicit same-tab upload recovery for direct Mosh sessions using the original verified host and existing saved/manual SSH authentication. Preserve attachment drafts, terminal/output identity, access leases, exclusive creation and upload limits; never save credentials, start a new terminal or automatically retry an upload. Other SSH tools retain their original connection.

### Patch Changes

- b63304b: Style native file-picker buttons with the active lazysh theme and minimum 44px touch targets.
- @lazysh/common@1.1.0
  - @lazysh/display-idle@1.1.0
  - @lazysh/et-transport@1.1.0
  - @lazysh/mosh-transport@1.1.0

## 1.0.2

### Patch Changes

- 496025f: Prevent mobile session toolbar labels and icons from overlapping by keeping complete buttons in a horizontally scrollable row.
- ea2426d: Explain a positively closed SSH attachment-transfer connection instead of showing a generic channel-send error. Direct users to the existing verified saved-host connection flow while preserving a live Mosh tab, partial-file warnings, upload limits and exclusive file creation. Automatic in-place SSH reauthentication remains separate work.
- @lazysh/common@1.0.2
  - @lazysh/display-idle@1.0.2
  - @lazysh/et-transport@1.0.2
  - @lazysh/mosh-transport@1.0.2

## 1.0.1

### Patch Changes

- e1b0208: Require a published, verified GitHub version for every completed milestone, including internal milestones, and clarify version preparation versus publication.

  Remove unused desktop browser archive tooling before Android source scans, and allow an exact-source retry of unpublished 1.0.0 with every build, scan, artifact and tag check preserved.
- c02f548: Restore the owned tmux shutdown discriminator's receipt assertion so its stopped-client/resume proof runs to completion. Product retirement guards and deadlines remain unchanged; this does not resolve the separate hosted fresh-SSH teardown failure.
- @lazysh/common@1.0.1
  - @lazysh/display-idle@1.0.1
  - @lazysh/et-transport@1.0.1
  - @lazysh/mosh-transport@1.0.1

## 1.0.0

### Major Changes

- f5e61f1: Accept only lazysh theme share codes and raw JSON, and remove vendor-identifying repository references.

### Minor Changes

- 3651a8c: Add optional per-host default multiplexer and named-session SSH direct entry while preserving saved transport and explicit launch behavior.
- f5e61f1: Add a localized named/function-key picker to shared shortcut editors with independent drafts and existing validated bindings.
- 8fe533a: Add separate opt-in private Android UnifiedPush event notification display with confirmed device binding and durable bounded replay admission. Existing enrollment alone leaves display off.
- 726ace1: Add persistent connected-workspace sidebar navigation, suspended hidden agent owners and a guarded tmux picker that adopts each returned native snapshot.
- ac60385: Add client-side reported-agent search, status filters and selected-report context while preserving explicit host actions and reported-only identity semantics.
- 1de657d: Refresh reported agent activity every five seconds while its board is visible and the app is in the foreground, preserving manual refresh and existing host permissions.
- 49a2d4a: Support warm desktop directory launches with caller-relative paths and one-shot guarded admission.

### Patch Changes

- 7968d3d: Fit the Android WebView to system bars, display cutouts and docked keyboard insets so the terminal resizes and special keys stay visible.
- 0b9b2b9: Refresh the default app appearance with lazysh brand colors, restrained glass surfaces, and consistent controls while retaining saved and terminal theme choices.
- 9520102: Publish the current version explicitly and preserve future verified version releases without superseding older in-flight builds.
- f5e9d70: Enable verified Android, Linux and Windows GitHub releases after Changesets version merges; defer Apple and official F-Droid inclusion.
- 5f3857a: Prepare Android, Linux and Windows release artifacts while Apple releases are deferred.
- 3fbb8c7: Fail closed on unsupported tmux client/session loops before enabling navigation or guarded Chat input, and require exactly one matching original client per action. Older servers retain ordinary terminal access.
- 698ed5e: Show the canonical lazysh logo on the welcome screen instead of the placeholder terminal illustration.
- f5cdace: Require native Windows NSIS install, same-version repair with preserved owned data, and uninstall acceptance before staging release bytes.
- 196fc79: Fix Windows release packaging validation of native workspace path separators.
- @lazysh/common@1.0.0
  - @lazysh/display-idle@1.0.0
  - @lazysh/et-transport@1.0.0
  - @lazysh/mosh-transport@1.0.0

## 0.23.0

### Minor Changes

- 3dc44f4: Prepare verified cross-platform installer artifacts, release notes, checksums and installation guidance.

### Patch Changes

- @lazysh/common@0.23.0
  - @lazysh/display-idle@0.23.0
  - @lazysh/et-transport@0.23.0
  - @lazysh/mosh-transport@0.23.0

## 0.22.0

### Patch Changes

- @lazysh/common@0.22.0
  - @lazysh/display-idle@0.22.0
  - @lazysh/et-transport@0.22.0
  - @lazysh/mosh-transport@0.22.0

## 0.21.0

### Minor Changes

- a8c7fba: Add Zellij tab 1–20 quick access through existing typed native actions while preserving drafts and original session/access ownership.

### Patch Changes

- @lazysh/common@0.21.0
  - @lazysh/display-idle@0.21.0
  - @lazysh/et-transport@0.21.0
  - @lazysh/mosh-transport@0.21.0

## 0.20.0

### Minor Changes

- 5a4cef4: Add explicit pinned Noto Sans Mono CJK SC download into existing local font storage, with integrity checks, cancellation and a narrowly scoped asset CSP. No automatic download or font selection.

### Patch Changes

- @lazysh/common@0.20.0
  - @lazysh/display-idle@0.20.0
  - @lazysh/et-transport@0.20.0
  - @lazysh/mosh-transport@0.20.0

## 0.19.0

### Minor Changes

- 1b5a350: Add explicit editable comments to numbered before/after diff lines, preserving observed staged/unstaged and rename context until the user stages a prompt draft.
- 65a81e4: Add an explicit action to paste a completed uploaded path into its original terminal without Enter, preserving terminal bracketed-paste mode and the editable prompt.

### Patch Changes

- @lazysh/common@0.19.0
  - @lazysh/display-idle@0.19.0
  - @lazysh/et-transport@0.19.0
  - @lazysh/mosh-transport@0.19.0

## 0.18.0

### Minor Changes

- 75b5460: Add opt-in five-second listener refresh scoped to the visible Preview panel, preserving explicit HTTP checks and preview opening.

### Patch Changes

- @lazysh/common@0.18.0
  - @lazysh/display-idle@0.18.0
  - @lazysh/et-transport@0.18.0
  - @lazysh/mosh-transport@0.18.0

## 0.17.2

### Patch Changes

- b1b4f3b: Use the selected terminal font in repository side-by-side diffs without reloading the review or changing its contents.
- cc8d477: Refresh agent-board display metadata on native main-window focus without polling or retrying failed acquisition.
- @lazysh/common@0.17.2
  - @lazysh/display-idle@0.17.2
  - @lazysh/et-transport@0.17.2
  - @lazysh/mosh-transport@0.17.2

## 0.17.1

### Patch Changes

- cf917f9: Remove the twelve-entry shortcut and snippet cap, retain all valid saved entries, and keep snippet drafts when device storage refuses a save.
- @lazysh/common@0.17.1
  - @lazysh/display-idle@0.17.1
  - @lazysh/et-transport@0.17.1
  - @lazysh/mosh-transport@0.17.1

## 0.17.0

### Minor Changes

- 5a1d420: Show a bounded server-reported Next.js hint during explicit preview HTTP discovery without changing its default or waiting for additional headers.

### Patch Changes

- e6c0e65: Catalogue the static Next.js preview hint label without changing discovery or its displayed brand.
- @lazysh/common@0.17.0
  - @lazysh/display-idle@0.17.0
  - @lazysh/et-transport@0.17.0
  - @lazysh/mosh-transport@0.17.0

## 0.16.0

### Minor Changes

- 2f1963a: Introduce the original Bed Mode lazysh identity, a full transparent SVG brand kit, and matching web, Android, iOS, and desktop launcher assets.

### Patch Changes

- 07f0eba: Use the approved Bed Mode mark as the decorative sidebar symbol without duplicating the app name for assistive technology.
- @lazysh/common@0.16.0
  - @lazysh/display-idle@0.16.0
  - @lazysh/et-transport@0.16.0
  - @lazysh/mosh-transport@0.16.0

## 0.15.0

### Minor Changes

- 9c8d067: Add opt-in F-Droid UnifiedPush distributor registration with truthful registration-only status and local revocation. Incoming messages remain ignored until a separate authenticated delivery integration is verified.

### Patch Changes

- e234a24: Use the interface catalog for the Cloud speech-engine option prefix while preserving validated backend identifiers and locale-stable draft/metadata behavior.
- @lazysh/common@0.15.0
  - @lazysh/display-idle@0.15.0
  - @lazysh/et-transport@0.15.0
  - @lazysh/mosh-transport@0.15.0

## 0.14.0

### Minor Changes

- 59252bd: Add an optional operator-selected self-hosted whisper.cpp relay backend while preserving OpenAI defaults, device consent and bounded transcription admission.

### Patch Changes

- @lazysh/common@0.14.0
  - @lazysh/display-idle@0.14.0
  - @lazysh/et-transport@0.14.0
  - @lazysh/mosh-transport@0.14.0

## 0.13.0

### Minor Changes

- 1f890f6: Add an explicit F-Droid Android variant without Google remote push dependencies. Local inbox notifications remain available; normal Android Firebase and iOS APNs builds retain their behavior.

### Patch Changes

- @lazysh/common@0.13.0
  - @lazysh/display-idle@0.13.0
  - @lazysh/et-transport@0.13.0
  - @lazysh/mosh-transport@0.13.0

## 0.12.2

### Patch Changes

- 1da4cad: Add English Android listing descriptions with development-preview and host-dependency limits, without claiming F-Droid publication or changing application behavior.
- @lazysh/common@0.12.2
  - @lazysh/display-idle@0.12.2
  - @lazysh/et-transport@0.12.2
  - @lazysh/mosh-transport@0.12.2

## 0.12.1

### Patch Changes

- 04d4085: Expose synchronized Android version metadata and reject ambiguous or out-of-range release version codes.
- @lazysh/common@0.12.1
  - @lazysh/display-idle@0.12.1
  - @lazysh/et-transport@0.12.1
  - @lazysh/mosh-transport@0.12.1

## 0.12.0

### Minor Changes

- fb625df: Add opt-in syntax highlighting to Remote Files text previews while preserving exact plain text, keyboard scrolling and existing SFTP reads. Keep syntax nodes tied to the current source across refreshes.

### Patch Changes

- @lazysh/common@0.12.0
  - @lazysh/display-idle@0.12.0
  - @lazysh/et-transport@0.12.0
  - @lazysh/mosh-transport@0.12.0

## 0.11.0

### Minor Changes

- 87e923a: Compose review dictation with the latest editable draft without losing concurrent edits. Preserve bounded drafts, per-clip history and separate clip-only direct delivery.

### Patch Changes

- @lazysh/common@0.11.0
  - @lazysh/display-idle@0.11.0
  - @lazysh/et-transport@0.11.0
  - @lazysh/mosh-transport@0.11.0

## 0.10.1

### Patch Changes

- 3ec508c: Preserve explicit Pi tool-result error booleans in recorded chat and reuse the recorded-error badge without inferring live state or changing other adapters.
- @lazysh/common@0.10.1
  - @lazysh/display-idle@0.10.1
  - @lazysh/et-transport@0.10.1
  - @lazysh/mosh-transport@0.10.1

## 0.10.0

### Minor Changes

- 491a8b9: Add uploaded host-local attachment paths explicitly to an existing Chat draft without automatic send or clipboard effects.

### Patch Changes

- @lazysh/common@0.10.0
  - @lazysh/display-idle@0.10.0
  - @lazysh/et-transport@0.10.0
  - @lazysh/mosh-transport@0.10.0

## 0.9.1

### Patch Changes

- 1f4aa2b: Translate retained access-status and unlock failures when the interface language changes without repeating native access work or changing access policy.
- @lazysh/common@0.9.1
  - @lazysh/display-idle@0.9.1
  - @lazysh/et-transport@0.9.1
  - @lazysh/mosh-transport@0.9.1

## 0.9.0

### Minor Changes

- ee9c0a9: Add explicit confirmed Chat input for original guarded Herdr terminals with candidate cleanup, preserved transcript/session authority and manual fallback.

### Patch Changes

- @lazysh/common@0.9.0
  - @lazysh/display-idle@0.9.0
  - @lazysh/et-transport@0.9.0
  - @lazysh/mosh-transport@0.9.0

## 0.8.0

### Minor Changes

- 0a66ded: Add native guarded Herdr attachment and access-bound terminal input prerequisites without enabling frontend controls.

### Patch Changes

- @lazysh/common@0.8.0
  - @lazysh/display-idle@0.8.0
  - @lazysh/et-transport@0.8.0
  - @lazysh/mosh-transport@0.8.0

## 0.7.1

### Patch Changes

- a73287a: Defer iOS status review registration until native plugin initialization completes, preserving existing readiness and privacy behavior.
- @lazysh/common@0.7.1
  - @lazysh/display-idle@0.7.1
  - @lazysh/et-transport@0.7.1
  - @lazysh/mosh-transport@0.7.1

## 0.7.0

### Minor Changes

- f852631: Accept one explicit saved-host or multiplexer request in an already-running desktop app, preserving current dialogs, original access receipts and normal authentication.

### Patch Changes

- @lazysh/common@0.7.0
  - @lazysh/display-idle@0.7.0
  - @lazysh/et-transport@0.7.0
  - @lazysh/mosh-transport@0.7.0

## 0.6.0

### Minor Changes

- 5791a6e: Extend explicitly chosen and confirmed tmux terminal input to all 17 native Chat readers, with immutable Hermes/OpenCode session selectors and unchanged Stage defaults.

### Patch Changes

- @lazysh/common@0.6.0
  - @lazysh/display-idle@0.6.0
  - @lazysh/et-transport@0.6.0
  - @lazysh/mosh-transport@0.6.0

## 0.5.0

### Minor Changes

- 9b9a761: Support explicitly confirmed multiline Chat terminal input and tabs through bounded native tmux paste without newline normalization. Stage remains default; bracketed paste depends on the terminal program, and interrupted input is never automatically resent.

### Patch Changes

- @lazysh/common@0.5.0
  - @lazysh/display-idle@0.5.0
  - @lazysh/et-transport@0.5.0
  - @lazysh/mosh-transport@0.5.0

## 0.4.0

### Minor Changes

- 0232b02: Add explicit Claude Chat Send and Request stop for a confirmed existing tmux
  terminal. Stage remains the default, unsupported drafts keep the terminal
  fallback, and uncertain input is never resent automatically.

### Patch Changes

- @lazysh/common@0.4.0
  - @lazysh/display-idle@0.4.0
  - @lazysh/et-transport@0.4.0
  - @lazysh/mosh-transport@0.4.0

## 0.3.0

### Minor Changes

- c997e5f: Add explicitly opted-in Claude reported-history metadata and a selected-row shortcut into Chat. Source files remain unread until Open transcript; reported history does not verify a running agent or enable direct Send/Stop. Existing capture, image and Follow defaults remain off.

### Patch Changes

- @lazysh/common@0.3.0
  - @lazysh/display-idle@0.3.0
  - @lazysh/et-transport@0.3.0
  - @lazysh/mosh-transport@0.3.0

## 0.2.1

### Patch Changes

- 0e21551: Keep retained transcript validation and read alerts in the current interface language without repeating reads or altering raw host diagnostics.
- @lazysh/common@0.2.1
  - @lazysh/display-idle@0.2.1
  - @lazysh/et-transport@0.2.1
  - @lazysh/mosh-transport@0.2.1

## 0.2.0

### Minor Changes

- 65bb97a: Add explicit bounded previews for recorded Codex user PNG/JPEG data-URL images in Records. Image inclusion remains off by default; file references and unsupported media stay inert.

### Patch Changes

- 3be70f8: Resolve native application versions from the synchronized client manifest so Android and Apple generators receive the product version instead of their missing-version defaults. Application identifiers, stored data and protocol schemas are unchanged.
- 284538b: Keep recorded-usage validation messages in the selected language after a locale change, without repeating requests or altering raw host diagnostics.
- b2600f0: Keep retained transcript-discovery validation alerts in the current language without repeating discovery or changing raw host diagnostics.
- e7c2c75: Track product versions and generated package changelogs through reviewed release pull requests, keeping Bun, Cargo and Tauri versions aligned. This does not publish binaries or packages, create tags, or change application defaults.
- @lazysh/common@0.2.0
  - @lazysh/display-idle@0.2.0
  - @lazysh/et-transport@0.2.0
  - @lazysh/mosh-transport@0.2.0
