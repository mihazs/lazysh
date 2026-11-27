import {afterEach, describe, expect, it, vi} from 'vitest';
import type {TerminalAdapter, TerminalBackendId, TerminalCapabilities} from './terminalAdapter';
import {StaleAccessError} from './access';
import {createBackendRegistry, type BackendProbe, type FailureMemory} from './terminalBackendRegistry';

const capabilities = (over: Partial<TerminalCapabilities> = {}): TerminalCapabilities => ({
  nativeRendering: false, selection: true, scrollback: true, mouseReporting: true, ime: true, accessibility: true,
  screenInspection: true, canonicalMoshResize: true, customBoldColor: true, ...over,
});
const adapter = (backend: TerminalBackendId) => ({backend}) as TerminalAdapter;

function registry(native: {probe?: BackendProbe | Error; autoEligible?: boolean; capabilities?: Partial<TerminalCapabilities>; create?: () => TerminalAdapter; failures?: FailureMemory} = {}) {
  const r = createBackendRegistry(native.failures);
  const probe = vi.fn(() => { if (native.probe instanceof Error) throw native.probe; return native.probe ?? {ok: true} as BackendProbe; });
  r.register({id: 'xterm', capabilities: capabilities(), autoEligible: true, probe: () => ({ok: true}), create: () => adapter('xterm')});
  r.register({id: 'native', capabilities: capabilities({nativeRendering: true, ...native.capabilities}), autoEligible: native.autoEligible ?? false, probe, create: native.create ?? (() => adapter('native'))});
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

  it('asks the probe again only when re-probed, so a device that now passes is offered and a repeat of the same question is not asked', async () => {
    let passes = false;
    const {r, probe} = registry();
    probe.mockImplementation(() => passes ? {ok: true} : {ok: false, reason: 'no hardware GPU'});
    expect(await r.refusal('native')).toBe('no hardware GPU');
    expect(await r.refusal('native')).toBe('no hardware GPU');
    expect(probe).toHaveBeenCalledTimes(1);
    passes = true;
    expect(await r.reprobe('native')).toBeUndefined();
    expect(probe).toHaveBeenLastCalledWith({fresh: true});
    expect(await r.refusal('native')).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
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

  it('gives a Mosh session only a backend that follows its frames, and tells the backend at creation that it is one', async () => {
    const {r, probe} = registry({capabilities: {canonicalMoshResize: false}});
    expect(await r.select({preference: 'native', mosh: true})).toMatchObject({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks canonicalMoshResize'}]});
    expect(probe).not.toHaveBeenCalled();
    expect(await r.select({preference: 'native'})).toMatchObject({id: 'native'});
    const created = vi.fn(() => adapter('native'));
    const capable = createBackendRegistry();
    capable.register({id: 'xterm', capabilities: capabilities(), autoEligible: true, probe: () => ({ok: true}), create: () => adapter('xterm')});
    capable.register({id: 'native', capabilities: capabilities(), autoEligible: false, probe: () => ({ok: true}), create: created});
    await capable.create({preference: 'native', mosh: true});
    await capable.create({preference: 'native'});
    expect(created.mock.calls).toEqual([[{mosh: true}], [{mosh: undefined}]]);
  });

  it('answers Settings with the reason a selection would record for a backend, or nothing when it is usable', async () => {
    expect(await registry().r.refusal('native')).toBeUndefined();
    expect(await registry({probe: {ok: false, reason: 'no Vulkan'}}).r.refusal('native')).toBe('no Vulkan');
    const {r, probe} = registry({capabilities: {accessibility: false}});
    expect(await r.refusal('native', ['accessibility'])).toBe('lacks accessibility');
    expect(probe).not.toHaveBeenCalled();
    expect(await createBackendRegistry().refusal('native')).toBe('not registered');
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

describe('the build-time kill switch of the native backend', () => {
  afterEach(() => vi.unstubAllGlobals());
  const killed = {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'disabled in this build'}]};

  it('lets a registered native backend through when the switch is not set, as before', async () => {
    for (const stub of [() => {}, () => vi.stubGlobal('__LAZYSH_NATIVE_TERMINAL_OFF__', false)]) {
      stub();
      expect(await registry({autoEligible: true}).r.select({override: 'native'})).toMatchObject({id: 'native', reason: 'developer override'});
      expect(await registry({autoEligible: true}).r.refusal('native')).toBeUndefined();
    }
  });

  it('ignores the preference and the developer override for a registered, eligible, probed-ok native backend, and never probes or creates it', async () => {
    vi.stubGlobal('__LAZYSH_NATIVE_TERMINAL_OFF__', true);
    const {r, probe} = registry({autoEligible: true});
    expect(await r.select({preference: 'native'})).toEqual(killed);
    expect(await r.select({override: 'native'})).toEqual(killed);
    expect(await r.select({preference: 'auto'})).toEqual(killed);
    expect(await r.select()).toEqual(killed);
    const {adapter: created} = await r.create({preference: 'native'});
    expect([created.backend, probe.mock.calls.length]).toEqual(['xterm', 0]);
  });

  it('records that native is off under Auto when nothing registers it, and keeps what the user chose when it is xterm.js', async () => {
    vi.stubGlobal('__LAZYSH_NATIVE_TERMINAL_OFF__', true);
    const r = createBackendRegistry();
    r.register({id: 'xterm', capabilities: capabilities(), autoEligible: true, probe: () => ({ok: true}), create: () => adapter('xterm')});
    expect(await r.select()).toEqual(killed);
    expect(await r.select({preference: 'xterm'})).toEqual({id: 'xterm', reason: 'preference', fallbacks: []});
  });

  it('refuses Native with the reason for the Settings choice, so the choice is disabled in such a build', async () => {
    vi.stubGlobal('__LAZYSH_NATIVE_TERMINAL_OFF__', true);
    const {r, probe} = registry({autoEligible: true});
    expect([await r.refusal('native'), await r.refusal('xterm'), probe.mock.calls.length]).toEqual(['disabled in this build', undefined, 0]);
  });
});

describe('release gate', () => {
  it('never gives native to Auto even when its probe passes, and gives it to an explicit choice', async () => {
    const {r} = registry();
    expect((await r.select()).id).toBe('xterm');
    expect((await r.select({preference: 'native'})).id).toBe('native');
  });
});

describe('a native session that fails to start', () => {
  const broken = () => { throw new Error('terminal_core_open: no surface'); };
  const failed = {id: 'native', reason: 'failed: terminal_core_open: no surface'};

  it('starts on xterm.js, records the failure among the reasons and keeps Auto away from native afterwards', async () => {
    const {r} = registry({autoEligible: true, create: broken});
    const first = await r.create();
    expect([first.adapter.backend, first.selection]).toEqual(['xterm', {id: 'xterm', reason: 'fallback', fallbacks: [failed]}]);
    expect(r.failure('native')).toBe(failed.reason);
    // Auto does not try native again, and says why.
    expect(await r.create()).toMatchObject({adapter: {backend: 'xterm'}, selection: {id: 'xterm', reason: 'fallback', fallbacks: [failed]}});
    expect((await r.select()).fallbacks).toEqual([failed]);
  });

  it('lets an explicit Native choice try again, and forgets the failure once a start works', async () => {
    let works = false;
    const {r} = registry({autoEligible: true, create: () => { if (!works) broken(); return adapter('native'); }});
    await r.create();
    expect(await r.refusal('native')).toBeUndefined();
    expect(await r.create({preference: 'native'})).toMatchObject({selection: {id: 'xterm', fallbacks: [failed]}});
    works = true;
    expect(await r.create({preference: 'native'})).toMatchObject({adapter: {backend: 'native'}, selection: {id: 'native', reason: 'preference'}});
    expect(r.failure('native')).toBeUndefined();
    expect((await r.create()).selection).toEqual({id: 'native', reason: 'automatic', fallbacks: []});
  });

  it('records a failure that happens in a session the same way, bounded, and answers the reason', async () => {
    const {r} = registry({autoEligible: true});
    expect(r.recordFailure('native', new Error('x'.repeat(500)))).toBe(`failed: ${'x'.repeat(200)}`);
    expect((await r.select()).fallbacks).toEqual([{id: 'native', reason: `failed: ${'x'.repeat(200)}`}]);
  });

  it('keeps the failure in the memory it was given, so a device keeps it', async () => {
    const kept = new Map<string, string>();
    const memory: FailureMemory = {get: id => kept.get(id), set: (id, reason) => void kept.set(id, reason), clear: id => void kept.delete(id)};
    await registry({autoEligible: true, create: broken, failures: memory}).r.create();
    expect([...kept]).toEqual([['native', failed.reason]]);
    expect((await registry({autoEligible: true, failures: memory}).r.select()).fallbacks).toEqual([failed]);
  });

  it('does not count a locked app as a failure of the engine, and cannot fall back from xterm.js', async () => {
    const {r} = registry({autoEligible: true, create: () => { throw new StaleAccessError(); }});
    await expect(r.create()).rejects.toBeInstanceOf(StaleAccessError);
    expect(r.failure('native')).toBeUndefined();
    const lone = createBackendRegistry();
    lone.register({id: 'xterm', capabilities: capabilities(), autoEligible: true, probe: () => ({ok: true}), create: () => { throw new Error('no DOM'); }});
    await expect(lone.create()).rejects.toThrow('no DOM');
  });

  it('does not fall back when the fallback itself is refused (a requirement it cannot meet)', async () => {
    const r = createBackendRegistry();
    r.register({id: 'xterm', capabilities: capabilities({accessibility: false}), autoEligible: true, probe: () => ({ok: true}), create: () => adapter('xterm')});
    r.register({id: 'native', capabilities: capabilities(), autoEligible: false, probe: () => ({ok: true}), create: broken});
    await expect(r.create({preference: 'native', requires: ['accessibility']})).rejects.toThrow('terminal_core_open: no surface');
  });
});
