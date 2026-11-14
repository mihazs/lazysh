/**
 * What the NativeTerminalAdapter asks of a native terminal core (docs/architecture/terminal-adapter.md, "Native backend").
 * This is a control plane: every value is a size, a position, a mode flag or the TEXT of rows. No command returns a
 * cell grid, styles or pixels; the renderer reads those inside the runtime.
 */
import type {Disposable, TerminalInputOrigin, TerminalModes, TerminalScrollAction, TerminalViewport} from './terminalAdapter';

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

/** What every state-changing command answers: the new state and the rows the adapter's synchronous readers serve from, with what the program reported since the last answer. */
export type NativeCoreSnapshot = {state: NativeCoreState; window: NativeRowWindow; events?: NativeCoreEvent[]};

/** One per occurrence, in order. `changed` is a coalesced doorbell: the screen differs, pull a `snapshot`. The others may arrive in a snapshot's `events` or through `subscribe`. */
export type NativeCoreEvent =
  | {type: 'changed'}
  | {type: 'title'; title: string}
  | {type: 'bell'}
  | {type: 'cwd'; path: string}
  | {type: 'clipboard'; text: string};

export interface NativeCoreBridge {
  snapshot(): Promise<NativeCoreSnapshot>;
  scroll(action: TerminalScrollAction): Promise<NativeCoreSnapshot>;
  /** Typed input, a paste or a terminal reply, as the text the program should receive. */
  input(data: string | Uint8Array, origin: TerminalInputOrigin): Promise<void>;
  /** Present only when the WebView hands transport bytes to the core (a core-only build, tests). A runtime that owns the transport has none. */
  feed?(bytes: Uint8Array): Promise<NativeCoreSnapshot>;
  /** Present when the WebView sizes the core itself; with a transport the core follows the PTY resize instead. */
  resize?(size: {columns: number; rows: number}): Promise<NativeCoreSnapshot>;
  /** An inactive session keeps parsing; the core stops waking the adapter. */
  setActive?(active: boolean): void;
  subscribe(listener: (event: NativeCoreEvent) => void): Disposable;
  /** Frees the core. Idempotent. */
  close(): Promise<void>;
}
