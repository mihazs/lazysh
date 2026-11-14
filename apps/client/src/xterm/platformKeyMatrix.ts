import {beforeAll, describe, expect, it} from 'vitest';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createTerminal} from './terminal';
import {defaults, savePreferences} from '../preferences';
import {coreKeyInput, keyboardPlatform, type CoreKeyInput, type KeyboardPlatform} from '../terminalPlatformKeys';

type Mods = Partial<Record<'shift' | 'ctrl' | 'alt' | 'meta' | 'altGraph', true>>;
/** One physical key press. `char` is the character the browser reports to `keypress`, when it types one. */
type KeyCase = {name: string; code: string; key: string; keyCode: number; mods?: Mods; char?: number; optionAsMeta?: true; xterm: string; core?: {bytes: string; why: string}};

const same = (name: string, code: string, key: string, keyCode: number, xterm: string, extra: Partial<KeyCase> = {}): KeyCase => ({name, code, key, keyCode, xterm, ...extra});
const common: KeyCase[] = [
  same('a plain letter', 'KeyA', 'a', 65, 'a', {char: 97}),
  same('Ctrl+C', 'KeyC', 'c', 67, '\x03', {mods: {ctrl: true}}),
  same('the platform key, which belongs to the app (copy, paste, search)', 'KeyC', 'c', 67, '', {mods: {meta: true}}),
];
const altLeft = same('Alt+Left', 'ArrowLeft', 'ArrowLeft', 37, '\x1b[1;5D', {mods: {alt: true}, core: {bytes: '\x1b[1;3D', why: 'xterm.js turns Alt+arrow into Ctrl+arrow; the core sends the standard Alt form (also listed in tests/keys.rs)'}});
const altB = same('Alt+B', 'KeyB', 'b', 66, '\x1bb', {mods: {alt: true}});
const chord = (xterm: string, core?: KeyCase['core']) => same('Ctrl+Alt+Q as a chord', 'KeyQ', 'q', 81, xterm, {mods: {ctrl: true, alt: true}, core});
const altGr = (name: string, code: string, key: string, keyCode: number, char: number, mods: Mods) => same(name, code, key, keyCode, key, {mods: {...mods, altGraph: true}, char});

const cases: Record<KeyboardPlatform, KeyCase[]> = {
  windows: [
    ...common, altB, altLeft,
    altGr('AltGr+Q on a German layout types @', 'KeyQ', '@', 81, 64, {ctrl: true, alt: true}),
    altGr('AltGr+E on a German layout types the euro sign', 'KeyE', '€', 69, 8364, {ctrl: true, alt: true}),
    chord('', {bytes: '\x1b\x11', why: 'xterm.js treats every Ctrl+Alt on Windows as AltGr and sends nothing when no character follows; the core sends the chord'}),
  ],
  other: [
    ...common, altB, altLeft,
    altGr('AltGr+Q on a German layout types @', 'KeyQ', '@', 81, 64, {}),
    altGr('AltGr+E on a German layout types the euro sign', 'KeyE', '€', 69, 8364, {}),
    chord('\x1b\x11'),
  ],
  mac: [
    ...common,
    same('Option+L types a character', 'KeyL', '¬', 76, '¬', {mods: {alt: true}, char: 172}),
    same('Option+1 types a character', 'Digit1', '¡', 49, '¡', {mods: {alt: true}, char: 161}),
    same('Option+L is Meta+L', 'KeyL', '¬', 76, '\x1bl', {mods: {alt: true}, optionAsMeta: true}),
    same('Option+Shift+B is Meta+B', 'KeyB', 'ı', 66, '\x1bB', {mods: {alt: true, shift: true}, optionAsMeta: true}),
    same('Option+1 is Meta+1', 'Digit1', '¡', 49, '\x1b1', {mods: {alt: true}, optionAsMeta: true}),
    same('Option+. is Meta+.', 'Period', '≥', 190, '\x1b.', {mods: {alt: true}, optionAsMeta: true}),
    same('Option+Left moves back a word', 'ArrowLeft', 'ArrowLeft', 37, '\x1bb', {mods: {alt: true}}),
    same('Option+Right moves forward a word', 'ArrowRight', 'ArrowRight', 39, '\x1bf', {mods: {alt: true}}),
  ],
};

const event = (testCase: KeyCase, type: string, extra: KeyboardEventInit = {}) => new KeyboardEvent(type, {
  key: testCase.key, code: testCase.code, keyCode: testCase.keyCode,
  shiftKey: !!testCase.mods?.shift, ctrlKey: !!testCase.mods?.ctrl, altKey: !!testCase.mods?.alt, metaKey: !!testCase.mods?.meta,
  modifierAltGraph: !!testCase.mods?.altGraph, bubbles: true, cancelable: true, ...extra,
} as KeyboardEventInit);

/** What xterm.js 5.5.0 sends for the press: `keydown`, then `keypress` when the browser would fire it. */
function xtermSends(testCase: KeyCase) {
  savePreferences({...defaults, optionAsMeta: !!testCase.optionAsMeta});
  const terminal = createTerminal(), host = document.createElement('div');
  document.body.append(host);
  terminal.open(host);
  let sent = '';
  terminal.onData(data => { sent += data; });
  const down = event(testCase, 'keydown');
  terminal.textarea!.dispatchEvent(down);
  if (testCase.char && !down.defaultPrevented) terminal.textarea!.dispatchEvent(event(testCase, 'keypress', {charCode: testCase.char, keyCode: testCase.char} as KeyboardEventInit));
  terminal.dispose(); host.remove();
  return sent;
}

export type PlatformKeyEntry = {name: string; optionAsMeta: boolean; xterm: string; core: string; why?: string; raw: CoreKeyInput; input: CoreKeyInput};
const fixturePath = (platform: KeyboardPlatform) => resolve(__dirname, '../../e2e/fixtures/platform-keys', `${platform}.json`);

/**
 * Runs the key cases of `platform` through xterm.js, which must have been loaded as that platform
 * (`emulatePlatform`), and through `coreKeyInput`. The fixture is what the Rust core is held to
 * (`packages/terminal-runtime/tests/platform_keys.rs`): its bytes must equal xterm.js's, or the listed difference.
 * Regenerate it with `UPDATE_PLATFORM_KEYS=1`.
 */
export function runPlatformKeyMatrix(platform: KeyboardPlatform) {
  describe(`keyboard parity on ${platform}`, () => {
    beforeAll(() => { window.matchMedia = ((query: string) => ({matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}})) as never; });
    const entries = (): PlatformKeyEntry[] => cases[platform].map(testCase => {
      const mods = testCase.mods ?? {};
      const raw = {code: testCase.code, key: testCase.key, keyCode: testCase.keyCode, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta, getModifierState: (name: string) => name === 'AltGraph' && !!mods.altGraph};
      const asFired: CoreKeyInput = {type: 'key', code: raw.code, key: raw.key, mods: {shift: raw.shiftKey, ctrl: raw.ctrlKey, alt: raw.altKey, meta: raw.metaKey}, repeat: false, release: false, composing: false};
      return {name: testCase.name, optionAsMeta: !!testCase.optionAsMeta, xterm: testCase.xterm, core: testCase.core?.bytes ?? testCase.xterm, ...(testCase.core ? {why: testCase.core.why} : {}), raw: asFired, input: coreKeyInput(raw, platform, !!testCase.optionAsMeta)};
    });

    it('is read by this xterm.js as the platform under test', () => {
      expect(keyboardPlatform(navigator.platform)).toBe(platform);
    });

    it.each(cases[platform].map(testCase => [testCase.name + (testCase.optionAsMeta ? ' (Option as Meta)' : ''), testCase] as const))('xterm.js sends what is recorded for %s', (_, testCase) => {
      expect(xtermSends(testCase)).toBe(testCase.xterm);
    });

    it('sends the native core the character a key typed, not the chord that typed it', () => {
      for (const {name, input} of entries()) {
        if (/AltGr|Option\+\w+ types/.test(name)) expect(input.mods, name).toMatchObject({alt: false, ctrl: false});
        if (/is Meta/.test(name)) expect(input.mods.alt, name).toBe(true);
      }
    });

    it('matches the fixture the Rust core is tested against', () => {
      const text = `${JSON.stringify(entries(), null, 2)}\n`;
      if (process.env.UPDATE_PLATFORM_KEYS) writeFileSync(fixturePath(platform), text);
      expect(text).toBe(readFileSync(fixturePath(platform), 'utf8'));
    });
  });
}
