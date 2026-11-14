// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {createHeadlessCore, type HeadlessCore, type HeadlessCoreOptions} from './xterm/nativeCoreHeadless';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {runTerminalAdapterContract} from './terminalAdapter.contract';
import type {NativeCoreBridge, NativeCoreSnapshot} from './nativeCoreBridge';

const text = (value: string) => new TextEncoder().encode(value);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let anchors = 0;
function anchor() {
  const element = document.createElement('div');
  element.id = `native-anchor-${anchors++}`;
  document.body.append(element);
  return {kind: 'native' as const, anchorId: element.id};
}

/** Every answer the core gives the adapter, checked as it crosses: text and small values only, bounded, never cells. */
function inspected(core: HeadlessCore, answers: NativeCoreSnapshot[] = []): HeadlessCore {
  const watch = <A extends unknown[]>(call: (...args: A) => Promise<NativeCoreSnapshot>) => async (...args: A) => {
    const answer = await call(...args);
    answers.push(answer);
    return answer;
  };
  const watched = Object.create(core, {
    snapshot: {value: watch(core.snapshot.bind(core))},
    scroll: {value: watch(core.scroll.bind(core))},
    ...(core.feed ? {feed: {value: watch(core.feed.bind(core))}, resize: {value: watch(core.resize!.bind(core))}} : {}),
  });
  return watched;
}

function assertNoCells(answer: NativeCoreSnapshot, window: number) {
  expect(Object.keys(answer).sort()).toEqual(['state', 'window']);
  expect(Object.keys(answer.state).sort()).toEqual(['columns', 'cursor', 'modes', 'rows', 'scrollbackLines', 'viewport']);
  expect(Object.keys(answer.window).sort()).toEqual(['first', 'rows']);
  expect(answer.window.rows.length).toBeLessThanOrEqual(window);
  // A row is its text: a string, never an array of cells or an object with attributes.
  expect(answer.window.rows.every(row => typeof row === 'string')).toBe(true);
}

runTerminalAdapterContract('native (control plane over a headless core)', {
  create: () => openNativeTerminalAdapter(createHeadlessCore()),
  target: anchor,
});

async function open(options: HeadlessCoreOptions = {}) {
  const answers: NativeCoreSnapshot[] = [];
  const core = inspected(createHeadlessCore(options), answers);
  const adapter = await openNativeTerminalAdapter(core, {refreshMs: 1});
  await adapter.attach(anchor());
  return {adapter, core, answers};
}

describe('native backend specifics', () => {
  it('reports what it is: native, no renderer, and a data path that follows the core', async () => {
    const fed = await open();
    expect(fed.adapter).toMatchObject({backend: 'native', dataPath: 'renderer'});
    expect(fed.adapter.capabilities).toMatchObject({nativeRendering: false, ime: false, canonicalMoshResize: false, screenInspection: true});
    const owned = await open({feed: false});
    expect(owned.adapter.dataPath).toBe('runtime');
    expect(owned.adapter.write).toBeUndefined();
    await Promise.all([fed.adapter.dispose(), owned.adapter.dispose()]);
  });

  it('never receives cells: every answer is the small state plus the text of a bounded window of rows', async () => {
    const {adapter, answers} = await open({window: 12});
    await adapter.write!(text(Array.from({length: 50}, (_, i) => `\x1b[3${i % 8}m line ${i}\x1b[0m`).join('\r\n')));
    adapter.scroll({kind: 'toTop'});
    adapter.requestSize({columns: 30, rows: 6});
    await adapter.write!(text('x'));
    expect(answers.length).toBeGreaterThan(3);
    answers.forEach(answer => assertNoCells(answer, 12));
    await adapter.dispose();
  });

  it('serves rows from the window the core chose and reads the rest as empty', async () => {
    const {adapter} = await open({window: 8});
    await adapter.write!(text(Array.from({length: 40}, (_, i) => `row ${i}`).join('\r\n')));
    const {top, length} = adapter.viewport();
    expect(adapter.readRows!(length - 8, 8)).toEqual(Array.from({length: 8}, (_, i) => `row ${length - 8 + i}`));
    expect(adapter.readRows!(0, 2)).toEqual(['', '']);
    // The window follows the reader: scrolling to the top brings the first rows in once the core answers.
    adapter.scroll({kind: 'toTop'});
    await adapter.write!(text(''));
    expect(adapter.viewport().top).toBeLessThan(top);
    expect(adapter.readRows!(0, 3)).toEqual(['row 0', 'row 1', 'row 2']);
    await adapter.dispose();
  });

  it('cuts text by columns the way the screen shows wide characters', async () => {
    const {adapter} = await open();
    await adapter.write!(text('a世界b éx\r\n'));
    expect(adapter.readRows!(0, 1, {start: 1, end: 5})).toEqual(['世界']);
    expect(adapter.readRows!(0, 1, {start: 5, end: 8})).toEqual(['b é']);
    adapter.select({start: {x: 1, y: 0}, end: {x: 2, y: 0}});
    expect(adapter.selectedText()).toBe('世');
    expect(adapter.selectWordAt({x: 2, y: 0})).toEqual({start: {x: 0, y: 0}, end: {x: 5, y: 0}});
    await adapter.dispose();
  });

  it('follows a size request at once and takes the core\'s answer as the truth', async () => {
    const {adapter} = await open();
    const sizes: string[] = [];
    adapter.subscribe(event => { if (event.type === 'geometry') sizes.push(`${event.size.columns}x${event.size.rows}`); });
    adapter.requestSize({columns: 30, rows: 8});
    expect(adapter.size()).toEqual({columns: 30, rows: 8});
    await adapter.write!(text('x'));
    expect(adapter.size()).toEqual({columns: 30, rows: 8});
    expect(adapter.viewport().rows).toBe(8);
    expect(sizes).toEqual(['30x8']);
    await adapter.dispose();
  });

  it('brackets a paste only while the program asked for it, and never lets pasted text end it', async () => {
    const {adapter, core} = await open();
    adapter.paste('one\r\ntwo\nthree');
    await adapter.write!(text('\x1b[?2004h'));
    adapter.paste('a\x1b[201~b');
    adapter.sendInput('\x1b[0n', 'terminal-reply');
    expect(core.inputs).toEqual([
      {data: 'one\rtwo\rthree', origin: 'paste'},
      {data: '\x1b[200~ab\x1b[201~', origin: 'paste'},
      {data: '\x1b[0n', origin: 'terminal-reply'},
    ]);
    await adapter.dispose();
  });

  it('forwards the core\'s title, bell, directory and clipboard events in order', async () => {
    const {adapter, core} = await open({feed: false});
    const seen: unknown[] = [];
    adapter.subscribe(event => seen.push(event), ['title', 'bell', 'cwd', 'clipboard']);
    await core.output(text('\x1b]0;build\x07\x07\x1b]7;file://host/srv/a%20b\x07\x1b]7;nonsense\x07\x1b]52;c;aGk=\x07'));
    expect(seen).toEqual([{type: 'title', title: 'build'}, {type: 'bell'}, {type: 'cwd', path: '/srv/a b'}, {type: 'clipboard', text: 'hi'}]);
    await adapter.dispose();
  });
});

describe('native geometry over a laid-out anchor', () => {
  /** jsdom lays nothing out, so the anchor reports the rectangle a real layout would: 200x100 at (10, 20), 20x5 cells of 10x20. */
  async function laidOut(options: HeadlessCoreOptions = {}) {
    const opened = await open(options);
    const [target] = [document.getElementById(`native-anchor-${anchors - 1}`)!];
    target.getBoundingClientRect = () => ({left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON() {}});
    return opened;
  }

  it('reports the screen rectangle and the cell size drawn into it', async () => {
    const {adapter} = await laidOut();
    expect(adapter.screenBounds()).toEqual({left: 10, top: 20, width: 200, height: 100});
    expect(adapter.metrics()).toMatchObject({columns: 20, rows: 5, cellWidth: 10, cellHeight: 20, scrollbackLines: 200});
    await adapter.detach();
    expect(adapter.screenBounds()).toBeUndefined();
    expect(adapter.metrics()).toMatchObject({cellWidth: 0, cellHeight: 0});
    await adapter.dispose();
  });

  it('names the cell under a point in absolute rows, clamped to the screen, and nothing before it is laid out', async () => {
    const {adapter} = await laidOut();
    await adapter.write!(text(Array.from({length: 12}, (_, i) => `row ${i}`).join('\r\n')));
    const top = adapter.viewport().top;
    expect(top).toBeGreaterThan(0);
    expect(adapter.cellAt(35, 65)).toEqual({x: 2, y: top + 2});
    expect(adapter.cellAt(-500, -500)).toEqual({x: 0, y: top});
    expect(adapter.cellAt(5000, 5000)).toEqual({x: 19, y: top + 4});
    const detached = await open();
    expect(detached.adapter.cellAt(35, 65)).toBeUndefined();
    await Promise.all([adapter.dispose(), detached.adapter.dispose()]);
  });

  it('turns a wheel into lines, scrolling only while the program does not track the mouse', async () => {
    const {adapter} = await laidOut();
    await adapter.write!(text(Array.from({length: 40}, (_, i) => `row ${i}`).join('\r\n')));
    const bottom = adapter.viewport().top;
    adapter.wheel({clientX: 20, clientY: 40, deltaY: -40, unit: 'pixel'});
    expect(adapter.viewport().top).toBe(bottom - 2);
    adapter.wheel({clientX: 20, clientY: 40, deltaY: -3, unit: 'line'});
    expect(adapter.viewport().top).toBe(bottom - 5);
    // A notch smaller than a line still moves one line.
    adapter.wheel({clientX: 20, clientY: 40, deltaY: 4, unit: 'pixel'});
    expect(adapter.viewport().top).toBe(bottom - 4);
    await adapter.write!(text('\x1b[?1000h'));
    adapter.wheel({clientX: 20, clientY: 40, deltaY: -40, unit: 'pixel'});
    expect(adapter.viewport().top).toBe(bottom - 4);
    await adapter.dispose();
  });
});

describe('native runtime path (the core owns the transport)', () => {
  it('pulls the state at the refresh rate however much output arrives', async () => {
    const refreshMs = 40, chunks = 5000;
    const answers: NativeCoreSnapshot[] = [];
    const core = inspected(createHeadlessCore({feed: false}), answers);
    const adapter = await openNativeTerminalAdapter(core, {refreshMs});
    await adapter.attach(anchor());
    const outputs: unknown[] = [];
    adapter.subscribe(event => outputs.push(event), ['output']);
    const started = performance.now();
    await Promise.all(Array.from({length: chunks}, (_, i) => core.output(text(`line ${i}\r\n`))));
    await sleep(3 * refreshMs);
    const pulls = core.calls.filter(call => call === 'snapshot').length - 1; // the first one opened the adapter
    const bound = Math.ceil((performance.now() - started) / refreshMs) + 1;
    // Every chunk rang the doorbell; the adapter pulled once per interval at most, far fewer times than chunks, and saw the last chunk.
    expect(pulls).toBeGreaterThan(0);
    expect(pulls).toBeLessThanOrEqual(bound);
    expect(pulls * 50).toBeLessThan(chunks);
    expect(outputs).toHaveLength(pulls);
    expect(adapter.readRows!(adapter.viewport().top + 3, 1)).toEqual([`line ${chunks - 1}`]);
    answers.forEach(answer => assertNoCells(answer, 256));
    await adapter.dispose();
  });

  it('asks for nothing while inactive and catches up when it becomes active again', async () => {
    const {adapter, core} = await open({feed: false});
    adapter.setActive(false);
    const before = core.calls.length;
    await core.output(text('while hidden\r\n'));
    await sleep(20);
    expect(core.calls.length).toBe(before);
    expect(adapter.readRows!(0, 1)).toEqual(['']);
    adapter.setActive(true);
    await sleep(20);
    expect(adapter.readRows!(0, 1)).toEqual(['while hidden']);
    await adapter.dispose();
  });

  it('keeps every session\'s screen its own while the active one is switched at random', async () => {
    const sessions = await Promise.all(['a', 'b', 'c'].map(async name => ({name, ...await open({feed: false})})));
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const writes: Promise<void>[] = [];
    for (let step = 0; step < 300; step++) {
      const session = sessions[Math.floor(random() * sessions.length)];
      sessions.forEach(other => other.adapter.setActive(other === session));
      writes.push(session.core.output(text(`${session.name}${step}\r\n`)));
      if (step % 7 === 0) await sleep(0);
    }
    await Promise.all(writes);
    sessions.forEach(session => session.adapter.setActive(true));
    await sleep(40);
    for (const {name, adapter} of sessions) {
      const rows = adapter.readRows!(adapter.viewport().top, 5).filter(Boolean);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row => row.startsWith(name))).toBe(true);
      // Output is strictly increasing within a session: nothing was reordered or taken from another session.
      const steps = rows.map(row => Number(row.slice(1)));
      expect(steps).toEqual([...steps].sort((x, y) => x - y));
    }
    await Promise.all(sessions.map(({adapter}) => adapter.dispose()));
  });
});

describe('native lifecycle', () => {
  it('rejects bytes it never applied, finishes the commands already issued and closes its core once', async () => {
    const {adapter, core} = await open();
    const late = adapter.write!(text('late'));
    adapter.scroll({kind: 'toTop'});
    const first = adapter.dispose();
    expect(adapter.dispose()).toBe(first);
    await expect(late).rejects.toThrow('disposed');
    await first;
    expect(core.closed).toBe(true);
    expect(core.calls.filter(call => call === 'scroll')).toHaveLength(1);
  });
});
