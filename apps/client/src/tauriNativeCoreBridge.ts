/**
 * The NativeCoreBridge over the app's `terminal_core_*` Tauri commands (docs/architecture/terminal-adapter.md, "Native backend").
 * The transport feeds the core in Rust, so the bridge has no `feed` and no `resize`: it asks for state and sends input.
 * Commands belong to the renderer's access lease (a locked app is refused and told nothing); `terminal_core_close` alone is
 * allowed while locked, like a disconnect.
 */
import {Channel, invoke as unguardedInvoke} from '@tauri-apps/api/core';
import {isAccessReady, protectedInvoke, sessionOutput, subscribeAccess} from './access';
import type {SshEvent} from './bridge';
import type {NativeCoreBridge, NativeCoreEvent, NativeCoreSnapshot} from './nativeCoreBridge';
import {NativeTerminalAdapter, type NativeAdapterOptions} from './nativeTerminalAdapter';
import {registerSessionOutput} from './pendingSessions';

const noop = () => {};
const coreEvents: ReadonlySet<string> = new Set<NativeCoreEvent['type']>(['changed', 'title', 'bell', 'cwd', 'clipboard']);
const isCoreEvent = (event: {type: string}): event is NativeCoreEvent => coreEvents.has(event.type);
/** Tauri rejects with the command's error value, usually a string; a caller of `createNativeTerminalAdapter` gets an `Error`, a lease refusal (`StaleAccessError`) as it is. */
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

/** What the commands answer: a snapshot without the History lines setting, which the client opened the core with. */
type Answer = {state: Omit<NativeCoreSnapshot['state'], 'scrollbackLines'>; window: NativeCoreSnapshot['window']};

export type NativeTerminalOptions = NativeAdapterOptions & {
  columns: number;
  rows: number;
  /** The History lines setting (100 to 20,000). */
  scrollbackLines: number;
  /** Everything on `events` that is not the core's: the transport's `closed` notice and auth hints. */
  onTransportEvent?: (event: SshEvent) => void;
};

export type NativeTerminalOpening = {
  adapter: NativeTerminalAdapter;
  /** Start the transport with this Channel: the core attaches to the session that starts on it, and its reports arrive on it. */
  events: Channel<NativeCoreEvent | SshEvent>;
  /** The transport's answer: the id of the session that started on `events`, or why it did not. Commands wait for it. */
  bind(session: Promise<string>): void;
};

/** The screen of a core that has just opened: blank, the cursor home, following the live rows. */
const blank = ({columns, rows, scrollbackLines}: NativeTerminalOptions): NativeCoreSnapshot => ({
  state: {
    columns, rows, cursor: {x: 0, y: 0}, scrollbackLines,
    modes: {bracketedPaste: false, mouseTracking: 'none', alternateScreen: false, applicationCursorKeys: false},
    viewport: {top: 0, rows, length: rows, following: true},
  },
  window: {first: 0, rows: []},
});

/**
 * Opens a native core for a session that is about to start and returns its adapter. The core is built when the transport
 * starts with `events`, so the session id arrives later, through `bind`; until then the adapter shows the blank screen the core opens with.
 */
export async function createNativeTerminalAdapter(options: NativeTerminalOptions): Promise<NativeTerminalOpening> {
  const {columns, rows, scrollbackLines, onTransportEvent, ...adapterOptions} = options;
  const events = new Channel<NativeCoreEvent | SshEvent>();
  const listeners = new Set<(event: NativeCoreEvent) => void>();
  const deliver = sessionOutput<NativeCoreEvent | SshEvent>(event => {
    if (isCoreEvent(event)) listeners.forEach(listener => listener(event)); else onTransportEvent?.(event);
  });
  events.onmessage = deliver;
  try {
    await protectedInvoke('terminal_core_open', {events, cols: columns, rows, scrollbackLines});
  } catch (error) {
    deliver.dispose();
    throw asError(error);
  }

  let bind!: (session: Promise<string>) => void;
  const session = new Promise<string>(resolve => { bind = resolve; });
  // A failed start is the caller's to report; the commands that waited for the id reject with it and the adapter drops them.
  session.then(id => registerSessionOutput(id, deliver.dispose), noop);

  const call = async <T>(command: string, args: Record<string, unknown> = {}) => {
    const sessionId = await session;
    return protectedInvoke<T>(command, {sessionId, ...args});
  };
  const snapshot = (command: string, args?: Record<string, unknown>) => call<Answer>(command, args)
    .then((answer): NativeCoreSnapshot => ({...answer, state: {...answer.state, scrollbackLines}}));

  let active = true, ready = isAccessReady(), closing: Promise<void> | undefined;
  // The core sends under the lease of the reader's latest command, so after a lock it is silent until a reader speaks again.
  const stopWatching = subscribeAccess(() => {
    const now = isAccessReady();
    if (now && !ready) call('terminal_core_set_active', {active}).catch(noop);
    ready = now;
  });

  const bridge: NativeCoreBridge = {
    snapshot: () => snapshot('terminal_core_snapshot'),
    scroll: action => snapshot('terminal_core_scroll', {action}),
    async input(data) {
      // The core's `text` input is sent verbatim, which is what the adapter built; xterm.js' backend decodes bytes the same way.
      const text = typeof data === 'string' ? data : new TextDecoder('utf-8', {fatal: true}).decode(data);
      await call('terminal_core_input', {input: {type: 'text', text}});
    },
    setActive(value) {
      active = value;
      call('terminal_core_set_active', {active}).catch(noop);
    },
    subscribe(listener) {
      listeners.add(listener);
      return {dispose: () => { listeners.delete(listener); }};
    },
    close() {
      return closing ??= (async () => {
        stopWatching(); deliver.dispose(); listeners.clear();
        const sessionId = await session.catch(() => undefined);
        // A session that never started has no core to free: the failed start already did.
        if (sessionId) await unguardedInvoke('terminal_core_close', {sessionId});
      })();
    },
  };
  return {adapter: new NativeTerminalAdapter(bridge, blank(options), adapterOptions), events, bind};
}
