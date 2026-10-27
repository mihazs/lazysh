# Confirmed terminal input

The native `tmux_chat` command adds an explicit terminal destination to a Claude
recorded view. It does not establish that the recorded file and a running Claude
process are the same session. It never launches an agent or uses a provider API.
Without a verified display-owned tmux binding, ordinary terminal input and Stage
remain the fallback. Herdr, Zellij and plain shells are outside this first slice.

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
`bind` requires that destination plus a bounded Claude source context (literal
path, Records/conversation view and image option). It replaces any prior receipt
with an ephemeral receipt owned by the original access lease. Nothing is saved
to configuration, restored, or automatically rebound.

`input` supplies that same receipt/source and the exact next operation number.
One native input may be pending per binding. Duplicate or regressing operations,
changed source/target, dead panes, copy modes and synchronized panes cannot submit
keys. Navigation retires the receipt. Known local/negative-marker rejections
preserve navigation; interrupted writes, timeout, EOF and malformed framing retire
the retained actor instead of reconnecting to a possibly different server.

Send accepts a nonempty single line of at most 4,096 UTF-8 bytes. C0/C1 controls,
Unicode line/paragraph separators and malformed Unicode are rejected. Text is
encoded into literal hex byte arguments, followed by one carriage-return Enter
byte. Request stop sends the fixed Escape key. Multiline, control-character and
oversized drafts retain Stage; richer paste support is tracked in [#253](https://github.com/mihazs/lazysh/issues/253).

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
```

The existing owned fixture uses temporary loopback SSH credentials and isolated
tmux namespaces. It exercises overlapping pane IDs, another displayed client,
literal UTF-8/Enter/Escape bytes, retained workload identity, duplicate operations,
source/lease/mode/synchronization/EOF retirement and controlled interleavings
after preflight and before dequeue. Its workload is synthetic `cat`, not Claude.
These checks are not automatically run merely because the ignored case exists.
Actual provider, native WebView, GUI and physical-device acceptance are separate.

Executed on owned Linux fixtures: the new SSH/tmux case and five existing
retained-navigation cases passed after shared framing/fixture extraction. The
final native library regression passed 274 cases with 17 ignored, including the
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

Primary contracts: [tmux 3.4 manual](https://github.com/tmux/tmux/blob/3.4/tmux.1),
[format contexts](https://github.com/tmux/tmux/blob/3.4/format.c),
[literal key injection](https://github.com/tmux/tmux/blob/3.4/cmd-send-keys.c), and
[Moshi Chat documentation](https://getmoshi.app/docs/chat-view). Moshi's published
behavior describes same-terminal prompts and an Escape stop request; it does not
provide an atomic foreground-process guarantee.
