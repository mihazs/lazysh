import {expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHeadlessCore} from './nativeCoreHeadless';

/**
 * The bytes the Rust core writes as the ANSI snapshot of a native session (`terminal_core_release`, #1342) are what
 * xterm.js replays when the session leaves the native engine. The fixture pins them (`tests/control.rs` in
 * `packages/terminal-runtime` checks the core writes exactly these and shows `expect` for both); headless xterm.js, the
 * parser the app ships, must show `expect` after the program and after the snapshot alone.
 */
const path = resolve(process.cwd(), '../../packages/terminal-runtime/fixtures/ansi-snapshot.json');
type Case = {id: string; cols: number; rows: number; scrollback: number; write: string; snapshot: string; expect: unknown};

it('shows the same screen, cursor and modes after replaying the core\'s snapshot as after the whole program', async () => {
  const {cases} = JSON.parse(readFileSync(path, 'utf8')) as {cases: Case[]};
  expect(cases.length).toBeGreaterThan(1);
  for (const c of cases) {
    const shown = async (bytes: string) => {
      const core = createHeadlessCore({columns: c.cols, rows: c.rows, scrollbackLines: c.scrollback, window: c.rows});
      const {state, window} = await core.feed!(new TextEncoder().encode(bytes));
      const from = state.viewport.top - window.first;
      return {cursor: state.cursor, modes: state.modes, lines: window.rows.slice(from, from + c.rows)};
    };
    expect(await shown(c.write), `${c.id} after the program`).toEqual(c.expect);
    expect(await shown(c.snapshot), `${c.id} after the snapshot`).toEqual(c.expect);
  }
});
