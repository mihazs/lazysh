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

describe('backend selection for a reader who uses a screen reader', () => {
  const native = (over: Partial<TerminalCapabilities>) => {
    const registry = createBackendRegistry();
    registry.register({id: 'xterm', capabilities: xtermCapabilities, autoEligible: true, probe: () => ({ok: true}), create: () => ({backend: 'xterm'}) as TerminalAdapter});
    registry.register({id: 'native', capabilities: {...xtermCapabilities, nativeRendering: true, ...over}, autoEligible: true, probe: () => ({ok: true}), create: () => ({backend: 'native'}) as TerminalAdapter});
    return registry;
  };

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
