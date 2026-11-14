import {describe, expect, it} from 'vitest';
import {coreKeyInput, keyboardPlatform, type KeyEventLike} from './terminalPlatformKeys';

const event = (over: Partial<KeyEventLike>): KeyEventLike => ({code: 'KeyA', key: 'a', keyCode: 65, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over});

describe('keyboardPlatform', () => {
  it('reads the platform like xterm.js does', () => {
    expect(['MacIntel', 'Win32', 'Linux x86_64', 'iPhone', ''].map(platform => keyboardPlatform(platform))).toEqual(['mac', 'windows', 'other', 'other', 'other']);
  });
});

describe('coreKeyInput', () => {
  it('passes a key through with its flags, and a keyup as a release', () => {
    expect(coreKeyInput(event({code: 'Enter', key: 'Enter', repeat: true, isComposing: true, type: 'keyup'}), 'other', false))
      .toEqual({type: 'key', code: 'Enter', key: 'Enter', mods: {shift: false, ctrl: false, alt: false, meta: false}, repeat: true, release: true, composing: true});
  });

  it('keeps Alt on a key that typed nothing, an Alt chord on Linux and Windows and a navigation key on every platform', () => {
    expect(coreKeyInput(event({key: 'Dead', altKey: true}), 'mac', false).mods.alt).toBe(true);
    expect(coreKeyInput(event({altKey: true}), 'other', false).mods.alt).toBe(true);
    expect(coreKeyInput(event({code: 'ArrowUp', key: 'ArrowUp', keyCode: 38, altKey: true}), 'mac', false)).toMatchObject({code: 'ArrowUp', mods: {alt: true}});
  });

  it('treats AltGr as a character on every platform, with Shift kept', () => {
    const altGr = event({code: 'Digit7', key: '{', keyCode: 55, shiftKey: true, ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph'});
    for (const platform of ['windows', 'other', 'mac'] as const) expect(coreKeyInput(altGr, platform, false).mods).toEqual({shift: true, ctrl: false, alt: false, meta: false});
  });

  it('only moves by a word on macOS, and only for Option alone', () => {
    const left = (over: Partial<KeyEventLike>) => event({code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37, altKey: true, ...over});
    expect(coreKeyInput(left({}), 'mac', true)).toMatchObject({code: 'KeyB', key: 'b'});
    expect(coreKeyInput(left({shiftKey: true}), 'mac', false)).toMatchObject({code: 'ArrowLeft'});
    expect(coreKeyInput(left({}), 'windows', false)).toMatchObject({code: 'ArrowLeft'});
  });
});
