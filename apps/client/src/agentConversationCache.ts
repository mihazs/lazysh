import {accessSnapshot, subscribeAccess} from './access';

/** The newest messages of a conversation the Agent view has read, kept for this page's lifetime so that coming back to it
 * (another agent in Herdr, another session, a reconnect) shows the last known content at once while the host is asked again.
 * Memory only, never storage: a conversation can hold secrets, as the composer history does. A lock of the app drops it. */
export type CachedConversation<M, A, Q, W, S> = Readonly<{messages: readonly M[]; older: boolean; activity?: A; queued: Q; work?: W; session?: S}>;
const LIMIT = 8;
export const CACHED_MESSAGES = 100;

const entries = new Map<string, CachedConversation<never, never, never, never, never>>();
subscribeAccess(() => {if (accessSnapshot().status?.locked) entries.clear();});

export const conversationKey = (sessionId: string, source: {agent: string; path: string; herdr?: {herdrSession: string}}) =>
  JSON.stringify([sessionId, source.agent, source.path, source.herdr?.herdrSession ?? null]);

export function cachedConversation<M, A, Q, W, S>(key: string): CachedConversation<M, A, Q, W, S> | undefined {
  const found = entries.get(key);
  if (!found) return;
  // Least recently used goes first.
  entries.delete(key); entries.set(key, found);
  return found as unknown as CachedConversation<M, A, Q, W, S>;
}
export function rememberConversation<M, A, Q, W, S>(key: string, value: CachedConversation<M, A, Q, W, S>) {
  entries.delete(key);
  entries.set(key, {...value, messages: value.messages.slice(-CACHED_MESSAGES)} as unknown as CachedConversation<never, never, never, never, never>);
  while (entries.size > LIMIT) entries.delete(entries.keys().next().value!);
}
export const forgetConversations = () => entries.clear();
