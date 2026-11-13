import {readFileSync} from 'node:fs';
import type {ScreenSource} from '../AgentPickerDock';
/** Screens captured from Claude Code 2.1.318 in a real 100x40 tmux pane, and `codex-*` ones from Codex CLI 0.167.0 (110x40, `codex-model-narrow` 45 wide), as the rows tmux drew (`src/test/agentDialogs/*.txt`). */
export const dialogScreen = (name: string) => readFileSync(`src/test/agentDialogs/${name}.txt`, 'utf8').split('\n');
/** What tmux draws for a pane that fills a 100x40 window: the program's rows from the top, then the status row at the bottom. */
export const onTmux = (rows: string[]) => [...rows, ...Array(39 - rows.length).fill(''), ' [work] 0:node*                                     "host" 12:34 12-Nov-26'];
/** The /model picker with the highlight on option `to` (1 to 5), as the TUI redraws it after an arrow key. */
export const modelScreen = (to: number) => onTmux(dialogScreen('model')).map(row => row.replace(/^ {2}❯ (\d)\./, '    $1.').replace(new RegExp(`^ {4}${to}\\.`), `  ❯ ${to}.`));
/** A terminal whose screen a test controls; `set` redraws it like the agent's output would. */
export function fakeTerminal(initial: string[]) {
  let rows = initial;
  const listeners = new Set<() => void>();
  const terminal: ScreenSource = {rows: 40, buffer: {active: {baseY: 0, getLine: y => ({translateToString: () => rows[y] ?? ''})}},
    onWriteParsed: listener => {listeners.add(listener); return {dispose: () => {listeners.delete(listener);}};}};
  return {terminal, set: (next: string[], notify = true) => {rows = next; if (notify) listeners.forEach(listener => listener());}};
}
