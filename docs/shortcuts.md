# Terminal shortcuts

Custom keyboard chords and text snippets have no purchased slots or fixed entry-count
cap. Valid entries beyond twelve survive save and reload. Individual name/text/binding
validation still applies; device storage can refuse a save, which leaves the saved
collection and draft unchanged. Settings sync retains its 128 KiB preferences-envelope
limit and can reject a large collection without truncating it. These resource boundaries
mean this is not a promise of infinite storage or identical capacity on every device.

Open Preferences → Keyboard chords to add a named shortcut to the terminal
toolbar. Advanced binding remains the default builder. Existing saved shortcuts
and gesture bindings keep their original strings and behavior; switching builders
does not rewrite them. Nothing is sent while building or saving a shortcut. Press
its toolbar button explicitly to send it to the active terminal.

Under Terminal touch gestures, choose Custom key chord for a body gesture,
two-finger swipe or D-pad corner. The same Advanced / Simple custom-text / Named key builder
is available for each slot. Press that slot's **Save … chord** button to save;
Advanced edits now also require Save instead of saving when the field loses
focus. Changing builders does not convert or save the existing binding. Each
slot keeps separate Advanced, Simple and Named key drafts and modifier choices
while its editor is open; drafts are not persisted across reload or leaving the
custom action. When a slot's saved binding changes, including after saving or a
settings import/sync, its editor returns to Advanced showing the saved string and
discards that slot's old drafts. Other slots' drafts remain untouched. Only
performing the configured gesture or pressing its D-pad corner sends input to a
connected terminal.

Choose **Named or function key** to select Enter, Tab, Escape, Backspace, Space, an arrow,
Home/End, Insert/Delete, PageUp/PageDown, or F1–F12. Optional Control, Option/Alt
and Shift modifiers use the same validated Advanced grammar. Saving stores one
ordinary key binding; it does not send input. Named-key and Simple-text modifier
choices are independent, and switching builders preserves their drafts. The
editor labels follow the interface language while stored key names stay stable.
Advanced remains the default. A multi-step sequence still uses Advanced.

Choose Simple custom text for the bounded text-and-modifiers builder. With no
modifiers, text is literal: Unicode, commas, and leading/trailing spaces survive
save and reload. `Enter` means the five letters, not the Enter key. Plain text
does not interpret doubled commas. With Control, Option/Alt or Shift selected,
single commas separate groups; doubled commas insert a literal comma. The
modifiers apply to the first character of each group; remaining characters retain
their original case and are sent literally.

| Input | Modifiers | Result |
| --- | --- | --- |
| `b1` | Control | Ctrl+B, then `1` |
| `a,b` | Control | Ctrl+A, then Ctrl+B |
| `a,,b` | Control | Ctrl+A, then literal `,b` |
| ` b ` | Control | Ctrl+Space, then literal `b ` |
| `你好,, world ` | None | Exactly that text, including both commas and final space |

The compiler stores the same `{label, keys}` record already used by Advanced,
encoding plain text as `text:…` and modified characters as ordinary advanced
steps. It validates the generated binding with the existing parser. No settings
schema, sync protocol or native IPC change is needed. Literal Advanced `text:`
bindings now also retain trailing spaces when saved.

The existing binding limit is 128 UTF-16 code units. The `text:` prefix leaves
123 for literal input; an emoji outside the basic multilingual plane counts as
two. Modified input must be printable ASCII, with nonempty comma-separated groups,
at most eight resulting character steps, and at most 128 units in both source
and generated binding. Control characters, malformed Unicode, unsupported
modifier/key combinations, empty groups, oversized input and modified Unicode
are rejected with an error. No input is trimmed or silently truncated. A literal
comma at a group's start still needs a supported modifier combination: Alt+comma
works, while Ctrl+comma is rejected by the existing grammar.

This implements the documented reference client simple custom-text rules (source URL omitted)
within lazysh's current bounds. That source describes the simple modifier and
comma behavior under “Key sequences (simple builder)”; its named-key table is
under Advanced bindings. Arbitrary Unicode tails after modified keys remain
unsupported. Use Advanced for multi-step named/function-key sequences or
modifiers that differ between steps.

Advanced chords and modified Simple shortcuts now preserve their compiled key
boundaries through the native input queue. Once an item reaches its transport
driver, the first step dispatches immediately;
subsequent steps wait at least 50 ms after the preceding step finishes its native
dispatch. This conservative fixed interval is lazysh's choice: the reference client documents a
small delay but does not publish a numeric value. It is not a guarantee about
packet spacing or remote execution time. There is no trailing delay. Literal
`text:` bindings remain one write, including Unicode, commas and trailing spaces.

Toolbar chords, custom gestures/D-pad bindings and tmux/Herdr prefix shortcuts
all use this path. Multiplexer prefixes must be one parsed key, such as Ctrl+b or
F12; comma-separated multi-step and `text:` literal prefixes are rejected. An
entire sequence consumes one existing
queue slot; later terminal input and resizes wait until it completes or is
discarded. Frontend grammar limits stay unchanged. Native requests allow at most
eight nonempty steps and 64 KiB total, preserving the existing input byte budget.
No new native command or persisted settings version is introduced.

Every step uses the request's original access lease. Locking, renderer replacement
or terminal disconnection discards unsent steps; unlocking never resumes an old
chord. ET additionally discards unsent remainders and queued timed chords when it
observes connection loss, without treating ordinary reconnect-status updates as
another loss. Ordinary one-write input keeps its existing ET behavior. Already
dispatched data cannot be recalled and ET may replay it during recovery. SSH
output and Mosh polling continue between steps; local PTY pacing runs in its
input worker. An RPC success acknowledges queue admission, not remote execution.
Late acknowledgements cannot update or redispatch from an old shortcut view
after its original access generation has changed.

Vitest verifies compilation, rejection boundaries, persisted text and panel
behavior. Playwright desktop and phone profiles verify actual builder controls,
reload, exact stored per-slot bindings, and terminal-toolbar/D-pad/body-gesture
IPC payloads and exact step arrays against a synthetic local-terminal bridge. Body gestures use
synthetic browser pointer events; no real shell or native OS keyboard is used.
Physical touch, IME and hardware keyboard behavior are separate acceptance gates.

Native Cargo tests use paused time for step boundaries and ET loss handling,
real SSH with a frozen input window for revocation/output progress, an owned PTY
for queue ordering, and explicit OpenSSH/Mosh/ET protocol interoperability fixtures.
These checks do not establish physical mobile timing parity.
