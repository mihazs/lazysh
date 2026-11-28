import {clip, limits, none, unliftable, type Lift} from './agentDialogLift';

/** A read-only lift of the list dialog Codex has open, from the rows of the terminal screen (the Codex profile of `liftDialog`).
 *
 * Codex draws its dialogs inline at the bottom of the screen: a title, the text that explains it, numbered options with `›` before the
 * highlighted one, and a footer. The shapes were captured from Codex 0.167.0 in a real tmux pane (`src/test/agentDialogs/codex-*.txt`).
 * Fail closed like the Claude profile: a footer that was not captured, a list that does not number 1, 2, 3… or has not exactly one
 * highlighted row is `unliftable`, and the caller points to the terminal.
 *
 * A `request_user_input` question is the same list with its own footer: a `Question 1/2` row, the question, the options with `›` two columns
 * in, and `tab to add notes | enter to submit answer | esc to interrupt`. Enter submits the highlighted option and goes on to the next question;
 * Esc interrupts the turn instead of closing the dialog, so the card offers no Cancel. The notes box (Tab) is a text field and stays in the terminal. */
/** Each captured footer says Enter takes the highlighted row and Esc leaves; another footer (a question with notes, a full-screen table) is not read. */
const footers = [/^ {2}enter select · esc back$/, /^ {2}enter default · s session · esc back$/, /^ {2}Press enter to confirm or esc to cancel$/];
/** Any row that offers Enter and Esc, so that a dialog this profile does not know shows the banner instead of nothing. */
export const keyRow = /^ {1,2}(?:Press )?enter\b.*\besc\b/i;
const numbered = /^( {0,2})([› ]) (\d{1,2})\. (\S.*)$/;
/** Codex 0.172 numbers only the first nine rows of a long list and leaves the number of the others blank (`›     GPT-5.6-Luna`). */
const option = /^( {0,2})([› ]) (?:(\d{1,2})\. | {4})(\S.*)$/;
/** The rows Codex draws above and below a window of a list that has more rows. */
const hiddenAbove = /^↑$/, hiddenBelow = /^↓$/;
/** The footers of a question, whole or wrapped over rows by a narrow terminal (which drops the bar where it breaks), compared without their spaces and bars. `notes` is the open notes box. */
const squash = (text: string) => text.replace(/[\s|]+/g, '');
const questionFooters = ['answer', 'all'].flatMap(submit => ['', ' | ←/→ to navigate questions'].map(navigate => squash(`tab to add notes | enter to submit ${submit}${navigate} | esc to interrupt`)));
const notesFooter = /^ {2}tab or esc to clear notes\b/;
const questionStart = /^ {2}tab to add notes\b/;
const progress = /^Question \d+\/\d+ \(\d+ unanswered\)$/;
const rowsBelowFooter = 2;
/** Codex's approval options that add a rule ("Yes, and don't ask again for commands that start with …"). */
const remembers = /\bdon't ask again\b/i;

export function liftCodexDialog(screen: readonly string[]): Lift {
  const lines = screen.map(line => line.trimEnd());
  const text = lines.flatMap((line, index) => line ? [index] : []);
  // A question's footer is spelled out from its first row to the row that completes it (a narrow terminal wraps it); a multiplexer's status row may follow.
  const asked = text.slice(-1 - 2 * rowsBelowFooter).find(index => notesFooter.test(lines[index]) || questionStart.test(lines[index]));
  let footer = asked, last = asked, question = false;
  if (asked !== undefined) {
    if (notesFooter.test(lines[asked])) return unliftable;
    let spelled = '', complete: number | undefined;
    for (const index of text.filter(row => row >= asked)) {
      spelled += squash(lines[index]);
      if (questionFooters.includes(spelled)) {complete = index; break;}
    }
    if (complete === undefined || text.filter(row => row > complete).length > rowsBelowFooter) return unliftable;
    question = true;
    last = complete;
  } else {
    // The footer is the last row of the screen except for a status row a multiplexer draws below it.
    footer = text.slice(-1 - rowsBelowFooter).find(index => keyRow.test(lines[index]));
    if (footer === undefined) return none;
    if (!footers.some(pattern => pattern.test(lines[footer!]))) return unliftable;
    last = footer;
  }
  // The options end above the footer and a blank row, and run up as numbered rows with deeper-indented continuations.
  let end = footer! - 1;
  while (end >= 0 && !lines[end]) end--;
  // A list with more rows than its window shows has a `↓` row under the window.
  const below = hiddenBelow.test(lines[end]?.trim() ?? '');
  if (below) end--;
  // Rows without a number are read only in a list whose ninth row is numbered, so a wrapped description is never taken for one.
  let block = end;
  while (block >= 0 && lines[block]) block--;
  const longList = lines.slice(block + 1, end + 1).some(row => /^ {0,2}[› ] 9\. \S/.test(row));
  const items: {number: number; marked: boolean; margin: number; labelRow: string; wrapped: string[]}[] = [];
  let top = end, wrapped: string[] = [];
  for (; top >= 0 && lines[top]; top--) {
    const found = (longList ? option : numbered).exec(lines[top]);
    if (found) {items.unshift({number: found[3] ? Number(found[3]) : 0, marked: found[2] === '›', margin: found[1].length, labelRow: lines[top], wrapped}); wrapped = [];}
    else if (/^ {4,}\S/.test(lines[top])) wrapped.unshift(lines[top]);
    else break;
  }
  // `top` is now the row above the block; a description row left over has no option above it.
  if (wrapped.length) return unliftable;
  // ... or the `↑` row of a window that is scrolled down: its first row is not the first of the list.
  const above = hiddenAbove.test(lines[top]?.trim() ?? '');
  if (above) top--;
  // A row without a number follows the row before it.
  for (const [index, item] of items.entries()) if (!item.number) item.number = index > 0 ? items[index - 1].number + 1 : 0;
  const base = items[0]?.number;
  const sequence = items.length > 0 && items.every((item, index) => item.number === base + index && item.margin === items[0].margin) && (base === 1) === !above && base > 0;
  if (!sequence || items.length < 2 || items.length > limits.options || items.filter(item => item.marked).length !== 1) return unliftable;
  // Above the options: the explaining text in paragraphs a blank row apart, up to the first gap of two blank rows (the history is above it).
  const about: string[] = [];
  let first = top, start = top;
  while (first >= 0 && !lines[first]) first--;
  if (top - first > 2) return unliftable;
  let gap = 0;
  for (let index = first; index >= 0 && gap < 2; index--) {
    if (lines[index]) {about.unshift(lines[index].trim()); gap = 0; start = index;} else gap++;
    if (about.length > limits.body + 1) return unliftable;
  }
  const [head, ...rest] = about;
  if (!head) return unliftable;
  // A question's first row counts its place among the questions; the question itself is the title.
  if (question && (!progress.test(head) || !rest.length)) return unliftable;
  const [title, ...body] = question ? [rest.join(' '), head] : about;
  const options = items.map(({labelRow, wrapped: more}) => {
    const prefix = labelRow.length - labelRow.replace(option, '$4').length;
    const [label, ...columns] = labelRow.slice(prefix).split(/ {2,}/);
    // Where the description starts: a wrapped row that starts left of it continues the label (a narrow terminal wraps both columns).
    const gapAt = / {2,}(?=\S)/.exec(labelRow.slice(prefix)), detailAt = gapAt ? prefix + gapAt.index + gapAt[0].length : undefined;
    let name = label;
    const detail = [...columns];
    for (const row of more) {
      const [piece, ...tail] = row.trim().split(/ {2,}/);
      if (detailAt !== undefined && row.length - row.trimStart().length < detailAt) {name += ` ${piece}`; detail.push(...tail);}
      else detail.push(row.trim().replace(/ {2,}/g, ' '));
    }
    const note = detail.join(' ');
    return {label: clip(name), ...(note ? {detail: clip(note)} : {}), ...(remembers.test(name) ? {remember: true as const} : {})};
  });
  const hint = question ? [] : [lines[footer!].trim()];
  return {kind: 'dialog', dialog: Object.freeze({title: clip(title), body: body.map(clip), options: Object.freeze(options), highlighted: items.findIndex(item => item.marked), hint,
    ...(question ? {interrupts: true as const} : {}), ...(above || below ? {more: true as const} : {}), signature: JSON.stringify([title, body, options, hint, question]), rows: Object.freeze(lines.slice(start, last! + 1))})};
}
