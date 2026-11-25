// In-page half of the terminal benchmark. It drives the real TerminalPane and createTerminal()
// (xterm.js 5.5.0, the app's preferences) and reports what the page can see: apply latency,
// render callbacks, frame intervals and long tasks. Process CPU and heap come from CDP in the Playwright driver.
// The renderer under test is the page's `?renderer=` query: the default DOM renderer (the baseline) or the
// canvas or WebGL addon on the same terminal, for the renderer shootout (#1323).
import { mountTerminalHistoryHarness } from '../e2e/fixtures/TerminalHistoryHarness';
import { createTerminal, syncTerminalViewport } from '../src/xterm/terminal';
import { attachRendererCandidate, type RendererCandidate } from '../src/xterm/rendererCandidates';
import { configureTerminalBold } from '../src/xterm/terminalBold';
import { XtermTerminalAdapter } from '../src/xtermTerminalAdapter';
import type { TerminalAdapter } from '../src/terminalAdapter';
import { ansiColor, chunks, CHUNK, fullScreenRedraw, moshEnvelope, plainText, shellSession, styledText, summarize, type Geometry, type StyleFamily, type Workload } from './workloads';
import type { Check, Replay } from './programWorkloads';

/** Credit window of the Rust session workers (ssh.rs OUTPUT_WINDOW, local.rs WINDOW). */
const WINDOW = 256 * 1024;
const yieldTask = () => new Promise<void>(resolve => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0); });
const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const digest = async (data: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)), b => b.toString(16).padStart(2, '0')).join('');

const requested = new URLSearchParams(location.search).get('renderer');
if (requested !== null && !['dom', 'canvas', 'webgl'].includes(requested)) throw new Error(`Unknown renderer candidate: ${requested}`);
const candidate = (requested ?? 'dom') as RendererCandidate;
let contextLosses = 0;
/** Timestamped events of the context-loss run: the forced loss and restore, the canvas events, the addon giving up. */
const lossLog: { type: string; at: number }[] = [];
const note = (type: string) => lossLog.push({ type, at: performance.now() });
/** Loads the candidate's renderer addon on an opened terminal; a lost WebGL context falls back to DOM, which would invalidate the numbers, so it is counted. */
const attach = (terminal: Harness['terminal']) => attachRendererCandidate(terminal, candidate, () => { contextLosses++; note('fallback'); });
/** The GPU the WebGL candidate really ran on (software rasterizer or hardware), from the page's own context. */
function glInfo() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && info ? { vendor: String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)), renderer: String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) } : null;
  } catch { return null; }
}

type Harness = ReturnType<typeof mountTerminalHistoryHarness>;
type Term = Harness['terminal'];
/** `?write=adapter` feeds every byte through XtermTerminalAdapter.write(bytes, onApplied), as App.tsx does; the default calls xterm's write, as the recorded baseline did. */
const viaAdapter = new URLSearchParams(location.search).get('write') === 'adapter';
const adapters = new WeakMap<Term, TerminalAdapter>(), encoder = new TextEncoder();
let adapterWrites = 0;
function put(terminal: Term, data: string | Uint8Array, applied?: () => void) {
  if (!viaAdapter) return terminal.write(data, applied);
  let adapter = terminal === harness?.terminal ? harness.session.adapter : adapters.get(terminal);
  if (!adapter) adapters.set(terminal, adapter = new XtermTerminalAdapter(terminal));
  adapterWrites++;
  void adapter.write!(typeof data === 'string' ? encoder.encode(data) : data, applied);
}
const putAndWait = (terminal: Term, data: string | Uint8Array) => new Promise<void>(resolve => put(terminal, data, resolve));
let harness: Harness | undefined;
const pending: number[] = [], latencies: number[] = [];
let echoMode: 'keydown' | 'composition' = 'keydown', echoed = 0, typed = 0, writesAtBegin = 0;
let echoColumn = 0;

function open(fixedGrid?: Geometry) {
  if (harness) return harness;
  harness = mountTerminalHistoryHarness({ input: data => echo(data), fixedGrid });
  attach(harness.terminal);
  document.addEventListener('keydown', event => { if (echoMode === 'keydown') pending.push(event.timeStamp); }, true);
  document.addEventListener('compositionend', event => { if (echoMode === 'composition') pending.push(event.timeStamp); }, true);
  return harness;
}

/** The remote echoes keystrokes at once (zero round trip); the time is keystroke to the xterm render that shows it. */
function echo(data: string) {
  const { terminal } = harness!, started = pending.shift();
  typed++;
  let text = data === '\r' ? '\r\n' : data;
  echoColumn = text === '\r\n' ? 0 : echoColumn + text.length;
  if (echoColumn > terminal.cols - 4) { text += '\r\n'; echoColumn = 0; }
  // Listen only once the echo is applied: a render already scheduled by the keystroke itself must not count.
  put(terminal, text, () => {
    const render = terminal.onRender(() => { render.dispose(); if (started !== undefined) latencies.push(performance.now() - started); echoed++; });
  });
}

type Frames = { stop(): { intervalsMs: number[]; longTasks: { n: number; totalMs: number; maxMs: number } } };
function meterFrames(): Frames {
  const intervals: number[] = [], tasks: number[] = [];
  let last: number | undefined, running = true;
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration); });
  try { observer.observe({ type: 'longtask', buffered: false }); } catch { /* long tasks unavailable */ }
  const tick = (time: number) => { if (!running) return; if (last !== undefined) intervals.push(time - last); last = time; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return { stop() { running = false; observer.takeRecords().forEach(entry => tasks.push(entry.duration)); observer.disconnect(); return { intervalsMs: intervals, longTasks: { n: tasks.length, totalMs: tasks.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...tasks) } }; } };
}
/** Dropped frames: whole refresh intervals missed beyond the first, using the calibrated nominal interval. */
function pacing(intervals: number[], nominal: number) {
  const dropped = intervals.reduce((n, ms) => n + (ms > nominal * 1.5 ? Math.round(ms / nominal) - 1 : 0), 0);
  return { frames: intervals.length, frameMs: summarize(intervals), dropped, nominalMs: nominal };
}
let nominal = 1000 / 60;
async function calibrate() {
  const meter = meterFrames();
  await sleep(500);
  const { intervalsMs } = meter.stop();
  nominal = summarize(intervalsMs)?.p50 ?? nominal;
  return nominal;
}

type Prepared = { chunks: Uint8Array[]; json: string[]; screen: string[]; bytes: number; sha256: string; description: string };
let prepared: Prepared | undefined;
/** Chunks are JSON number arrays exactly like SshEvent::Data over the Tauri channel; decoding them is timed. */
async function prepare(workload: Workload) {
  const parts = chunks(workload.data);
  prepared = { chunks: parts, json: parts.map(part => JSON.stringify(Array.from(part))), screen: workload.screen, bytes: workload.data.length, sha256: await digest(workload.data), description: workload.description };
}

function screenText(terminal: Term = harness!.terminal) {
  const buffer = terminal.buffer.active, rows = terminal.rows;
  return Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true).trimEnd() ?? '');
}
let lastMismatch: { expected: string[]; actual: string[] } | undefined;
const sameScreen = (expected: string[]) => {
  const actual = screenText(), same = actual.length === expected.length && actual.every((row, i) => row === expected[i]);
  lastMismatch = same ? undefined : { expected, actual };
  return same;
};

/** Applies chunks through the same credit window and ack-after-write contract as App.tsx. */
async function drain(json: string[], until?: () => boolean, paced = false, onLastApplied?: () => void) {
  const { terminal } = harness!, ack: number[] = [];
  let inflight = 0, waiter: (() => void) | undefined, decodeMs = 0, bytes = 0;
  for (let i = 0; (until ? !until() : i < json.length); i++) {
    const decoding = performance.now();
    const data = new Uint8Array(JSON.parse(json[i % json.length]));
    decodeMs += performance.now() - decoding;
    while (inflight + data.length > WINDOW) await new Promise<void>(resolve => { waiter = resolve; });
    inflight += data.length; bytes += data.length;
    const written = performance.now();
    put(terminal, data, () => { if (i === json.length - 1) onLastApplied?.(); inflight -= data.length; ack.push(performance.now() - written); waiter?.(); waiter = undefined; });
    await (paced ? frame() : yieldTask());
  }
  while (inflight > 0) await new Promise<void>(resolve => { waiter = resolve; });
  return { bytes, decodeMs, ackMs: ack };
}

async function settle() { await putAndWait(harness!.terminal, ''); await frame(); await frame(); }
async function reset() {
  const { terminal } = harness!;
  terminal.reset();
  syncTerminalViewport(terminal);
  await settle();
  echoColumn = 0;
}

/** The terminal's WebGL canvas: the one that has a webgl2 context (the addon's link layer is a 2D canvas, for which getContext('webgl2') is null). */
function webglContext() {
  for (const canvas of harness!.terminal.element?.querySelectorAll('canvas') ?? []) { const gl = canvas.getContext('webgl2'); if (gl) return { canvas, gl }; }
  return null;
}
/** The extension object is kept: getExtension() returns null once the context is lost. */
let loser: WEBGL_lose_context | null = null;

const fromBase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
/** One replayed session: the app's createTerminal() and XtermTerminalAdapter in a visible element, resized to the geometry the program was recorded at. It is not mounted in the TerminalPane, whose fit to its container would undo that geometry (a phone viewport cannot hold 100 columns); it has no toolbar, input layer or React tree. */
async function mountSession({ cols, rows, kind }: Pick<Replay, 'cols' | 'rows' | 'kind'>) {
  const terminal = createTerminal(), adapter = new XtermTerminalAdapter(terminal), pane = document.createElement('div'), mount = document.createElement('div');
  pane.style.cssText = 'position:fixed;top:0;left:0;z-index:100;background:#101010';
  pane.append(mount); document.body.append(pane);
  await adapter.attach({ kind: 'dom', element: mount });
  attach(terminal);
  terminal.resize(cols, rows);
  // As App.tsx does for a Mosh transport, before its first output.
  if (kind === 'mosh') adapter.enableCanonicalResize!();
  adapters.set(terminal, adapter);
  await settleTerminal(terminal);
  return { terminal, adapter, pane, mount, dispose() { void adapter.dispose(); pane.remove(); } };
}
async function settleTerminal(terminal: Term) { await putAndWait(terminal, ''); await frame(); await frame(); }
/** What a step is delivered as: the bytes of a stream, or a Mosh body inside the envelope naming its size. */
const delivery = (replay: Replay, step: string, index: number) => replay.kind === 'mosh' ? moshEnvelope(index + 1, { cols: replay.checks[index]!.size![0], rows: replay.checks[index]!.size![1] }, fromBase64(step)) : fromBase64(step);
function holds(terminal: Term, check: Check | null) {
  if (!check) return true;
  const { cursorX, cursorY } = terminal.buffer.active, rows = screenText(terminal);
  return cursorX === check.cursor[0] && cursorY === check.cursor[1] && (!check.lines || (rows.length === check.lines.length && rows.every((row, i) => row === check.lines![i])))
    && (!check.size || (terminal.cols === check.size[0] && terminal.rows === check.size[1])) && (check.row1 === undefined || rows[1] === check.row1);
}

const api = {
  open(fixedGrid?: Geometry) {
    const { terminal } = open(fixedGrid);
    return { cols: terminal.cols, rows: terminal.rows, scrollback: terminal.options.scrollback, cursorBlink: terminal.options.cursorBlink, fontSize: terminal.options.fontSize, devicePixelRatio: window.devicePixelRatio, viewport: [window.innerWidth, window.innerHeight], userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, build: import.meta.env.PROD ? 'production' : 'development', renderer: `xterm-${candidate}`, writePath: viaAdapter ? 'adapter' : 'direct', canvases: terminal.element?.querySelectorAll('canvas').length ?? 0, gl: candidate === 'webgl' ? glInfo() : null, domNodes: document.getElementsByTagName('*').length };
  },
  /** App features that reach into xterm's DOM renderer: tried on the live terminal, because a different renderer may refuse them. Run after the measurements. */
  seams() {
    try { configureTerminalBold(harness!.terminal, '#ff8800'); configureTerminalBold(harness!.terminal, undefined); return { customBoldColor: 'applied' }; }
    catch (error) { return { customBoldColor: `refused: ${error instanceof Error ? error.message : String(error)}` }; }
  },
  /** A lost WebGL context silently reverts to the DOM renderer; the driver rejects a run that saw one. */
  contextLosses() { return contextLosses; },
  /** Context-loss run: fixed pixels (no blinking cursor, not focused), text written and parsed, and the canvas count. */
  quiet() { harness!.terminal.options.cursorBlink = false; harness!.terminal.blur(); },
  async write(text: string) { await new Promise<void>(resolve => harness!.terminal.write(text, resolve)); await settle(); },
  canvases() { return harness!.terminal.element?.querySelectorAll('canvas').length ?? 0; },
  /** Forces the loss of the WebGL context (WEBGL_lose_context); false if the terminal has none. */
  loseContext() {
    const lost = webglContext();
    if (!lost) return false;
    const { canvas } = lost;
    loser = lost.gl.getExtension('WEBGL_lose_context');
    canvas.addEventListener('webglcontextlost', () => note('canvas-lost'));
    canvas.addEventListener('webglcontextrestored', () => note('canvas-restored'));
    note('lose'); loser!.loseContext();
    return true;
  },
  restoreContext() { note('restore'); loser!.restoreContext(); },
  /** After the addon gave up and was disposed: what a production integration does on resume. */
  reattach() { note('reattach'); attach(harness!.terminal); },
  contextEvents() { return lossLog.slice(); },
  screenLines() { return screenText(); },
  mismatch() { return lastMismatch; },
  /** Writes that went through XtermTerminalAdapter.write: zero unless the page was opened with ?write=adapter. */
  adapterWrites() { return adapterWrites; },
  async calibrate() { return calibrate(); },
  async prepare(kind: 'plain' | 'ansi' | 'redraw', size: number) {
    const { cols, rows } = open().terminal;
    await prepare(kind === 'plain' ? plainText({ bytes: size, cols, rows, seed: 20 }) : kind === 'ansi' ? ansiColor({ bytes: size, cols, rows, seed: 30 }) : fullScreenRedraw({ frames: size, cols, rows, seed: 40 }));
    return { bytes: prepared!.bytes, chunks: prepared!.chunks.length, sha256: prepared!.sha256, description: prepared!.description };
  },
  /** Words in `styles` distinct styles of one family (first-burst cost, #1323): returns how many glyph-style pairs a glyph cache has to draw once. */
  async prepareStyled(family: StyleFamily, styles: number, size: number) {
    const { cols, rows } = open().terminal, workload = styledText({ bytes: size, cols, rows, seed: 50, styles, family });
    await prepare(workload);
    return { bytes: prepared!.bytes, chunks: prepared!.chunks.length, sha256: prepared!.sha256, description: prepared!.description, distinctGlyphs: workload.distinctGlyphs };
  },
  /** W2, W3, W4: stream the prepared bytes and check the final screen. `paced` waits for a frame after every chunk, so each chunk is rendered, as output that arrives over time is. */
  async stream(paced = false) {
    await reset();
    let renders = 0, finalApplied = false, renderedAt: number | undefined;
    const counting = harness!.terminal.onRender(() => {
      renders++;
      if (finalApplied) renderedAt ??= performance.now();
    });
    const meter = meterFrames(), started = performance.now();
    const { bytes, decodeMs, ackMs } = await drain(prepared!.json, undefined, paced, () => { finalApplied = true; });
    const wallMs = performance.now() - started;
    await settle();
    const renderThroughputMiBs = renderedAt === undefined ? null : bytes / 1048576 / ((renderedAt - started) / 1000);
    const frames = meter.stop();
    counting.dispose();
    return { renders, bytes, wallMs, renderThroughputMiBs, throughputMiBs: bytes / 1048576 / (wallMs / 1000), decodeMs, decodeMsPerMiB: decodeMs / (bytes / 1048576), ackMs: summarize(ackMs), pacing: pacing(frames.intervalsMs, nominal), longTasks: frames.longTasks, correct: sameScreen(prepared!.screen), chunkBytes: CHUNK };
  },
  /** W1: one remote burst at a time; write to apply, and write to the render that shows it. */
  async shell(interactions: number) {
    await reset();
    const { terminal } = harness!, { bursts, screen } = shellSession(interactions, terminal, 10);
    const applied: number[] = [], rendered: number[] = [];
    await putAndWait(terminal, '$ ');
    for (const burst of bursts) {
      const written = performance.now();
      const render = new Promise<void>(resolve => put(terminal, burst, () => {
        applied.push(performance.now() - written);
        const d = terminal.onRender(() => { d.dispose(); rendered.push(performance.now() - written); resolve(); });
      }));
      await Promise.race([render, sleep(100)]);
      await sleep(4);
    }
    await settle();
    return { bursts: bursts.length, applyMs: summarize(applied), renderMs: summarize(rendered), correct: sameScreen(screen) };
  },
  /** W0: nothing is written. Counts DOM mutations and long tasks; no rAF loop so the page does not wake itself. */
  async idle(ms: number, blink: boolean) {
    await reset();
    const { terminal } = harness!;
    terminal.options.cursorBlink = blink; terminal.focus();
    let mutations = 0;
    const watch = new MutationObserver(records => { mutations += records.length; });
    watch.observe(terminal.element!, { subtree: true, childList: true, attributes: true, characterData: true });
    const tasks: number[] = [], observer = new PerformanceObserver(list => list.getEntries().forEach(e => tasks.push(e.duration)));
    try { observer.observe({ type: 'longtask' }); } catch { /* unavailable */ }
    await sleep(ms);
    watch.takeRecords(); observer.disconnect(); watch.disconnect();
    return { ms, cursorBlink: blink, domMutations: mutations, domMutationsPerSecond: mutations / (ms / 1000), longTasks: tasks.length, correct: true };
  },
  /** Starts a sustained flood into the visible terminal (W2 style) to test input under load. */
  startFlood() {
    const state = { stop: false, done: undefined as unknown as ReturnType<typeof drain> };
    state.done = drain(prepared!.json, () => state.stop);
    flooding = state;
  },
  async stopFlood() { flooding!.stop = true; const result = await flooding!.done; flooding = undefined; return { bytes: result.bytes }; },
  /** W12: typed or composed text echoed by the remote; latency is event timestamp to xterm render. */
  async inputBegin(mode: 'keydown' | 'composition') {
    await reset(); harness!.terminal.focus();
    echoMode = mode; pending.length = 0; latencies.length = 0; echoed = 0; typed = 0; writesAtBegin = harness!.writes.length;
  },
  progress() { return { echoed, typed }; },
  async inputEnd(expectedEchoes: number) {
    const deadline = performance.now() + 5000;
    while (echoed < expectedEchoes && performance.now() < deadline) await sleep(10);
    await settle();
    return { keystrokes: expectedEchoes, echoed, writesToRemote: harness!.writes.length - writesAtBegin, remoteWrites: harness!.writes.slice(writesAtBegin).join('|').slice(0, 120), latencyMs: summarize(latencies), correct: echoed === expectedEchoes && harness!.writes.length - writesAtBegin === expectedEchoes };
  },
  async scrollCost(lines: number, scrollback: number) {
    const { terminal } = harness!;
    terminal.options.scrollback = scrollback;
    await reset();
    const data = new TextEncoder().encode(Array.from({ length: lines }, (_, i) => `scrollback line ${String(i).padStart(6, '0')} ${'x'.repeat(40)}`).join('\r\n') + '\r\n');
    const started = performance.now();
    for (const part of chunks(data)) await putAndWait(terminal, part);
    const fillMs = performance.now() - started;
    await settle();
    const retained = terminal.buffer.active.length;
    const meter = meterFrames();
    for (let i = 0; i < 100; i++) { terminal.scrollLines(i % 2 ? 40 : -40); await frame(); }
    terminal.scrollToTop(); await frame(); terminal.scrollToBottom(); await frame();
    const frames = meter.stop();
    return { linesWritten: lines, scrollback, bufferLines: retained, fillMs, pacing: pacing(frames.intervalsMs, nominal), longTasks: frames.longTasks, correct: retained === Math.min(lines + 1, scrollback + terminal.rows) || retained === scrollback + terminal.rows };
  },
  /** W9: background sessions filled to the scrollback limit. App.tsx mounts a TerminalPane per session and hides the inactive ones with display:none; so do these. */
  async sessions(count: number, lines: number) {
    await reset();
    const extra = Array.from({ length: Math.max(0, count - 1) }, () => {
      const terminal = createTerminal(), pane = document.createElement('div'), canvas = document.createElement('div');
      pane.className = 'terminal-pane'; pane.style.display = 'none'; canvas.className = 'terminal-canvas';
      pane.append(canvas); document.body.append(pane); terminal.open(canvas); attach(terminal);
      panes.push(pane);
      return terminal;
    });
    sessions.push(...extra);
    const data = new TextEncoder().encode(Array.from({ length: lines }, (_, i) => `background session line ${String(i).padStart(6, '0')} ${'y'.repeat(30)}`).join('\r\n') + '\r\n');
    const all = [harness!.terminal, ...extra];
    await Promise.all(all.map(async terminal => { for (const part of chunks(data)) await putAndWait(terminal, part); }));
    await settle();
    const retained = all.map(terminal => terminal.buffer.active.length);
    return { sessions: all.length, linesPerSession: lines, retainedLines: Math.min(...retained), correct: retained.every(length => length >= Math.min(lines, all[0].options.scrollback ?? 0)) };
  },
  /** Keeps the background sessions of W9 streaming while the visible one is typed into. */
  async startBackground(streams: number) {
    const [prepare] = [prepared!];
    background = { stop: false, done: [] };
    for (const terminal of sessions.slice(0, streams)) {
      background.done.push((async () => {
        const data = new Uint8Array(JSON.parse(prepare.json[0]));
        while (!background!.stop) { await putAndWait(terminal, data); await yieldTask(); }
      })());
    }
  },
  async stopBackground() { background!.stop = true; await Promise.all(background!.done); background = undefined; },
  /** W5 to W8: `reps` fresh sessions each take the recorded steps one at a time, as the remote delivered them; write to apply, and write to the render that shows it. */
  async replay(replay: Replay, reps: number) {
    const applyMs: number[] = [], renderMs: number[] = [], repMs: number[] = [], steps = replay.steps.map((step, i) => delivery(replay, step, i));
    let correct = true;
    const meter = meterFrames();
    for (let rep = 0; rep < reps; rep++) {
      const session = await mountSession(replay), started = performance.now();
      for (const [i, data] of steps.entries()) {
        const written = performance.now();
        const render = new Promise<void>(resolve => put(session.terminal, data, () => {
          applyMs.push(performance.now() - written);
          const d = session.terminal.onRender(() => { d.dispose(); renderMs.push(performance.now() - written); resolve(); });
        }));
        await Promise.race([render, sleep(100)]);
        correct = holds(session.terminal, replay.checks[i]) && correct;
      }
      repMs.push(performance.now() - started);
      session.dispose();
    }
    const frames = meter.stop();
    return { reps, steps: steps.length, bytes: replay.bytes, applyMs: summarize(applyMs), renderMs: summarize(renderMs), repMs: summarize(repMs), applyMiBs: (reps * replay.bytes) / 1048576 / (applyMs.reduce((a, b) => a + b, 0) / 1000), pacing: pacing(frames.intervalsMs, nominal), longTasks: frames.longTasks, correct };
  },
  /**
   * W11: `reps` fresh sessions take `copies` deliveries of a stream while their pane is hidden (display:none, as App.tsx keeps an inactive session), then the pane is shown
   * (resume: show to the next render) and the adapter is detached and attached again (a recreated surface: attach to the first animation frame, and whether xterm drew again). The screen must be the recorded one after each.
   */
  async background(replay: Replay, reps: number, copies: number) {
    const applyMs: number[] = [], resumeMs: number[] = [], recreateMs: number[] = [], steps = replay.steps.map(fromBase64), last = replay.checks.at(-1)!;
    let correct = true, recreatedWithRender = 0;
    /** Time from now to the next render, or null when nothing was drawn within the wait. */
    const nextRender = (terminal: Term, within = 1000) => { const started = performance.now(); return new Promise<number | null>(resolve => { const d = terminal.onRender(() => { d.dispose(); resolve(performance.now() - started); }); setTimeout(() => { d.dispose(); resolve(null); }, within); }); };
    for (let rep = 0; rep < reps; rep++) {
      const session = await mountSession(replay), { terminal } = session;
      session.pane.style.display = 'none';
      await sleep(100); // the visibility observer reports the pane gone
      const started = performance.now();
      let inflight = 0, waiter: (() => void) | undefined;
      for (let copy = 0; copy < copies; copy++) for (const data of steps) {
        while (inflight + data.length > WINDOW) await new Promise<void>(resolve => { waiter = resolve; });
        inflight += data.length;
        put(terminal, data, () => { inflight -= data.length; waiter?.(); waiter = undefined; });
        await yieldTask();
      }
      while (inflight > 0) await new Promise<void>(resolve => { waiter = resolve; });
      applyMs.push(performance.now() - started);
      const resumed = nextRender(terminal);
      session.pane.style.display = 'block';
      resumeMs.push((await resumed) ?? NaN);
      await settleTerminal(terminal);
      correct = holds(terminal, last) && correct;
      await session.adapter.detach(); await frame();
      let redrawn = false;
      const drawing = terminal.onRender(() => { redrawn = true; }), reinserted = performance.now();
      await session.adapter.attach({ kind: 'dom', element: session.mount });
      await frame();
      recreateMs.push(performance.now() - reinserted); drawing.dispose();
      if (redrawn) recreatedWithRender++;
      await settleTerminal(terminal);
      correct = holds(terminal, last) && correct;
      session.dispose();
    }
    const bytes = copies * replay.bytes;
    return { reps, copies, bytes, applyMs: summarize(applyMs), applyMiBs: (reps * bytes) / 1048576 / (applyMs.reduce((a, b) => a + b, 0) / 1000), resumeMs: summarize(resumeMs.filter(Number.isFinite)), resumeWithoutRender: resumeMs.filter(ms => !Number.isFinite(ms)).length, recreateMs: summarize(recreateMs), recreatedWithRender, correct };
  },
  disposeSessions() { sessions.forEach(terminal => terminal.dispose()); sessions.length = 0; panes.forEach(pane => pane.remove()); panes.length = 0; },
};
const sessions: ReturnType<typeof createTerminal>[] = [], panes: HTMLElement[] = [];
let flooding: { stop: boolean; done: ReturnType<typeof drain> } | undefined;
let background: { stop: boolean; done: Promise<void>[] } | undefined;

declare global { interface Window { terminalBench: typeof api } }
window.terminalBench = api;
