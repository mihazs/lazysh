import type {Page} from '@playwright/test';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BACKEND_ENV, requestedBackend} from '../e2e/fixtures/terminalBackend';
import {onAdapter} from '../e2e/fixtures/terminalState';
import type {TerminalAdapter, TerminalBackendId} from './terminalAdapter';

afterEach(() => vi.unstubAllEnvs());

/** A page whose drawn terminal is a `backend` adapter; the read runs here instead of in a browser. */
const pageDrawing = (backend: TerminalBackendId) => ({
  evaluateHandle: async () => ({evaluate: async (read: (adapter: unknown, arg?: unknown) => unknown, arg?: unknown) => read({backend}, arg), dispose: async () => {}}),
}) as unknown as Page;

describe('the backend a terminal e2e run asked for', () => {
  it('is whatever the app picks when none was requested, and rejects a name that is not a backend', () => {
    expect(requestedBackend({})).toBeUndefined();
    expect(requestedBackend({[BACKEND_ENV]: ''})).toBeUndefined();
    expect(requestedBackend({[BACKEND_ENV]: 'native'})).toBe('native');
    expect(() => requestedBackend({[BACKEND_ENV]: 'ghostty'})).toThrow(`${BACKEND_ENV} must be xterm or native, not "ghostty"`);
  });

  it('fails a read against a terminal that is not the requested backend, before the read runs', async () => {
    vi.stubEnv(BACKEND_ENV, 'native');
    const read = vi.fn(() => 'rows');
    await expect(onAdapter(pageDrawing('xterm'), read)).rejects.toThrow(/native but the terminal on screen is the xterm backend/);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads from a terminal of the requested backend', async () => {
    vi.stubEnv(BACKEND_ENV, 'xterm');
    await expect(onAdapter(pageDrawing('xterm'), (adapter: TerminalAdapter, suffix: string) => `${adapter.backend}${suffix}`, '!')).resolves.toBe('xterm!');
  });

  it('asserts nothing when no backend was requested', async () => {
    vi.stubEnv(BACKEND_ENV, '');
    await expect(onAdapter(pageDrawing('native'), adapter => adapter.backend)).resolves.toBe('native');
  });
});
