import {describe, expect, it, vi} from 'vitest';
import type {TerminalAdapter, TerminalBackendId, TerminalCapabilities} from './terminalAdapter';
import {createBackendRegistry, type BackendProbe} from './terminalBackendRegistry';

const capabilities = (over: Partial<TerminalCapabilities> = {}): TerminalCapabilities => ({
  nativeRendering: false, selection: true, scrollback: true, mouseReporting: true, ime: true, accessibility: true,
  screenInspection: true, canonicalMoshResize: true, customBoldColor: true, ...over,
});
const adapter = (backend: TerminalBackendId) => ({backend}) as TerminalAdapter;

function registry(native: {probe?: BackendProbe | Error; autoEligible?: boolean; capabilities?: Partial<TerminalCapabilities>} = {}) {
  const r = createBackendRegistry();
  const probe = vi.fn(() => { if (native.probe instanceof Error) throw native.probe; return native.probe ?? {ok: true} as BackendProbe; });
  r.register({id: 'xterm', capabilities: capabilities(), autoEligible: true, probe: () => ({ok: true}), create: () => adapter('xterm')});
  r.register({id: 'native', capabilities: capabilities({nativeRendering: true, ...native.capabilities}), autoEligible: native.autoEligible ?? false, probe, create: () => adapter('native')});
  return {r, probe};
}

describe('terminal backend selection', () => {
  it('keeps xterm for automatic selection until native is declared eligible', async () => {
    const {r, probe} = registry();
    expect(await r.select()).toEqual({id: 'xterm', reason: 'automatic', fallbacks: []});
    expect(probe).not.toHaveBeenCalled();
    expect((await registry({autoEligible: true}).r.select()).id).toBe('native');
  });

  it('lets a preference or a developer override choose native, with the override winning', async () => {
    const {r} = registry();
    expect(await r.select({preference: 'native'})).toMatchObject({id: 'native', reason: 'preference'});
    expect(await r.select({preference: 'xterm', override: 'native'})).toMatchObject({id: 'native', reason: 'developer override'});
    expect(await r.select({preference: 'native', override: 'xterm'})).toMatchObject({id: 'xterm'});
  });

  it('never lets an override enable a backend whose probe failed, and records why', async () => {
    for (const probe of [{ok: false, reason: 'no Vulkan'} as BackendProbe, new Error('surface crashed')]) {
      const {r} = registry({probe});
      const selection = await r.select({override: 'native'});
      expect(selection.id).toBe('xterm');
      expect(selection.reason).toBe('fallback');
      expect(selection.fallbacks).toEqual([{id: 'native', reason: probe instanceof Error ? 'Error: surface crashed' : 'no Vulkan'}]);
    }
  });

  it('skips a backend that lacks a required capability without probing it', async () => {
    const {r, probe} = registry({capabilities: {accessibility: false}});
    const selection = await r.select({preference: 'native', requires: ['accessibility']});
    expect(selection).toMatchObject({id: 'xterm', fallbacks: [{id: 'native', reason: 'lacks accessibility'}]});
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes once and creates the selected adapter', async () => {
    const {r, probe} = registry();
    await r.select({preference: 'native'});
    const {selection, adapter: created} = await r.create({preference: 'native'});
    expect([selection.id, created.backend, probe.mock.calls.length]).toEqual(['native', 'native', 1]);
  });

  it('fails loudly when nothing is usable and rejects duplicate registration', async () => {
    const r = createBackendRegistry();
    await expect(r.select()).rejects.toThrow('No terminal backend is usable: xterm (not registered)');
    const {r: both} = registry();
    expect(() => both.register({id: 'xterm', capabilities: capabilities(), autoEligible: true, probe: () => ({ok: true}), create: () => adapter('xterm')})).toThrow('already registered');
  });
});
