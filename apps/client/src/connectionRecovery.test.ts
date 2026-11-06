import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ConnectionRecovery, RECOVERY_MAX_ATTEMPTS, RECOVERY_MAX_DELAY, reconnectDelay, retriableFailure, type RecoveryOutcome} from './connectionRecovery';

describe('reconnectDelay', () => {
  it('doubles from one second, caps at thirty seconds and jitters by at most a fifth', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(attempt => reconnectDelay(attempt, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(reconnectDelay(3, () => 0)).toBe(3200);
    expect(reconnectDelay(3, () => 1)).toBe(4800);
    expect(reconnectDelay(20, () => 1)).toBe(RECOVERY_MAX_DELAY * 1.2);
  });
});

describe('retriableFailure', () => {
  it('keeps retrying transport failures and stops on credential or host-key decisions', () => {
    expect(retriableFailure({kind: 'ssh_error', message: 'Connection refused'})).toBe(true);
    expect(retriableFailure({kind: 'timeout', message: 'SSH connection timed out'})).toBe(true);
    expect(retriableFailure(new Error('offline'))).toBe(true);
    for (const kind of ['authentication_failed', 'credentials_required', 'host_key_changed', 'unknown_host_key'])
      expect(retriableFailure({kind, message: kind})).toBe(false);
  });
});

describe('ConnectionRecovery', () => {
  let online = true;
  let outcomes: RecoveryOutcome[] = [];
  const attempt = vi.fn(async () => outcomes.shift() ?? {retry: true, message: 'Connection refused'});
  const changed = vi.fn();
  const recovery = () => new ConnectionRecovery({attempt, changed, online: () => online, random: () => 0.5, now: () => Date.now()});
  beforeEach(() => { vi.useFakeTimers(); online = true; outcomes = []; attempt.mockClear(); changed.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it('retries with growing delays until one attempt reconnects, then forgets the session', async () => {
    const subject = recovery();
    outcomes = [{retry: true, message: 'refused'}, {retry: true, message: 'refused'}, 'reconnected'];
    subject.start('a', true);
    expect(subject.state('a')).toMatchObject({phase: 'waiting', attempt: 0, retryAt: Date.now() + 1000});
    await vi.advanceTimersByTimeAsync(999);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(subject.state('a')).toMatchObject({phase: 'waiting', attempt: 1});
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(subject.has('a')).toBe(false);
  });

  it('slows to the cap while offline and retries at once when the network returns', async () => {
    const subject = recovery();
    online = false;
    subject.start('a', true);
    expect(subject.state('a')).toEqual({phase: 'offline', attempt: 0});
    await vi.advanceTimersByTimeAsync(RECOVERY_MAX_DELAY - 1);
    expect(attempt).not.toHaveBeenCalled();
    // A wrong offline signal must not strand the session: the capped probe still runs.
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(subject.state('a')).toEqual({phase: 'offline', attempt: 1});
    outcomes = ['reconnected'];
    online = true;
    subject.networkChanged(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(subject.has('a')).toBe(false);
  });

  it('defers a pending retry to the cap when the device goes offline', async () => {
    const subject = recovery();
    subject.start('a', true);
    online = false;
    subject.networkChanged(false);
    expect(subject.state('a')).toEqual({phase: 'offline', attempt: 0});
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('stops on a final failure and only an explicit retry tries again', async () => {
    const subject = recovery();
    outcomes = [{retry: false, message: 'Authentication rejected by the server'}];
    subject.start('a', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(subject.state('a')).toEqual({phase: 'stopped', attempt: 1, message: 'Authentication rejected by the server', exhausted: false});
    subject.networkChanged(true);
    await vi.advanceTimersByTimeAsync(RECOVERY_MAX_DELAY * 2);
    expect(attempt).toHaveBeenCalledTimes(1);
    outcomes = ['reconnected'];
    subject.retryNow('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(subject.has('a')).toBe(false);
  });

  it('gives up after the attempt cap until the network returns', async () => {
    const subject = recovery();
    subject.start('a', true);
    await vi.advanceTimersByTimeAsync(RECOVERY_MAX_DELAY * 2 * RECOVERY_MAX_ATTEMPTS);
    expect(attempt).toHaveBeenCalledTimes(RECOVERY_MAX_ATTEMPTS);
    expect(subject.state('a')).toMatchObject({phase: 'stopped', attempt: RECOVERY_MAX_ATTEMPTS, exhausted: true});
    subject.networkChanged(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(RECOVERY_MAX_ATTEMPTS + 1);
  });

  it('never prompts on its own for a session that needs the person, and Retry now runs immediately', async () => {
    const subject = recovery();
    subject.start('a', false, 'Unlock to reconnect');
    await vi.advanceTimersByTimeAsync(RECOVERY_MAX_DELAY * 2);
    expect(attempt).not.toHaveBeenCalled();
    subject.retryNow('a');
    expect(subject.state('a')).toEqual({phase: 'connecting', attempt: 1});
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('cancelling discards the pending timer and a late result of the attempt in flight', async () => {
    const subject = recovery();
    let finish: (value: RecoveryOutcome) => void = () => {};
    attempt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    subject.start('a', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(subject.state('a')).toEqual({phase: 'connecting', attempt: 1});
    subject.cancel('a');
    finish({retry: true, message: 'late'});
    await vi.advanceTimersByTimeAsync(RECOVERY_MAX_DELAY * 2);
    expect(subject.has('a')).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
