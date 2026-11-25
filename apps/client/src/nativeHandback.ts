import {Channel} from '@tauri-apps/api/core';
import {isAccessReady, channelSessionOutput, StaleAccessError} from './access';
import type {SshEvent} from './bridge';
import {registerSessionOutput} from './pendingSessions';
import type {TerminalAdapter} from './terminalAdapter';
import {SWITCHED} from './terminalBackendRegistry';
import type {LiveSession} from './terminal';
import {releaseNativeCore} from './tauriNativeCoreBridge';

export type HandbackOptions = {
  /** What the session does with an event of its transport: write the data to `session.adapter`, acknowledge it, note the close. */
  onEvent(event: SshEvent): void;
  /** A fresh xterm.js terminal for the session. */
  createXterm(): Promise<TerminalAdapter>;
  /** The reason the native engine is recorded as failed, when it failed; absent when the user chose to leave. */
  failure?: string;
};

/**
 * Moves a live native session onto xterm.js (#1342): a new terminal of the same size shows the screen, cursor and modes the core
 * snapshots, then the transport's output, which `terminal_core_release` routes to a new Channel from one chunk boundary on, so every byte
 * is applied once and in order. Held back until the snapshot is on screen: whatever the Channel delivers meanwhile. Not carried over:
 * scrollback and the other losses `terminal-adapter.md` lists. Resolves to whether the screen was carried over; when the core
 * could not answer, the output already flows to xterm.js and the program's next redraw fills it.
 */
export async function handBackToXterm(session: LiveSession, {onEvent, createXterm, failure}: HandbackOptions): Promise<boolean> {
  const from = session.adapter;
  if (from.backend !== 'native' || !session.id) throw new Error('This session is not on the native engine.');
  // A locked app cannot send the command, and the transport stays with the core.
  if (!isAccessReady()) throw new StaleAccessError();
  const to = await createXterm();
  to.requestSize(from.size());
  const held: SshEvent[] = [];
  let holding = true;
  const events = new Channel<SshEvent>();
  const disposeOutput = channelSessionOutput(events, event => holding ? held.push(event) : onEvent(event));
  registerSessionOutput(session.id, disposeOutput);
  let carried = false;
  try {
    await to.write!(new TextEncoder().encode(await releaseNativeCore(session.id, events)));
    carried = true;
  } catch { /* The output flows to `events` all the same: nothing is carried over, and nothing is lost. */ }
  if (session.disposed) { void to.dispose(); return false; }
  session.adapter = to;
  session.selection = failure === undefined ? {id: 'xterm', reason: SWITCHED, fallbacks: []} : {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: failure}]};
  session.leaveNative = undefined;
  // The same turn that lets the Channel through, so no event slips between the held ones and the next.
  for (const event of held.splice(0)) onEvent(event);
  holding = false;
  void from.dispose();
  window.dispatchEvent(new Event('lazysh-session-change'));
  return carried;
}
