# Confirmed terminal input

The native `tmux_chat` command adds an explicit terminal destination to a supported
recorded Chat view. It does not establish that the recorded file and a running agent
process are the same session. It never launches an agent or uses a provider API.
Without a verified display-owned tmux binding, ordinary terminal input and Stage
remain the fallback. Zellij and plain shells remain outside confirmed input. Guarded Herdr input is described below.

The destination comes from the retained control channel on the authenticated
terminal's immutable tmux server. It matches the original displayed client by
both PID and TTY, then its current session, window and pane. The user must confirm
that destination. A filename, pane ID or current-command label is not agent
identity. Read-only and independent `active-pane` clients are unsupported; tmux
3.4 formats can otherwise describe the window's active pane instead of the
independent client's pane.

## Native contract

`snapshot` returns the control generation and exact session/window/pane IDs,
alongside navigation's bounded human-readable session/window labels and a pane
index for confirmation. Labels and the connected host name help users choose;
they never replace internal identity checks. PID, TTY and lease internals do not
belong in the product confirmation.
`bind` requires that destination plus a bounded reader source context (literal
agent/path, Records/conversation view and image option). It replaces any prior receipt
with an ephemeral receipt owned by the original access lease. Nothing is saved
to configuration, restored, or automatically rebound.

The closed reader IDs are `claude`, `codex`, `pi`, `omp`, `hermes`, `opencode`,
`copilot`, `qoder-ide`, `kimi`, `jcode`, `droid`, `cursor`, `omo`, `devin-atif`,
`amp-json`, `grok-acp` and `antigravity-jsonl`. This includes explicitly selected
record/export formats; it does not make them verified live-process integrations.
Gemini/Qwen's hook-only tier and unknown IDs retain the TUI fallback.

Records are supported for every reader. Conversation is supported for Claude and
Grok; recorded images retain the existing Claude Records/conversation and
Grok/Codex Records limits. Other option combinations fail closed. Hermes and
OpenCode additionally require their exact database `transcriptSessionId`, bounded
to 256 UTF-8 bytes without control characters. Other readers must omit that field;
explicit null is rejected. The original Claude four-field IPC remains readable.
The literal selector is never trimmed, guessed or replaced on retry. Editing the
selector, including A→B→A in the same database, retires the old confirmation and
late result; choose and confirm again. Continuation reads retain matching
authority, while explicitly opening a source always requires new confirmation.

`input` supplies that same receipt/source and the exact next operation number.
One native input may be pending per binding. Duplicate or regressing operations,
changed source/target, dead panes, copy modes and synchronized panes cannot submit
keys. Navigation retires the receipt. Known local/negative-marker rejections
preserve navigation; interrupted writes, timeout, EOF and malformed framing retire
the retained actor instead of reconnecting to a possibly different server.

Send accepts nonempty text of at most 4,096 UTF-8 bytes, including LF and TAB.
CR, other C0 controls, DEL/C1, Unicode line/paragraph separators and malformed
Unicode are rejected. Accepted bytes are preserved without newline normalization.
Ordinary single-line text retains literal hexadecimal byte arguments followed
by one carriage-return Enter byte. Request stop still sends fixed Escape.
Unsupported and oversized drafts retain Stage.

Text containing LF or TAB instead uses native tmux `paste-buffer -p -r -d`,
followed by one fixed CR outside any paste brackets. `-r` preserves LF; this
differs intentionally from ordinary xterm paste's LF/CRLF-to-CR normalization.
`-p` brackets only when the terminal program enables bracketed paste. Otherwise
LF/TAB are ordinary terminal input and may cause intermediate actions. tmux 3.4
exposes no public format guard for that mode. This is not a guaranteed atomic
agent message or provider identity proof. The existing explicit destination
confirmation and visible explanation apply; Stage remains the default.

Every payload byte is encoded as fixed octal inside a quoted argument in one
generated ASCII control line, capped at 32 KiB before dispatch. The original
context guard precedes creation of a UUID named buffer, then runs again before
paste and before CR because buffer hooks can change context. A context change
after paste withholds CR and retires the actor as uncertain; it cannot recall
text already delivered. Before-paste context rejection deletes only the owned
buffer and delivers no text.

Named paste buffers are server-global, visible to other clients/hooks, and are
not private storage. No clipboard flag, files, buffer-content query or payload
logging is used. Normal paste deletes its buffer; bounded exact-name cleanup is
limited to a demonstrably synchronized original stream. A command error may skip
deletion, and cancellation/EOF/crash may leave a buffer. The actor still retires
on `%error` or uncertain framing instead of resynchronizing for cleanup. Buffer
freeing does not promise zeroization. The UI warns when delivery or cleanup is
unknown, retains the draft and never retries automatically. No stale warning is
published after source/access revocation; the static explanation also describes
possible residue after interruption.

An explicit input intent is frozen when native queue admission accepts it. A
later view/source close or queued `release` retires future authority but does not
withdraw that already-admitted operation. A cancelled admitted waiter that has
not started is discarded and its receipt retired. The actor checks the original
lease and target before dispatch; observed cancellation or loss of ownership
retires work rather than capturing a new proof. Once the SSH write begins,
delivery may be partial or complete and cannot be recalled. No failed or uncertain
operation is retried automatically. Frontend callers must retain the draft and
suppress stale result/error publication using their original source and lease.

The final tmux format guard independently derives the bound session's current
window/pane using a session loop. Its nested client loop matches the original
PID/TTY and that actual client's session. Client loops alone inherit the control
command's context and are insufficient. Labels stay dynamic format values, never
raw syntax. Command acknowledgement means tmux completed the input command; it
does not prove process receipt, provider acceptance, or that an agent stopped. A process can exit or change
after confirmation; this terminal contract cannot guarantee atomic consumption by
a particular process.

## Native acceptance

With local OpenSSH `sshd`, tmux 3.4+ and the project's native build prerequisites:

```sh
cargo test --locked -p lazysh --lib tmux_jump::chat::tests::
cargo test --locked -p lazysh --lib \
  ssh::tmux_jump_fixture::real_tmux_chat_original_display_namespace_bytes_and_retirement \
  -- --ignored --exact
cargo test --locked -p lazysh --lib \
  ssh::tmux_jump_fixture::multiline::real_tmux_multiline_modes_hooks_errors_and_lost_ack \
  -- --ignored --exact
```

The existing owned fixture uses temporary loopback SSH credentials and isolated
tmux namespaces. It exercises overlapping pane IDs, another displayed client,
literal UTF-8/Enter/Escape bytes, retained workload identity, duplicate operations,
source/lease/mode/synchronization/EOF retirement and controlled interleavings
after preflight and before dequeue. Each of the 17 closed reader contexts sends
literal text/Enter and Escape through that same retained client and workload;
changed database selectors are rejected. Its workload is synthetic `cat`, not
any of the 17 agent runtimes.
These checks are not automatically run merely because the ignored case exists.
Actual provider, native WebView, GUI and physical-device acceptance are separate.

The multiline fixture additionally captures exact LF/TAB and Unicode bytes with
paste mode enabled, disabled and changed at dispatch; it covers the full 4 KiB
boundary, leading-option and parser metacharacters, both hook-driven context
changes, pane exit, buffer error, original-lease revocation and a lost waiter.
It checks unrelated-buffer preservation and no replay. These remain owned
synthetic SSH/tmux tests, not a guarantee that a particular program consumes the
input or that a disconnected server cleans up a buffer.

Historical evidence for the original single-line slice in #256, released with
0.4.0: on owned Linux fixtures, its SSH/tmux case and five existing
retained-navigation cases passed after shared framing/fixture extraction. That
original native library regression passed 274 cases with 17 ignored, including the
nine tmux module cases. Restoring the earlier
inherited-context guard made the held-preflight move case fail; omitting queued
cancellation cleanup made the abandoned-receipt case fail. Restored production
code passed again. A native classifier counterexample also reproduced mixed
success-marker output being misclassified as safe rejection; only an exact
single-row rejection marker now permits that classification. Unknown/mixed
completion rows are protocol uncertainty and retire the actor. The fixture and
shared command/completion helpers remove actual scanner-reported clones.

The first SSH fixture attempts incorrectly omitted normal session adoption and
failed when lock correctly retired their unadopted sessions. Adopting the owned
sessions through the existing public API repaired the fixture; no production
behavior or timeout changed for that failure. These results establish synthetic
terminal delivery and ownership, not actual Claude/provider, Windows/macOS,
mobile WebView or physical-device acceptance.

Separate #253 multiline implementation checkpoint on owned Linux: the native
library suite passed 277 cases with 18 ignored. The 12-scenario multiline SSH
oracle and original single-line SSH oracle were each executed separately and
passed. Frontend checks passed 1,010 tests across 93 files, TypeScript and Vite;
six desktop/phone browser cases used a synthetic native bridge. These results
do not establish actual provider, packaged native WebView or physical-device
behavior, and do not guarantee cleanup after transport loss.

Primary contracts: [tmux 3.4 manual](https://github.com/tmux/tmux/blob/3.4/tmux.1),
[format contexts](https://github.com/tmux/tmux/blob/3.4/format.c),
[literal key injection](https://github.com/tmux/tmux/blob/3.4/cmd-send-keys.c),
[native paste](https://github.com/tmux/tmux/blob/3.4/cmd-paste-buffer.c),
[argument parsing](https://github.com/tmux/tmux/blob/3.4/cmd-parse.y), and
[Moshi Chat documentation](https://getmoshi.app/docs/chat-view). Moshi's published
behavior describes same-terminal prompts and an Escape stop request; it does not
provide an atomic foreground-process guarantee.

## Guarded Herdr Chat controls

An attached original guarded Herdr terminal can expose the same explicit Choose,
Confirm, Send and Request stop controls. Stage remains the default. Choosing checks
native availability and prepares the exact opened transcript source under the
original attached child SSH session and access lease. Stock or unsupported Herdr
keeps Stage and ordinary terminal use; the UI does not upgrade, attach or reconnect
automatically.

The confirmation displays public workspace, tab, pane and terminal identifiers
and viewport geometry. These labels do not establish agent or provider identity.
Confirmation reprepares and checks the same destination. Send preserves the same
4,096-byte UTF-8/LF/TAB boundary; Request stop queues Escape. Acknowledgements mean
queue admission, not execution, agent processing or that a process stopped. The
Herdr path does not use tmux server-global paste buffers.

An unconfirmed preparation candidate is already native-owned authority. Cancel,
Clear, source/selector/view/image changes, transcript refresh, session/backend
changes, access invalidation and unmount retire the matching local candidate or
receipt with the original session and lease. Late replies are discarded and their
known UUIDs are released best-effort. Revocation can prevent cleanup; no fresh
authority is acquired to retry it. Submitted native work can outlive the view.
Missing or malformed acknowledgements retain the draft, retire the confirmation
and require inspection of the terminal; nothing is automatically resent.

Frontend tests use synthetic native replies. They establish UI routing and lifecycle
behavior, separately from the native adapter's owned SSH/guarded-server acceptance.
They do not prove provider identity, physical-device behavior or atomic agent-message
processing.

## Packaged Android guarded Herdr acceptance

The native Android instrumentation contains a dedicated
`NativeWorkspaceTest#ownedGuardedHerdrChatThroughRealUi` case. Its Bun host fixture
uses the existing explicit owned-emulator/ADB reverse and ephemeral SSH trust
flow. It requires current-source `LAZYSH_TEST_HERDR`, `LAZYSH_TEST_AGENT_BIN`
and `LAZYSH_TEST_RECEIVER_BIN` executables plus `LAZYSH_ANDROID_UI_HERDR=1`; it never downloads or guesses a tool.
CI obtains Herdr from the same run's source-verified build and checks the separately
transmitted SHA256 before use, then builds the actual companion and Linux native Cargo receiver fixture from its checkout. The receiver uses native termios and bounded byte copying; no receiver shell script is installed.

The shipping WebView selects the owned Herdr session, reads a synthetic record
through the real companion/native SSH path, and explicitly chooses/confirms the
terminal before Send and Escape. Native clipboard input preserves a bounded
synthetic UTF-8/LF/TAB draft; it does not inject a native reply or receipt. The host
checks the raw receiver's exact text/CR/Escape bytes and original process start
identity. A source edit retires the controls, and returning to the source does not
restore a confirmation. Only this fixture's host, tabs, clipboard label, ADB
reverse, files and process trees are cleaned up.

Ordinary SSH fixture behavior and its existing deadlines remain unchanged. The
opt-in Herdr variant alone supports remote exec, with private HOME/XDG/tmux and
captured tool binaries; it never uses the operator's session catalogs or services.
This acceptance is not an agent/provider integration or physical-device proof.
Execution results must be recorded separately: preparing or compiling this case is
not a passing packaged-app acceptance receipt.
