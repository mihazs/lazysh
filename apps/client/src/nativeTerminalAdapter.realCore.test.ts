// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {nativeCapabilities, openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {runTerminalAdapterContract} from './terminalAdapter.contract';
import {passedCases, untestedCapabilities} from './terminalCapabilityTests';
import {openStdioCore} from './test/stdioNativeCore';

// The harness is built from the runtime crate with Zig (`cargo build --example control_stdio`), which only the herdr-native
// CI job has: it sets this variable, and every other run skips the file.
const binary = process.env.LAZYSH_CONTROL_STDIO;
let anchors = 0;
const bytes = (value: string) => new TextEncoder().encode(value);
/** The cases xterm.js and the code lazysh uses today recorded (`packages/terminal-runtime/fixtures/<name>.json`). */
const fixture = <Case>(name: string) => (JSON.parse(readFileSync(resolve(process.cwd(), `../../packages/terminal-runtime/fixtures/${name}.json`), 'utf8')) as {cases: Case[]}).cases;
type Cell = [number, number];
type SelectionCase = {
  id: string; cols: number; rows: number; write: string; all: string; screen: string;
  selections: {start: Cell; end: Cell; text: string}[];
  words: {at: Cell; range: [Cell, Cell]}[];
  searches: {query: string; direction: 1 | -1; from: number | null; hit: {row: number; column: number; length: number} | null}[];
};
type ClipboardCase = {id: string; data: string; text: string | null; core?: {text: string | null}};
const cell = ([x, y]: Cell) => ({x, y});

describe.skipIf(!binary)('NativeTerminalAdapter over the real core', () => {
  runTerminalAdapterContract('native (control plane over libghostty-vt)', {
    create: async () => openNativeTerminalAdapter(await openStdioCore(binary!)),
    target: () => {
      const element = document.createElement('div');
      element.id = `real-core-anchor-${anchors++}`;
      document.body.append(element);
      return {kind: 'native', anchorId: element.id};
    },
  });

  it('answers the selection, word, search, select-all and copy-screen questions of selection.json as xterm.js does', async () => {
    for (const c of fixture<SelectionCase>('selection')) {
      const core = await openStdioCore(binary!, {columns: c.cols, rows: c.rows});
      try {
        await core.feed!(bytes(c.write));
        const ask = core.query!.bind(core);
        for (const s of c.selections) expect(await ask({kind: 'selectionText', range: {start: cell(s.start), end: cell(s.end)}}), `${c.id}: ${JSON.stringify(s)}`).toBe(s.text);
        for (const w of c.words) expect(await ask({kind: 'wordAt', cell: cell(w.at)}), `${c.id}: word at ${w.at}`).toEqual({start: cell(w.range[0]), end: cell(w.range[1])});
        for (const q of c.searches) {
          const hit = await ask({kind: 'search', query: q.query, direction: q.direction > 0 ? 'forward' : 'backward', from: q.from ?? undefined});
          expect(hit, `${c.id}: ${JSON.stringify(q)}`).toEqual(q.hit);
        }
        const all = await ask({kind: 'bufferRange'});
        expect(await ask({kind: 'selectionText', range: all!}), `${c.id}: select all`).toBe(c.all);
        expect(await ask({kind: 'copyScreen'}), `${c.id}: copy screen`).toBe(c.screen);
      } finally { await core.close(); }
    }
  });

  it('gives the adapter the core\'s text where the window of rows has none: a wrapped line, rows far above, a match in history', async () => {
    const adapter = await openNativeTerminalAdapter(await openStdioCore(binary!));
    try {
      // 20 columns: the second line wraps once. 400 lines push the first ones out of the 256-row window.
      await adapter.write!(bytes(`needle at the top\r\n${'w'.repeat(30)}\r\n${Array.from({length: 400}, (_, i) => `n${i}`).join('\r\n')}`));
      expect(adapter.search('needle', 1)).toBeUndefined();
      expect(await adapter.searchBuffer!('NEEDLE', 1)).toEqual({row: 0, column: 0, length: 17});
      expect(await adapter.searchBuffer!('absent', -1)).toBeUndefined();
      adapter.select({start: {x: 7, y: 0}, end: {x: 19, y: 2}});
      expect(adapter.selectedText()).toBe('\n\n');
      await vi.waitFor(() => expect(adapter.selectedText()).toBe(`at the top\n${'w'.repeat(30)}`));
      adapter.selectAll();
      await vi.waitFor(() => expect(adapter.selectedText().split('\n')).toHaveLength(402));
      // Row 0 is outside the window, so the adapter's own guess is one cell; the core knows the word.
      adapter.select(adapter.selectWordAt({x: 3, y: 0}));
      await vi.waitFor(() => expect(adapter.selectedText()).toBe('needle'));
    } finally { await adapter.dispose(); }
  });

  it('offers the OSC 52 writes of osc52.json to the consent flow as the core\'s policy decides, and no other', async () => {
    const adapter = await openNativeTerminalAdapter(await openStdioCore(binary!));
    const offered: string[] = [];
    adapter.subscribe(event => { if (event.type === 'clipboard') offered.push(event.text); });
    try {
      for (const c of fixture<ClipboardCase>('osc52')) {
        offered.length = 0;
        await adapter.write!(bytes(`\x1b]52;${c.data}\x07`));
        const text = c.core ? c.core.text : c.text;
        expect(offered, c.id).toEqual(text === null ? [] : [text]);
      }
    } finally { await adapter.dispose(); }
  });

  it('has passed a case for each capability the adapter declares', ({task}) => {
    expect(untestedCapabilities(nativeCapabilities, passedCases(task.suite!))).toEqual([]);
  });
});
