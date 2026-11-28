import {escape} from './agentDialogLift';
import {keyRow} from './agentDialogLiftCodex';

/** The rows of the dialog an agent has open that no profile can read exactly (tabs, a search box, a full-screen table, a footer it does not know), as the
 * terminal draws them, to show read-only above the way to the terminal. Display only: nothing is inferred from them and nothing is sent. From the dialog's
 * frame (a row of `─` or `▔`, which Claude Code draws above it) or, for Codex, from the rows above its footer up to a gap of two blank rows (a full-screen table, from its first row), down to its footer;
 * empty when no footer is on the screen, so a working agent's status row or a screen of output is never shown as a dialog. */
const frame = /^(?:[─▔]{20,}|.*\S ▔)$/;
const optionRow = /^ {0,2}[› ] (?:\d{1,2}\. | {4})\S/;
export const copyLimits = {rows: 40, text: 200};

export function dialogCopy(agent: string, screen: readonly string[]): string {
  const lines = screen.map(line => line.trimEnd());
  const claude = agent !== 'Codex';
  const isFooter = (line: string) => claude ? escape.test(line) : keyRow.test(line);
  // A footer wrapped at the pane width (`... Esc to` / `cancel`) is one footer, which ends on the row that completes it.
  const wraps = (index: number) => claude && !isFooter(lines[index]) && isFooter(`${lines[index]} ${lines[index + 1]?.trim() ?? ''}`);
  let footer = lines.length;
  while (--footer >= 0 && !isFooter(lines[footer]) && !wraps(footer));
  if (footer >= 0 && wraps(footer)) footer++;
  // The footer is the last row of the screen except for a status row a multiplexer draws below it (and the keys row Codex's tables add); the copy ends at it.
  if (footer < 0 || lines.slice(footer + 1).filter(Boolean).length > 2) return '';
  // A full-screen table of Codex (`/resume`) has a rule just above its footer and starts at the first row of the screen.
  const table = !claude && lines.slice(Math.max(0, footer - 3), footer).some(line => /^─{20,}/.test(line));
  let top = table ? lines.findIndex(Boolean) : footer, crossed = false;
  for (let index = footer - 1; !table && index >= 0 && footer - index <= copyLimits.rows; index--) {
    if (claude) {
      if (frame.test(lines[index].trim())) {top = index + 1; break;}
      top = index;
    } else if (lines[index]) top = index;
    // Codex draws no frame: the dialog ends at a gap of two blank rows, which the options of a list cross once to reach their title.
    else if (!lines[index - 1] && lines[index - 1] !== undefined) {
      if (crossed || !optionRow.test(lines[top])) break;
      crossed = true;
    }
  }
  if (claude && (top === footer || !frame.test(lines[top - 1]?.trim() ?? ''))) return '';
  const rows = lines.slice(top, footer + 1).slice(0, copyLimits.rows);
  const indent = Math.min(...rows.filter(Boolean).map(line => line.length - line.trimStart().length));
  return rows.map(line => line.slice(indent, indent + copyLimits.text)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
