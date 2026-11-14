import {expect, it} from 'vitest';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {TerminalScrollAction} from '../terminalAdapter';
import {createHeadlessCore} from './nativeCoreHeadless';

/**
 * The fixture the Rust core replays (`packages/terminal-runtime/tests/control.rs`) and the Tauri commands serialize to
 * (`terminal_core.rs`): bytes, scrolls, and the control-plane answer headless xterm.js gives after each. `UPDATE_CONTROL_PLANE=1` rewrites it.
 */
const path = resolve(process.cwd(), '../../packages/terminal-runtime/fixtures/control-plane.json');
type Case = {id: string; cols: number; rows: number; scrollback: number; window: number; write: string; steps: TerminalScrollAction[]; snapshots?: unknown[]};

it('records what the stand-in core answers for every case the Rust core must match (UPDATE_CONTROL_PLANE=1 rewrites them)', async () => {
  const data = JSON.parse(readFileSync(path, 'utf8')) as {cases: Case[]};
  for (const c of data.cases) {
    const core = createHeadlessCore({columns: c.cols, rows: c.rows, scrollbackLines: c.scrollback, window: c.window});
    // The wire answer has no history setting: the bridge adds the one the session was opened with.
    const answer = ({state: {scrollbackLines: _, ...state}, window}: Awaited<ReturnType<typeof core.snapshot>>) => ({state, window});
    const seen = [answer(await core.feed!(new TextEncoder().encode(c.write)))];
    for (const step of c.steps) seen.push(answer(await core.scroll(step)));
    if (process.env.UPDATE_CONTROL_PLANE) c.snapshots = seen;
    expect(seen, c.id).toEqual(c.snapshots);
    expect(seen.length, c.id).toBe(c.steps.length + 1);
  }
  if (process.env.UPDATE_CONTROL_PLANE) writeFileSync(path, JSON.stringify(data, null, 1) + '\n');
});
