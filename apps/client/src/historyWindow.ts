/** The part of a long session the Agent view holds. Pages read from the host land at either end of this window by
 * message id, so the reading position survives, and the window never grows past `WINDOW_CAP` messages: reading on
 * drops the far end, which a later scroll or Jump reads back. */
export const WINDOW_CAP = 400;

export type HistoryWindow<M extends {id: string}> = {messages: M[]; older: boolean; newer: boolean};
/** `tail` is the newest page, `start` the first page of the session, `before` and `after` the neighbours of a message. */
export type WindowRequest = {kind: 'tail'} | {kind: 'start'} | {kind: 'before'; id: string} | {kind: 'after'; id: string};
/** A page the host cut from the whole session: `older`/`newer` say whether more exists beyond each end. */
export type WindowPage<M extends {id: string}> = {messages: M[]; older: boolean; newer: boolean};

/** The arguments the native commands take for a request; the newest page needs none. */
export function windowArguments(request: WindowRequest): {before: string} | {after: string} | {fromStart: true} | undefined {
  switch (request.kind) {
    case 'before': return {before: request.id};
    case 'after': return {after: request.id};
    case 'start': return {fromStart: true};
    default: return undefined;
  }
}

const unique = <M extends {id: string}>(messages: M[]): M[] => [...new Map(messages.map(message => [message.id, message])).values()];

/** Places a page into the window. `fresh` drops what is loaded (a new source, or the window is away from the newest page). */
export function placePage<M extends {id: string}>(state: HistoryWindow<M>, request: WindowRequest, page: WindowPage<M>, fresh = false, cap = WINDOW_CAP): HistoryWindow<M> {
  let next: HistoryWindow<M>;
  if (request.kind === 'start') next = {messages: page.messages, older: false, newer: page.newer};
  else if (request.kind === 'before') next = {messages: unique([...page.messages, ...state.messages]), older: page.older, newer: state.newer};
  else if (request.kind === 'after') next = {messages: unique([...state.messages, ...page.messages]), older: state.older, newer: page.newer};
  else {
    // The newest page replaces the tail of what is loaded. Older pages already read stay in front when the two meet.
    const tail = new Set(page.messages.map(message => message.id));
    const meet = state.messages.findIndex(message => tail.has(message.id));
    next = fresh || state.newer || meet < 0
      ? {messages: page.messages, older: page.older, newer: false}
      : {messages: unique([...state.messages.slice(0, meet), ...page.messages]), older: state.older, newer: false};
  }
  if (next.messages.length <= cap) return next;
  // Reading towards one end releases the other.
  return request.kind === 'before' || request.kind === 'start'
    ? {...next, messages: next.messages.slice(0, cap), newer: true}
    : {...next, messages: next.messages.slice(-cap), older: true};
}
