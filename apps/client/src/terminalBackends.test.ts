// @vitest-environment jsdom
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {stubMatchMedia} from './test/stubMatchMedia';
import type {TerminalAdapter, TerminalCapabilities} from './terminalAdapter';
import {defaults, savePreferences} from './preferences';
import {createBackendRegistry, type BackendProbe} from './terminalBackendRegistry';
import {backendRefusal, createTerminalAdapter, defaultTerminalEngine, recordedNativeFailure, recordNativeFailure, registerNativeBackend} from './terminalBackends';
import {appVersion} from './version';
import {describeTerminalEngine} from './terminalEngineReason';
import {xtermCapabilities} from './xtermTerminalAdapter';

const openCore = vi.hoisted(() => vi.fn());
const systemReader = vi.hoisted(() => vi.fn(async () => false));
vi.mock('./androidScreenReader', () => ({systemScreenReader: systemReader}));
// The real probe and capabilities stay; only opening a core, which needs the Tauri commands, is replaced.
vi.mock('./tauriNativeCoreBridge', async original => ({...await original<typeof import('./tauriNativeCoreBridge')>(), createNativeTerminalAdapter: openCore}));

beforeAll(stubMatchMedia);
// The preferences are cached beyond the storage: a screen-reader test must not leave its setting to the next test.
afterEach(() => { localStorage.clear(); savePreferences(defaults); localStorage.clear(); openCore.mockReset(); systemReader.mockReset().mockResolvedValue(false); });

const withXterm = () => {
  const registry = createBackendRegistry();
  registry.register({id: 'xterm', capabilities: xtermCapabilities, autoEligible: true, probe: () => ({ok: true}), create: () => ({backend: 'xterm'}) as TerminalAdapter});
  return registry;
};
const native = (over: Partial<TerminalCapabilities>) => {
  const registry = withXterm();
  registry.register({id: 'native', capabilities: {...xtermCapabilities, nativeRendering: true, ...over}, autoEligible: true, probe: () => ({ok: true}), create: () => ({backend: 'native'}) as TerminalAdapter});
  return registry;
};

describe('backend selection for a reader who uses a screen reader', () => {

  it('keeps a native backend that cannot reach a screen reader out of a new session and records why', async () => {
    const registry = native({accessibility: false});
    expect(await createTerminalAdapter({preference: 'native'}, registry)).toMatchObject({selection: {id: 'native'}});
    savePreferences({...defaults, screenReader: true});
    expect(await createTerminalAdapter({preference: 'native'}, registry)).toMatchObject({selection: {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks accessibility'}]}});
  });

  it('offers a native backend that declares accessibility to a screen-reader session', async () => {
    savePreferences({...defaults, screenReader: true});
    expect((await createTerminalAdapter({preference: 'native'}, native({accessibility: true}))).selection.id).toBe('native');
  });

  it('applies the screen-reader preference to every new session, and xterm still satisfies it', async () => {
    const {selection, adapter} = await createTerminalAdapter();
    expect(selection.id).toBe('xterm');
    await adapter.dispose();
    savePreferences({...defaults, screenReader: true});
    const reading = await createTerminalAdapter();
    expect(reading.selection).toMatchObject({id: 'xterm', fallbacks: []});
    expect(reading.adapter.capabilities.accessibility).toBe(true);
    await reading.adapter.dispose();
  });
});

describe('backend selection while Android reports a screen reader (TalkBack, touch exploration)', () => {
  const lacking = {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks accessibility'}]};

  it('keeps a native backend that cannot reach it out of a new session, under Auto and Native, with the reason, though the in-app preference is off', async () => {
    systemReader.mockResolvedValue(true);
    for (const preference of ['auto', 'native'] as const)
      expect((await createTerminalAdapter({preference}, native({accessibility: false}))).selection).toEqual(lacking);
    expect(await defaultTerminalEngine(native({accessibility: false}))).toBe('xterm');
  });

  it('keeps Settings\' answer for the Native choice in step: refused while it is on, offered again once it is off', async () => {
    systemReader.mockResolvedValue(true);
    expect(await backendRefusal('native', false)).toBe('lacks accessibility');
    systemReader.mockResolvedValue(false);
    // Outside the app the probe is what refuses it; the screen reader no longer does.
    expect(await backendRefusal('native', false)).toBe('this is not the lazysh app');
  });

  it('gives native back to the next session once it is off, and to a backend that declares accessibility while it is on', async () => {
    const registry = native({accessibility: false});
    systemReader.mockResolvedValue(true);
    expect((await createTerminalAdapter({preference: 'native'}, registry)).selection).toEqual(lacking);
    systemReader.mockResolvedValue(false);
    expect((await createTerminalAdapter({preference: 'native'}, registry)).selection.id).toBe('native');
    systemReader.mockResolvedValue(true);
    expect((await createTerminalAdapter({preference: 'native'}, native({accessibility: true}))).selection.id).toBe('native');
  });
});

describe('the engine each preference value selects', () => {
  it('uses xterm.js for every value outside the app, where the registered native engine fails its probe, and records why Native was refused', async () => {
    const selections = await Promise.all((['auto', 'xterm', 'native'] as const).map(async preference => {
      const {selection, adapter} = await createTerminalAdapter({preference});
      await adapter.dispose();
      return selection;
    }));
    expect(selections).toEqual([
      {id: 'xterm', reason: 'automatic', fallbacks: []},
      {id: 'xterm', reason: 'preference', fallbacks: []},
      {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'this is not the lazysh app'}]},
    ]);
  });

  it('lets Auto and Native pick the native engine where it is registered, and xterm.js always win when chosen', async () => {
    const registry = native({accessibility: true});
    expect(await Promise.all((['auto', 'native', 'xterm'] as const).map(async preference => (await createTerminalAdapter({preference}, registry)).selection.id))).toEqual(['native', 'native', 'xterm']);
  });

  it('keeps a developer override above the preference', async () => {
    localStorage.setItem('lazysh.terminal.backend', 'xterm');
    expect((await createTerminalAdapter({preference: 'native'}, native({accessibility: true}))).selection).toEqual({id: 'xterm', reason: 'developer override', fallbacks: []});
  });

  it('refuses a native engine that a screen reader cannot reach under Auto as well as under Native, with the reason', async () => {
    savePreferences({...defaults, screenReader: true});
    for (const preference of ['auto', 'native'] as const)
      expect((await createTerminalAdapter({preference}, native({accessibility: false}))).selection).toEqual({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks accessibility'}]});
  });
});

describe('the native backend as the app registers it', () => {
  const registered = (probe: BackendProbe | (() => Promise<BackendProbe>)) => {
    const registry = withXterm();
    registerNativeBackend(registry, typeof probe === 'function' ? probe : () => probe);
    return registry;
  };
  const refusal = 'The native terminal core is not built into this app';

  it('is chosen by the Native setting and by the developer override once its probe passes, and Auto still picks xterm.js', async () => {
    openCore.mockResolvedValue({adapter: {backend: 'native'}});
    const registry = registered({ok: true});
    const chosen = await Promise.all((['auto', 'native', 'xterm'] as const).map(async preference => (await createTerminalAdapter({preference}, registry)).selection));
    expect(chosen).toEqual([
      {id: 'xterm', reason: 'automatic', fallbacks: []},
      {id: 'native', reason: 'preference', fallbacks: []},
      {id: 'xterm', reason: 'preference', fallbacks: []},
    ]);
    localStorage.setItem('lazysh.terminal.backend', 'native');
    const {selection, adapter} = await createTerminalAdapter({preference: 'xterm'}, registry);
    expect([selection, adapter.backend]).toEqual([{id: 'native', reason: 'developer override', fallbacks: []}, 'native']);
    expect(openCore).toHaveBeenCalledWith(expect.objectContaining({columns: 80, rows: 24, scrollbackLines: defaults.scrollback, cursorStyle: defaults.cursorStyle, cursorBlink: defaults.cursorBlink}));
  });

  it('cannot be forced on by the override or the setting when its probe fails, and the session says why', async () => {
    const registry = registered({ok: false, reason: refusal});
    localStorage.setItem('lazysh.terminal.backend', 'native');
    const forced = await createTerminalAdapter({preference: 'native'}, registry);
    expect(forced.selection).toEqual({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: refusal}]});
    expect(describeTerminalEngine(forced.selection)).toBe(`xterm.js: the native engine cannot run here (${refusal})`);
    expect(openCore).not.toHaveBeenCalled();
  });

  it('records a probe that throws as its reason and probes once, however many sessions ask', async () => {
    const probe = vi.fn(async (): Promise<BackendProbe> => { throw new Error('invoke failed'); });
    const registry = registered(probe);
    const refused = await Promise.all([1, 2].map(async () => (await createTerminalAdapter({preference: 'native'}, registry)).selection));
    expect(refused).toEqual(Array(2).fill({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'Error: invoke failed'}]}));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('is never reached by a screen reader, whatever the probe says', async () => {
    savePreferences({...defaults, screenReader: true});
    const {selection} = await createTerminalAdapter({preference: 'native'}, registered({ok: true}));
    expect(selection).toEqual({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks accessibility'}]});
    expect(openCore).not.toHaveBeenCalled();
  });

  it('starts on xterm.js when the core cannot be opened, and the session says why', async () => {
    openCore.mockRejectedValue(new Error('terminal_core_open refused'));
    const {selection, adapter} = await createTerminalAdapter({preference: 'native'}, registered({ok: true}));
    expect([adapter.backend, selection]).toEqual(['xterm', {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'failed: terminal_core_open refused'}]}]);
    expect(describeTerminalEngine(selection)).toBe('xterm.js: the native engine failed (terminal_core_open refused)');
  });
});

describe('the failure the device remembers', () => {
  const key = 'lazysh.terminal.failure.native';

  it('is kept for the version of the app that recorded it and forgotten after an update', () => {
    expect(recordedNativeFailure()).toBeUndefined();
    expect(recordNativeFailure(new Error('surface lost'))).toBe('failed: surface lost');
    expect(recordedNativeFailure()).toBe('failed: surface lost');
    localStorage.setItem(key, JSON.stringify({version: `${appVersion}-older`, reason: 'failed: surface lost'}));
    expect(recordedNativeFailure()).toBeUndefined();
  });

  it('is not a failure when the stored value is not one', () => {
    for (const value of ['nonsense', '{"version":1}', 'null', JSON.stringify({version: appVersion, reason: 7})]) {
      localStorage.setItem(key, value);
      expect(recordedNativeFailure()).toBeUndefined();
    }
  });
});
