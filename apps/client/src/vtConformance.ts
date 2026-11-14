import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Terminal} from '@xterm/xterm';

/** What both engines must agree on after a fixture's steps (see packages/terminal-runtime/fixtures/README.md). */
export type Observation = {
  lines: string[];
  cursor: {x: number; y: number};
  buffer: 'normal' | 'alternate';
  modes: {bracketedPaste: boolean; applicationCursorKeys: boolean; mouseTracking: boolean; sendFocus: boolean};
  scrollbackRows: number;
  cells: CellObservation[];
  /** Bytes the terminal sent to the host: replies, and paste output, in order. */
  data: string;
  events: {bell: number; osc52: string[]};
};

export type CellObservation = {
  x: number; y: number; text: string; width: number; fg: string; bg: string;
  flags: string[];
};

/** Fixtures store only what differs from a quiet terminal (all modes off, nothing sent, no events). */
export const quiet = {buffer: 'normal', scrollbackRows: 0, cells: [], data: '', events: {bell: 0, osc52: []}, modes: {bracketedPaste: false, applicationCursorKeys: false, mouseTracking: false, sendFocus: false}} as const;

export function sparse(observation: Observation): Partial<Observation> {
  const out: Record<string, unknown> = {...observation};
  for (const [key, value] of Object.entries(quiet)) if (JSON.stringify(out[key]) === JSON.stringify(value)) delete out[key];
  if (out.modes) out.modes = Object.fromEntries(Object.entries(observation.modes).filter(([, on]) => on));
  if (out.events) out.events = Object.fromEntries(Object.entries(observation.events).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(quiet.events[key as 'bell' | 'osc52'])));
  return out;
}

/** The full observation a sparse `expect` stands for. */
export function dense(expect: Partial<Observation>): Observation {
  return {...quiet, ...expect, modes: {...quiet.modes, ...expect.modes}, events: {...quiet.events, ...expect.events}} as Observation;
}

export type Step = {write: string} | {writeBase64: string} | {writeFile: string} | {resize: [number, number]} | {paste: string};

/** Fixtures live in packages/terminal-runtime/fixtures; `writeFile` paths are relative to it. */
export const fixturesDir = join(__dirname, '../../../packages/terminal-runtime/fixtures');

export type Fixture = {
  id: string; about: string; cols: number; rows: number; scrollback: number;
  steps: Step[]; probes?: [number, number][];
  expect: Partial<Observation>;
  /** Where the core knowingly differs: ids into fixtures/divergences.json and the core's expected values. */
  core?: {divergence: string[]; expect: Partial<Observation>};
};

const encoder = new TextEncoder();

export function stepBytes(step: Step): Uint8Array | undefined {
  if ('write' in step) return encoder.encode(step.write);
  if ('writeBase64' in step) return new Uint8Array(Buffer.from(step.writeBase64, 'base64'));
  if ('writeFile' in step) return new Uint8Array(readFileSync(join(fixturesDir, step.writeFile)));
  return undefined;
}

// xterm colour modes: 0 default, 16777216 = 16-colour palette, 33554432 = 256 palette, 50331648 = RGB.
function color(mode: number, value: number): string {
  if (mode === 0) return 'default';
  if (mode === 50331648) return `rgb:${value.toString(16).padStart(6, '0')}`;
  return `p:${value}`;
}

/** jsdom has no matchMedia, which xterm's `open` needs. */
function mountable() {
  window.matchMedia ??= ((query: string) => ({matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}})) as never;
}

export async function observeXterm(fixture: Pick<Fixture, 'cols' | 'rows' | 'scrollback' | 'steps' | 'probes'>): Promise<Observation> {
  // The app's constructor options apart from rendering: no Unicode addon, allowProposedApi false.
  const term = new Terminal({cols: fixture.cols, rows: fixture.rows, scrollback: fixture.scrollback, allowProposedApi: false});
  let data = '';
  term.onData(chunk => { data += chunk; });
  const events = {bell: 0, osc52: [] as string[]};
  term.onBell(() => { events.bell += 1; });
  term.parser.registerOscHandler(52, payload => { events.osc52.push(payload); return true; });
  // The app's terminal is always mounted, and only a mounted one has a theme to answer colour queries with and a
  // helper textarea to paste into (jsdom has no matchMedia).
  mountable();
  term.open(document.createElement('div'));
  for (const step of fixture.steps) {
    const bytes = stepBytes(step);
    if (bytes) await new Promise<void>(done => term.write(bytes, done));
    else if ('resize' in step) term.resize(step.resize[0], step.resize[1]);
    else if ('paste' in step) term.paste(step.paste);
  }
  const buffer = term.buffer.active;
  const lines = Array.from({length: term.rows}, (_, y) => buffer.getLine(buffer.viewportY + y)!.translateToString(true, 0, term.cols).trimEnd());
  const cells = (fixture.probes ?? []).map(([x, y]): CellObservation => {
    const cell = buffer.getLine(buffer.viewportY + y)!.getCell(x)!;
    const flags = ([
      ['bold', cell.isBold()], ['italic', cell.isItalic()], ['underline', cell.isUnderline()], ['inverse', cell.isInverse()],
      ['faint', cell.isDim()], ['strikethrough', cell.isStrikethrough()], ['invisible', cell.isInvisible()], ['blink', cell.isBlink()],
    ] as const).filter(([, on]) => on).map(([name]) => name);
    return {x, y, text: cell.getChars(), width: cell.getWidth(), fg: color(cell.getFgColorMode(), cell.getFgColor()), bg: color(cell.getBgColorMode(), cell.getBgColor()), flags};
  });
  const observation: Observation = {
    lines,
    cursor: {x: buffer.cursorX, y: buffer.cursorY},
    buffer: buffer.type,
    modes: {
      bracketedPaste: term.modes.bracketedPasteMode,
      applicationCursorKeys: term.modes.applicationCursorKeysMode,
      mouseTracking: term.modes.mouseTrackingMode !== 'none',
      sendFocus: term.modes.sendFocusMode,
    },
    scrollbackRows: term.buffer.normal.length - term.rows,
    cells,
    data,
    events,
  };
  term.dispose();
  return observation;
}

export type KeyFixture = {
  id: string; about: string; setup: string; key: string; code: string; keyCode: number;
  mods: ('shift' | 'alt' | 'ctrl' | 'meta')[];
  /** Bytes xterm sends to the host. */
  expect: string;
  core?: {divergence: string[]; expect: string};
};

/** A real key press on a mounted terminal: what xterm's own keyboard handling puts on the wire. */
export async function observeXtermKey(fixture: Pick<KeyFixture, 'setup' | 'key' | 'code' | 'keyCode' | 'mods'>): Promise<string> {
  mountable();
  const term = new Terminal({cols: 20, rows: 4, allowProposedApi: false});
  term.open(document.createElement('div'));
  await new Promise<void>(done => term.write(fixture.setup, done));
  let sent = '';
  term.onData(chunk => { sent += chunk; });
  const event = new KeyboardEvent('keydown', {
    key: fixture.key, code: fixture.code, keyCode: fixture.keyCode, bubbles: true, cancelable: true,
    shiftKey: fixture.mods.includes('shift'), altKey: fixture.mods.includes('alt'),
    ctrlKey: fixture.mods.includes('ctrl'), metaKey: fixture.mods.includes('meta'),
  });
  term.textarea!.dispatchEvent(event);
  term.dispose();
  return sent;
}

/** Cell size in surface pixels, shared with the core's side so pixel positions mean the same to both. */
export const mouseCell = {width: 10, height: 20};

/**
 * A mouse event as `<type> <button> <col>,<row>[ <mods>][ @<x>,<y>]`: type press, release, motion or wheel;
 * button left, middle, right, none, up, down, left or right (wheel directions); 0-based cell; mods joined by
 * `+` from shift, alt, ctrl; optional surface pixel (default the cell centre).
 */
export type MouseEventSpec = string;

export type ParsedMouseEvent = {type: string; button: string; col: number; row: number; mods: string[]; x: number; y: number};

export function parseMouseEvent(spec: MouseEventSpec): ParsedMouseEvent {
  const [type, button, cell, ...rest] = spec.split(' ');
  const [col, row] = cell.split(',').map(Number);
  const pixel = rest.find(part => part.startsWith('@'))?.slice(1).split(',').map(Number);
  const mods = rest.find(part => !part.startsWith('@'))?.split('+') ?? [];
  return {type, button, col, row, mods, x: pixel?.[0] ?? col * mouseCell.width + mouseCell.width / 2, y: pixel?.[1] ?? row * mouseCell.height + mouseCell.height / 2};
}

export type MouseFixture = {
  id: string; about: string; cols: number; rows: number;
  /** Written first: the escape sequences that enable the protocol and encoding. */
  setup: string;
  events: MouseEventSpec[];
  /** What xterm sends for each event, one string per event, one character per byte. */
  expect: string[];
  core?: {divergence: string[]; expect: string[]};
};

// xterm's CoreMouseButton (left 0, middle 1, right 2, none 3, wheel 4) and CoreMouseAction (up 0, down 1, left 2, right 3, move 32).
const xtermButton: Record<string, number> = {left: 0, middle: 1, right: 2, none: 3};
const xtermWheel: Record<string, number> = {up: 0, down: 1, left: 2, right: 3};

/**
 * xterm's own encoder: the events go to its CoreMouseService, which `bindMouse` feeds from DOM events. jsdom
 * has no layout, so the DOM-to-cell conversion (and the wheel-delta-to-direction one) is not exercised.
 */
export async function observeXtermMouse(fixture: Pick<MouseFixture, 'cols' | 'rows' | 'setup' | 'events'>): Promise<string[]> {
  const term = new Terminal({cols: fixture.cols, rows: fixture.rows, allowProposedApi: false});
  await new Promise<void>(done => term.write(fixture.setup, done));
  const mouse = (term as unknown as {_core: {coreMouseService: {triggerMouseEvent(event: object): boolean}}})._core.coreMouseService;
  let sent = '';
  term.onData(chunk => { sent += chunk; });
  term.onBinary(chunk => { sent += chunk; });
  const reports = fixture.events.map(spec => {
    const event = parseMouseEvent(spec);
    const wheel = event.type === 'wheel';
    sent = '';
    mouse.triggerMouseEvent({
      col: event.col, row: event.row, x: event.x, y: event.y,
      button: wheel ? 4 : xtermButton[event.button],
      action: wheel ? xtermWheel[event.button] : ({release: 0, press: 1, motion: 32} as Record<string, number>)[event.type],
      shift: event.mods.includes('shift'), alt: event.mods.includes('alt'), ctrl: event.mods.includes('ctrl'),
    });
    return sent;
  });
  term.dispose();
  return reports;
}
