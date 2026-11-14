import {parseSnapshot} from './AgentPanel';
import {parseHerdrAgents} from './useHerdrNavigation';
import type {bindProtectedInvoke} from './access';
import type {ScreenSource} from './AgentPickerDock';

/** The followed Claude Code or Codex agent of a Herdr pane: the pane and terminal Herdr reports for this one conversation. */
export type HerdrAgentTarget = Readonly<{server: string; pane: string; terminal: string; agent: 'claude' | 'codex'; agentSessionId: string}>;
type Invoke = ReturnType<typeof bindProtectedInvoke>;

/** Reads the Herdr tree again: true only while exactly one live agent names this session, in this pane and terminal. */
export async function herdrStillRuns(invoke: Invoke, sessionId: string, target: HerdrAgentTarget): Promise<boolean> {
  try {
    const mine = parseHerdrAgents(await invoke('herdr_tree', {sessionId, name: target.server}))
      .filter(row => row.agent_session?.agent === target.agent && row.agent_session.value === target.agentSessionId);
    return mine.length === 1 && mine[0].agent === target.agent && mine[0].pane_id === target.pane && mine[0].terminal_id === target.terminal;
  } catch {return false;}
}

/** ... and the companion's report of that session still says it needs the user: the same evidence a tmux answer needs, with Herdr naming the pane. */
export async function herdrStillWaits(invoke: Invoke, sessionId: string, target: HerdrAgentTarget): Promise<boolean> {
  if (!await herdrStillRuns(invoke, sessionId, target)) return false;
  try {
    const rows = parseSnapshot(await invoke('agent_snapshot', {sessionId})).filter(row => row.sessionId === target.agentSessionId);
    return rows.length === 1 && rows[0].agent === 'Claude Code' && rows[0].state === 'needs_attention';
  } catch {return false;}
}

/** The visible rows of the followed agent's pane, as the host read them (`herdr_agent_screen`); anything else is no screen. */
export const screenRows = (value: unknown): readonly string[] => Array.isArray(value) && value.length <= 200 && value.every(row => typeof row === 'string' && row.length <= 400) ? value : [];

/** What the dialog card reads on a Herdr or Zellij pane, whose own terminal shows the multiplexer's screen rather than the agent's: the agent pane's visible rows, read from the
 * host every `interval` ms while something listens and whenever a caller asks (`readAgain`, before the card decides from the screen). A failed read is a blank screen. */
export function hostScreen(read: () => Promise<readonly string[]>, interval = 3000): ScreenSource & {readAgain: () => Promise<void>} {
  let lines: readonly string[] = [];
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined, flight: Promise<void> | undefined;
  const refresh = () => flight ??= read().catch(() => []).then(rows => {lines = rows; listeners.forEach(listener => listener());}).finally(() => {flight = undefined;});
  return {
    readRows: (first, count) => Array.from({length: count}, (_, row) => lines[first + row] ?? ''),
    viewport: () => ({top: 0, rows: lines.length, length: lines.length, following: true}),
    subscribe(listener) {
      const notify = () => listener({type: 'output'});
      listeners.add(notify);
      timer ??= setInterval(() => void refresh(), interval);
      void refresh();
      return {dispose() {listeners.delete(notify); if (!listeners.size) {clearInterval(timer); timer = undefined;}}};
    },
    readAgain: refresh,
  };
}
