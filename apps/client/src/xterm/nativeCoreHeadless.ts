/**
 * A native-core stand-in for tests: the control plane of {@link NativeCoreBridge} over a headless xterm.js terminal, which
 * parses the same VT stream the Rust core does. It lets the adapter contract run where the real core (libghostty-vt, built
 * with Zig) cannot, and it is NOT evidence about the Rust core: the Rust commands have their own tests. It lives with the
 * xterm backend because it is built on xterm.js and goes when xterm.js does (#1343).
 */
import {Terminal} from '@xterm/headless';
import {decodeClipboardRequest} from '../preferences';
import type {NativeCoreBridge, NativeCoreEvent, NativeCoreSnapshot} from '../nativeCoreBridge';
import {cwdFromOsc7} from '../terminalText';
import type {TerminalModes} from '../terminalAdapter';

export type HeadlessCoreOptions = {
  columns?: number; rows?: number; scrollbackLines?: number;
  /** Rows of text in every snapshot's window. */
  window?: number;
  /** The WebView hands transport bytes to the core (`feed`); without it the test pushes output with `output()` like a runtime. */
  feed?: boolean;
};

export type HeadlessCore = NativeCoreBridge & {
  /** What a transport does in a runtime that owns it: parse the bytes, then ring the doorbell. */
  output(bytes: Uint8Array): Promise<void>;
  readonly closed: boolean;
  /** What the bridge was asked to do, in order. */
  readonly calls: string[];
  /** What the adapter sent the program. */
  readonly inputs: {data: string | Uint8Array; origin: string}[];
};

export function createHeadlessCore({columns = 20, rows = 5, scrollbackLines = 200, window = 256, feed = true}: HeadlessCoreOptions = {}): HeadlessCore {
  const terminal = new Terminal({cols: columns, rows, scrollback: scrollbackLines, allowProposedApi: true});
  const listeners = new Set<(event: NativeCoreEvent) => void>();
  const send = (event: NativeCoreEvent) => listeners.forEach(listener => listener(event));
  terminal.onTitleChange(title => send({type: 'title', title}));
  terminal.onBell(() => send({type: 'bell'}));
  terminal.parser.registerOscHandler(7, data => { const path = cwdFromOsc7(data); if (path !== undefined) send({type: 'cwd', path}); return true; });
  terminal.parser.registerOscHandler(52, data => { const text = decodeClipboardRequest(data); if (text !== undefined) send({type: 'clipboard', text}); return true; });
  const calls: string[] = [], inputs: HeadlessCore['inputs'] = [];
  let closed = false;

  const snapshot = (): NativeCoreSnapshot => {
    const buffer = terminal.buffer.active, {viewportY, baseY, length} = buffer;
    const first = Math.min(Math.max(0, length - window), viewportY);
    const modes: TerminalModes = {
      bracketedPaste: terminal.modes.bracketedPasteMode, mouseTracking: terminal.modes.mouseTrackingMode,
      alternateScreen: buffer.type === 'alternate', applicationCursorKeys: terminal.modes.applicationCursorKeysMode,
    };
    return {
      state: {columns: terminal.cols, rows: terminal.rows, cursor: {x: buffer.cursorX, y: buffer.cursorY}, modes, scrollbackLines, viewport: {top: viewportY, rows: terminal.rows, length, following: viewportY === baseY}},
      window: {first, rows: Array.from({length: Math.min(window, length - first)}, (_, i) => buffer.getLine(first + i)?.translateToString(true).trimEnd() ?? '')},
    };
  };
  const parse = (bytes: Uint8Array) => new Promise<void>(resolve => terminal.write(bytes, resolve));
  const core: HeadlessCore = {
    calls, inputs,
    get closed() { return closed; },
    async snapshot() { calls.push('snapshot'); return snapshot(); },
    async scroll(action) {
      calls.push('scroll');
      if (action.kind === 'lines') terminal.scrollLines(action.delta);
      else if (action.kind === 'pages') terminal.scrollPages(action.delta);
      else if (action.kind === 'toTop') terminal.scrollToTop();
      else if (action.kind === 'toBottom') terminal.scrollToBottom();
      else terminal.scrollToLine(action.row);
      return snapshot();
    },
    async input(data, origin) { inputs.push({data, origin}); },
    subscribe(listener) { listeners.add(listener); return {dispose: () => { listeners.delete(listener); }}; },
    async close() { closed = true; terminal.dispose(); },
    async output(bytes) { await parse(bytes); send({type: 'changed'}); },
  };
  if (feed) {
    core.feed = async bytes => { calls.push('feed'); await parse(bytes); return snapshot(); };
    core.resize = async size => { calls.push('resize'); terminal.resize(size.columns, size.rows); return snapshot(); };
  }
  return core;
}
