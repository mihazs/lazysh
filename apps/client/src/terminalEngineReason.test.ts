import {afterEach, describe, expect, it} from 'vitest';
import {uiI18n} from './i18n/core';
import type {BackendSelection} from './terminalBackendRegistry';
import {describeTerminalEngine} from './terminalEngineReason';

afterEach(() => uiI18n.changeLanguage('en'));

const selections: Record<string, BackendSelection> = {
  automatic: {id: 'xterm', reason: 'automatic', fallbacks: []},
  preference: {id: 'xterm', reason: 'preference', fallbacks: []},
  override: {id: 'native', reason: 'developer override', fallbacks: []},
  unregistered: {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'not registered'}]},
  screenReader: {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks accessibility'}]},
  lacking: {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'lacks ime, mouseReporting'}]},
  probe: {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'no Vulkan'}]},
  killSwitch: {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'disabled in this build'}]},
  failed: {id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'failed: surface lost'}]},
  switched: {id: 'xterm', reason: 'switched', fallbacks: []},
};

describe('the recorded reason a session got its terminal engine', () => {
  it('says which engine a session uses and why', () => {
    expect(Object.fromEntries(Object.entries(selections).map(([name, selection]) => [name, describeTerminalEngine(selection)]))).toEqual({
      automatic: 'xterm.js: chosen automatically',
      preference: 'xterm.js: chosen in Settings',
      override: 'Native: chosen by the developer override',
      unregistered: 'xterm.js: the native engine is not available on this platform yet',
      screenReader: 'xterm.js: a screen reader is active and the native engine cannot be read by it',
      lacking: 'xterm.js: the native engine lacks ime, mouseReporting',
      probe: 'xterm.js: the native engine cannot run here (no Vulkan)',
      killSwitch: 'xterm.js: the native engine is disabled in this build',
      failed: 'xterm.js: the native engine failed (surface lost)',
      switched: 'xterm.js: you switched this session from the native engine',
    });
  });

  it.each(['pt-BR', 'es'])('is available in %s for every recorded reason, with the same engine detail', async language => {
    const english = Object.values(selections).map(describeTerminalEngine);
    await uiI18n.changeLanguage(language);
    const translated = Object.values(selections).map(describeTerminalEngine);
    translated.forEach((text, index) => expect(text, `${language} ${index}`).not.toBe(english[index]));
    expect(translated.filter(text => text.includes('no Vulkan'))).toHaveLength(1);
    expect(translated.filter(text => text.includes('ime, mouseReporting'))).toHaveLength(1);
    expect(translated.filter(text => text.includes('surface lost'))).toHaveLength(1);
  });
});
