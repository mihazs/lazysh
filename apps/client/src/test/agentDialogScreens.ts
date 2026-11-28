import {readFileSync} from 'node:fs';
import type {ScreenSource} from '../AgentPickerDock';
/** Screens captured from Claude Code 2.1.318 in a real 100x40 tmux pane, as the rows tmux drew (`src/test/agentDialogs/*.txt`). */
export const dialogScreen = (name: string) => readFileSync(`src/test/agentDialogs/${name}.txt`, 'utf8').split('\n');
/** What tmux draws for a pane that fills a 100x40 window: the program's rows from the top, then the status row at the bottom. */
export const onTmux = (rows: string[]) => [...rows, ...Array(39 - rows.length).fill(''), ' [work] 0:node*                                     "host" 12:34 12-Nov-26'];
/** The /model picker with the highlight on option `to` (1 to 5), as the TUI redraws it after an arrow key. */
export const modelScreen = (to: number) => onTmux(dialogScreen('model')).map(row => row.replace(/^ {2}❯ (\d)\./, '    $1.').replace(new RegExp(`^ {4}${to}\\.`), `  ❯ ${to}.`));
/** How many times `block` is on `screen` as one run of rows, compared without trailing blanks: what the host asks of a pane before it presses a key. */
export const runsOn = (screen: readonly string[], block: readonly string[]) => {
  const rows = screen.map(row => row.trimEnd());
  return rows.filter((_, start) => block.length > 0 && block.every((row, offset) => rows[start + offset] === row.trimEnd())).length;
};
/** A terminal whose screen a test controls; `set` redraws it like the agent's output would. */
export function fakeTerminal(initial: string[]) {
  let rows = initial;
  const listeners = new Set<() => void>();
  const terminal: ScreenSource = {readRows: (first, count) => Array.from({length: count}, (_, row) => rows[first + row] ?? ''), viewport: () => ({top: 0, rows: 40, length: 40, following: true}),
    subscribe: listener => {const notify = () => listener({type: 'output'}); listeners.add(notify); return {dispose: () => {listeners.delete(notify);}};}};
  return {terminal, set: (next: string[], notify = true) => {rows = next; if (notify) listeners.forEach(listener => listener());}};
}
/** An input as the keys it presses: a `pick` or `dismiss` without the dialog rows it was read from. */
export const withoutSeen = (input: object) => {const {seen, ...key} = input as {seen?: unknown}; return key;};
/** Codex 0.172.0's `/model` list: ten rows, a window of eight in view from row `first` with the highlight on row `at`, a `↑` or `↓` row where rows are hidden, and no number
 * after the ninth. The last window is the real screen (`codex-0.172.0-model-scrolled`); the others move over the same rows (the lift test checks the two agree). */
const codexModelRows = (() => {
  const recorded = dialogScreen('codex-0.172.0-model-scrolled');
  return ['  1. GPT-6.2-Sol (current)  Fast, go-to model for coding and everyday work.', '  2. GPT-6.2-Astra          Our most capable model for complex coding and professional work.',
    ...recorded.slice(4, 12).map(row => row.replace(/^›/, ' '))];
})();
export const codexModelWindow = (first: number, at: number) => ['', '  Select Model and Effort', '', first > 1 ? '↑' : '',
  ...codexModelRows.slice(first - 1, first + 7).map((row, index) => first + index === at ? `›${row.slice(1)}` : row),
  first + 7 < codexModelRows.length ? '↓' : '', '  enter select · esc back'];
