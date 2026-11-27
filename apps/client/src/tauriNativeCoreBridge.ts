/**
 * The NativeCoreBridge over the app's `terminal_core_*` Tauri commands (docs/architecture/terminal-adapter.md, "Native backend").
 * The transport feeds the core in Rust, so the bridge has no `feed` and no `resize`: it asks for state and sends input.
 * Commands belong to the renderer's access lease (a locked app is refused and told nothing); `terminal_core_close` is allowed
 * while locked, like a disconnect, and so are the probe's `terminal_core_available` and `native_terminal_probe`, which read the build and the device, nothing of the user's.
 */
import {Channel, invoke as unguardedInvoke, isTauri} from '@tauri-apps/api/core';
import {channelSessionOutput, isAccessReady, protectedInvoke, subscribeAccess, type AccessLease} from './access';
import type {SshEvent} from './bridge';
import type {NativeCoreAnswer, NativeCoreBridge, NativeCoreEvent, NativeCoreQuery, NativeCoreSnapshot} from './nativeCoreBridge';
import {NativeTerminalAdapter, type NativeAdapterOptions} from './nativeTerminalAdapter';
import {registerSessionOutput} from './pendingSessions';
import type {BackendProbe} from './terminalBackendRegistry';

const noop = () => {};
const coreEvents: ReadonlySet<string> = new Set<NativeCoreEvent['type']>(['changed', 'title', 'bell', 'cwd', 'clipboard', 'failure']);
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
  /** The session's transport is Mosh: its frames decide the grid's size, so the core follows them and takes the renderer's sizes as intent. */
  canonicalFrames?: boolean;
  cursorStyle?: "bar" | "block" | "underline";
  cursorBlink?: boolean;
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

type ProbeAnswer = {available?: boolean; reason?: string} | null;

/**
 * The native backend's probe: the app says whether this build has the core compiled in and a host to draw it on
 * (`terminal_core_available`, free), and only then whether the device's GPU can draw it (`native_terminal_probe`, #1336,
 * which the app bounds and answers once per process). Only an explicit yes to both passes, so no app, an app without a
 * command or an unexpected answer is a refusal with a reason. A rejected command is the registry's to record. `fresh` is the
 * re-probe path: the app forgets its kept device answer and asks the GPU again.
 */
export async function probeNativeCore({fresh = false}: {fresh?: boolean} = {}): Promise<BackendProbe> {
  if (!isTauri()) return {ok: false, reason: 'this is not the lazysh app'};
  for (const [command, silent] of [['terminal_core_available', 'the app did not report a native terminal core'], ['native_terminal_probe', 'the app did not report whether this device can draw a native terminal']] as const) {
    const answer = await (command === 'native_terminal_probe' && fresh ? unguardedInvoke<ProbeAnswer>(command, {fresh}) : unguardedInvoke<ProbeAnswer>(command));
    if (answer?.available !== true) return {ok: false, reason: answer?.reason || silent};
  }
  return {ok: true};
}

/**
 * Opens a native core for a session that is about to start and returns its adapter. The core is built when the transport
 * starts with `events`, so the session id arrives later, through `bind`; until then the adapter shows the blank screen the core opens with.
 */
export async function createNativeTerminalAdapter(options: NativeTerminalOptions): Promise<NativeTerminalOpening> {
  const {columns, rows, scrollbackLines: opened, canonicalFrames, cursorStyle, cursorBlink, onTransportEvent, ...adapterOptions} = options;
  let scrollbackLines = opened;
  let {theme} = adapterOptions;
  const events = new Channel<NativeCoreEvent | SshEvent>();
  const listeners = new Set<(event: NativeCoreEvent) => void>();
  const disposeOutput = channelSessionOutput(events, event => {
    if (isCoreEvent(event)) listeners.forEach(listener => listener(event)); else { onTransportEvent?.(event); adapter.transport?.onEvent?.(event); }
  });
  try {
    // The colours the core reports to the programs that ask for them, and the Mosh mode, are fixed before its first byte.
    const config = theme || canonicalFrames || cursorStyle ? {theme, canonicalFrames, ...cursorStyle && {cursorStyle, cursorBlink}} : undefined;
    await protectedInvoke('terminal_core_open', {events, cols: columns, rows, scrollbackLines: opened, config});
  } catch (error) {
    disposeOutput();
    throw asError(error);
  }

  let bind!: (session: Promise<string>) => void, bound = false;
  const session = new Promise<string>(resolve => { bind = started => { bound = true; resolve(started); }; });
  // A failed start is the caller's to report; the commands that waited for the id reject with it and the adapter drops them.
  session.then(id => registerSessionOutput(id, disposeOutput), disposeOutput);

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
    if (now && !ready) {
      call('terminal_core_set_active', {active}).catch(noop);
      // A theme chosen while the app was locked was refused, and must not be lost.
      if (theme) call('terminal_core_theme', {theme}).catch(noop);
    }
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
    async key(input) { await call('terminal_core_input', {input}); },
    async mouse(input) { await call('terminal_core_input', {input}); },
    query<Q extends NativeCoreQuery>({kind, ...args}: Q) {
      // One command per question: `selectionText` is `terminal_core_selection_text`, with the question's fields as its arguments.
      return call<NativeCoreAnswer<Q>>(`terminal_core_${kind.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`, args);
    },
    select(range) { call('terminal_core_select', {range: range ?? null}).catch(noop); },
    setActive(value) {
      active = value;
      call('terminal_core_set_active', {active}).catch(noop);
    },
    async setScrollback(lines) {
      await call('terminal_core_scrollback', {lines});
      scrollbackLines = lines;
      return snapshot('terminal_core_snapshot');
    },
    setTheme(next) {
      theme = next;
      call('terminal_core_theme', {theme}).catch(noop);
    },
    // The mode is fixed when the core opens: a core that was not opened for Mosh cannot follow its frames.
    ...canonicalFrames && {canonicalFrames: async () => {}},
    subscribe(listener) {
      listeners.add(listener);
      return {dispose: () => { listeners.delete(listener); }};
    },
    close() {
      return closing ??= (async () => {
        stopWatching(); disposeOutput(); listeners.clear();
        // A transport that never started has no session to wait for.
        const sessionId = bound ? await session.catch(() => undefined) : undefined;
        // A session that never started has no core to free: the failed start already did.
        if (sessionId) await unguardedInvoke('terminal_core_close', {sessionId});
      })();
    },
  };
  const adapter = new NativeTerminalAdapter(bridge, blank(options), adapterOptions);
  adapter.transport = {events, bind};
  return {adapter, events, bind};
}

/**
 * Hands a native session's transport back to the WebView (#1342): from the next chunk on its output and closing notice arrive on
 * `events`, and the answer is the ANSI snapshot of the screen the program had until then, which a fresh terminal of the same size
 * replays first. The core is freed. Under the lease of this call, like every command of the core.
 */
export async function releaseNativeCore(lease: AccessLease, sessionId: string, events: Channel<SshEvent>) {
  lease.assert();
  // Wait for the ownership receipt even if access changes. Native redacts stale snapshots.
  const snapshot = await unguardedInvoke<{ansi: string; columns: number; rows: number} | null>('terminal_core_release', {sessionId, events}, {headers: lease.headers});
  return lease.current() ? snapshot : null;
}
