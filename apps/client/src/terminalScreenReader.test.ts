// @vitest-environment jsdom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {stubMatchMedia} from './test/stubMatchMedia';
import type {TerminalAdapter, TerminalEvent} from './terminalAdapter';
import {createXtermTerminalAdapter, xtermCapabilities} from './xtermTerminalAdapter';
import {mountScreenReaderMirror, needsScreenReaderMirror, newScreenLines} from './terminalScreenReader';

beforeAll(stubMatchMedia);

describe('newScreenLines', () => {
  it('speaks nothing for the first screen, an identical screen or blank rows', () => {
    expect(newScreenLines([], ['a', 'b'])).toEqual([]);
    expect(newScreenLines(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(newScreenLines(['a', 'b', 'c'], ['a', '', 'c'])).toEqual([]);
  });

  it('speaks the lines that scrolled in and not the ones that merely moved up', () => {
    expect(newScreenLines(['one', 'two', 'three', '$'], ['two', 'three', 'out', '$ ls'])).toEqual(['out', '$ ls']);
  });

  it('speaks only what was appended to a single edited row, or the row when it was rewritten', () => {
    expect(newScreenLines(['ok', '$'], ['ok', '$ ls'])).toEqual(['ls']);
    expect(newScreenLines(['ok', '⠋ build'], ['ok', '⠙ build'])).toEqual(['⠙ build']);
    expect(newScreenLines(['ok', '$ ls'], ['ok', '$ l'])).toEqual(['$ l']);
    expect(newScreenLines(['ok', 'x'], ['ok', ''])).toEqual([]);
  });

  it('lists every non-blank row of a full redraw', () => {
    expect(newScreenLines(['a', 'b', 'c'], ['x', '', 'z'])).toEqual(['x', 'z']);
  });
});

type FakeScreen = {rows: string[]; cursorY: number; following: boolean; selected: string};
function fakeAdapter(screen: FakeScreen) {
  const listeners = new Set<(event: TerminalEvent) => void>();
  const reads = {rows: 0};
  const adapter = {
    capabilities: {...xtermCapabilities, accessibility: false, screenInspection: true},
    viewport: () => ({top: 100, rows: screen.rows.length, length: 200, following: screen.following}),
    readRows: (first: number, count: number) => { reads.rows++; expect(first).toBe(100); return screen.rows.slice(0, count); },
    cursor: () => ({x: 0, y: screen.cursorY}),
    selectedText: () => screen.selected,
    subscribe: (listener: (event: TerminalEvent) => void) => { listeners.add(listener); return {dispose: () => { listeners.delete(listener); }}; },
  } as unknown as TerminalAdapter;
  return {adapter, reads, listeners, emit: (event: TerminalEvent) => listeners.forEach(listener => listener(event))};
}

describe('screen reader mirror', () => {
  let host: HTMLElement;
  const rowsOf = () => [...host.querySelectorAll('[role=listitem]')].map(item => item.textContent);
  const spoken = () => [...host.querySelectorAll('[role=log] > div')].map(entry => entry.textContent);
  const screen = (rows: string[], extra: Partial<FakeScreen> = {}): FakeScreen => ({rows, cursorY: rows.length - 1, following: true, selected: '', ...extra});
  const write = (state: FakeScreen, rows: string[]) => { state.rows = rows; };

  beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host); });
  afterEach(() => { vi.useRealTimers(); host.remove(); });

  it('lists the visible rows for a screen reader and marks the cursor row', () => {
    const state = screen(['ls', 'a b', '$']);
    mountScreenReaderMirror(fakeAdapter(state).adapter, host);
    expect(rowsOf()).toEqual(['ls', 'a b', '$']);
    expect(host.querySelector('[role=list]')?.getAttribute('aria-label')).toBe('Terminal screen text');
    expect(host.querySelector('[aria-current=location]')?.textContent).toBe('$');
    expect(spoken()).toEqual([]);
  });

  it('is visually hidden without leaving the accessibility tree or taking pointer input', () => {
    mountScreenReaderMirror(fakeAdapter(screen(['$'])).adapter, host);
    const region = host.firstElementChild as HTMLElement;
    expect(region.style).toMatchObject({position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', pointerEvents: 'none'});
    for (const hidden of [region, ...region.querySelectorAll('*')]) {
      expect(hidden.closest('[hidden], [aria-hidden=true]')).toBeNull();
      expect((hidden as HTMLElement).style.display).not.toBe('none');
    }
  });

  it('reads the viewport once per settle window however much output arrives', () => {
    const state = screen(['', '$']);
    const {adapter, reads, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host);
    const initial = reads.rows;
    for (let i = 0; i < 5000; i++) emit({type: 'output'});
    vi.advanceTimersByTime(149);
    expect(reads.rows).toBe(initial);
    vi.advanceTimersByTime(1);
    expect(reads.rows).toBe(initial + 1);
    for (let i = 0; i < 5000; i++) emit({type: 'output'});
    vi.advanceTimersByTime(150);
    expect(reads.rows).toBe(initial + 2);
  });

  it('speaks new output once and keeps the list current', () => {
    const state = screen(['$ ls', '$']);
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host);
    write(state, ['$ ls', 'file.txt', '$']);
    emit({type: 'output'});
    vi.advanceTimersByTime(150);
    expect(rowsOf()).toEqual(['$ ls', 'file.txt', '$']);
    vi.advanceTimersByTime(1000);
    expect(spoken()).toEqual(['file.txt']);
    emit({type: 'output'});
    vi.advanceTimersByTime(5000);
    expect(spoken()).toEqual(['file.txt']);
  });

  it('keeps announcements a minimum interval apart and drops the oldest lines past its bound', () => {
    const state = screen(['', '', '']);
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host, {maxLines: 2});
    const step = (rows: string[]) => { write(state, rows); emit({type: 'output'}); vi.advanceTimersByTime(150); };
    step(['', '', 'one']);
    expect(spoken()).toEqual(['one']);
    step(['', 'one', 'two']);
    step(['one', 'two', 'three']);
    step(['two', 'three', 'four']);
    expect(spoken()).toEqual(['one']);
    vi.advanceTimersByTime(1000);
    expect(spoken()).toEqual(['one', 'three', 'four']);
  });

  it('replaces a flood by a count of changed lines', () => {
    const state = screen(Array.from({length: 24}, () => ''));
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host);
    write(state, Array.from({length: 24}, (_, i) => `row ${i}`));
    emit({type: 'output'});
    vi.advanceTimersByTime(2000);
    expect(spoken()).toEqual(['24 lines changed']);
    expect(rowsOf()).toHaveLength(24);
  });

  it('stays silent while the reader looks at history but keeps the list current', () => {
    const state = screen(['old', 'older'], {following: false});
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host);
    write(state, ['older', 'oldest']);
    emit({type: 'viewport', viewport: {top: 0, rows: 2, length: 200, following: false}});
    vi.advanceTimersByTime(3000);
    expect(rowsOf()).toEqual(['older', 'oldest']);
    expect(spoken()).toEqual([]);
    expect(host.querySelector('[aria-current]')).toBeNull();
  });

  it('does not announce the difference between history and the live screen when the reader returns to it', () => {
    const state = screen(['old', 'older'], {following: false});
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host);
    state.following = true;
    write(state, ['live', 'screen']);
    emit({type: 'viewport', viewport: {top: 198, rows: 2, length: 200, following: true}});
    vi.advanceTimersByTime(3000);
    expect(rowsOf()).toEqual(['live', 'screen']);
    expect(spoken()).toEqual([]);
    write(state, ['screen', 'next']);
    emit({type: 'output'});
    vi.advanceTimersByTime(150);
    expect(spoken()).toEqual(['next']);
  });

  it('speaks a selection, cut to its bound, and nothing when the selection is cleared', () => {
    const state = screen(['text', '$']);
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host, {maxSelectionChars: 5});
    state.selected = 'abcdefgh';
    emit({type: 'selection', range: {start: {x: 0, y: 100}, end: {x: 7, y: 100}}});
    vi.advanceTimersByTime(1000);
    expect(spoken()).toEqual(['Selected: abcde…']);
    state.selected = '';
    emit({type: 'selection', range: undefined});
    vi.advanceTimersByTime(5000);
    expect(spoken()).toEqual(['Selected: abcde…']);
  });

  it('names the row under the cursor when only the cursor moved, as a menu does', () => {
    const state = screen(['> alpha', '  beta'], {cursorY: 0});
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host);
    state.cursorY = 1;
    emit({type: 'output'});
    vi.advanceTimersByTime(1200);
    expect(spoken()).toEqual(['beta']);
    expect(host.querySelector('[aria-current=location]')?.textContent).toBe('  beta');
  });

  it('keeps only the newest announcements in its log', () => {
    const state = screen(['', '']);
    const {adapter, emit} = fakeAdapter(state);
    mountScreenReaderMirror(adapter, host, {logSize: 2, minIntervalMs: 0});
    for (const text of ['a', 'b', 'c']) { write(state, ['', text]); emit({type: 'output'}); vi.advanceTimersByTime(150); }
    expect(spoken()).toEqual(['b', 'c']);
  });

  it('removes its nodes and stops reading once disposed', () => {
    const state = screen(['$']);
    const {adapter, reads, emit, listeners} = fakeAdapter(state);
    const mirror = mountScreenReaderMirror(adapter, host);
    emit({type: 'output'});
    mirror.dispose();
    const after = reads.rows;
    vi.advanceTimersByTime(5000);
    expect(reads.rows).toBe(after);
    expect(listeners.size).toBe(0);
    expect(host.childElementCount).toBe(0);
  });
});

describe('needsScreenReaderMirror', () => {
  it('is for backends a screen reader cannot reach that can read their rows', () => {
    expect(needsScreenReaderMirror({capabilities: xtermCapabilities})).toBe(false);
    expect(needsScreenReaderMirror({capabilities: {...xtermCapabilities, accessibility: false}})).toBe(true);
    expect(needsScreenReaderMirror({capabilities: {...xtermCapabilities, accessibility: false, screenInspection: false}})).toBe(false);
  });
});

describe('screen reader mirror over the xterm backend', () => {
  it('lists real terminal rows and speaks real output without repeating the screen', async () => {
    const adapter = createXtermTerminalAdapter();
    adapter.requestSize({columns: 20, rows: 5});
    const element = document.createElement('div'), host = document.createElement('div');
    document.body.append(element, host);
    await adapter.attach({kind: 'dom', element});
    await adapter.write!(new TextEncoder().encode('first\r\n$ '));
    const mirror = mountScreenReaderMirror(adapter, host, {settleMs: 5, minIntervalMs: 0});
    expect([...host.querySelectorAll('[role=listitem]')].map(item => item.textContent).slice(0, 2)).toEqual(['first', '$']);
    await adapter.write!(new TextEncoder().encode('ls\r\nfile.txt\r\n$ '));
    await vi.waitFor(() => expect([...host.querySelectorAll('[role=log] > div')].map(entry => entry.textContent)).toEqual(['$ ls', 'file.txt']));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(host.querySelectorAll('[role=log] > div')).toHaveLength(2);
    mirror.dispose();
    await adapter.dispose();
  });
});
