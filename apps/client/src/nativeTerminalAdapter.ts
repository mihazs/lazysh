import type {NativeCoreBridge, NativeCoreEvent, NativeCoreSnapshot} from './nativeCoreBridge';
import {cellsOf, sliceColumns} from './nativeRowText';
import type {
  Disposable, TerminalAdapter, TerminalBounds, TerminalCapabilities, TerminalCell, TerminalEvent, TerminalInputOrigin,
  TerminalMountTarget, TerminalRange, TerminalScrollAction, TerminalSearchHit, TerminalSelection, TerminalSize, TerminalViewport,
} from './terminalAdapter';
import {TerminalEvents} from './terminalEvents';
import {searchRows} from './terminalText';

/** Honest for a core without a renderer: it parses, scrolls and answers questions about the screen, and draws nothing. */
export const nativeCapabilities: TerminalCapabilities = {
  nativeRendering: false, selection: true, scrollback: true, mouseReporting: false, ime: false, accessibility: false,
  screenInspection: true, canonicalMoshResize: false, customBoldColor: false,
};

/** Longest pause between two pulls of the core's state, so IPC calls follow the screen's refresh rate and not the output volume. */
const REFRESH_MS = 16;
const noop = () => {};

export type NativeAdapterOptions = {refreshMs?: number};

/**
 * The native backend: the terminal's state lives in a Rust core behind a {@link NativeCoreBridge}. The adapter keeps a
 * mirror (the state plus the text of a bounded window of rows) so the contract's synchronous readers need no round trip;
 * every command answers with a fresh mirror and the commands run in order. Rows outside the window read as empty, and
 * search and selection text work on the window until the core owns them (#1320).
 */
export class NativeTerminalAdapter implements TerminalAdapter {
  readonly backend = 'native' as const;
  readonly capabilities = nativeCapabilities;
  readonly dataPath: 'renderer' | 'runtime';
  write?: TerminalAdapter['write'];
  private mirror: NativeCoreSnapshot;
  private selected: TerminalRange | undefined;
  private anchor: HTMLElement | undefined;
  private active = true;
  private disposed: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<(error: Error) => void>();
  private readonly events = new TerminalEvents();
  private readonly source: Disposable;
  private pulling = false;
  private again = false;
  private stale = false;

  constructor(private readonly bridge: NativeCoreBridge, initial: NativeCoreSnapshot, private readonly options: NativeAdapterOptions = {}) {
    this.mirror = initial;
    this.dataPath = bridge.feed ? 'renderer' : 'runtime';
    if (bridge.feed) this.write = (bytes, onApplied) => this.feed(bytes, onApplied);
    this.source = bridge.subscribe(event => this.onCore(event));
  }

  async attach(target: TerminalMountTarget) {
    if (this.disposed) throw new Error('This terminal is disposed.');
    const anchor = target.kind === 'native' ? document.getElementById(target.anchorId) : target.element;
    if (!anchor) throw new Error('The native terminal anchor is not mounted.');
    this.anchor = anchor;
  }

  async detach() { this.anchor = undefined; }

  setActive(active: boolean) {
    this.active = active;
    this.bridge.setActive?.(active);
    if (active && this.stale) this.ring();
  }

  dispose() {
    if (this.disposed) return this.disposed;
    this.source.dispose(); this.events.clear(); this.anchor = undefined;
    const error = new Error('This terminal was disposed before the bytes were applied.');
    this.pending.forEach(reject => reject(error)); this.pending.clear();
    // Queued commands finish first: closing the core under one would turn its answer into an error.
    return this.disposed = this.queue.then(() => this.bridge.close()).catch(noop);
  }

  /** Commands go to the core one at a time, in the order they were issued, whatever their latency. */
  private command(run: () => Promise<NativeCoreSnapshot>) {
    const result = this.queue.then(run);
    this.queue = result.catch(noop);
    return result;
  }

  private feed(bytes: Uint8Array, onApplied?: () => void) {
    if (this.disposed) return Promise.reject(new Error('This terminal is disposed.'));
    const applied = new Promise<void>((resolve, reject) => {
      this.pending.add(reject);
      this.command(() => this.bridge.feed!(bytes)).then(snapshot => {
        if (!this.pending.delete(reject)) return;
        this.apply(snapshot);
        this.emit({type: 'output'});
        onApplied?.();
        resolve();
      }, error => { if (this.pending.delete(reject)) reject(error); });
    });
    // Disposal rejects what it did not apply; a caller that dropped the promise must not see that as a crash.
    applied.catch(noop);
    return applied;
  }

  /** Replaces the mirror and reports what differs from it. */
  private apply(snapshot: NativeCoreSnapshot) {
    const before = this.mirror.state;
    this.mirror = snapshot;
    const {state} = snapshot;
    if (state.columns !== before.columns || state.rows !== before.rows) this.emit({type: 'geometry', size: {columns: state.columns, rows: state.rows}, authority: 'local'});
    if (JSON.stringify(state.viewport) !== JSON.stringify(before.viewport)) this.emit({type: 'viewport', viewport: state.viewport});
    if (JSON.stringify(state.modes) !== JSON.stringify(before.modes)) this.emit({type: 'modes', modes: state.modes});
    snapshot.events?.forEach(event => this.onCore(event));
  }

  private onCore(event: NativeCoreEvent) {
    if (event.type === 'changed') this.ring(); else this.emit(event);
  }

  /** The core says the screen changed: pull its state at most once per refresh interval, and not at all while inactive. */
  private ring() {
    if (!this.active) { this.stale = true; return; }
    if (this.pulling) { this.again = true; return; }
    this.pulling = true; this.stale = false;
    this.command(() => this.bridge.snapshot()).then(snapshot => { this.apply(snapshot); this.emit({type: 'output'}); }, noop)
      .then(() => new Promise(resolve => setTimeout(resolve, this.options.refreshMs ?? REFRESH_MS)))
      .then(() => { this.pulling = false; if (this.again) { this.again = false; this.ring(); } });
  }

  sendInput(data: string | Uint8Array, origin: TerminalInputOrigin) {
    // A refused write (input gated, app locked) is dropped by the transport on purpose: a stale key must not arrive later.
    this.bridge.input(data, origin).catch(noop);
  }

  paste(text: string) {
    const body = text.replace(/\r?\n/g, '\r');
    // The end marker is stripped inside a bracketed paste: pasted text must not be able to end it.
    this.sendInput(this.mirror.state.modes.bracketedPaste ? `\x1b[200~${body.replaceAll('\x1b[201~', '')}\x1b[201~` : body, 'paste');
  }

  requestSize({columns, rows}: TerminalSize) {
    // An intent: the mirror follows at once (the contract reads it synchronously) and the core's answer replaces it.
    const {state} = this.mirror;
    this.mirror = {...this.mirror, state: {...state, columns, rows, viewport: {...state.viewport, rows}}};
    this.emit({type: 'geometry', size: {columns, rows}, authority: 'local'});
    this.emit({type: 'resizeIntent', size: {columns, rows}});
    const {resize} = this.bridge;
    if (resize) this.command(() => resize.call(this.bridge, {columns, rows})).then(snapshot => this.apply(snapshot), noop);
  }

  size() { return {columns: this.mirror.state.columns, rows: this.mirror.state.rows}; }

  screenBounds(): TerminalBounds | undefined {
    const rect = this.anchor?.getBoundingClientRect();
    return rect && {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  }

  metrics() {
    const {columns, rows, scrollbackLines} = this.mirror.state, rect = this.screenBounds();
    return {columns, rows, cellWidth: rect && columns ? rect.width / columns : 0, cellHeight: rect && rows ? rect.height / rows : 0, scrollbackLines};
  }

  applyPreferences() { /* The renderer applies fonts and colours; the core has no use for them. */ }

  scroll(action: TerminalScrollAction) {
    const {state} = this.mirror, {top, rows, length} = state.viewport, last = Math.max(0, length - rows);
    const clamp = (row: number) => Math.min(last, Math.max(0, row));
    const next = clamp(action.kind === 'lines' ? top + action.delta : action.kind === 'pages' ? top + action.delta * (rows - 1)
      : action.kind === 'toTop' ? 0 : action.kind === 'toBottom' ? last : action.row);
    if (next !== top) {
      const viewport = {...state.viewport, top: next, following: next >= last};
      this.mirror = {...this.mirror, state: {...state, viewport}};
      this.emit({type: 'viewport', viewport});
    }
    this.command(() => this.bridge.scroll(action)).then(snapshot => this.apply(snapshot), noop);
  }

  viewport(): TerminalViewport { return this.mirror.state.viewport; }
  atLiveScreen() { return !this.mirror.state.modes.alternateScreen && this.mirror.state.viewport.following; }
  modes() { return this.mirror.state.modes; }
  cursor() { return this.mirror.state.cursor; }
  followLive() { if (!this.mirror.state.viewport.following) this.scroll({kind: 'toBottom'}); }

  wheel({deltaY, unit}: Parameters<TerminalAdapter['wheel']>[0]) {
    // Mouse reports for programs that track the mouse come with the input slice (#1334); scrolling is what a wheel does otherwise.
    if (this.mirror.state.modes.mouseTracking !== 'none') return;
    const lines = unit === 'line' ? deltaY : deltaY / (this.metrics().cellHeight || 16);
    this.scroll({kind: 'lines', delta: Math.round(lines) || Math.sign(lines)});
  }

  private rowText(row: number) {
    const {first, rows} = this.mirror.window;
    return rows[row - first] ?? '';
  }

  readRows(first: number, count: number, columns?: {start: number; end: number}) {
    return Array.from({length: Math.max(0, count)}, (_, i) => {
      const text = this.rowText(first + i);
      return columns ? sliceColumns(text, columns.start, columns.end) : text;
    });
  }

  search(query: string, direction: 1 | -1, from?: number): TerminalSearchHit | undefined {
    return searchRows(this.mirror.state.viewport.length, row => this.rowText(row), query, direction, from);
  }

  cellAt(clientX: number, clientY: number): TerminalCell | undefined {
    const rect = this.screenBounds(), {columns, rows, viewport} = this.mirror.state;
    if (!rect || rect.width <= 0 || rect.height <= 0 || columns <= 0 || rows <= 0) return;
    const column = Math.floor((clientX - rect.left) / (rect.width / columns)), row = Math.floor((clientY - rect.top) / (rect.height / rows));
    if (!Number.isFinite(column) || !Number.isFinite(row)) return;
    return {x: Math.min(columns - 1, Math.max(0, column)), y: viewport.top + Math.min(rows - 1, Math.max(0, row))};
  }

  getSelection(): TerminalSelection | undefined { return this.selected && {range: this.selected, text: this.selectedText()}; }
  hasSelection() { return !!this.selected; }
  selectionRange() { return this.selected; }

  selectedText() {
    const range = this.selected;
    if (!range) return '';
    const {columns} = this.mirror.state, lines: string[] = [];
    for (let y = range.start.y; y <= range.end.y; y++) {
      lines.push(sliceColumns(this.rowText(y), y === range.start.y ? range.start.x : 0, (y === range.end.y ? range.end.x : columns - 1) + 1));
    }
    return lines.join('\n');
  }

  select(range: TerminalRange) { this.selected = range; this.emit({type: 'selection', range}); }

  /** The run of non-blank cells under the finger, or that single cell. A wide character's second cell belongs to its word. */
  selectWordAt(cell: TerminalCell): TerminalRange {
    const cells = cellsOf(this.rowText(cell.y)), inWord = (x: number) => x >= 0 && x < cells.length && (cells[x] === '' || /\S/.test(cells[x]));
    if (!inWord(cell.x)) return {start: cell, end: cell};
    let start = cell.x, end = cell.x;
    while (inWord(start - 1)) start--;
    while (end < this.mirror.state.columns - 1 && inWord(end + 1)) end++;
    return {start: {x: start, y: cell.y}, end: {x: end, y: cell.y}};
  }

  selectAll() { this.select({start: {x: 0, y: 0}, end: {x: this.mirror.state.columns - 1, y: this.mirror.state.viewport.length - 1}}); }

  clearSelection() {
    if (!this.selected) return;
    this.selected = undefined;
    this.emit({type: 'selection', range: undefined});
  }

  // No renderer draws yet, so there is no DOM to lay out, no editor to type into and no key to intercept (#1327, #1328).
  inputElement() { return undefined; }
  screenElement() { return undefined; }
  layoutRowHeight() { return 0; }
  proposeSize(): TerminalSize | undefined { return undefined; }
  fit() {}
  syncViewport() {}
  interceptKeys(): Disposable { return {dispose: noop}; }
  registerLinks(): Disposable { return {dispose: noop}; }
  focus() {}
  blur() {}

  subscribe(listener: (event: TerminalEvent) => void, types?: readonly TerminalEvent['type'][]): Disposable {
    return this.disposed ? {dispose: noop} : this.events.add(listener, types);
  }

  private emit(event: TerminalEvent) { this.events.emit(event); }
}

/** The native terminal of one new session over its core. */
export async function openNativeTerminalAdapter(bridge: NativeCoreBridge, options?: NativeAdapterOptions): Promise<NativeTerminalAdapter> {
  return new NativeTerminalAdapter(bridge, await bridge.snapshot(), options);
}
