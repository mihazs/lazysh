/**
 * The contract between lazysh's UI and a terminal implementation. React owns the
 * layout around the terminal; an adapter owns the terminal state of ONE session:
 * emulation, scrollback, selection and drawing. Nothing here exposes cells,
 * xterm.js types or DOM nodes of a backend. See docs/architecture/terminal-adapter.md.
 */

export type TerminalBackendId = 'native' | 'xterm';

export type TerminalSize = {columns: number; rows: number; pixelWidth?: number; pixelHeight?: number};

/** What a backend really does. A backend must not claim a capability it cannot pass tests for. */
export type TerminalCapabilities = {
  readonly nativeRendering: boolean;
  readonly selection: boolean;
  readonly scrollback: boolean;
  readonly mouseReporting: boolean;
  /** `observeInput` is available: IME composition is separated from terminal control input. */
  readonly ime: boolean;
  /** Screen readers can reach the content. */
  readonly accessibility: boolean;
  /** `readRows` returns the text of buffer rows. */
  readonly screenInspection: boolean;
  /** `enableCanonicalResize` applies Mosh's transport-authoritative framebuffer geometry. */
  readonly canonicalMoshResize: boolean;
  readonly customBoldColor: boolean;
};

export type TerminalMountTarget =
  | {kind: 'dom'; element: HTMLElement}
  /** A native surface still has a DOM anchor so layout stays in React. */
  | {kind: 'native'; anchorId: string};

export type TerminalTheme = {
  foreground?: string; background?: string; cursor?: string; cursorAccent?: string;
  selectionBackground?: string; selectionForeground?: string; selectionInactiveBackground?: string;
  black?: string; red?: string; green?: string; yellow?: string; blue?: string; magenta?: string; cyan?: string; white?: string;
  brightBlack?: string; brightRed?: string; brightGreen?: string; brightYellow?: string; brightBlue?: string;
  brightMagenta?: string; brightCyan?: string; brightWhite?: string; extendedAnsi?: string[];
};

export type TerminalPreferences = {
  fontFamily: string;
  fontSize: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollbackLines: number;
  optionAsMeta: boolean;
  screenReader: boolean;
  /** Draw bold text in the bright palette variant. */
  brightBold: boolean;
  /** A fixed colour for default-coloured bold text; only with `customBoldColor`. */
  boldColor?: string;
  theme: TerminalTheme;
};

export type TerminalScrollAction =
  | {kind: 'lines'; delta: number}
  | {kind: 'pages'; delta: number}
  | {kind: 'toTop'}
  | {kind: 'toBottom'}
  | {kind: 'toRow'; row: number};

/** A buffer cell: `x` is a column, `y` an absolute buffer row. */
export type TerminalCell = {x: number; y: number};
/** The end cell is inclusive. */
export type TerminalRange = {start: TerminalCell; end: TerminalCell};
export type TerminalSelection = {range: TerminalRange; text: string};

export type TerminalModes = {
  bracketedPaste: boolean;
  mouseTracking: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  alternateScreen: boolean;
  applicationCursorKeys: boolean;
};

/** `top` is the first visible absolute row; `length` the rows held; `following` means the view shows live output. */
export type TerminalViewport = {top: number; rows: number; length: number; following: boolean};

export type TerminalInputOrigin = 'keyboard' | 'ime' | 'paste' | 'pointer' | 'terminal-reply';

export type TerminalFailure = 'invalid-frame' | 'partial-frame';

export type TerminalEvent =
  /** The user asked for a size (a layout change); the transport decides what it becomes. */
  | {type: 'resizeIntent'; size: TerminalSize}
  /** The terminal's own size changed. `transport` authority is Mosh's canonical framebuffer. */
  | {type: 'geometry'; size: TerminalSize; authority: 'local' | 'transport'}
  | {type: 'viewport'; viewport: TerminalViewport}
  | {type: 'selection'; selection: TerminalSelection | undefined}
  | {type: 'modes'; modes: TerminalModes}
  | {type: 'title'; title: string}
  | {type: 'bell'}
  | {type: 'failure'; reason: TerminalFailure};

export type UnappliedTerminalEdit = {text: string; truncated: boolean};

/** Separates IME composition from control input; mirrors the lifecycle `TerminalPane` drives. */
export type TerminalInputObserver = {
  /** False when the backend could not install its input marker; virtual modifiers are then unavailable. */
  readonly available: boolean;
  readonly idle: boolean;
  composing(): boolean | undefined;
  reset(): void; clear(): void; resume(): void; flush(): void; settle(): void; dismiss(): void;
  dispose(): void;
};

/** Transport-authoritative geometry (Mosh). User sizes are intent until the framebuffer says otherwise. */
export type CanonicalResize = {
  requestSize(cols: number, rows: number): void;
  onResizeIntent(listener: (size: {cols: number; rows: number}) => void): {dispose(): void};
  close(): Promise<void>;
  dispose(): void;
  readonly failure: TerminalFailure | null;
};

export type TerminalSearchHit = {row: number; column: number; length: number};

export interface Disposable {dispose(): void}

export interface TerminalAdapter {
  readonly backend: TerminalBackendId;
  readonly capabilities: TerminalCapabilities;
  /** Who receives transport bytes: the JS side (`write`) or a native runtime that owns the transport. */
  readonly dataPath: 'renderer' | 'runtime';

  /** The session outlives any view: `detach` and `attach` keep every byte of state. */
  attach(target: TerminalMountTarget): Promise<void>;
  detach(): Promise<void>;
  /** Inactive terminals keep parsing; they must not draw continuously. */
  setActive(active: boolean): void;
  /** Idempotent. Pending writes reject; subscribers are released. */
  dispose(): Promise<void>;

  /**
   * Present when `dataPath` is 'renderer'. Resolves once the bytes are applied: the point to return transport credits.
   * `onApplied` runs synchronously at that point, in write order, before any promise continuation.
   */
  write?(bytes: Uint8Array, onApplied?: () => void): Promise<void>;
  /** Inject input as if it were typed; it reaches the observer like keyboard input. */
  sendInput(data: string | Uint8Array, origin: TerminalInputOrigin): void;
  /** Present with the `ime` capability. */
  observeInput?(listener: (data: string, userInput: boolean) => void, acceptsInput?: () => boolean, onUnappliedEdit?: (edit: UnappliedTerminalEdit | null) => void): TerminalInputObserver;
  /** Present with the `canonicalMoshResize` capability; call before the first output of a Mosh transport. */
  enableCanonicalResize?(): CanonicalResize;
  /** Bracketed-paste aware. */
  paste(text: string): void;

  requestSize(size: TerminalSize): void;
  metrics(): {columns: number; rows: number; cellWidth: number; cellHeight: number};
  applyPreferences(preferences: TerminalPreferences): void;
  scroll(action: TerminalScrollAction): void;
  viewport(): TerminalViewport;
  modes(): TerminalModes;

  cellAt(clientX: number, clientY: number): TerminalCell | undefined;
  getSelection(): TerminalSelection | undefined;
  select(range: TerminalRange): void;
  selectWordAt(cell: TerminalCell): TerminalRange;
  selectAll(): void;
  clearSelection(): void;
  /** Present with the `screenInspection` capability: trimmed text of absolute rows, optionally of a column span. Never cells. */
  readRows?(first: number, count: number, columns?: {start: number; end: number}): string[];
  /** Wraps around the buffer; `from` is the previous hit's row. */
  search(query: string, direction: 1 | -1, from?: number): TerminalSearchHit | undefined;

  focus(): void;
  blur(): void;

  /** Listeners run in order and never outlive `dispose`. */
  subscribe(listener: (event: TerminalEvent) => void): Disposable;
}
