import { beforeEach, expect, it, vi } from 'vitest';
const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
import { accessSnapshot, acknowledgeAccessReady, applyAccessStatus, bindProtectedApi, bindProtectedInvoke, captureAccess, guardAccessCallback, parseAccessStatus, protectedInvoke, sessionOutput } from './access';

let generationBase = 0;
const status = (generation: string, locked = false) => ({ initialized: true, supported: true,
  reason: '', enabled: true, locked, generation: String(generationBase + ({a:1,b:2,c:3}[generation] ?? 0)), ...(locked ? {} : { nonce: generation.repeat(64) }) });
beforeEach(() => { generationBase += 10; nativeInvoke.mockReset(); applyAccessStatus(status('a')); acknowledgeAccessReady(accessSnapshot().epoch); });
it('sends the original immutable nonce header and never retries a stale response', async () => {
  let resolve!: (value: string) => void;
  nativeInvoke.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
  const request = protectedInvoke<string>('read_file', { sessionId: 's', path: '/secret' });
  const rejected = expect(request).rejects.toThrow('App access changed');
  expect(nativeInvoke).toHaveBeenCalledWith('read_file', { sessionId: 's', path: '/secret' },
    { headers: { 'X-Lazysh-Access': 'a'.repeat(64) } });
  applyAccessStatus(status('b', true)); await rejected;
  applyAccessStatus(status('c')); resolve('stale private contents');
  await Promise.resolve(); expect(nativeInvoke).toHaveBeenCalledTimes(1);
});
it('does not let an old async component callback acquire a new nonce after unlock', async () => {
  const invoke = bindProtectedInvoke(captureAccess());
  applyAccessStatus(status('b', true)); applyAccessStatus(status('c'));
  await expect(invoke('write_stdin', { sessionId: 's', data: 'old draft' })).rejects.toThrow('App access changed');
  expect(nativeInvoke).not.toHaveBeenCalled();
  nativeInvoke.mockResolvedValue('fresh');
  await expect(protectedInvoke('read_file')).resolves.toBe('fresh');
  expect(nativeInvoke.mock.calls[0][2].headers['X-Lazysh-Access']).toBe('c'.repeat(64));
});
it('fences bridge methods and channel callbacks from an old mounted view', async () => {
  const method = vi.fn(); const callback = vi.fn();
  const api = bindProtectedApi({ method }, captureAccess());
  const deliver = guardAccessCallback(callback);
  deliver('before'); applyAccessStatus(status('b', true)); applyAccessStatus(status('c'));
  deliver('after'); await expect(api.method()).rejects.toThrow('App access changed');
  expect(method).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledExactlyOnceWith('before');
});
it('rejects locked calls before native and rejects malformed status instead of accepting a nonce', async () => {
  applyAccessStatus(status('b', true));
  await expect(protectedInvoke('list_hosts')).rejects.toThrow('App access changed');
  expect(nativeInvoke).not.toHaveBeenCalled();
  expect(() => parseAccessStatus({ ...status('b', true), nonce: 'b'.repeat(64) })).toThrow('Invalid native');
  expect(() => parseAccessStatus({ ...status('a'), nonce: 'not-a-nonce' })).toThrow('Invalid native');
});
it('retains already-delivered terminal output through lock without reusing a tools lease', () => {
  const callback = vi.fn(); const deliver = sessionOutput(callback);
  deliver({type:'data',data:[1]}); applyAccessStatus(status('b',true));
  deliver({type:'data',data:[2,3]}); deliver({type:'closed'});
  expect(callback).toHaveBeenCalledTimes(1);
  applyAccessStatus(status('c'));
  expect(callback).toHaveBeenCalledTimes(1);
  acknowledgeAccessReady(accessSnapshot().epoch);
  expect(callback.mock.calls.map(([value])=>value.type)).toEqual(['data','data','closed']);
  expect(callback.mock.calls[1][0].data).toEqual([2,3]);
});
it('ignores older numeric status generations instead of restoring an old nonce', async () => {
  applyAccessStatus(status('c'));const invoke=bindProtectedInvoke(captureAccess());
  applyAccessStatus(status('a'));nativeInvoke.mockResolvedValue('current');
  await expect(invoke('list_hosts')).resolves.toBe('current');
  expect(nativeInvoke.mock.calls[0][2].headers['X-Lazysh-Access']).toBe('c'.repeat(64));
});
it('keeps OFF-policy renderer replacement fenced until the new initialized nonce arrives', async () => {
  const old = { ...status('a'), enabled: false, nonce: undefined };
  applyAccessStatus(old); const original = bindProtectedInvoke(captureAccess());
  nativeInvoke.mockResolvedValue([]); await protectedInvoke('list_hosts');
  expect(nativeInvoke.mock.calls[0][2].headers['X-Lazysh-Access']).toBe('');
  applyAccessStatus({ ...status('b', true), enabled: false, initialized: false });
  await expect(original('list_hosts')).rejects.toThrow('App access changed');
  applyAccessStatus({ ...status('c'), enabled: false }); applyAccessStatus(old);
  await protectedInvoke('list_hosts');
  expect(nativeInvoke.mock.calls.at(-1)![2].headers['X-Lazysh-Access']).toBe('c'.repeat(64));
});
