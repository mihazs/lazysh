import type {useProtectedInvoke} from './access';
import {LocalUiError} from './i18n/localError';

type Invoke = ReturnType<typeof useProtectedInvoke>;

/** Keep touch history requests separate from terminal input and ordinary mouse wheels. */
export async function observeHerdrHistory(invoke: Invoke, sessionId: string): Promise<unknown> {
  const reply = await invoke<{kind:string; destination:unknown}>('herdr_chat', {sessionId, action:{kind:'observe'}});
  if (reply.kind !== 'observed' || !reply.destination) throw new LocalUiError('unavailable');
  return reply.destination;
}

export function scrollHerdrHistory(invoke: Invoke, sessionId: string, destination: unknown, x: number, y: number, lines: number) {
  return invoke('herdr_chat', {sessionId, action:{kind:'scroll_history', destination, x, y, lines}});
}
