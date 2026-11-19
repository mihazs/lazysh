// @vitest-environment jsdom
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {stubMatchMedia} from './test/stubMatchMedia';
import type {TerminalAdapter, TerminalCapabilities} from './terminalAdapter';
import {defaults, savePreferences} from './preferences';
import {createBackendRegistry} from './terminalBackendRegistry';
import {createTerminalAdapter} from './terminalBackends';
import {xtermCapabilities} from './xtermTerminalAdapter';

beforeAll(stubMatchMedia);
afterEach(() => localStorage.clear());

const native = (over: Partial<TerminalCapabilities>) => {
  const registry = createBackendRegistry();
  registry.register({id: 'xterm', capabilities: xtermCapabilities, autoEligible: true, probe: () => ({ok: true}), create: () => ({backend: 'xterm'}) as TerminalAdapter});
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

describe('the engine each preference value selects', () => {
  it('uses xterm.js for every value while it is the only registered engine, and records that Native was refused', async () => {
    const selections = await Promise.all((['auto', 'xterm', 'native'] as const).map(async preference => {
      const {selection, adapter} = await createTerminalAdapter({preference});
      await adapter.dispose();
      return selection;
    }));
    expect(selections).toEqual([
      {id: 'xterm', reason: 'automatic', fallbacks: []},
      {id: 'xterm', reason: 'preference', fallbacks: []},
      {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'not registered'}]},
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
