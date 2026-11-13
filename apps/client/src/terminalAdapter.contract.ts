import {afterEach, describe, expect, it} from 'vitest';
import fixture from '../e2e/fixtures/mosh-resize-frames.json';
import type {TerminalAdapter, TerminalEvent, TerminalMountTarget} from './terminalAdapter';

type Frame = {cols: number; rows: number; bytesHex: string; expectedVisibleRows: number; expectedCursor: number[]; expectedLongRow: string};
const frames: Frame[] = fixture.frames;
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, part => Number.parseInt(part, 16));
const text = (value: string) => new TextEncoder().encode(value);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type ContractHarness = {
  /** A new adapter, 20 columns by 5 rows, scrollback of at least 200 lines, not yet attached. */
  create(): TerminalAdapter | Promise<TerminalAdapter>;
  /** A mount target the backend accepts. */
  target(): TerminalMountTarget;
};

/**
 * Behaviour every terminal backend must show. A capability a backend claims is
 * tested; a capability it does not claim must be absent, never faked.
 * Run it from the backend's own test file, in an environment that can host it.
 */
export function runTerminalAdapterContract(name: string, harness: ContractHarness) {
  describe(`TerminalAdapter contract: ${name}`, () => {
    const made: TerminalAdapter[] = [];
    afterEach(async () => { await Promise.all(made.splice(0).map(adapter => adapter.dispose())); });
    async function open() {
      const adapter = await harness.create();
      made.push(adapter);
      await adapter.attach(harness.target());
      const events: TerminalEvent[] = [];
      adapter.subscribe(event => events.push(event));
      const write = (data: string | Uint8Array) => adapter.write!(typeof data === 'string' ? text(data) : data);
      const screen = (rows = 5) => adapter.readRows!(adapter.viewport().top, rows);
      return {adapter, events, write, screen};
    }

    it('claims only what it provides', async () => {
      const {adapter} = await open();
      const {capabilities: c} = adapter;
      expect(typeof adapter.readRows === 'function').toBe(c.screenInspection);
      expect(typeof adapter.observeInput === 'function').toBe(c.ime);
      expect(typeof adapter.enableCanonicalResize === 'function').toBe(c.canonicalMoshResize);
      expect(typeof adapter.write === 'function').toBe(adapter.dataPath === 'renderer');
      expect(['native', 'xterm']).toContain(adapter.backend);
    });

    it('applies bytes in order, split anywhere, and acknowledges only after applying them', async () => {
      const {write, screen} = await open();
      const all = text('one\r\n世界 two\r\n\x1b[31mred\x1b[0m\r\n');
      // Every split point, including the middle of a UTF-8 sequence, in one ordered stream.
      const done = Array.from(all, (_, i) => i).map(i => write(all.slice(i, i + 1)));
      await Promise.all(done);
      expect(screen().slice(0, 3)).toEqual(['one', '世界 two', 'red']);
      await write('x');
      expect(screen()[3]).toBe('x');
    });

    it('runs the applied callback synchronously, in write order, before the promise settles', async () => {
      const {adapter} = await open();
      const seen: string[] = [];
      const first = adapter.write!(text('a'), () => seen.push('a-applied')).then(() => seen.push('a-resolved'));
      const second = adapter.write!(text('b'), () => seen.push('b-applied')).then(() => seen.push('b-resolved'));
      await Promise.all([first, second]);
      expect(seen.indexOf('a-applied')).toBeLessThan(seen.indexOf('b-applied'));
      expect(seen.indexOf('a-applied')).toBeLessThan(seen.indexOf('a-resolved'));
      expect(seen.indexOf('b-applied')).toBeLessThan(seen.indexOf('b-resolved'));
    });

    it('never reorders a write behind a later one', async () => {
      const {adapter, write} = await open();
      const order: number[] = [];
      await Promise.all([1, 2, 3, 4].map(n => write(`line${n}\r\n`).then(() => { order.push(n); })));
      expect(order).toEqual([1, 2, 3, 4]);
      expect(adapter.readRows!(0, 4)).toEqual(['line1', 'line2', 'line3', 'line4']);
    });

    it('reports modes from the stream', async () => {
      const {adapter, write} = await open();
      expect(adapter.modes()).toEqual({bracketedPaste: false, mouseTracking: 'none', alternateScreen: false, applicationCursorKeys: false});
      await write('\x1b[?2004h\x1b[?1000h\x1b[?1h');
      expect(adapter.modes()).toMatchObject({bracketedPaste: true, mouseTracking: 'vt200', applicationCursorKeys: true});
      await write('\x1b[?1049h');
      expect(adapter.modes().alternateScreen).toBe(true);
      await write('\x1b[?1049l\x1b[?2004l\x1b[?1000l');
      expect(adapter.modes()).toMatchObject({bracketedPaste: false, mouseTracking: 'none', alternateScreen: false});
    });

    it('scrolls through history and follows live output again', async () => {
      const {adapter, write} = await open();
      await write(Array.from({length: 40}, (_, i) => `row ${i}`).join('\r\n'));
      expect(adapter.viewport()).toMatchObject({rows: 5, following: true});
      expect(adapter.viewport().length).toBeGreaterThanOrEqual(40);
      adapter.scroll({kind: 'toTop'});
      expect(adapter.viewport()).toMatchObject({top: 0, following: false});
      adapter.scroll({kind: 'lines', delta: 3});
      expect(adapter.viewport().top).toBe(3);
      adapter.scroll({kind: 'pages', delta: 1});
      // A page is a backend's own notion (xterm keeps one row of context): between one row and a screen.
      expect(adapter.viewport().top).toBeGreaterThan(4);
      expect(adapter.viewport().top).toBeLessThanOrEqual(8);
      adapter.scroll({kind: 'toRow', row: 10});
      expect(adapter.viewport().top).toBe(10);
      adapter.scroll({kind: 'toBottom'});
      expect(adapter.viewport().following).toBe(true);
    });

    it('selects by absolute inclusive coordinates, wide characters included, and reports the change', async () => {
      const {adapter, events, write} = await open();
      await write('hello 世界 end\r\n');
      adapter.select({start: {x: 6, y: 0}, end: {x: 9, y: 0}});
      expect(adapter.getSelection()).toEqual({range: {start: {x: 6, y: 0}, end: {x: 9, y: 0}}, text: '世界'});
      expect(adapter.selectWordAt({x: 7, y: 0})).toEqual({start: {x: 6, y: 0}, end: {x: 9, y: 0}});
      expect(adapter.selectWordAt({x: 5, y: 0})).toEqual({start: {x: 5, y: 0}, end: {x: 5, y: 0}});
      await sleep(0);
      expect(events.some(event => event.type === 'selection' && event.range?.start.x === 6 && event.range.end.x === 9)).toBe(true);
      adapter.clearSelection();
      expect(adapter.getSelection()).toBeUndefined();
      adapter.selectAll();
      expect(adapter.getSelection()?.text).toContain('hello 世界 end');
    });

    it('answers selection questions without building text, and clears on request', async () => {
      const {adapter, events, write} = await open();
      await write('hello 世界 end\r\n');
      expect(adapter.hasSelection()).toBe(false);
      expect(adapter.selectionRange()).toBeUndefined();
      expect(adapter.selectedText()).toBe('');
      adapter.select({start: {x: 6, y: 0}, end: {x: 9, y: 0}});
      expect(adapter.hasSelection()).toBe(true);
      expect(adapter.selectionRange()).toEqual({start: {x: 6, y: 0}, end: {x: 9, y: 0}});
      expect(adapter.selectedText()).toBe('世界');
      events.length = 0;
      adapter.clearSelection();
      await sleep(0);
      expect(adapter.hasSelection()).toBe(false);
      expect(events).toContainEqual({type: 'selection', range: undefined});
    });

    it('selects across rows by absolute coordinates, ending on the last column', async () => {
      const {adapter, write} = await open();
      await write('aaaaaaaaaaaaaaaaaaaa\r\nbbbbbbbbbbbbbbbbbbbb\r\ncc\r\n');
      // 20 columns: the end cell is the last column of row 1, not the first of row 2.
      adapter.select({start: {x: 5, y: 0}, end: {x: 19, y: 1}});
      expect(adapter.selectionRange()).toEqual({start: {x: 5, y: 0}, end: {x: 19, y: 1}});
      expect(adapter.selectedText()).toBe(`${'a'.repeat(15)}\n${'b'.repeat(20)}`);
    });

    it('reports where the screen is drawn, the cursor and the configured scrollback', async () => {
      const adapter = await harness.create();
      made.push(adapter);
      expect(adapter.screenBounds()).toBeUndefined();
      await adapter.attach(harness.target());
      expect(adapter.screenBounds()).toEqual({left: expect.any(Number), top: expect.any(Number), width: expect.any(Number), height: expect.any(Number)});
      await adapter.write!(text('ab\r\ncd'));
      expect(adapter.cursor()).toEqual({x: 2, y: 1});
      expect(adapter.metrics().scrollbackLines).toBeGreaterThanOrEqual(200);
      expect(adapter.size()).toEqual({columns: 20, rows: 5});
    });

    it('delivers only the event types a subscriber asked for', async () => {
      const {adapter, write} = await open();
      const seen: string[] = [];
      adapter.subscribe(event => seen.push(event.type), ['output']);
      await write('x\r\n');
      adapter.requestSize({columns: 25, rows: 6});
      expect(new Set(seen)).toEqual(new Set(['output']));
    });

    it('announces each applied write as output', async () => {
      const {events, write} = await open();
      events.length = 0;
      await write('x');
      expect(events.filter(event => event.type === 'output')).toHaveLength(1);
    });

    it('knows when the primary screen shows live output', async () => {
      const {adapter, write} = await open();
      expect(adapter.atLiveScreen()).toBe(true);
      await write(Array.from({length: 40}, (_, i) => `row ${i}`).join('\r\n'));
      expect(adapter.atLiveScreen()).toBe(true);
      adapter.scroll({kind: 'toTop'});
      expect(adapter.atLiveScreen()).toBe(false);
      adapter.scroll({kind: 'toBottom'});
      await write('\x1b[?1049h');
      expect(adapter.atLiveScreen()).toBe(false);
    });

    it('returns a reader of history to the live screen when typed input would', async () => {
      const {adapter, write} = await open();
      await write(Array.from({length: 40}, (_, i) => `row ${i}`).join('\r\n'));
      adapter.scroll({kind: 'toTop'});
      expect(adapter.viewport().following).toBe(false);
      adapter.followLive();
      expect(adapter.viewport().following).toBe(true);
    });

    it('searches the whole buffer, wrapping, in both directions', async () => {
      const {adapter, write} = await open();
      await write(Array.from({length: 30}, (_, i) => i === 4 || i === 20 ? `needle ${i}` : `hay ${i}`).join('\r\n'));
      expect(adapter.search('NEEDLE', 1)?.row).toBe(4);
      expect(adapter.search('needle', 1, 4)?.row).toBe(20);
      expect(adapter.search('needle', 1, 20)?.row).toBe(4);
      expect(adapter.search('needle', -1, 4)?.row).toBe(20);
      expect(adapter.search('absent', 1)).toBeUndefined();
      expect(adapter.search('', 1)).toBeUndefined();
    });

    it('keeps its state when the view is detached and attached again', async () => {
      const {adapter, write, screen} = await open();
      await write('kept\r\n');
      await adapter.detach();
      await write('while hidden\r\n');
      await adapter.attach(harness.target());
      expect(screen().slice(0, 2)).toEqual(['kept', 'while hidden']);
    });

    it('survives rapid active switching without losing or duplicating bytes', async () => {
      const {adapter, write, screen} = await open();
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) { adapter.setActive(i % 2 === 0); writes.push(write(`n${i}\r\n`)); }
      adapter.setActive(true);
      await Promise.all(writes);
      expect(adapter.readRows!(0, 20)).toEqual(Array.from({length: 20}, (_, i) => `n${i}`));
      expect(screen().length).toBe(5);
    });

    it('treats a size request as intent and a Mosh frame as the geometry authority', async () => {
      const {adapter, events, write} = await open();
      adapter.requestSize({columns: 30, rows: 8});
      expect(adapter.metrics()).toMatchObject({columns: 30, rows: 8});
      expect(events).toContainEqual({type: 'geometry', size: {columns: 30, rows: 8}, authority: 'local'});
      expect(events).toContainEqual({type: 'resizeIntent', size: {columns: 30, rows: 8}});
      if (!adapter.capabilities.canonicalMoshResize) return;
      events.length = 0;
      const canonical = adapter.enableCanonicalResize!();
      adapter.requestSize({columns: 25, rows: 9});
      expect(adapter.metrics()).toMatchObject({columns: 30, rows: 8});
      expect(events).toEqual([{type: 'resizeIntent', size: {columns: 25, rows: 9}}]);
      for (const frame of frames) {
        events.length = 0;
        await write(bytes(frame.bytesHex));
        expect(adapter.metrics()).toMatchObject({columns: frame.cols, rows: frame.rows});
        expect(events).toContainEqual({type: 'geometry', size: {columns: frame.cols, rows: frame.rows}, authority: 'transport'});
        expect(adapter.viewport().top).toBe(0);
        expect(adapter.readRows!(1, 1)[0]).toBe(frame.expectedLongRow);
      }
      expect(canonical.failure).toBeNull();
    });

    it('reports a malformed Mosh frame as a failure, not as terminal output', async () => {
      const {adapter, events, write} = await open();
      if (!adapter.capabilities.canonicalMoshResize) return;
      adapter.enableCanonicalResize!();
      await write('\x1b]7777;lazysh-mosh;1;begin;7;10;4\x1b\\\x1b]7777;lazysh-mosh;1;end;9\x1b\\');
      expect(events).toContainEqual({type: 'failure', reason: 'invalid-frame'});
    });

    it('separates typed input, terminal replies and bracketed paste', async () => {
      const {adapter, write} = await open();
      if (!adapter.capabilities.ime) return;
      const received: [string, boolean][] = [];
      const observer = adapter.observeInput!((data, user) => received.push([data, user]));
      expect(observer.available).toBe(true);
      adapter.sendInput('a', 'keyboard');
      adapter.sendInput('\x1b[0n', 'terminal-reply');
      adapter.paste('plain');
      await write('\x1b[?2004h');
      adapter.paste('wrapped');
      observer.dispose();
      adapter.sendInput('ignored', 'keyboard');
      expect(received.map(([data]) => data)).toEqual(['a', '\x1b[0n', 'plain', '\x1b[200~wrapped\x1b[201~']);
      expect(received.slice(0, 2).map(([, user]) => user)).toEqual([true, false]);
    });

    it('disposes idempotently, rejects bytes it never applied and releases subscribers', async () => {
      const {adapter, events} = await open();
      const late = adapter.write!(text('late'));
      const first = adapter.dispose();
      const second = adapter.dispose();
      expect(second).toBe(first);
      await first;
      await late.catch(() => {});
      const seen = events.length;
      const after = adapter.subscribe(() => events.push({type: 'bell'}));
      after.dispose();
      expect(events.length).toBe(seen);
      await expect(adapter.attach(harness.target())).rejects.toThrow();
      await expect(adapter.write!(text('x'))).rejects.toThrow();
    });
  });
}
