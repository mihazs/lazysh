// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {nativeCapabilities, openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {defaults, terminalPreferences} from './preferences';
import {runTerminalAdapterContract, type ContractHarness} from './terminalAdapter.contract';
import {passedCases, runTerminalCapabilityContract, untestedCapabilities} from './terminalCapabilityTests';
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
type LinksCase = {
  id: string; cols: number; rows: number; scrollback: number; write: string;
  urls?: {text: string; start: Cell; end: Cell}[];
  paths?: {text: string; path: string; start: Cell; end: Cell; line: number | null; column: number | null}[];
};
type ClipboardCase = {id: string; data: string; text: string | null; core?: {text: string | null}};
const cell = ([x, y]: Cell) => ({x, y});

describe.skipIf(!binary)('NativeTerminalAdapter over the real core', () => {
  const harness: ContractHarness = {
    create: async () => openNativeTerminalAdapter(await openStdioCore(binary!)),
    target: () => {
      const element = document.createElement('div');
      element.id = `real-core-anchor-${anchors++}`;
      document.body.append(element);
      return {kind: 'native', anchorId: element.id};
    },
  };
  const name = 'native (control plane over libghostty-vt)';
  runTerminalAdapterContract(name, harness);
  runTerminalCapabilityContract(name, harness);

  it('applies captured Mosh frame geometry while holding local resize requests as intents', async () => {
    const {frames} = JSON.parse(readFileSync(resolve('e2e/fixtures/mosh-resize-frames.json'), 'utf8')) as {
      frames: {cols: number; rows: number; bytesHex: string; expectedCursor: [number, number]; expectedLongRow: string}[];
    };
    const adapter = await harness.create();
    try {
      adapter.enableCanonicalResize!();
      for (const {cols, rows, bytesHex, expectedCursor: [x, y], expectedLongRow} of frames) {
        await adapter.write!(Buffer.from(bytesHex, 'hex'));
        expect(adapter.size()).toEqual({columns: cols, rows});
        expect(adapter.cursor()).toMatchObject({x, y});
        adapter.requestSize({columns: cols + 1, rows: rows + 1});
        expect(adapter.size()).toEqual({columns: cols, rows});
        expect(adapter.readRows!(adapter.viewport().top + 1, 1)[0]).toContain(expectedLongRow);
      }
    } finally { await adapter.dispose(); }
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
    } finally { await adapter.dispose(); }
  });

  it('selects the word of selection.json under a cell as the core answers it', async () => {
    for (const c of fixture<SelectionCase>('selection')) {
      const adapter = await openNativeTerminalAdapter(await openStdioCore(binary!, {columns: c.cols, rows: c.rows}));
      try {
        await adapter.write!(bytes(c.write));
        for (const w of c.words) {
          adapter.select(adapter.selectWordAt(cell(w.at)));
          await vi.waitFor(() => expect(adapter.selectionRange(), `${c.id}: word at ${w.at}`).toEqual({start: cell(w.range[0]), end: cell(w.range[1])}));
        }
      } finally { await adapter.dispose(); }
    }
  });

  it('says what a tap on the first and the last cell of every URL and host path of links.json opens, wrapped across rows or not', async () => {
    for (const c of fixture<LinksCase>('links')) {
      const adapter = await openNativeTerminalAdapter(await openStdioCore(binary!, {columns: c.cols, rows: c.rows, scrollbackLines: c.scrollback}));
      try {
        await adapter.write!(bytes(c.write));
        for (const link of c.urls ?? []) for (const [x, y] of [link.start, link.end]) expect(await adapter.linkAt({x, y}), `${c.id}: ${link.text} at ${x},${y}`).toEqual({kind: 'url', uri: link.text});
        for (const link of c.paths ?? []) for (const [x, y] of [link.start, link.end]) {
          expect(await adapter.linkAt({x, y}), `${c.id}: ${link.text} at ${x},${y}`)
            .toMatchObject({kind: 'path', text: link.text, path: link.path, ...(link.line === null ? {} : {line: link.line}), ...(link.column === null ? {} : {column: link.column})});
        }
      } finally { await adapter.dispose(); }
    }
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

  it('keeps the History lines the setting says in a session that is open: more rows after a raise, the oldest dropped at once after a cut', async () => {
    const core = await openStdioCore(binary!, {columns: 80, rows: 24, scrollbackLines: 100});
    const adapter = await openNativeTerminalAdapter(core);
    const rows = (from: number, count: number) => bytes(Array.from({length: count}, (_, i) => `${from + i}`.padStart(79, '0')).join('\r\n') + '\r\n');
    const withHistory = (scrollbackLines: number) => ({...terminalPreferences(defaults), scrollbackLines});
    const length = async () => (await core.snapshot()).state.viewport.length;
    try {
      await adapter.write!(rows(0, 12_000));
      const small = await length();
      expect(small, 'a budget of 100 lines keeps about as many rows as its bytes hold, not the 12,000 printed').toBeLessThan(6_000);

      adapter.applyPreferences(withHistory(5_000));
      await vi.waitFor(() => expect(adapter.metrics().scrollbackLines).toBe(5_000));
      await adapter.write!(rows(12_000, 12_000));
      const large = await length();
      expect(large, 'raised to 5,000 lines').toBeGreaterThanOrEqual(5_000 + 24);
      expect(large).toBeGreaterThan(small + 2_000);

      adapter.applyPreferences(withHistory(100));
      await vi.waitFor(async () => expect(await length()).toBeLessThan(small + 1));
      expect(await length(), 'cut to 100 lines, dropped at once').toBeGreaterThanOrEqual(100 + 24);
      expect(adapter.metrics().scrollbackLines).toBe(100);
      expect(adapter.readRows!(adapter.viewport().top + 22, 1)[0]).toContain('23999');
    } finally { await adapter.dispose(); }
  });

  it('sizes the real core to its pane: the grid the pane holds is the grid the core has, after each change of the pane or the font', async () => {
    const core = await openStdioCore(binary!);
    // The renderer's cell: 0.6 x 1.2 of the font size in device pixels.
    const adapter = await openNativeTerminalAdapter(core, {cell: async (fontSize, dpr) => ({width: Math.round(fontSize * 0.6 * dpr), height: Math.round(fontSize * 1.2 * dpr)})});
    const element = document.createElement('div');
    element.id = `real-core-pane-${anchors++}`;
    document.body.append(element);
    const pane = {width: 480, height: 240};
    element.getBoundingClientRect = () => ({...pane, x: 0, y: 0, left: 0, top: 0, right: pane.width, bottom: pane.height, toJSON: () => ({})});
    const coreGrid = (columns: number, rows: number) => vi.waitFor(async () => {
      const {state} = await core.snapshot();
      expect([state.columns, state.rows]).toEqual([columns, rows]);
    });
    try {
      await adapter.attach({kind: 'native', anchorId: element.id, surface: 'real-core-session'});
      adapter.applyPreferences({...terminalPreferences(defaults), fontSize: 10});
      await coreGrid(80, 20);
      expect(adapter.size()).toEqual({columns: 80, rows: 20});
      Object.assign(pane, {width: 245, height: 481});
      adapter.fit();
      await coreGrid(40, 40);
      expect(adapter.size()).toEqual({columns: 40, rows: 40});
      adapter.applyPreferences({...terminalPreferences(defaults), fontSize: 20});
      await coreGrid(20, 20);
      expect(adapter.size()).toEqual({columns: 20, rows: 20});
    } finally { await adapter.dispose(); }
  });

  it('has passed a case for each capability the adapter declares', ({task}) => {
    expect(untestedCapabilities(nativeCapabilities, passedCases(task.suite!))).toEqual([]);
  });
});
