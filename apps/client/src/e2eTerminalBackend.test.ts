import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {type AdapterPage, assertNativeBackendObserved, BACKEND_ENV, onAdapter, onEngine, requestedBackend} from './e2eTerminalBackend';
import type {TerminalAdapter, TerminalBackendId} from './terminalAdapter';
import type {BackendSelection} from './terminalBackendRegistry';

afterEach(() => vi.unstubAllEnvs());

type Handle = {evaluate: (read: (value: unknown, arg?: unknown) => unknown, arg?: unknown) => Promise<unknown>; evaluateHandle: (pick: (value: unknown) => unknown) => Promise<Handle>; dispose: () => Promise<void>};
const handleTo = (value: unknown): Handle => ({evaluate: async (read, arg) => read(value, arg), evaluateHandle: async pick => handleTo(pick(value)), dispose: async () => {}});

/** A page whose drawn terminal is a `backend` adapter whose session recorded `selection`; the reads run here instead of in a browser. */
const pageDrawing = (backend: TerminalBackendId, selection: BackendSelection = {id: backend, reason: 'automatic', fallbacks: []}) => ({
  evaluateHandle: async () => handleTo({adapter: {backend}, selection}),
}) as unknown as AdapterPage;

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

  it('requires a successful native adapter read on the same page', async () => {
    vi.stubEnv(BACKEND_ENV, 'native');
    const native = pageDrawing('native'), wrong = pageDrawing('xterm');
    await onEngine(native);
    expect(() => assertNativeBackendObserved(native)).toThrow(/Native backend unverified/);
    await expect(onAdapter(native, () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
    expect(() => assertNativeBackendObserved(native)).toThrow(/Native backend unverified/);
    await expect(onAdapter(wrong, adapter => adapter.backend)).rejects.toThrow(/xterm backend/);
    expect(() => assertNativeBackendObserved(wrong)).toThrow(/Native backend unverified/);
    await expect(onAdapter(native, adapter => adapter.backend)).resolves.toBe('native');
    expect(() => assertNativeBackendObserved(native)).not.toThrow();
    expect(() => assertNativeBackendObserved(pageDrawing('native'))).toThrow(/Native backend unverified/);
  });

  it('asserts nothing when no backend was requested', async () => {
    vi.stubEnv(BACKEND_ENV, '');
    await expect(onAdapter(pageDrawing('native'), adapter => adapter.backend)).resolves.toBe('native');
  });

  it('reads the engine the drawn terminal got and why, whatever backend was requested', async () => {
    vi.stubEnv(BACKEND_ENV, 'native');
    const recorded: BackendSelection = {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks accessibility'}]};
    await expect(onEngine(pageDrawing('xterm', recorded))).resolves.toEqual({backend: 'xterm', selection: recorded});
  });
});

describe('the program the source build type-checks', () => {
  it('never reaches Playwright, whose types the F-Droid build (it removes playwright-core) lacks', () => {
    const client = join(dirname(fileURLToPath(import.meta.url)), '..');
    const config = ts.getParsedCommandLineOfConfigFile(join(client, 'tsconfig.json'), {}, {...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); }})!;
    const program = ts.createProgram({rootNames: config.fileNames, options: config.options});
    const reached = program.getSourceFiles().map(file => relative(client, file.fileName).split(sep).join('/')).filter(file => /(^|\/)node_modules\/(@playwright|playwright|playwright-core)\//.test(file));
    expect(reached).toEqual([]);
  }, 60_000);
});
