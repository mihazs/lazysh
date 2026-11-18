import {describe, expect, it, vi} from 'vitest';
import {confirmHint, type ListenerVerdict} from './authListeners';

const hint = {port: 8085, firstSeenAt: '2026-11-13T10:00:00Z'};
const start = Date.parse(hint.firstSeenAt);
const listener = {source: 'companion', bind: 'loopback', ownedBySessionUser: true} as const;
const unknownAge = {source: 'fallback', bind: 'loopback', ownedBySessionUser: true} as const;

/** A clock that moves only when the correlator sleeps, and the answers the host would give in turn. */
function host(answers: ListenerVerdict[]) {
  let at = start;
  const asked: number[] = [];
  const check = vi.fn(async (_port: number, seenSecondsAgo: number) => {
    asked.push(seenSecondsAgo);
    return answers[Math.min(asked.length - 1, answers.length - 1)];
  });
  return {check, asked, options: {now: () => at, sleep: async (ms: number) => { at += ms; }}};
}

describe('confirming a sign-in hint against the host listeners', () => {
  it('confirms at once a listener that started with the sign-in', async () => {
    const {check, options} = host([{state: 'confirmed', listener: {...listener, ageSeconds: 3}}]);
    expect(await confirmHint(hint, check, options)).toMatchObject({state: 'confirmed', appeared: false});
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith(8085, 0);
  });

  it('reports the age of the hint to the host so no clock has to agree with another', async () => {
    const {check, asked, options} = host([{state: 'absent'}, {state: 'absent'}, {state: 'confirmed', listener}]);
    await confirmHint(hint, check, options);
    expect(asked).toEqual([0, 1, 2]);
  });

  it('waits for a listener that is not there yet and gives up 30 seconds after the hint', async () => {
    const {check, asked, options} = host([{state: 'absent'}]);
    expect(await confirmHint(hint, check, options)).toEqual({state: 'absent', appeared: false});
    expect(asked.at(-1)).toBe(30);
    expect(asked).toHaveLength(31);
  });

  it('does not wait for an old listener: a long-running program on the port is not this sign-in', async () => {
    const {check, options} = host([{state: 'stale', listener: {...listener, ageSeconds: 86_000}}]);
    expect(await confirmHint(hint, check, options)).toMatchObject({state: 'stale'});
    expect(check).toHaveBeenCalledOnce();
  });

  it('cannot prove a listener of unknown age that was there from the start', async () => {
    const {check, options} = host([{state: 'unproven', listener: unknownAge}]);
    expect(await confirmHint(hint, check, options)).toMatchObject({state: 'unproven', appeared: false});
    expect(check).toHaveBeenCalledOnce();
  });

  it('confirms a listener of unknown age that appeared after the port was seen empty', async () => {
    const {check, options} = host([{state: 'absent'}, {state: 'absent'}, {state: 'unproven', listener: unknownAge}]);
    expect(await confirmHint(hint, check, options)).toMatchObject({state: 'confirmed', appeared: true, listener: unknownAge});
  });

  it('stops asking when it is aborted', async () => {
    const controller = new AbortController();
    const {check, options} = host([{state: 'absent'}]);
    check.mockImplementation(async () => { controller.abort(); return {state: 'absent'} as const; });
    expect(await confirmHint(hint, check, {...options, signal: controller.signal})).toEqual({state: 'absent', appeared: false});
    expect(check).toHaveBeenCalledOnce();
  });

  it('refuses a hint without a time', async () => {
    await expect(confirmHint({port: 1, firstSeenAt: 'yesterday'}, vi.fn(), {})).rejects.toThrow('time it was first seen');
  });
});
