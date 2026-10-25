# Terminal shortcuts

Open Preferences → Keyboard chords to add a named shortcut to the terminal
toolbar. Advanced binding remains the default builder. Existing saved shortcuts
and gesture bindings keep their original strings and behavior; switching builders
does not rewrite them. Nothing is sent while building or saving a shortcut. Press
its toolbar button explicitly to send it to the active terminal.

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

This implements the documented [Moshi simple custom-text rules](https://getmoshi.app/docs/keyboard)
within lazysh's current bounds. That source describes the simple modifier and
comma behavior under “Key sequences (simple builder)”; its named-key table is
under Advanced bindings. Simple named/function-key pickers and arbitrary Unicode
tails after modified keys are not implemented. Use Advanced for named keys,
function keys or modifiers that differ between steps. The current sender writes
the compiled bytes together; documented per-step advanced-binding delays and
Simple builders inside gesture/D-pad editors remain separate parity work.

Vitest verifies compilation, rejection boundaries, persisted text and panel
behavior. Playwright desktop and phone profiles verify actual builder controls,
reload and exact terminal-toolbar IPC payloads against a synthetic local-terminal
bridge; no real shell or native OS keyboard is used. Physical IME and hardware
keyboard behavior are separate acceptance gates.
