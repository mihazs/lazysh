import type {Terminal} from '@xterm/xterm';
import {version} from '@xterm/xterm/package.json';
import {installMoshResize} from './moshResize';
import {applyXtermPreferences} from './terminalBold';
import {createTerminal, observeTerminalInput} from './terminal';
import {inclusiveEnd, selectTerminalRange, terminalCellAt, terminalWordAt} from './terminalTouchSelection';
import type {
  CanonicalResize, Disposable, TerminalAdapter, TerminalCapabilities, TerminalCell, TerminalEvent, TerminalInputOrigin,
  TerminalModes, TerminalMountTarget, TerminalPreferences, TerminalRange, TerminalScrollAction, TerminalSearchHit,
  TerminalSelection, TerminalSize, TerminalViewport,
} from './terminalAdapter';

export const xtermCapabilities: TerminalCapabilities = {
  nativeRendering: false, selection: true, scrollback: true, mouseReporting: true, ime: true, accessibility: true,
  screenInspection: true,
  // moshResize.ts patches xterm 5.5.0 internals and refuses any other version.
  canonicalMoshResize: version === '5.5.0',
  customBoldColor: true,
};
const mouseModes = new Set<TerminalModes['mouseTracking']>(['none', 'x10', 'vt200', 'drag', 'any']);

/** The xterm.js backend: the terminal's state lives in the WebView, in one xterm `Terminal`. */
export class XtermTerminalAdapter implements TerminalAdapter {
  readonly backend = 'xterm' as const;
  readonly dataPath = 'renderer' as const;
  readonly capabilities = xtermCapabilities;
  private readonly listeners = new Set<(event: TerminalEvent) => void>();
  private readonly sources: Disposable[] = [];
  private readonly pending = new Set<(error: Error) => void>();
  private canonical: CanonicalResize | undefined;
  private intents: Disposable | undefined;
  private disposed: Promise<void> | undefined;
  private active = true;

  /** `xterm` is the one terminal of this session; the adapter takes ownership and disposes it. */
  constructor(private readonly xterm: Terminal) {}

  /** Transitional escape hatch for code still written against xterm (#1308); not part of the contract. */
  get terminal(): Terminal { return this.xterm; }

  async attach(target: TerminalMountTarget) {
    if (this.disposed) throw new Error('This terminal is disposed.');
    if (target.kind !== 'dom') throw new Error('The xterm backend draws into a DOM element.');
    if (!this.xterm.element) this.xterm.open(target.element);
    else if (this.xterm.element.parentElement !== target.element) target.element.append(this.xterm.element);
  }

  async detach() { this.xterm.element?.remove(); }

  setActive(active: boolean) {
    // xterm draws only dirty rows on demand; "inactive" cannot suspend that, but a revived terminal repaints.
    const wake = active && !this.active;
    this.active = active;
    if (wake && this.xterm.element) this.xterm.refresh(0, this.xterm.rows - 1);
  }

  dispose() {
    if (this.disposed) return this.disposed;
    // Everything below runs synchronously: the caller may drop its reference right after this call.
    this.intents?.dispose(); this.canonical?.dispose();
    this.sources.splice(0).forEach(source => source.dispose());
    this.listeners.clear();
    const error = new Error('This terminal was disposed before the bytes were applied.');
    this.pending.forEach(reject => reject(error)); this.pending.clear();
    this.xterm.dispose();
    return this.disposed = Promise.resolve();
  }

  write(bytes: Uint8Array) {
    if (this.disposed) return Promise.reject(new Error('This terminal is disposed.'));
    return new Promise<void>((resolve, reject) => {
      this.pending.add(reject);
      this.xterm.write(bytes, () => {
        if (!this.pending.delete(reject)) return;
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

  metrics() {
    const rect = this.xterm.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    const {cols, rows} = this.xterm;
    return {columns: cols, rows, cellWidth: rect && cols ? rect.width / cols : 0, cellHeight: rect && rows ? rect.height / rows : 0};
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
    const position = this.xterm.hasSelection() ? this.xterm.getSelectionPosition() : undefined;
    if (!position) return;
    return {range: {start: position.start, end: inclusiveEnd(position.end, this.xterm.cols)}, text: this.xterm.getSelection()};
  }

  select(range: TerminalRange) { selectTerminalRange(this.xterm, range); }
  selectWordAt(cell: TerminalCell) { return terminalWordAt(this.xterm, cell); }
  selectAll() { this.xterm.selectAll(); }
  clearSelection() { this.xterm.clearSelection(); }

  readRows(first: number, count: number, columns?: {start: number; end: number}) {
    const buffer = this.xterm.buffer.active;
    const rows: string[] = [];
    for (let y = first; y < first + count; y++) rows.push(buffer.getLine(y)?.translateToString(true, columns?.start, columns?.end).trimEnd() ?? '');
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

  focus() { this.xterm.focus(); }
  blur() { this.xterm.blur(); }

  subscribe(listener: (event: TerminalEvent) => void): Disposable {
    if (this.disposed) return {dispose() {}};
    this.listeners.add(listener);
    this.observeTerminal();
    this.hookIntents();
    return {dispose: () => { this.listeners.delete(listener); }};
  }

  private emit(event: TerminalEvent) { for (const listener of [...this.listeners]) listener(event); }

  private hookIntents() {
    if (!this.canonical || this.intents || !this.listeners.size) return;
    this.intents = this.canonical.onResizeIntent(({cols, rows}) => this.emit({type: 'resizeIntent', size: {columns: cols, rows}}));
  }

  /** Wired on the first subscription, so a terminal nobody observes carries no listeners. */
  private observeTerminal() {
    if (this.sources.length) return;
    const x = this.xterm;
    this.sources.push(
      x.onResize(({cols, rows}) => {
        const size = {columns: cols, rows};
        this.emit({type: 'geometry', size, authority: this.canonical ? 'transport' : 'local'});
        if (!this.canonical) this.emit({type: 'resizeIntent', size});
      }),
      x.onScroll(() => this.emit({type: 'viewport', viewport: this.viewport()})),
      x.onSelectionChange(() => this.emit({type: 'selection', selection: this.getSelection()})),
      x.buffer.onBufferChange(() => this.emit({type: 'modes', modes: this.modes()})),
      x.onTitleChange(title => this.emit({type: 'title', title})),
      x.onBell(() => this.emit({type: 'bell'})),
    );
  }
}

/** The registered xterm backend factory. */
export function createXtermTerminalAdapter(): TerminalAdapter { return new XtermTerminalAdapter(createTerminal()); }
