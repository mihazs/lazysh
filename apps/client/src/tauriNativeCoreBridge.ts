import {Channel, type InvokeArgs} from '@tauri-apps/api/core';
import type {NativeCoreBridge, NativeCoreEvent, NativeCoreSnapshot, NativeCoreState} from './nativeCoreBridge';
import type {Disposable, TerminalInputOrigin} from './terminalAdapter';
import {cwdFromOsc7} from './terminalText';

/** What the `terminal_core_*` commands answer (apps/client/src-tauri/src/terminal_core.rs; `control-plane.json` pins the shape from both sides). */
type CoreAnswer = {
  state: Omit<NativeCoreState, 'scrollbackLines'>;
  window: NativeCoreSnapshot['window'];
  events?: ({type: 'bell'} | {type: 'cwd'; report: string} | {type: 'clipboard'; text: string})[];
};

export type TauriCoreOptions = {
  /** The session whose core this is. */
  sessionId: string;
  /** The history the session was opened with: the core answers sizes and positions, not settings. */
  scrollbackLines: number;
  /** Runs a command under the renderer's access lease (`bindProtectedInvoke`). */
  invoke<T>(command: string, args?: InvokeArgs): Promise<T>;
  /** Sends typed input, a paste or a terminal reply to the session's transport through the app's input path, whose lease checks and ordering apply. */
  input(data: string | Uint8Array, origin: TerminalInputOrigin): Promise<void>;
  /** Rows of text per answer; the app clamps it. */
  window?: number;
  channel?: () => {onmessage: (signal: {type: 'changed'}) => void};
};

const noop = () => {};

/** The native core of a session over the `terminal_core_*` commands. Only text, sizes and positions cross: no command returns cells. */
export async function createTauriNativeCoreBridge({sessionId, scrollbackLines, invoke, input, window, channel = () => new Channel<{type: 'changed'}>()}: TauriCoreOptions): Promise<NativeCoreBridge> {
  const listeners = new Set<(event: NativeCoreEvent) => void>();
  const doorbell = channel();
  doorbell.onmessage = () => listeners.forEach(listener => listener({type: 'changed'}));
  await invoke('terminal_core_watch', {sessionId, events: doorbell});

  // The core already decoded and bounded a clipboard write; an OSC 7 report is decoded here as the xterm backend does.
  const events = (reported: CoreAnswer['events'] = []) => reported.flatMap((event): NativeCoreEvent[] => {
    if (event.type !== 'cwd') return [event];
    const path = cwdFromOsc7(event.report);
    return path === undefined ? [] : [{type: 'cwd', path}];
  });
  const snapshot = (answer: CoreAnswer): NativeCoreSnapshot => ({state: {...answer.state, scrollbackLines}, window: answer.window, events: events(answer.events)});
  const ask = (command: string, args: InvokeArgs = {}) => invoke<CoreAnswer>(command, {sessionId, window, ...args}).then(snapshot);
  let closed: Promise<void> | undefined;
  return {
    snapshot: () => ask('terminal_core_snapshot'),
    scroll: action => ask('terminal_core_scroll', {action}),
    input,
    setActive: active => { void invoke('terminal_core_active', {sessionId, active}).catch(noop); },
    subscribe(listener): Disposable {
      listeners.add(listener);
      return {dispose: () => { listeners.delete(listener); }};
    },
    close: () => closed ??= invoke<void>('terminal_core_close', {sessionId}).finally(() => { doorbell.onmessage = noop; listeners.clear(); }),
  };
}
