import type {Terminal} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {version} from '@xterm/xterm/package.json';
import {decodeClipboardRequest} from './preferences';
import {installMoshResize} from './xterm/moshResize';
import {TerminalFitAddon} from './xterm/terminalFit';
import {installTerminalLinks} from './xterm/links';
import {applyXtermPreferences} from './xterm/terminalBold';
import {createTerminal, keepViewportScrolls, observeTerminalInput, syncTerminalViewport} from './xterm/terminal';
import {inclusiveEnd} from './terminalTouchSelection';
import {selectTerminalRange, terminalCellAt, terminalWordAt} from './xterm/selection';
import type {
  CanonicalResize, Disposable, TerminalAdapter, TerminalCapabilities, TerminalCell, TerminalEvent, TerminalInputOrigin,
  TerminalModes, TerminalMountTarget, TerminalPreferences, TerminalRange, TerminalScrollAction, TerminalSearchHit,
  TerminalSelection, TerminalSize, TerminalViewport, TerminalBounds,
} from './terminalAdapter';

export const xtermCapabilities: TerminalCapabilities = {
  nativeRendering: false, selection: true, scrollback: true, mouseReporting: true, ime: true, accessibility: true,
  screenInspection: true,
  // moshResize.ts patches xterm 5.5.0 internals and refuses any other version.
  canonicalMoshResize: version === '5.5.0',
  customBoldColor: true,
};
const allEventTypes: readonly TerminalEvent['type'][] = ['resizeIntent', 'geometry', 'viewport', 'output', 'selection', 'modes', 'title', 'bell', 'failure', 'cwd', 'clipboard'];
const mouseModes = new Set<TerminalModes['mouseTracking']>(['none', 'x10', 'vt200', 'drag', 'any']);

/** The xterm.js backend: the terminal's state lives in the WebView, in one xterm `Terminal`. */
export class XtermTerminalAdapter implements TerminalAdapter {
  readonly backend = 'xterm' as const;
  readonly dataPath = 'renderer' as const;
  readonly capabilities = xtermCapabilities;
  private readonly listeners = new Set<{listener: (event: TerminalEvent) => void; types?: ReadonlySet<TerminalEvent['type']>}>();
  private readonly sources = new Map<TerminalEvent['type'], Disposable[]>();
  private readonly pending = new Set<(error: Error) => void>();
  private canonical: CanonicalResize | undefined;
  private intents: Disposable | undefined;
  private disposed: Promise<void> | undefined;
  private active = true;

  /** `xterm` is the one terminal of this session; the adapter takes ownership and disposes it. */
  constructor(private readonly xterm: Terminal) {}

  /** The mounted view's seams (viewport clamp guard, scroll repair), undone on detach. */
  private unmount: (() => void) | undefined;
  private fitAddon: TerminalFitAddon | undefined;
  private viewportHeight = 0;

  /** Mounting is synchronous: when the promise is created the terminal is in the DOM and measurable. */
  async attach(target: TerminalMountTarget) {
    if (this.disposed) throw new Error('This terminal is disposed.');
    if (target.kind !== 'dom') throw new Error('The xterm backend draws into a DOM element.');
    this.unmount?.();
    if (!this.fitAddon) this.xterm.loadAddon(this.fitAddon = new TerminalFitAddon());
    if (!this.xterm.element) this.xterm.open(target.element);
    else if (this.xterm.element.parentElement !== target.element) target.element.append(this.xterm.element);
    this.unmount = this.mountSeams(target.element);
  }

  async detach() { this.unmount?.(); this.unmount = undefined; this.xterm.element?.remove(); }

  /**
   * A taller container clamps the DOM viewport before any fit runs. That scroll is layout, not a reader: xterm would
   * otherwise move the reader to the clamp and stop following output. Mosh resizes only after a round trip.
   */
  private mountSeams(element: HTMLElement) {
    const viewport = element.querySelector<HTMLElement>('.xterm-viewport');
    this.viewportHeight = viewport?.clientHeight ?? 0;
    const clamped = (event: Event) => {
      if (!viewport || event.target !== viewport || viewport.clientHeight === this.viewportHeight) return;
      this.viewportHeight = viewport.clientHeight;
      event.stopPropagation();
      syncTerminalViewport(this.xterm);
    };
    element.addEventListener('scroll', clamped, true);
    const scrolls = keepViewportScrolls(this.xterm, element);
    return () => { element.removeEventListener('scroll', clamped, true); scrolls(); };
  }

  setActive(active: boolean) {
    // xterm draws only dirty rows on demand; "inactive" cannot suspend that, but a revived terminal repaints.
    const wake = active && !this.active;
    this.active = active;
    if (wake && this.xterm.element) this.xterm.refresh(0, this.xterm.rows - 1);
  }

  dispose() {
    if (this.disposed) return this.disposed;
    // Everything below runs synchronously: the caller may drop its reference right after this call.
    this.unmount?.(); this.unmount = undefined; this.fitAddon?.dispose();
    this.intents?.dispose(); this.canonical?.dispose();
    this.sources.forEach(group => group.forEach(source => source.dispose())); this.sources.clear();
    this.listeners.clear();
    const error = new Error('This terminal was disposed before the bytes were applied.');
    this.pending.forEach(reject => reject(error)); this.pending.clear();
    this.xterm.dispose();
    return this.disposed = Promise.resolve();
  }

  write(bytes: Uint8Array, onApplied?: () => void) {
    if (this.disposed) return Promise.reject(new Error('This terminal is disposed.'));
    return new Promise<void>((resolve, reject) => {
      this.pending.add(reject);
      this.xterm.write(bytes, () => {
        if (!this.pending.delete(reject)) return;
        onApplied?.();
        resolve();
        // The canonical-geometry controller records a malformed Mosh frame as it parses it.
        const failure = this.canonical?.failure;
        if (failure) this.emit({type: 'failure', reason: failure});
      });
    });
  }

  sendInput(data: string | Uint8Array, origin: TerminalInputOrigin) {
    // xterm.js delivers a string to its data listeners; arbitrary binary cannot pass through it.
    const text = typeof data === 'string' ? data : new TextDecoder('utf-8', {fatal: true}).decode(data);
    this.xterm.input(text, origin !== 'terminal-reply');
  }

  observeInput(listener: (data: string, userInput: boolean) => void, acceptsInput?: () => boolean, onUnappliedEdit?: Parameters<NonNullable<TerminalAdapter['observeInput']>>[2]) {
    return observeTerminalInput(this.xterm, listener, acceptsInput, onUnappliedEdit);
  }

  enableCanonicalResize() {
    if (!this.capabilities.canonicalMoshResize) throw new Error('This terminal cannot apply canonical Mosh resizing.');
    this.canonical = installMoshResize(this.xterm);
    this.hookIntents();
    return this.canonical;
  }

  paste(text: string) { this.xterm.paste(text); }

  requestSize(size: TerminalSize) {
    // With canonical resize enabled, `resize` is the controller's request: an intent, not a geometry change.
    this.xterm.resize(size.columns, size.rows);
  }

  size() { return {columns: this.xterm.cols, rows: this.xterm.rows}; }

  metrics() {
    const rect = this.screenBounds();
    const {cols, rows} = this.xterm;
    return {columns: cols, rows, cellWidth: rect && cols ? rect.width / cols : 0, cellHeight: rect && rows ? rect.height / rows : 0, scrollbackLines: this.xterm.options.scrollback ?? 0};
  }

  screenBounds(): TerminalBounds | undefined {
    const rect = this.xterm.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    return rect && {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  }

  applyPreferences(preferences: TerminalPreferences) { applyXtermPreferences(this.xterm, preferences); }

  scroll(action: TerminalScrollAction) {
    switch (action.kind) {
      case 'lines': return this.xterm.scrollLines(action.delta);
      case 'pages': return this.xterm.scrollPages(action.delta);
      case 'toTop': return this.xterm.scrollToTop();
      case 'toBottom': return this.xterm.scrollToBottom();
      case 'toRow': return this.xterm.scrollToLine(action.row);
    }
  }

  viewport(): TerminalViewport {
    const {viewportY, baseY, length} = this.xterm.buffer.active;
    return {top: viewportY, rows: this.xterm.rows, length, following: viewportY === baseY};
  }

  atLiveScreen() {
    const {type, baseY, viewportY} = this.xterm.buffer.active;
    return type === 'normal' && Number.isInteger(baseY) && baseY >= 0 && viewportY === baseY;
  }

  modes(): TerminalModes {
    const {modes, options} = this.xterm;
    const tracking = mouseModes.has(modes.mouseTrackingMode as TerminalModes['mouseTracking']) ? modes.mouseTrackingMode : 'none';
    return {
      bracketedPaste: modes.bracketedPasteMode && !options.ignoreBracketedPasteMode,
      mouseTracking: tracking as TerminalModes['mouseTracking'],
      alternateScreen: this.xterm.buffer.active.type === 'alternate',
      applicationCursorKeys: modes.applicationCursorKeysMode,
    };
  }

  cellAt(clientX: number, clientY: number) { return terminalCellAt(this.xterm, clientX, clientY); }

  getSelection(): TerminalSelection | undefined {
    const range = this.selectionRange();
    return range && {range, text: this.xterm.getSelection()};
  }

  selectionRange(): TerminalRange | undefined {
    const position = this.xterm.hasSelection() ? this.xterm.getSelectionPosition() : undefined;
    return position && {start: position.start, end: inclusiveEnd(position.end, this.xterm.cols)};
  }

  hasSelection() { return this.xterm.hasSelection(); }
  selectedText() { return this.xterm.getSelection(); }

  select(range: TerminalRange) { selectTerminalRange(this.xterm, range); }
  selectWordAt(cell: TerminalCell) { return terminalWordAt(this.xterm, cell); }
  selectAll() { this.xterm.selectAll(); }
  clearSelection() { this.xterm.clearSelection(); }

  readRows(first: number, count: number, columns?: {start: number; end: number}) {
    const buffer = this.xterm.buffer.active;
    const rows: string[] = [];
    for (let y = first; y < first + count; y++) rows.push(buffer.getLine(y)?.translateToString(true, columns?.start, columns?.end)?.trimEnd() ?? '');
    return rows;
  }

  search(query: string, direction: 1 | -1, from?: number): TerminalSearchHit | undefined {
    if (!query) return;
    const buffer = this.xterm.buffer.active, needle = query.toLocaleLowerCase();
    const start = from === undefined || from < 0 ? (direction > 0 ? -1 : buffer.length) : from;
    for (let offset = 1; offset <= buffer.length; offset++) {
      const row = (start + offset * direction + buffer.length * 2) % buffer.length;
      const text = buffer.getLine(row)?.translateToString(true) ?? '';
      const column = text.toLocaleLowerCase().indexOf(needle);
      if (column >= 0) return {row, column, length: text.length};
    }
  }

  cursor() { return {x: this.xterm.buffer.active.cursorX, y: this.xterm.buffer.active.cursorY}; }

  followLive() { if (this.xterm.options.scrollOnUserInput !== false) this.xterm.scrollToBottom(); }

  wheel({clientX, clientY, deltaY, unit}: Parameters<TerminalAdapter['wheel']>[0]) {
    this.xterm.element?.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX, clientY, deltaY, deltaMode: unit === 'line' ? WheelEvent.DOM_DELTA_LINE : WheelEvent.DOM_DELTA_PIXEL,
    }));
  }

  inputElement() { return this.xterm.textarea; }
  screenElement() { return this.xterm.element?.querySelector<HTMLElement>('.xterm-screen') ?? undefined; }

  layoutRowHeight() {
    const screen = this.screenElement(), height = screen && this.xterm.rows > 0 ? Math.ceil(screen.clientHeight / this.xterm.rows) : 0;
    return Number.isFinite(height) ? height : 0;
  }

  proposeSize() {
    const proposed = this.fitAddon?.proposeDimensions();
    return proposed && {columns: proposed.cols, rows: proposed.rows};
  }

  fit() {
    const terminal = this.xterm, addon = this.fitAddon;
    if (!addon) return;
    const buffer = terminal.buffer.active;
    // Stock resize moves scrolled-back history with the cursor.
    const history = buffer.type === 'normal' && buffer.viewportY < buffer.baseY;
    let top = buffer.viewportY;
    // Reflow merges or splits wrapped rows; their logical line start survives.
    if (history && addon.proposeDimensions()?.cols !== terminal.cols) while (top > 0 && buffer.getLine(top)?.isWrapped) top--;
    const anchor = history ? terminal.registerMarker(top - buffer.baseY - buffer.cursorY) : undefined;
    try {
      addon.fit();
      if (anchor && !anchor.isDisposed && terminal.buffer.active === buffer) terminal.scrollToLine(anchor.line);
    } finally { anchor?.dispose(); }
  }

  syncViewport() {
    syncTerminalViewport(this.xterm);
    const viewport = this.xterm.element?.querySelector<HTMLElement>('.xterm-viewport');
    if (viewport) this.viewportHeight = viewport.clientHeight;
  }

  interceptKeys(handler: (event: KeyboardEvent) => boolean): Disposable {
    this.xterm.attachCustomKeyEventHandler(handler);
    return {dispose: () => { if (!this.disposed) this.xterm.attachCustomKeyEventHandler(() => true); }};
  }

  registerLinks(handlers: Parameters<TerminalAdapter['registerLinks']>[0]) {
    return installTerminalLinks(this.xterm, handlers.openUrl, handlers.hostPaths);
  }

  focus() { this.xterm.focus(); }
  blur() { this.xterm.blur(); }

  subscribe(listener: (event: TerminalEvent) => void, types?: readonly TerminalEvent['type'][]): Disposable {
    if (this.disposed) return {dispose() {}};
    const entry = {listener, types: types && new Set(types)};
    this.listeners.add(entry);
    for (const type of types ?? allEventTypes) this.observe(type);
    this.hookIntents();
    return {dispose: () => { this.listeners.delete(entry); }};
  }

  private emit(event: TerminalEvent) {
    for (const {listener, types} of [...this.listeners]) if (!types || types.has(event.type)) listener(event);
  }

  private hookIntents() {
    if (!this.canonical || this.intents) return;
    const wanted = [...this.listeners].some(({types}) => !types || types.has('resizeIntent'));
    if (wanted) this.intents = this.canonical.onResizeIntent(({cols, rows}) => this.emit({type: 'resizeIntent', size: {columns: cols, rows}}));
  }

  /** Wired when the first listener asks for the type, so a terminal nobody observes carries no listeners. */
  private observe(type: TerminalEvent['type']) {
    const x = this.xterm, source = type === 'resizeIntent' ? 'geometry' : type;
    if (this.sources.has(source) || source === 'failure') return;
    const wire = (): Disposable[] => {
      switch (source) {
        case 'geometry': return [x.onResize(({cols, rows}) => {
          const size = {columns: cols, rows};
          this.emit({type: 'geometry', size, authority: this.canonical ? 'transport' : 'local'});
          if (!this.canonical) this.emit({type: 'resizeIntent', size});
        })];
        // A redraw (output, a font or theme change) can move the cells without scrolling.
        case 'viewport': return [x.onScroll(() => this.emit({type: 'viewport', viewport: this.viewport()})), x.onRender(() => this.emit({type: 'viewport', viewport: this.viewport()}))];
        case 'output': return [x.onWriteParsed(() => this.emit({type: 'output'}))];
        case 'selection': return [x.onSelectionChange(() => this.emit({type: 'selection', range: this.selectionRange()}))];
        case 'modes': return [x.buffer.onBufferChange(() => this.emit({type: 'modes', modes: this.modes()}))];
        case 'title': return [x.onTitleChange(title => this.emit({type: 'title', title}))];
        case 'bell': return [x.onBell(() => this.emit({type: 'bell'}))];
        case 'cwd': return [x.parser.registerOscHandler(7, data => {
          try { const url = new URL(data); if (url.protocol === 'file:') this.emit({type: 'cwd', path: decodeURIComponent(url.pathname)}); } catch { /* A malformed report keeps the last directory. */ }
          return true;
        })];
        case 'clipboard': return [x.parser.registerOscHandler(52, data => {
          const text = decodeClipboardRequest(data);
          if (text !== undefined) this.emit({type: 'clipboard', text});
          return true;
        })];
        default: return [];
      }
    };
    this.sources.set(source, wire());
  }
}

/** The registered xterm backend factory. */
export function createXtermTerminalAdapter(): TerminalAdapter { return new XtermTerminalAdapter(createTerminal()); }
