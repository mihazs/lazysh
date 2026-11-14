import {describe, expect, it} from 'vitest';
import {placePage, windowArguments, type HistoryWindow, type WindowRequest} from './historyWindow';

const session = Array.from({length: 12_000}, (_, index) => ({id: `m${index}`}));
const page = (from: number, to: number, total = session.length) => ({messages: session.slice(from, to), older: from > 0, newer: to < total});
const ids = (state: HistoryWindow<{id: string}>) => state.messages.map(message => message.id);

describe('reading a 12k message session from its end to its first message', () => {
  it('keeps every page contiguous, bounded, and reaches the start', () => {
    let state: HistoryWindow<{id: string}> = placePage({messages: [], older: false, newer: false}, {kind: 'tail'}, page(11_900, 12_000));
    let peak = 0;
    while (state.older) {
      const first = Number(state.messages[0].id.slice(1));
      state = placePage(state, {kind: 'before', id: `m${first}`}, page(Math.max(0, first - 100), first), false, 400);
      peak = Math.max(peak, state.messages.length);
      const numbers = state.messages.map(message => Number(message.id.slice(1)));
      expect(numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1)).toBe(true);
    }
    expect(peak).toBe(400);
    expect(ids(state)[0]).toBe('m0');
    expect(state.newer).toBe(true);
  });

  it('walks forward from the start to the newest page and drops the far end instead of growing', () => {
    let state = placePage({messages: [], older: false, newer: false}, {kind: 'start'}, page(0, 100));
    expect(state).toMatchObject({older: false, newer: true});
    while (state.newer) {
      const last = Number(state.messages.at(-1)!.id.slice(1));
      state = placePage(state, {kind: 'after', id: `m${last}`}, page(last + 1, Math.min(session.length, last + 101)));
      expect(state.messages.length).toBeLessThanOrEqual(400);
    }
    expect(state.messages.at(-1)!.id).toBe('m11999');
    expect(state.older).toBe(true);
  });
});

describe('the newest page while older pages are loaded', () => {
  const loaded: HistoryWindow<{id: string}> = {messages: session.slice(100, 300), older: true, newer: false};
  it('keeps the older pages in front when the pages meet, and moves the window down as the session grows', () => {
    const next = placePage(loaded, {kind: 'tail'}, page(250, 350, 350));
    expect(ids(next)[0]).toBe('m100');
    expect(next.messages.at(-1)!.id).toBe('m349');
    expect(next.messages).toHaveLength(250);
    expect(next.older).toBe(true);
  });
  it('replaces the window when nothing is shared, when the window is away from the newest page, or when fresh', () => {
    const far = placePage(loaded, {kind: 'tail'}, page(11_900, 12_000));
    expect(ids(far)[0]).toBe('m11900');
    expect(far).toMatchObject({older: true, newer: false});
    expect(placePage({...loaded, newer: true}, {kind: 'tail'}, page(250, 350)).messages).toHaveLength(100);
    expect(placePage(loaded, {kind: 'tail'}, page(250, 350), true).messages).toHaveLength(100);
  });
});

it('maps requests to the native window arguments', () => {
  const args = (request: WindowRequest) => windowArguments(request);
  expect([{kind: 'tail'}, {kind: 'start'}, {kind: 'before', id: 'a'}, {kind: 'after', id: 'b'}].map(request => args(request as WindowRequest)))
    .toEqual([undefined, {fromStart: true}, {before: 'a'}, {after: 'b'}]);
});
