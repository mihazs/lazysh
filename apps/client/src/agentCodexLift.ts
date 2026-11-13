import {indent, lastWhere, limits, liftedDialog, liftedOption, none, unliftable, type Lift} from './agentDialogLift';

/** The same read-only, fail-closed lift as `liftDialog`, for the list dialogs Codex draws: an approval, a `request_user_input` question,
 * /model, /permissions and the rate-limit reminder. Captured from Codex CLI 0.167.0 in a real 110x40 tmux pane (`src/test/agentDialogs/codex-*.txt`).
 * What it does not read (the /resume search screen, a list that has scrolled off its first option, a second highlight) is `none` or `unliftable`. */
// Their footers: "enter select · esc back", "Press enter to confirm or esc to cancel", "tab to add notes | enter to submit answer | esc to interrupt".
const enterTakesRow = /\benter (?:to )?(?:select|confirm|submit)\b/i, escLeaves = /\besc (?:to )?(?:cancel|back|interrupt)\b/i;
// Any footer that names Enter and Esc is a screen with keys of its own (the /resume search screen): this lift does not read it, and says so.
const keyFooter = /\benter\b.*\besc\b/i;
// "› 1. Yes, proceed (y)": the highlighted row, or the same two columns blank, then the digit the TUI also takes as the answer.
const optionRow = /^( *)(› )?(\d{1,2})\. (\S.*)$/;
// A row of Codex's own history (a message, a result, a notice, the time a turn took), which is not part of the dialog under it.
const history = /^\s*(?:[•✗■⚠✔└›]|Worked for )/;

export function liftCodexDialog(screen: readonly string[]): Lift {
  const lines = screen.map(line => line.trimEnd());
  const footer = lastWhere(lines, line => keyFooter.test(line));
  // The footer is the last row of the dialog, except for a status row a multiplexer draws below it (and a wrapped footer).
  if (footer < 0 || lines.slice(footer + 1).filter(Boolean).length > 2) return none;
  if (!enterTakesRow.test(lines[footer]) || !escLeaves.test(lines[footer])) return unliftable;
  const end = lastWhere(lines, (line, index) => index < footer && !!line);
  if (end < 0) return unliftable;
  let top = end;
  while (top > 0 && lines[top - 1]) top--;
  const items: {number: number; column: number; marked: boolean; rows: string[]}[] = [];
  for (const line of lines.slice(top, end + 1)) {
    const found = optionRow.exec(line);
    if (found) items.push({number: Number(found[3]), column: found[1].length + (found[2] ? 2 : 0), marked: !!found[2], rows: [found[4]]});
    // A wrapped description sits under the label of the option above it.
    else if (items.length && indent(line) >= items.at(-1)!.column + 3) items.at(-1)!.rows.push(line.trim());
    else return unliftable;
  }
  if (items.length < 2 || items.length > limits.options || items.filter(item => item.marked).length !== 1 || new Set(items.map(item => item.column)).size !== 1
    || items.some((item, index) => item.number !== index + 1)) return unliftable;
  // The title and the lines that explain the choice sit above the options, back to the history or to a gap of two blank rows above the first of them.
  let from = top, found = false;
  while (from > 0 && !history.test(lines[from - 1])) {
    if (lines[from - 1]) found = true;
    else if (found && !lines[from - 2]) break;
    from--;
  }
  const [title, ...body] = lines.slice(from, top).map(line => line.trim()).filter(Boolean);
  if (!title || body.length > limits.body) return unliftable;
  return liftedDialog(title, body, items.map(({rows}) => liftedOption(rows)), items.findIndex(item => item.marked), [lines[footer].trim()]);
}
