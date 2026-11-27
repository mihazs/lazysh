import {isAndroidApp} from './isAndroidApp';
import type {CoreMouseInput, NativeCoreBridge, NativeCoreEvent, NativeCoreLink, NativeCoreQuery, NativeCoreSnapshot} from './nativeCoreBridge';
import {NativeCanonicalResize} from './nativeCanonicalResize';
import {attachLinkTaps, type LinkHandlers} from './nativeLinkTap';
import {NativeInputCapture} from './nativeInputCapture';
import {SurfaceInput} from './nativeSurfaceInput';
import {attachPointerSelection} from './nativePointerSelection';
import {cellsOf, sliceColumns} from './nativeRowText';
import type {
  CanonicalResize, Disposable, RuntimeTransport, TerminalAdapter, TerminalBounds, TerminalCapabilities, TerminalCell, TerminalEvent, TerminalInputOrigin,
  TerminalMountTarget, TerminalPreferences, TerminalRange, TerminalScrollAction, TerminalSearchHit, TerminalSelection, TerminalSize, TerminalTheme,
  TerminalViewport,
} from './terminalAdapter';
import {TerminalEvents} from './terminalEvents';
import type {CoreKeyInput} from './terminalPlatformKeys';
import {shareImportedFonts} from './nativeFonts';
import {nativeSurface, type CellSize, type SurfaceLook} from './terminalSurfaceAnchor';
import {searchRows} from './terminalText';

/** Honest for a core without a renderer (`ime` is xterm.js' input observation and `mouseReporting` is its DOM wheel dispatch, which this backend does not have: its keyboards are the capture and the Android input view, and its wheel reports go to the core): it parses, scrolls and answers questions about the screen, and draws nothing. `canonicalMoshResize` holds for a core that follows Mosh's frames (`NativeCoreBridge.canonicalFrames`); `enableCanonicalResize` refuses one that cannot. */
export const nativeCapabilities: TerminalCapabilities = {
  nativeRendering: false, selection: true, scrollback: true, mouseReporting: false, ime: false, accessibility: false,
  screenInspection: true, canonicalMoshResize: true, customBoldColor: true,
};

/** Longest pause between two pulls of the core's state, so IPC calls follow the screen's refresh rate and not the output volume. */
const REFRESH_MS = 16;
const noop = () => {};

export type NativeAdapterOptions = {
  refreshMs?: number;
  /** The theme the core was opened with, so `applyPreferences` tells the core only about a change. */
  theme?: TerminalTheme;
  /** How a surface's session is told its look (`native_terminal_surface_look`); injected by tests. */
  look?: (session: string, look: SurfaceLook) => Promise<unknown>;
  /** The renderer's cell for a font size and a display density (`native_terminal_surface_cell`); injected by tests. */
  cell?: (fontSize: number, dpr: number) => Promise<CellSize>;
};

/** The most columns or rows the transport takes (`check_size` in the shell). */
const MAX_GRID = 1000;

/**
 * The native backend: the terminal's state lives in a Rust core behind a {@link NativeCoreBridge}. The adapter keeps a
 * mirror (the state plus the text of a bounded window of rows) so the contract's synchronous readers need no round trip;
 * every command answers with a fresh mirror and the commands run in order. Rows outside the window read as empty.
 * A core that answers questions about its text (`bridge.query`, #1320) is asked for the selected text, which then
 * replaces what the window gave, and for `searchBuffer`; the synchronous readers answer from the window meanwhile,
 * and always for a core without queries.
 */
export class NativeTerminalAdapter implements TerminalAdapter {
  readonly backend = 'native' as const;
  /** A mounted screen-reader mirror is what makes the rows reachable, so `accessibility` holds only while one is. */
  get capabilities(): TerminalCapabilities { return this.mirrored ? {...nativeCapabilities, accessibility: true} : nativeCapabilities; }
  readonly dataPath: 'renderer' | 'runtime';
  transport?: RuntimeTransport;
  write?: TerminalAdapter['write'];
  searchBuffer?: TerminalAdapter['searchBuffer'];
  private mirror: NativeCoreSnapshot;
  private selected: TerminalRange | undefined;
  /** The selected text as the core read it; undefined until it answers for the current selection. */
  private coreText: string | undefined;
  private asking = false;
  private askAgain = false;
  private anchor: HTMLElement | undefined;
  private capture: {readonly element?: HTMLTextAreaElement; focus(): void; blur(): void; dispose(): void} | undefined;
  private pointer: Disposable | undefined;
  private links: LinkHandlers | undefined;
  private taps: Disposable | undefined;
  private interceptor: ((event: KeyboardEvent) => boolean) | undefined;
  private preferences: TerminalPreferences | undefined;
  /** The session the shell's surface is under (only a pane with a surface has a renderer), and the look it was last sent (as JSON) and the commands that carry it, in order. */
  private surface: string | undefined;
  private looked: string | undefined;
  private lookQueue: Promise<unknown> = Promise.resolve();
  /** The renderer's cell for the font size and display density `key` names, as the shell last answered, and the key asked for last: its cell sizes the grid. */
  private cell: (CellSize & {dpr: number; key: string}) | undefined;
  private cellKey: string | undefined;
  private active = true;
  private disposed: Promise<void> | undefined;
  /** Set once a Mosh session asked for it: the transport's frames decide the grid and `requestSize` is an intent. */
  private canonical: NativeCanonicalResize | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<(error: Error) => void>();
  private readonly events = new TerminalEvents();
  private readonly source: Disposable;
  private pulling = false;
  private again = false;
  private stale = false;
  private mirrored = false;
  /** The theme the core reports, as JSON: preferences hand over a new object whenever anything changes. */
  private theme: string | undefined;
  /** The History lines the core was last told to keep, so a preference change that leaves it alone sends nothing. */
  private history: number;

  constructor(private readonly bridge: NativeCoreBridge, initial: NativeCoreSnapshot, private readonly options: NativeAdapterOptions = {}) {
    this.mirror = initial;
    this.theme = options.theme && JSON.stringify(options.theme);
    this.history = initial.state.scrollbackLines;
    this.dataPath = bridge.feed ? 'renderer' : 'runtime';
    if (bridge.feed) this.write = (bytes, onApplied) => this.feed(bytes, onApplied);
    if (bridge.query) this.searchBuffer = async (query, direction, from) => {
      if (this.disposed) return undefined;
      return await this.ask({kind: 'search', query, direction: direction > 0 ? 'forward' : 'backward', from}) ?? undefined;
    };
    this.source = bridge.subscribe(event => this.onCore(event));
  }

  async attach(target: TerminalMountTarget) {
    if (this.disposed) throw new Error('This terminal is disposed.');
    const anchor = target.kind === 'native' ? document.getElementById(target.anchorId) : target.element;
    if (!anchor) throw new Error('The native terminal anchor is not mounted.');
    this.anchor = anchor;
    this.surface = target.kind === 'native' ? target.surface : undefined;
    this.sendLook();
    this.measure();
    this.capture?.dispose(); this.pointer?.dispose();
    this.pointer = attachPointerSelection(this, anchor, target.kind !== 'native' || target.touchSelection !== 'pane');
    this.tapLinks();
    // Android types through a native input connection (#1328), not a DOM editor.
    const preferences = () => this.preferences;
    this.capture = isAndroidApp() ? (target.kind === 'native' && target.surface ? new SurfaceInput(this, target.surface, anchor, preferences) : undefined) : new NativeInputCapture(this, anchor, {intercepts: event => this.interceptor?.(event) === false, preferences});
  }

  async detach() { this.capture?.dispose(); this.pointer?.dispose(); this.taps?.dispose(); this.pointer = this.capture = this.taps = this.anchor = undefined; }

  screenReaderMirrored(): Disposable {
    this.mirrored = true;
    return {dispose: () => { this.mirrored = false; }};
  }

  setActive(active: boolean) {
    if (this.disposed) return;
    this.active = active;
    this.bridge.setActive?.(active);
    if (active && this.stale) this.ring();
  }

  dispose() {
    if (this.disposed) return this.disposed;
    this.source.dispose(); this.capture?.dispose(); this.pointer?.dispose(); this.canonical?.dispose(); this.taps?.dispose(); this.events.clear(); this.anchor = this.capture = this.pointer = this.taps = this.links = undefined;
    const error = new Error('This terminal was disposed before the bytes were applied.');
    this.pending.forEach(reject => reject(error)); this.pending.clear();
    // Queued commands finish first: closing the core under one would turn its answer into an error.
    return this.disposed = this.queue.then(() => this.bridge.close()).catch(noop);
  }

  /** Commands go to the core one at a time, in the order they were issued, whatever their latency. */
  private command<T>(run: () => Promise<T>) {
    const result = this.queue.then(run);
    this.queue = result.catch(noop);
    return result;
  }

  /** A question for the core, asked after the commands already issued, so the answer includes what they wrote. */
  private ask<Q extends NativeCoreQuery>(query: Q) { return this.command(() => this.bridge.query!(query)); }

  /** Asks the core for the selected text, one question at a time; the latest selection and screen are asked again when it answers. */
  private readSelection() {
    const range = this.selected;
    if (!range || !this.bridge.query || this.disposed) return;
    if (this.asking) { this.askAgain = true; return; }
    this.asking = true;
    // shortcut: output under a selection re-reads all of its text; ask only for the rows that changed if a large selection held during heavy output costs too much.
    this.ask({kind: 'selectionText', range}).then(text => { if (this.selected === range) this.coreText = text; }, noop)
      .then(() => { this.asking = false; if (this.askAgain) { this.askAgain = false; this.readSelection(); } });
  }

  /** Output was applied: the mirror is replaced and the rows under a selection may read differently. */
  private applyOutput(snapshot: NativeCoreSnapshot) {
    this.apply(snapshot);
    this.readSelection();
    this.emit({type: 'output'});
  }

  private feed(bytes: Uint8Array, onApplied?: () => void) {
    if (this.disposed) return Promise.reject(new Error('This terminal is disposed.'));
    const applied = new Promise<void>((resolve, reject) => {
      this.pending.add(reject);
      this.command(() => this.bridge.feed!(bytes)).then(snapshot => {
        if (!this.pending.delete(reject)) return;
        try {
          this.applyOutput(snapshot);
          onApplied?.();
          resolve();
        } catch (error) { reject(error); }
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
    if (state.columns !== before.columns || state.rows !== before.rows) this.emit({type: 'geometry', size: {columns: state.columns, rows: state.rows}, authority: this.canonical ? 'transport' : 'local'});
    if (JSON.stringify(state.viewport) !== JSON.stringify(before.viewport)) this.emit({type: 'viewport', viewport: state.viewport});
    if (JSON.stringify(state.modes) !== JSON.stringify(before.modes)) this.emit({type: 'modes', modes: state.modes});
  }

  private onCore(event: NativeCoreEvent) {
    if (event.type === 'changed') this.ring();
    else if (event.type === 'failure') this.canonical?.fail(event.reason);
    else this.emit(event);
  }

  /** The core says the screen changed: pull its state at most once per refresh interval, and not at all while inactive. */
  private ring() {
    if (this.disposed) return;
    if (!this.active) { this.stale = true; return; }
    if (this.pulling) { this.again = true; return; }
    this.pulling = true; this.stale = false;
    this.command(() => this.bridge.snapshot()).then(snapshot => this.applyOutput(snapshot), noop)
      .catch(noop)
      .then(() => new Promise(resolve => setTimeout(resolve, this.options.refreshMs ?? REFRESH_MS)))
      .then(() => { this.pulling = false; if (this.again) { this.again = false; this.ring(); } });
  }

  afterSurfaceInput(action: () => Promise<void>) {
    if (!(this.capture instanceof SurfaceInput)) return false;
    this.capture.afterInput(() => this.command(action));
    return true;
  }

  sendInput(data: string | Uint8Array, origin: TerminalInputOrigin) {
    // Typing clears the selection, as xterm.js' selection service does on user input; a terminal's reply is not typing.
    if (origin !== 'terminal-reply') this.clearSelection();
    // What the soft keyboard types takes the toolbar's armed Ctrl or Alt; a paste, a reply and a pointer's text do not.
    const typed = this.modifier && (origin === 'ime' || origin === 'keyboard') && typeof data === 'string' ? this.modifier(data) : data;
    this.send(() => this.bridge.input(typed, origin));
  }

  private modifier: ((typed: string) => string) | undefined;
  setInputModifier(modifier: ((typed: string) => string) | undefined) { this.modifier = modifier; }

  /** A key as the DOM reports it, for the core to encode for the modes the program set; `sendInput` carries text. */
  sendKey(input: CoreKeyInput) {
    if (!input.release) this.clearSelection();
    this.send(() => this.bridge.key(input));
  }

  private send(run: () => Promise<void>) {
    // A refused write (input gated, app locked) is dropped by the transport on purpose: a stale key must not arrive later.
    if (this.disposed) return;
    this.queue = this.queue.then(() => this.disposed ? undefined : run()).catch(noop);
  }

  paste(text: string) {
    const body = text.replace(/\r?\n/g, '\r');
    // The end marker is stripped inside a bracketed paste: pasted text must not be able to end it.
    this.sendInput(this.mirror.state.modes.bracketedPaste ? `\x1b[200~${body.replaceAll('\x1b[201~', '')}\x1b[201~` : body, 'paste');
  }

  /** Mosh: the core was opened to follow the frames' sizes; from now on a size asked for is an intent for the transport, and a frame the core refuses fails the display. Call it before the transport's first output. */
  enableCanonicalResize(): CanonicalResize {
    const {canonicalFrames} = this.bridge;
    if (this.disposed || !canonicalFrames) throw new Error('This terminal cannot apply canonical Mosh resizing.');
    if (this.canonical) return this.canonical;
    // The barrier is a no-op command: it answers after every command issued before it.
    const canonical = this.canonical = new NativeCanonicalResize(() => this.command(async () => {}), reason => this.emit({type: 'failure', reason}));
    canonical.onResizeIntent(({cols, rows}) => this.emit({type: 'resizeIntent', size: {columns: cols, rows}}));
    // Ahead of any output that follows, whatever the core's latency; a core that cannot follow the frames cannot show the session.
    this.command(() => canonicalFrames.call(this.bridge)).catch(() => canonical.fail('invalid-frame'));
    return canonical;
  }

  requestSize({columns, rows}: TerminalSize) {
    if (this.disposed) return;
    if (this.canonical) return this.canonical.requestSize(columns, rows);
    // An intent: the mirror follows at once (the contract reads it synchronously) and the core's answer replaces it.
    const {state} = this.mirror;
    this.mirror = {...this.mirror, state: {...state, columns, rows, viewport: {...state.viewport, rows}}};
    this.emit({type: 'geometry', size: {columns, rows}, authority: 'local'});
    this.emit({type: 'resizeIntent', size: {columns, rows}});
    const {resize} = this.bridge;
    if (resize) this.command(() => resize.call(this.bridge, {columns, rows})).then(snapshot => this.apply(snapshot)).catch(noop);
  }

  size() { return {columns: this.mirror.state.columns, rows: this.mirror.state.rows}; }

  screenBounds(): TerminalBounds | undefined {
    const rect = this.anchor?.getBoundingClientRect();
    return rect && {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  }

  metrics() {
    const {columns, rows, scrollbackLines} = this.mirror.state, rect = this.screenBounds(), {cell} = this;
    return {columns, rows, cellWidth: cell ? cell.width / cell.dpr : rect && columns ? rect.width / columns : 0, cellHeight: cell ? cell.height / cell.dpr : rect && rows ? rect.height / rows : 0, scrollbackLines};
  }

  /** The key the renderer's cell is asked and kept under: it depends on the font size and the display density. */
  private cellFor() { return this.preferences && `${this.preferences.fontSize}@${window.devicePixelRatio}`; }

  /** Asks the shell for the renderer's cell once for each font size and display density, and fits the grid when it answers. */
  private measure() {
    const {surface, preferences} = this, key = this.cellFor();
    if (!surface || !preferences || key === undefined || key === this.cellKey || this.disposed) return;
    this.cellKey = key;
    const dpr = window.devicePixelRatio;
    const refused = () => { if (this.cellKey === key) this.cellKey = undefined; };
    (this.options.cell ?? nativeSurface.cell)(preferences.fontSize, dpr).then(cell => {
      if (this.cellKey !== key || this.disposed) return;
      // A shell that answers with anything but a cell has no renderer to size the grid by.
      if (!(cell?.width > 0 && cell?.height > 0)) return refused();
      this.cell = {width: cell.width, height: cell.height, dpr, key};
      this.fit();
    }, refused);
  }

  /** The renderer's surface draws with the preferences that decide its look; it is told once for each change, and again if the shell refused. */
  private sendLook() {
    const {surface, preferences} = this;
    if (!surface || !preferences || this.disposed) return;
    const {theme, fontFamily, fontSize, cursorStyle, cursorBlink, brightBold, boldColor} = preferences;
    const look: SurfaceLook = {theme, fontFamily, fontSize, cursorStyle, cursorBlink, brightBold, boldColor};
    const sent = JSON.stringify(look);
    if (sent === this.looked) return;
    this.looked = sent;
    const send = this.options.look ?? nativeSurface.look;
    // The imported fonts its family list names reach the app first, so the look can name them.
    this.lookQueue = this.lookQueue.then(() => shareImportedFonts(look.fontFamily)).then(() => send(surface, look)).catch(() => { if (this.looked === sent) this.looked = undefined; });
  }

  /** The renderer applies fonts and colours; the input editor reads them for the preedit and `optionAsMeta` for its keys, and the core needs the theme to answer a program that asks what its colours are. */
  applyPreferences(preferences: TerminalPreferences) {
    this.preferences = preferences;
    this.sendLook();
    this.measure();
    this.followHistory(preferences);
    const next = JSON.stringify(preferences.theme);
    if (this.disposed || next === this.theme) return;
    this.theme = next;
    this.bridge.setTheme?.(preferences.theme);
  }

  /** The History lines setting reaches a session that is open; a refusal is tried again with the next preferences. */
  private followHistory({scrollbackLines}: TerminalPreferences) {
    const {setScrollback} = this.bridge, before = this.history;
    if (!setScrollback || this.disposed || scrollbackLines === before) return;
    this.history = scrollbackLines;
    this.command(() => setScrollback.call(this.bridge, scrollbackLines)).then(snapshot => this.apply(snapshot), () => { if (this.history === scrollbackLines) this.history = before; });
  }

  scroll(action: TerminalScrollAction) {
    if (this.disposed) return;
    const {state} = this.mirror, {top, rows, length} = state.viewport, last = Math.max(0, length - rows);
    const clamp = (row: number) => Math.min(last, Math.max(0, row));
    const next = clamp(action.kind === 'lines' ? top + action.delta : action.kind === 'pages' ? top + action.delta * (rows - 1)
      : action.kind === 'toTop' ? 0 : action.kind === 'toBottom' ? last : action.row);
    if (next !== top) {
      const viewport = {...state.viewport, top: next, following: next >= last};
      this.mirror = {...this.mirror, state: {...state, viewport}};
      this.emit({type: 'viewport', viewport});
    }
    this.command(() => this.bridge.scroll(action)).then(snapshot => this.apply(snapshot)).catch(noop);
  }

  viewport(): TerminalViewport { return this.mirror.state.viewport; }
  atLiveScreen() { return !this.mirror.state.modes.alternateScreen && this.mirror.state.viewport.following; }
  modes() { return this.mirror.state.modes; }
  cursor() { return this.mirror.state.cursor; }
  followLive() { if (!this.mirror.state.viewport.following) this.scroll({kind: 'toBottom'}); }

  /** Reports a mouse event to a program that tracks the mouse, in the cell under the point; false (nothing sent) when none does or the core takes no reports. */
  reportMouse(action: 'press' | 'release' | 'motion', button: CoreMouseInput['button'], clientX: number, clientY: number, modifiers?: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>) {
    const {mouse} = this.bridge;
    if (!mouse || this.mirror.state.modes.mouseTracking === 'none') return false;
    const cell = this.cellAt(clientX, clientY);
    const mods = {shift: !!modifiers?.shiftKey, ctrl: !!modifiers?.ctrlKey, alt: !!modifiers?.altKey, meta: !!modifiers?.metaKey};
    const input = {type: 'mouse' as const, action, button, mods,
      x: cell?.x ?? 0, y: cell ? cell.y - this.mirror.state.viewport.top : 0};
    this.send(() => mouse.call(this.bridge, input));
    return true;
  }

  wheel({clientX, clientY, deltaY, unit}: Parameters<TerminalAdapter['wheel']>[0], modifiers?: WheelEvent) {
    // A program that tracks the mouse gets a report per notch and nothing scrolls, as under xterm.js.
    if (this.mirror.state.modes.mouseTracking !== 'none') { if (deltaY) this.reportMouse('press', deltaY < 0 ? 'wheelUp' : 'wheelDown', clientX, clientY, modifiers); return; }
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
    const rect = this.screenBounds(), {columns, rows, viewport} = this.mirror.state, {cell} = this;
    if (!rect || rect.width <= 0 || rect.height <= 0 || columns <= 0 || rows <= 0) return;
    // The renderer draws whole cells from the pane's top left, so a pane that is not a whole number of them has a margin at the right and bottom.
    const column = Math.floor((clientX - rect.left) / (cell ? cell.width / cell.dpr : rect.width / columns)), row = Math.floor((clientY - rect.top) / (cell ? cell.height / cell.dpr : rect.height / rows));
    if (!Number.isFinite(column) || !Number.isFinite(row)) return;
    return {x: Math.min(columns - 1, Math.max(0, column)), y: viewport.top + Math.min(rows - 1, Math.max(0, row))};
  }

  getSelection(): TerminalSelection | undefined { return this.selected && {range: this.selected, text: this.selectedText()}; }
  hasSelection() { return !!this.selected; }
  selectionRange() { return this.selected; }

  selectedText() {
    const range = this.selected;
    if (!range) return '';
    if (this.coreText !== undefined) return this.coreText;
    const {columns} = this.mirror.state, lines: string[] = [];
    for (let y = range.start.y; y <= range.end.y; y++) {
      lines.push(sliceColumns(this.rowText(y), y === range.start.y ? range.start.x : 0, (y === range.end.y ? range.end.x : columns - 1) + 1));
    }
    return lines.join('\n');
  }

  select(range: TerminalRange) {
    this.selected = range; this.coreText = undefined;
    if (!this.disposed) this.bridge.select?.(range);
    this.readSelection();
    this.emit({type: 'selection', range});
  }

  /** The run of non-blank cells under the finger, or that single cell. A wide character's second cell belongs to its word. */
  selectWordAt(cell: TerminalCell): TerminalRange {
    const cells = cellsOf(this.rowText(cell.y)), inWord = (x: number) => x >= 0 && x < cells.length && (cells[x] === '' || /\S/.test(cells[x]));
    if (!inWord(cell.x)) return {start: cell, end: cell};
    let start = cell.x, end = cell.x;
    while (inWord(start - 1)) start--;
    while (end < this.mirror.state.columns - 1 && inWord(end + 1)) end++;
    const range = {start: {x: start, y: cell.y}, end: {x: end, y: cell.y}};
    this.refine(range, {kind: 'wordAt', cell});
    return range;
  }

  /** The whole row under a cell, or the wrapped line it belongs to once the core answers. */
  selectLineAt(row: number): TerminalRange {
    const range = {start: {x: 0, y: row}, end: {x: this.mirror.state.columns - 1, y: row}};
    this.refine(range, {kind: 'lineAt', row});
    return range;
  }

  selectAll() {
    const range = {start: {x: 0, y: 0}, end: {x: this.mirror.state.columns - 1, y: this.mirror.state.viewport.length - 1}};
    this.select(range);
    this.refine(range, {kind: 'bufferRange'});
  }

  /** The contract answers synchronously from the window; the core's answer replaces `guess` if that is still the selection (an empty buffer selects nothing). */
  private refine(guess: TerminalRange, query: NativeCoreQuery & {kind: 'wordAt' | 'lineAt' | 'bufferRange'}) {
    if (!this.bridge.query || this.disposed) return;
    this.ask(query).then(answer => {
      const now = this.selected;
      if (this.disposed || !now || JSON.stringify(now) !== JSON.stringify(guess)) return;
      if (!answer) this.clearSelection();
      else if (JSON.stringify(answer) !== JSON.stringify(guess)) this.select(answer);
    }, noop);
  }

  clearSelection() {
    if (!this.selected) return;
    this.selected = undefined; this.coreText = undefined;
    if (!this.disposed) this.bridge.select?.(undefined);
    this.emit({type: 'selection', range: undefined});
  }

  // The renderer draws on a surface, so there is no DOM to lay out (#1327). The typed-input editor is the capture's, on desktop and iOS.
  inputElement() { return this.capture?.element; }
  screenElement() { return undefined; }
  /** One row of the renderer's grid in layout pixels; 0 until the shell has said how big a cell is (and without a surface). */
  layoutRowHeight() { return this.cell ? this.cell.height / this.cell.dpr : 0; }

  /** The whole cells the pane holds at the renderer's cell size: the surface is `round(css * dpr)` device pixels, from which the renderer draws a grid of whole cells. */
  proposeSize(): TerminalSize | undefined {
    const rect = this.anchor?.getBoundingClientRect(), {cell} = this;
    // The cell of an earlier font size or density says nothing about the grid until the shell answers for the current one.
    if (!rect || !cell || cell.key !== this.cellFor()) return undefined;
    const columns = Math.min(MAX_GRID, Math.floor(Math.round(rect.width * cell.dpr) / cell.width)), rows = Math.min(MAX_GRID, Math.floor(Math.round(rect.height * cell.dpr) / cell.height));
    return columns > 0 && rows > 0 ? {columns, rows} : undefined;
  }

  /** Resizes the grid to what the pane holds; the page sends the new size to the transport, which the core follows. */
  fit() {
    this.measure();
    const size = this.proposeSize(), {columns, rows} = this.mirror.state;
    if (size && (size.columns !== columns || size.rows !== rows)) this.requestSize(size);
  }

  syncViewport() {}
  interceptKeys(handler: (event: KeyboardEvent) => boolean): Disposable {
    this.interceptor = handler;
    return {dispose: () => { if (this.interceptor === handler) this.interceptor = undefined; }};
  }
  /** A tap on a URL, an OSC 8 hyperlink or a host path the core finds under it goes to `handlers`; the pane registers before it attaches, so the taps follow the anchor. */
  registerLinks(handlers: LinkHandlers): Disposable {
    this.links = handlers;
    this.tapLinks();
    return {dispose: () => { if (this.links !== handlers) return; this.links = undefined; this.tapLinks(); }};
  }

  private tapLinks() {
    this.taps?.dispose();
    this.taps = this.anchor && this.links && !this.disposed ? attachLinkTaps(this, this.anchor, this.links) : undefined;
  }

  /** The link a tap on `cell` opens, as the core reads it; none where there is nothing, or for a core that cannot say. */
  async linkAt(cell: TerminalCell): Promise<NativeCoreLink | undefined> {
    if (this.disposed || !this.bridge.query) return undefined;
    return await this.ask({kind: 'linkAt', cell}) ?? undefined;
  }
  focus() { this.capture?.focus(); }
  blur() { this.capture?.blur(); }
  dismissKeyboardIfIdle() {
    if (this.capture instanceof SurfaceInput) this.capture.dismissKeyboardIfIdle();
  }

  subscribe(listener: (event: TerminalEvent) => void, types?: readonly TerminalEvent['type'][]): Disposable {
    return this.disposed ? {dispose: noop} : this.events.add(listener, types);
  }

  private emit(event: TerminalEvent) { this.events.emit(event); }
}

/** The native terminal of one new session over its core. */
export async function openNativeTerminalAdapter(bridge: NativeCoreBridge, options?: NativeAdapterOptions): Promise<NativeTerminalAdapter> {
  return new NativeTerminalAdapter(bridge, await bridge.snapshot(), options);
}
