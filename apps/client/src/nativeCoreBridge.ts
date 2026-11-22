/**
 * What the NativeTerminalAdapter asks of a native terminal core (docs/architecture/terminal-adapter.md, "Native backend").
 * This is a control plane: every value is a size, a position, a mode flag or the TEXT of rows. No command returns a
 * cell grid, styles or pixels; the renderer reads those inside the runtime.
 */
import type {Disposable, TerminalCell, TerminalInputOrigin, TerminalModes, TerminalRange, TerminalScrollAction, TerminalSearchHit, TerminalTheme, TerminalViewport} from './terminalAdapter';
import type {CoreKeyInput} from './terminalPlatformKeys';

/** The wire shape of a wheel notch for `terminal_core_input`: a cell of the live screen, row 0 its first row. */
export type CoreMouseInput = {
  type: 'mouse'; action: 'press'; button: 'wheelUp' | 'wheelDown';
  mods: {shift: boolean; ctrl: boolean; alt: boolean; meta: boolean}; x: number; y: number;
};

export type NativeCoreState = {
  columns: number;
  rows: number;
  /** The cursor in the live screen: row 0 is its first row. */
  cursor: {x: number; y: number};
  modes: TerminalModes;
  viewport: TerminalViewport;
  /** The configured history, in lines. */
  scrollbackLines: number;
};

/** The text of a run of absolute rows, trimmed on the right, that the core chose around the viewport. Bounded by the core. */
export type NativeRowWindow = {first: number; rows: string[]};

/** What every state-changing command answers: the new state and the rows the adapter's synchronous readers serve from. */
export type NativeCoreSnapshot = {state: NativeCoreState; window: NativeRowWindow};

/** Ordered, one per occurrence. `changed` is a coalesced doorbell: the screen differs, pull a `snapshot`. */
export type NativeCoreEvent =
  | {type: 'changed'}
  | {type: 'title'; title: string}
  | {type: 'bell'}
  | {type: 'cwd'; path: string}
  | {type: 'clipboard'; text: string};

/** A question about the buffer's text, which the core answers from its own state: absolute rows, both ends of a range inclusive. */
export type NativeCoreQuery =
  | {kind: 'selectionText'; range: TerminalRange}
  /** `from` is the previous hit's row. */
  | {kind: 'search'; query: string; direction: 'forward' | 'backward'; from?: number}
  | {kind: 'wordAt'; cell: TerminalCell}
  | {kind: 'lineAt'; row: number}
  | {kind: 'bufferRange'}
  | {kind: 'copyScreen'};

/** Text, a range or a hit: `null` where there is none (no match, an empty buffer). Never cells. */
export type NativeCoreAnswer<Q extends NativeCoreQuery> =
  Q extends {kind: 'selectionText' | 'copyScreen'} ? string
  : Q extends {kind: 'search'} ? TerminalSearchHit | null
  : Q extends {kind: 'bufferRange'} ? TerminalRange | null
  : TerminalRange;

export interface NativeCoreBridge {
  snapshot(): Promise<NativeCoreSnapshot>;
  scroll(action: TerminalScrollAction): Promise<NativeCoreSnapshot>;
  /** Typed input, a paste or a terminal reply, as the text the program should receive. */
  input(data: string | Uint8Array, origin: TerminalInputOrigin): Promise<void>;
  /** A key as the DOM reports it, after the platform rules; the core encodes it for the modes the program set. */
  key(input: CoreKeyInput): Promise<void>;
  /** A mouse report for a program that tracks the mouse (wheel notches from a finger or a wheel); the core encodes it for the mode the program set. Absent: the adapter sends none. */
  mouse?(input: CoreMouseInput): Promise<void>;
  /** Present only when the WebView hands transport bytes to the core (a core-only build, tests). A runtime that owns the transport has none. */
  feed?(bytes: Uint8Array): Promise<NativeCoreSnapshot>;
  /** Present when the WebView sizes the core itself; with a transport the core follows the PTY resize instead. */
  resize?(size: {columns: number; rows: number}): Promise<NativeCoreSnapshot>;
  /** An inactive session keeps parsing; the core stops waking the adapter. */
  setActive?(active: boolean): void;
  /** The app's terminal theme changed: the core reports these colours to the programs that ask for them from now on. */
  setTheme?(theme: TerminalTheme): void;
  /** Present when the core answers questions about the text itself; without it the adapter reads the window of rows. */
  query?<Q extends NativeCoreQuery>(query: Q): Promise<NativeCoreAnswer<Q>>;
  /** The cells the core's renderer highlights as selected; `undefined` clears them. */
  select?(range: TerminalRange | undefined): void;
  subscribe(listener: (event: NativeCoreEvent) => void): Disposable;
  /** Frees the core. Idempotent. */
  close(): Promise<void>;
}
