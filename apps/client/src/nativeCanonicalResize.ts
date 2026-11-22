import type {CanonicalResize, TerminalFailure} from './terminalAdapter';

type Size = {cols: number; rows: number};

/** What the Mosh transport and the core accept (`packages/terminal-runtime/src/mosh.rs`, as `moshResize.ts` does): 2 to 512 columns, 1 to 256 rows, at most 32,768 cells. */
const valid = ({cols, rows}: Size) => Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && cols <= 512 && rows >= 1 && rows <= 256 && cols * rows <= 32768;

/**
 * The native backend's half of a Mosh session: the transport decides the grid (its frames reach the core, which applies them
 * top-anchored and without reflow), and the sizes the UI wants are intents, handed to whoever listens, normally the page that
 * asks the Mosh server for that size. A frame the core refuses fails the display for good, as `moshResize.ts` does.
 */
export class NativeCanonicalResize implements CanonicalResize {
  private reason: TerminalFailure | null = null;
  private open = true;
  private closing: Promise<void> | undefined;
  /** Each listener with the last size it was told, so one that is told a size twice hears it once. */
  private readonly listeners = new Map<(size: Size) => void, Size | undefined>();

  /** `settled` resolves once the core has handled everything the adapter sent it; `failed` tells the adapter's subscribers. */
  constructor(private readonly settled: () => Promise<unknown>, private readonly failed: (reason: TerminalFailure) => void) {}

  get failure() { return this.reason; }

  requestSize(cols: number, rows: number) {
    if (!this.open) return;
    const wanted = {cols, rows};
    if (!valid(wanted)) throw new Error('This terminal cannot apply canonical Mosh resizing.');
    for (const [listener, told] of [...this.listeners]) {
      if (told?.cols === cols && told.rows === rows) continue;
      this.listeners.set(listener, wanted);
      listener({...wanted});
    }
  }

  onResizeIntent(listener: (size: Size) => void) {
    if (this.open) this.listeners.set(listener, undefined);
    return {dispose: () => { this.listeners.delete(listener); }};
  }

  /** The core said its display cannot follow the transport. The first reason stays. */
  fail(reason: TerminalFailure) {
    if (this.reason) return;
    this.reason = reason; this.open = false; this.listeners.clear();
    this.failed(reason);
  }

  close() {
    this.open = false; this.listeners.clear();
    return this.closing ??= this.settled().then(() => undefined, () => undefined);
  }

  dispose() { this.open = false; this.listeners.clear(); }
}
