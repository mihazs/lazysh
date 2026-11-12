/** A read-only lift of the list dialog Claude Code has open, from the rows of the terminal screen.
 *
 * Display only, and fail closed: a screen that is not one whole, simple list dialog (a second list, tabs, check boxes, a text
 * field, a footer this profile does not know, another agent's dialog) is `unliftable`, and the caller points to the terminal
 * instead of guessing. The shapes were captured from Claude Code 2.1.318 in a real tmux pane (`src/test/agentDialogs`). */
export type LiftedDialog = Readonly<{
  title: string;
  /** Text between the title and the options, such as the folder a trust prompt asks about. */
  body: readonly string[];
  options: readonly Readonly<{label: string; detail?: string}>[];
  /** The option the TUI highlights now. */
  highlighted: number;
  /** What the dialog says about its keys, the footer last. */
  hint: readonly string[];
  /** Same title, body, options and footer: the dialog a person saw is the dialog an answer is sent to. */
  signature: string;
}>;
/** `none`: no dialog footer on the screen. `unliftable`: a dialog is open that this profile cannot read exactly. */
export type Lift = Readonly<{kind: 'none' | 'unliftable'} | {kind: 'dialog'; dialog: LiftedDialog}>;
const none: Lift = {kind: 'none'}, unliftable: Lift = {kind: 'unliftable'};

/** The Claude Code 2.1.x profile is data: Esc leaves the dialog, and one of these footers says Enter takes the highlighted row. */
const escape = /\bEsc to (?:cancel|close|go back|dismiss)\b|\bctrl\+g to edit in\b/i;
const enterTakesRow = [/\bEnter to (?:select|confirm|continue|set as default)\b/, /\bType to search\b/, /\bctrl\+g to edit in\b/];
// These belong to a question dialog, which has its own card.
const questionRows = /Type something|Chat about this/;
const rule = /^─{20,}$/;
const marker = /^ {0,3}❯ \S/;
const numberedMark = /^ {0,3}❯ \d\. \S/;
const checkbox = /^(?:\[.?\]|[☐☑☒])/;
const limits = {options: 12, body: 12, hint: 4, text: 300};
const indent = (line: string) => line.length - line.trimStart().length;
const lastWhere = <T>(items: readonly T[], test: (item: T, index: number) => boolean) => { let index = items.length; while (--index >= 0 && !test(items[index], index)); return index; };
const clip = (text: string) => text.length > limits.text ? `${text.slice(0, limits.text - 1)}…` : text;

export function liftDialog(screen: readonly string[]): Lift {
  const lines = screen.map(line => line.trimEnd());
  // The row that tells how to leave is the last of the screen except for a status row a multiplexer draws below it (and a wrapped footer).
  const found = lastWhere(lines, line => escape.test(line));
  const esc = found >= 0 && lines.slice(found + 1).filter(Boolean).length <= 2 ? found : undefined;
  // A screen that ends in a numbered list with a highlighted row and has no footer is still a dialog (the page after a choice, such as
  // /rewind's confirmation): the terminal has it. A numbered prompt echoed in the history is followed by other output.
  const at = lastWhere(lines, line => numberedMark.test(line));
  const below = at < 0 ? [] : lines.slice(at + 1).filter(Boolean);
  if (esc === undefined) return at >= 0 && below.slice(0, -1).every(line => /^ {2,4}\d\. \S/.test(line)) && !rule.test(below.at(-1)?.trim() ?? '') ? unliftable : none;
  // The dialog opens under the nearest full-width rule that has a highlighted row below it, and that is its only rule.
  const rules = lines.map((line, index) => rule.test(line.trim()) && index < esc ? index : -1).filter(index => index >= 0);
  const marks = (from: number) => lines.map((line, index) => index > from && index < esc && marker.test(line) ? index : -1).filter(index => index >= 0);
  const top = rules[lastWhere(rules, index => marks(index).length > 0)] ?? -1, mark = marks(top)[0];
  if (top < 0 || marks(top).length !== 1 || rules.some(index => index > top)) return unliftable;
  const footer = lastWhere(lines, (line, index) => index < esc && !line) + 1;
  const labelColumn = indent(lines[mark]) + 2;
  // The option block: the highlighted row and the rows around it that sit under its label column; a blank row may separate items.
  const member = (index: number) => index > top && index < footer && !!lines[index].trim() && indent(lines[index]) >= labelColumn;
  let start = mark, end = mark;
  for (let index = mark - 1; index > top && (!lines[index] || member(index)); index--) if (member(index)) start = index;
  for (let index = mark + 1; index < footer && (!lines[index] || member(index)); index++) if (member(index)) end = index;
  const titleRow = lines.findIndex((line, index) => index > top && line);
  if (titleRow >= start) return unliftable;
  // The marker and a check mark each take two columns that the other rows leave blank.
  const block = lines.slice(start, end + 1).map((line, index) => (index + start === mark ? line.replace('❯', ' ') : line).replace(/^( *)✔ /, '$1  '));
  const column = Math.min(...block.filter(line => line.trim()).map(indent));
  const grouped = block.includes('');
  const items: {rows: string[]; marked: boolean}[] = [];
  let inside = false;
  for (const [index, line] of block.entries()) {
    const text = line.trim();
    if (!text) {inside = false; continue;}
    if (grouped ? !inside : indent(line) === column) items.push({rows: [text], marked: false});
    else if (items.length) items[items.length - 1].rows.push(text);
    else return unliftable;
    inside = true;
    if (index + start === mark) items[items.length - 1].marked = true;
  }
  // Another indented row apart from the block is part of a list this lift does not hold.
  if (lines.some((line, index) => index > titleRow && index < footer && (index < start || index > end) && line.trim() && indent(line) >= labelColumn)) return unliftable;
  const body = lines.slice(titleRow + 1, start).map(line => line.replace(/^[\s╭╰│]+|[\s╮╯│─]+$/g, '')).filter(Boolean);
  let highlighted = items.findIndex(item => item.marked);
  // A list that groups its items under a heading (one line, where every other item takes two or more) keeps the heading out of the options.
  if (grouped && items.length >= 3 && highlighted > 0 && items[0].rows.length === 1 && items.slice(1, -1).every(item => item.rows.length >= 2)) {
    body.push(items.shift()!.rows[0]);
    highlighted--;
  }
  const options = items.map(({rows}) => {
    const [label, ...columns] = grouped ? [rows[0]] : rows[0].split(/ {2,}/);
    const detail = [...columns, ...rows.slice(1)].join(' ');
    return {label: clip(label.replace(/^\d\.\s+/, '')), ...(detail ? {detail: clip(detail)} : {})};
  });
  const hint = lines.slice(footer, esc + 1).map(line => line.trim()).filter(Boolean);
  if (options.length < 2 || options.length > limits.options || options.some(option => checkbox.test(option.label)) || body.length > limits.body
    || hint.length > limits.hint || !enterTakesRow.some(pattern => pattern.test(hint.join(' '))) || questionRows.test(lines.slice(top, esc).join('\n'))) return unliftable;
  const title = clip(lines[titleRow].trim());
  return {kind: 'dialog', dialog: Object.freeze({title, body: body.map(clip), options: Object.freeze(options), highlighted, hint: hint.map(clip),
    signature: JSON.stringify([title, body, options.map(option => option.label), hint])})};
}
