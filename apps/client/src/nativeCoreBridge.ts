/**
 * What the NativeTerminalAdapter asks of a native terminal core (docs/architecture/terminal-adapter.md, "Native backend").
 * This is a control plane: every value is a size, a position, a mode flag or the TEXT of rows. No command returns a
 * cell grid, styles or pixels; the renderer reads those inside the runtime.
 */
import type {Disposable, TerminalCell, TerminalEvent, TerminalInputOrigin, TerminalModes, TerminalRange, TerminalScrollAction, TerminalSearchHit, TerminalTheme, TerminalViewport} from './terminalAdapter';
import type {CoreKeyInput} from './terminalPlatformKeys';

/** The wire shape of a wheel notch or a button report for `terminal_core_input`: a cell of the live screen, row 0 its first row. */
export type CoreMouseInput = {
  type: 'mouse'; action: 'press' | 'release' | 'motion'; button: 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown';
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

/**
 * Ordered, one per occurrence. `changed` is a coalesced doorbell: the screen differs, pull a `snapshot`. The rest are what the program
 * reported, as the adapter's own events; `failure` is the Mosh display ceasing to follow the transport (a frame the core refused, or the stream
 * ended inside one), which the session cannot recover from.
 */
export type NativeCoreEvent = {type: 'changed'} | Extract<TerminalEvent, {type: 'title' | 'bell' | 'cwd' | 'clipboard' | 'failure'}>;

/** What a tap on a cell opens: where an OSC 8 hyperlink points or the URL printed there, or a host path printed there (0-based absolute cells, both ends inclusive). */
export type NativeCoreLink =
  | {kind: 'url'; uri: string}
  | {kind: 'path'; text: string; path: string; line?: number; column?: number; range: TerminalRange};

/** A question about the buffer's text, which the core answers from its own state: absolute rows, both ends of a range inclusive. */
export type NativeCoreQuery =
  | {kind: 'selectionText'; range: TerminalRange}
  /** `from` is the previous hit's row. */
  | {kind: 'search'; query: string; direction: 'forward' | 'backward'; from?: number}
  | {kind: 'wordAt'; cell: TerminalCell}
  | {kind: 'lineAt'; row: number}
  | {kind: 'bufferRange'}
  | {kind: 'copyScreen'}
  /** The link a tap on `cell` opens: an OSC 8 hyperlink, else a URL, else a host path. */
  | {kind: 'linkAt'; cell: TerminalCell};

/** Text, a range, a hit or a link: `null` where there is none (no match, an empty buffer, nothing under the cell). Never cells. */
export type NativeCoreAnswer<Q extends NativeCoreQuery> =
  Q extends {kind: 'selectionText' | 'copyScreen'} ? string
  : Q extends {kind: 'search'} ? TerminalSearchHit | null
  : Q extends {kind: 'bufferRange'} ? TerminalRange | null
  : Q extends {kind: 'linkAt'} ? NativeCoreLink | null
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
  /** Present when the core follows Mosh's frames, whose sizes decide its grid (the UI's sizes are intent only). Resolves once it does; a core opened for Mosh has been doing so from its first byte. Absent: the core cannot, and the adapter refuses Mosh. */
  canonicalFrames?(): Promise<void>;
  /** An inactive session keeps parsing; the core stops waking the adapter. */
  setActive?(active: boolean): void;
  /** The app's terminal theme changed: the core reports these colours to the programs that ask for them from now on. */
  setTheme?(theme: TerminalTheme): void;
  /** The History lines setting changed: the core keeps that many rows of history from now on (fewer drops the oldest at once) and answers with its state. Absent: the core keeps the number it opened with. */
  setScrollback?(lines: number): Promise<NativeCoreSnapshot>;
  /** Present when the core answers questions about the text itself; without it the adapter reads the window of rows. */
  query?<Q extends NativeCoreQuery>(query: Q): Promise<NativeCoreAnswer<Q>>;
  /** The cells the core's renderer highlights as selected; `undefined` clears them. */
  select?(range: TerminalRange | undefined): void;
  subscribe(listener: (event: NativeCoreEvent) => void): Disposable;
  /** Frees the core. Idempotent. */
  close(): Promise<void>;
}
