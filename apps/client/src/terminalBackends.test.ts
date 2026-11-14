// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createTerminalBackends, developerBackendOverride} from './terminalBackends';
import type {BackendProbe} from './terminalBackendRegistry';

afterEach(() => { localStorage.clear(); vi.unstubAllEnvs(); vi.resetModules(); });

function backends(options: {killed?: boolean; probe?: BackendProbe; override?: 'native' | 'xterm'} = {}) {
  const announced: string[] = [], asked: string[] = [];
  const set = createTerminalBackends({
    killed: options.killed, override: () => options.override, announce: reason => announced.push(reason),
    probeNative: () => { asked.push('probe'); return options.probe ?? {ok: false, reason: 'This build has no native terminal renderer.'}; },
  });
  return {...set, announced, asked};
}

describe('terminal backends', () => {
  it('gives a session xterm.js by default without probing or announcing anything', async () => {
    const {registry, announced, asked} = backends();
    expect(await registry.select()).toEqual({id: 'xterm', reason: 'automatic', fallbacks: []});
    expect(announced).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('falls back to xterm.js and says why when a developer asks for native and its probe fails', async () => {
    const {registry, create, announced} = backends({override: 'native'});
    expect(await registry.select({override: 'native'})).toEqual({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'This build has no native terminal renderer.'}]});
    const {selection, adapter} = await create();
    expect(selection.id).toBe('xterm');
    expect(adapter.backend).toBe('xterm');
    // Said once, not again for every session that follows.
    await (await create()).adapter.dispose();
    await adapter.dispose();
    expect(announced).toEqual(['This build has no native terminal renderer.']);
  });

  it('never picks native while the kill switch is on, and does not even probe', async () => {
    const {registry, create, announced, asked} = backends({killed: true, override: 'native', probe: {ok: true}});
    expect(await registry.select({override: 'native'})).toMatchObject({id: 'xterm', fallbacks: [{id: 'native', reason: 'The native terminal engine is switched off in this build.'}]});
    await (await create()).adapter.dispose();
    expect(asked).toEqual([]);
    expect(announced).toEqual(['The native terminal engine is switched off in this build.']);
  });

  it('lets a developer pick native only when its probe passes', async () => {
    const {registry} = backends({probe: {ok: true}});
    expect(await registry.select({override: 'native'})).toEqual({id: 'native', reason: 'developer override', fallbacks: []});
    // Automatic selection never reaches for native, even when it could run.
    expect(await registry.select()).toMatchObject({id: 'xterm', fallbacks: []});
  });

  it('reads the developer override from the device and ignores anything else', () => {
    expect(developerBackendOverride()).toBeUndefined();
    localStorage.setItem('lazysh.terminal.backend', 'native');
    expect(developerBackendOverride()).toBe('native');
    localStorage.setItem('lazysh.terminal.backend', 'auto');
    expect(developerBackendOverride()).toBeUndefined();
  });

  it('reads the build-time kill switch from the environment the build was made with', async () => {
    vi.stubEnv('VITE_LAZYSH_DISABLE_NATIVE_TERMINAL', '1');
    vi.resetModules();
    const {createTerminalBackends: killedBuild} = await import('./terminalBackends');
    const asked: string[] = [];
    const set = killedBuild({override: () => 'native', probeNative: () => { asked.push('probe'); return {ok: true}; }, announce: () => {}});
    expect(await set.registry.select({override: 'native'})).toMatchObject({id: 'xterm', fallbacks: [{id: 'native', reason: 'The native terminal engine is switched off in this build.'}]});
    expect(asked).toEqual([]);
    vi.stubEnv('VITE_LAZYSH_DISABLE_NATIVE_TERMINAL', '');
    vi.resetModules();
    const {createTerminalBackends: openBuild} = await import('./terminalBackends');
    expect(await openBuild({override: () => 'native', probeNative: () => ({ok: true}), announce: () => {}}).registry.select({override: 'native'})).toMatchObject({id: 'native'});
  });
});
