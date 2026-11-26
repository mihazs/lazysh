// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {createHeadlessCore, type HeadlessCore, type HeadlessCoreOptions} from './xterm/nativeCoreHeadless';
import {nativeCapabilities, openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {mountScreenReaderMirror} from './terminalScreenReader';
import {runTerminalAdapterContract} from './terminalAdapter.contract';
import {defaults, terminalPreferences} from './preferences';
import type {NativeCoreBridge, NativeCoreQuery, NativeCoreSnapshot} from './nativeCoreBridge';

const text = (value: string) => new TextEncoder().encode(value);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
}
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

it('keeps the focused editor through a click on its canvas without intercepting an unfocused click', async () => {
  const adapter = await openNativeTerminalAdapter(createHeadlessCore());
  const target = anchor();
  const canvas = document.getElementById(target.anchorId)!;
  const mouseDown = () => canvas.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
  try {
    await adapter.attach(target);
    expect(mouseDown()).toBe(true);
    adapter.focus();
    expect(document.activeElement).toBe(adapter.inputElement());
    expect(mouseDown()).toBe(false);
    await adapter.detach();
    expect(mouseDown()).toBe(true);
  } finally {
    await adapter.dispose();
    canvas.remove();
  }
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
    expect(fed.adapter.capabilities).toMatchObject({nativeRendering: false, ime: false, canonicalMoshResize: true, screenInspection: true});
    const owned = await open({feed: false});
    expect(owned.adapter.dataPath).toBe('runtime');
    expect(owned.adapter.write).toBeUndefined();
    await Promise.all([fed.adapter.dispose(), owned.adapter.dispose()]);
  });

  it('is readable by a screen reader only while a mirror of its rows is mounted, and speaks new output in a bounded polite log', async () => {
    const {adapter} = await open({rows: 4});
    await adapter.write!(text('$ make\r\n'));
    expect(adapter.capabilities.accessibility).toBe(false);
    const host = document.createElement('div');
    document.body.append(host);
    const mirror = mountScreenReaderMirror(adapter, host, {settleMs: 1, minIntervalMs: 0, maxLines: 2, logSize: 3});
    expect(adapter.capabilities.accessibility).toBe(true);
    // The backend's registration is what selection reads: it still refuses a screen-reader session.
    expect(nativeCapabilities.accessibility).toBe(false);
    const rows = () => [...host.querySelectorAll('[role=list] [role=listitem]')].map(item => item.textContent);
    const spoken = () => [...host.querySelector('[role=log]')!.children].map(entry => entry.textContent);
    expect(rows()).toEqual(['$ make', '', '', '']);
    await adapter.write!(text('built\r\n'));
    await sleep(30);
    expect(rows()).toEqual(['$ make', 'built', '', '']);
    expect(spoken()).toEqual(['built']);
    for (let burst = 0; burst < 6; burst++) {
      await adapter.write!(text(Array.from({length: 8}, (_, line) => `out ${burst}.${line}\r\n`).join('')));
      await sleep(30);
    }
    expect(rows()).toHaveLength(4);
    expect(spoken()).toHaveLength(3);
    expect(spoken().at(-1)).toMatch(/lines changed$/);
    mirror.dispose();
    expect(adapter.capabilities.accessibility).toBe(false);
    expect(host.childElementCount).toBe(0);
    host.remove();
    await adapter.dispose();
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
    await adapter.write!(text(''));
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

describe('native Mosh resize', () => {
  const frame = (id: number, cols: number, rows: number, body = '') => text(`\x1b]7777;lazysh-mosh;1;begin;${id};${cols};${rows}\x1b\\${body}\x1b]7777;lazysh-mosh;1;end;${id}\x1b\\`);

  it('refuses a core that cannot follow the frames, and asks one that can before the first byte', async () => {
    const owned = await open({feed: false});
    expect(() => owned.adapter.enableCanonicalResize()).toThrow('cannot apply canonical Mosh resizing');
    const {adapter, core} = await open();
    const canonical = adapter.enableCanonicalResize();
    expect(adapter.enableCanonicalResize()).toBe(canonical);
    await adapter.write!(frame(1, 30, 6, 'hello'));
    expect(core.calls.filter(call => call === 'canonicalFrames' || call === 'feed')).toEqual(['canonicalFrames', 'feed']);
    expect(adapter.size()).toEqual({columns: 30, rows: 6});
    expect(adapter.readRows!(0, 1)).toEqual(['hello']);
    await Promise.all([owned.adapter.dispose(), adapter.dispose()]);
  });

  it('hands each size it is asked for to the transport once, refuses one the transport cannot have and follows only the frames', async () => {
    const {adapter} = await open();
    const canonical = adapter.enableCanonicalResize();
    const asked: unknown[] = [];
    canonical.onResizeIntent(size => asked.push(size));
    for (const [columns, rows] of [[60, 20], [60, 20], [80, 24]]) adapter.requestSize({columns, rows});
    expect(asked).toEqual([{cols: 60, rows: 20}, {cols: 80, rows: 24}]);
    for (const [columns, rows] of [[1, 5], [513, 5], [200, 200], [2.5, 4]]) expect(() => adapter.requestSize({columns, rows}), `${columns}x${rows}`).toThrow('canonical Mosh resizing');
    expect(adapter.size()).toEqual({columns: 20, rows: 5});
    await adapter.write!(frame(1, 50, 10));
    expect(adapter.size()).toEqual({columns: 50, rows: 10});
    await adapter.dispose();
  });

  it('fails the display for good on a frame the core refuses: one event, no more intents, later frames ignored', async () => {
    const {adapter} = await open();
    const canonical = adapter.enableCanonicalResize();
    const failures: unknown[] = [], asked: unknown[] = [];
    adapter.subscribe(event => failures.push(event), ['failure']);
    canonical.onResizeIntent(size => asked.push(size));
    await adapter.write!(frame(1, 30, 6));
    await adapter.write!(text('\x1b]7777;lazysh-mosh;1;end;9\x1b\\'));
    expect(failures).toEqual([{type: 'failure', reason: 'invalid-frame'}]);
    expect(canonical.failure).toBe('invalid-frame');
    adapter.requestSize({columns: 60, rows: 20});
    await adapter.write!(frame(2, 50, 10));
    expect(asked).toEqual([]);
    expect(adapter.size()).toEqual({columns: 30, rows: 6});
    expect(failures).toHaveLength(1);
    await adapter.dispose();
  });

  it('closes once the core has handled what was sent before, and asks for nothing afterwards', async () => {
    const {adapter} = await open();
    const canonical = adapter.enableCanonicalResize();
    const asked: unknown[] = [];
    canonical.onResizeIntent(size => asked.push(size));
    adapter.write!(frame(1, 30, 6, 'late'));
    await canonical.close();
    expect(adapter.readRows!(0, 1)).toEqual(['late']);
    adapter.requestSize({columns: 60, rows: 20});
    expect(asked).toEqual([]);
    expect(adapter.size()).toEqual({columns: 30, rows: 6});
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

describe('native text queries (a core that reads its own text)', () => {
  /** The stand-in core plus the questions of a core that answers about its text; the test answers each one. */
  async function asking() {
    const questions: {query: NativeCoreQuery; answer(value: unknown): void}[] = [], highlighted: unknown[] = [];
    const bridge: NativeCoreBridge = Object.create(createHeadlessCore(), {
      query: {value: (query: NativeCoreQuery) => new Promise(answer => { questions.push({query, answer}); })},
      select: {value: (range: unknown) => { highlighted.push(range); }},
    });
    const adapter = await openNativeTerminalAdapter(bridge);
    await adapter.attach(anchor());
    const answer = async (value: unknown) => { questions.shift()!.answer(value); await sleep(0); };
    return {adapter, questions, highlighted, answer};
  }
  const row = (from: number, to: number) => ({start: {x: from, y: 0}, end: {x: to, y: 0}});

  it('reads the selected text from the window until the core answers, then gives the core\'s', async () => {
    const {adapter, questions, highlighted, answer} = await asking();
    await adapter.write!(text('hello world'));
    adapter.select(row(0, 4));
    expect(adapter.selectedText()).toBe('hello');
    await sleep(0);
    expect(questions.map(question => question.query)).toEqual([{kind: 'selectionText', range: row(0, 4)}]);
    await answer('as the core reads it');
    expect(adapter.selectedText()).toBe('as the core reads it');
    expect(adapter.getSelection()).toEqual({range: row(0, 4), text: 'as the core reads it'});
    expect(highlighted).toEqual([row(0, 4)]);
    adapter.clearSelection();
    expect(adapter.selectedText()).toBe('');
    expect(highlighted).toEqual([row(0, 4), undefined]);
    await adapter.dispose();
  });

  it('asks one question at a time and never shows the text of an earlier selection', async () => {
    const {adapter, questions, answer} = await asking();
    await adapter.write!(text('hello world'));
    adapter.select(row(0, 4));
    adapter.select(row(6, 10));
    await sleep(0);
    expect(questions).toHaveLength(1);
    await answer('hello');
    // The answer was for the first selection: the second keeps the window's text and is asked now.
    expect(adapter.selectedText()).toBe('world');
    expect(questions.map(question => question.query)).toEqual([{kind: 'selectionText', range: row(6, 10)}]);
    await answer('WORLD');
    expect(adapter.selectedText()).toBe('WORLD');
    expect(questions).toEqual([]);
    await adapter.dispose();
  });

  it('reads the selection again when output changed the screen under it', async () => {
    const {adapter, questions, answer} = await asking();
    await adapter.write!(text('hello'));
    adapter.select(row(0, 4));
    await sleep(0);
    await answer('hello');
    const written = adapter.write!(text('\rHELLO'));
    await sleep(0);
    await written;
    await sleep(0);
    expect(questions.map(question => question.query)).toEqual([{kind: 'selectionText', range: row(0, 4)}]);
    await answer('HELLO');
    expect(adapter.selectedText()).toBe('HELLO');
    await adapter.dispose();
  });

  /** The core answers one question at a time, in order: answer the earlier ones with their own text until `kind` is asked, then give it `value`. */
  async function answerKind(questions: {query: NativeCoreQuery; answer(value: unknown): void}[], kind: string, value: unknown) {
    for (let i = 0; i < 5 && !questions.some(question => question.query.kind === kind); i++) { questions.shift()?.answer(''); await sleep(0); }
    questions.splice(questions.findIndex(question => question.query.kind === kind), 1)[0].answer(value);
    await sleep(0);
  }

  it('takes the word under a cell and the whole buffer from the core, replacing the window\'s guess', async () => {
    const {adapter, highlighted, questions} = await asking();
    await adapter.write!(text('hello world'));
    const guess = adapter.selectWordAt({x: 7, y: 0});
    expect(guess).toEqual(row(6, 10));
    adapter.select(guess);
    await answerKind(questions, 'wordAt', row(5, 10));
    expect(adapter.selectionRange()).toEqual(row(5, 10));
    expect(highlighted.at(-1)).toEqual(row(5, 10));
    adapter.selectAll();
    await answerKind(questions, 'bufferRange', row(0, 10));
    expect(adapter.selectionRange()).toEqual(row(0, 10));
    for (let i = 0; i < 5; i++) { questions.shift()?.answer(''); await sleep(0); }
    await adapter.dispose();
  });

  it('clears a select-all when the core has no buffer to select', async () => {
    const {adapter, questions} = await asking();
    adapter.selectAll();
    await answerKind(questions, 'bufferRange', null);
    expect(adapter.hasSelection()).toBe(false);
    await adapter.dispose();
  });

  it('searches the whole buffer through the core, and has no such search without one', async () => {
    const {adapter, questions, answer} = await asking();
    const none = adapter.searchBuffer!('needle', -1, 3), found = adapter.searchBuffer!('needle', 1);
    await sleep(0);
    expect(questions[0].query).toEqual({kind: 'search', query: 'needle', direction: 'backward', from: 3});
    await answer(null);
    expect(await none).toBeUndefined();
    expect(questions[0].query).toEqual({kind: 'search', query: 'needle', direction: 'forward', from: undefined});
    await answer({row: 7, column: 2, length: 9});
    expect(await found).toEqual({row: 7, column: 2, length: 9});
    await adapter.dispose();
    expect(await adapter.searchBuffer!('needle', 1)).toBeUndefined();
    const plain = await openNativeTerminalAdapter(createHeadlessCore());
    expect(plain.searchBuffer).toBeUndefined();
    await plain.dispose();
  });
});

describe('native lifecycle', () => {
  it('settles a write if its applied callback throws and continues the queue', async () => {
    const {adapter} = await open();
    await expect(adapter.write!(text('first'), () => { throw new Error('callback failed'); })).rejects.toThrow('callback failed');
    await adapter.write!(text('second'));
    expect(adapter.readRows!(0, 1)).toEqual(['firstsecond']);
    await adapter.dispose();
  });

  it('settles a write if an output listener throws', async () => {
    const {adapter} = await open();
    const listener = adapter.subscribe(() => { throw new Error('listener failed'); }, ['output']);
    await expect(adapter.write!(text('first'))).rejects.toThrow('listener failed');
    listener.dispose();
    await adapter.write!(text('second'));
    await adapter.dispose();
  });

  it('serializes input and waits for a started input before closing', async () => {
    const core = createHeadlessCore();
    const sent: string[] = [];
    const first = deferred();
    core.input = async data => {
      if (data === 'first') await first.promise;
      sent.push(String(data));
    };
    const adapter = await openNativeTerminalAdapter(core);
    adapter.sendInput('first', 'keyboard');
    adapter.sendInput('second', 'keyboard');
    await sleep(0);
    expect(sent).toEqual([]);
    first.release();
    await adapter.write!(text(''));
    expect(sent).toEqual(['first', 'second']);
    await adapter.dispose();
  });

  it('drops queued input on disposal and makes no bridge calls afterward', async () => {
    const core = createHeadlessCore();
    const sent: string[] = [];
    const first = deferred();
    core.input = async data => { await first.promise; sent.push(String(data)); };
    let activeCalls = 0;
    core.setActive = () => { activeCalls++; };
    const adapter = await openNativeTerminalAdapter(core);
    adapter.sendInput('first', 'keyboard');
    await sleep(0);
    adapter.sendInput('stale', 'keyboard');
    const closed = adapter.dispose();
    adapter.sendInput('later', 'keyboard');
    adapter.scroll({kind: 'toTop'});
    adapter.requestSize({columns: 10, rows: 3});
    adapter.setActive(false);
    expect(core.closed).toBe(false);
    first.release();
    await closed;
    expect(sent).toEqual(['first']);
    expect(core.closed).toBe(true);
    expect(core.calls.filter(call => call === 'scroll' || call === 'resize')).toEqual([]);
    expect(activeCalls).toBe(0);
  });

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

describe('native wheel and finger scrolling', () => {
  async function open(output = '') {
    const core = createHeadlessCore({feed: true});
    const adapter = await openNativeTerminalAdapter(core);
    await adapter.write!(text(output));
    return {core, adapter};
  }

  it('sends a program that tracks the mouse one wheel report per notch, in the cell under the finger, and scrolls nothing', async () => {
    const {core, adapter} = await open('\x1b[?1000h\x1b[?1006h');
    const element = document.createElement('div');
    document.body.append(element);
    element.getBoundingClientRect = () => ({left: 0, top: 0, width: 800, height: 240, right: 800, bottom: 240, x: 0, y: 0, toJSON() {}});
    await adapter.attach({kind: 'native', anchorId: (element.id = 'wheel-anchor')});
    adapter.wheel({clientX: 85, clientY: 25, deltaY: 1, unit: 'line'});
    adapter.wheel({clientX: 85, clientY: 25, deltaY: -40, unit: 'pixel'});
    await sleep(10);
    const {columns, rows} = adapter.size(), cell = {x: Math.floor(85 / (800 / columns)), y: Math.floor(25 / (240 / rows))};
    expect(core.mice.map(m => [m.button, m.x, m.y])).toEqual([['wheelDown', cell.x, cell.y], ['wheelUp', cell.x, cell.y]]);
    expect(core.calls).not.toContain('scroll');
  });

  it('scrolls the history by lines when the program does not track the mouse', async () => {
    const {core, adapter} = await open(Array.from({length: 60}, (_, i) => `row ${i}\r\n`).join(''));
    const bottom = adapter.viewport().top;
    adapter.wheel({clientX: 0, clientY: 0, deltaY: -3, unit: 'line'});
    await sleep(10);
    expect(adapter.viewport().top).toBe(bottom - 3);
    expect(core.mice).toEqual([]);
  });
});

describe('native selection and typing', () => {
  async function selected() {
    const core = createHeadlessCore({feed: true});
    const adapter = await openNativeTerminalAdapter(core);
    await adapter.write!(text('hello world'));
    adapter.select({start: {x: 6, y: 0}, end: {x: 10, y: 0}});
    return {core, adapter};
  }

  it('clears the selection when the user types, as xterm.js does, and sends what was typed', async () => {
    for (const type of [(a: Awaited<ReturnType<typeof selected>>['adapter']) => a.sendInput('x', 'ime'), (a: Awaited<ReturnType<typeof selected>>['adapter']) => a.sendInput('x', 'paste'),
      (a: Awaited<ReturnType<typeof selected>>['adapter']) => a.sendKey({type: 'key', code: 'KeyA', key: 'a', mods: {shift: false, ctrl: false, alt: false, meta: false}, repeat: false, release: false, composing: false})]) {
      const {core, adapter} = await selected();
      expect(adapter.hasSelection()).toBe(true);
      type(adapter);
      expect(adapter.hasSelection()).toBe(false);
      await sleep(5);
      expect(core.inputs.length + core.keys.length).toBe(1);
    }
  });

  it('keeps the selection for a terminal reply and for a key release', async () => {
    const {adapter} = await selected();
    adapter.sendInput('\x1b[0n', 'terminal-reply');
    adapter.sendKey({type: 'key', code: 'KeyA', key: 'a', mods: {shift: false, ctrl: false, alt: false, meta: false}, repeat: false, release: true, composing: false});
    expect(adapter.selectedText()).toBe('world');
  });
});

describe('native History lines setting', () => {
  it('reaches a session that is open: the core keeps the new number of rows, the metrics say so, and an unchanged number sends nothing', async () => {
    const core = createHeadlessCore({scrollbackLines: 50});
    const adapter = await openNativeTerminalAdapter(core);
    const lines = (count: number) => Array.from({length: count}, (_, i) => `line ${i}`).join('\r\n');
    const withHistory = (scrollbackLines: number) => ({...terminalPreferences(defaults), scrollbackLines});
    expect(adapter.metrics().scrollbackLines).toBe(50);
    adapter.applyPreferences(withHistory(50));
    await sleep(5);
    expect(core.calls).not.toContain('scrollback');

    await adapter.write!(text(lines(200)));
    expect(adapter.viewport().length).toBe(50 + 5);
    adapter.applyPreferences(withHistory(300));
    adapter.applyPreferences(withHistory(300));
    await sleep(5);
    expect(core.calls.filter(call => call === 'scrollback')).toHaveLength(1);
    expect(adapter.metrics().scrollbackLines).toBe(300);
    await adapter.write!(text(`\r\n${lines(400)}`));
    expect(adapter.viewport().length).toBe(300 + 5);
    await adapter.dispose();
  });
});
