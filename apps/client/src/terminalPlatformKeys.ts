/**
 * The DOM key event a native terminal core should see, which is not always the event the browser fired:
 * a key that typed a character with Option (macOS) or AltGr (Windows, Linux) arrives with Alt (and Ctrl)
 * still set, and the core would answer with an Alt chord instead of the character. xterm.js treats these
 * as a "third level shift" and sends the character from `keypress`; this applies the same rules, so the
 * native path types what the xterm path types. See docs/architecture/platform-integration.md.
 */

export type KeyboardPlatform = 'mac' | 'windows' | 'other';

/** The fields of a `KeyboardEvent` that the rules read. */
export type KeyEventLike = {
  code: string; key: string; keyCode?: number;
  shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
  repeat?: boolean; isComposing?: boolean; type?: string;
  getModifierState?(key: string): boolean;
};

/** The wire shape of a key for the native core (`terminal_core_input`). */
export type CoreKeyInput = {
  type: 'key'; code: string; key: string;
  mods: {shift: boolean; ctrl: boolean; alt: boolean; meta: boolean};
  repeat: boolean; release: boolean; composing: boolean;
};

/** The platform's keyboard rules, from `navigator.platform` like xterm.js; iOS is `other` until it is verified. */
export function keyboardPlatform(platform = typeof navigator === 'undefined' ? '' : navigator.platform): KeyboardPlatform {
  return /^Mac/.test(platform) ? 'mac' : /^Win/.test(platform) ? 'windows' : 'other';
}

const legends: Record<string, readonly [string, string]> = {
  Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Space: [' ', ' '],
  Digit0: ['0', ')'], Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'],
  Digit5: ['5', '%'], Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('],
};

/**
 * The character a key types without Option or AltGr. Letters follow the layout (`keyCode`, as xterm.js does);
 * digits and punctuation use the US legend of the physical key.
 * shortcut: punctuation under Option-as-Meta on a non-US layout sends the US legend; fine until a layout needs `getLayoutMap`.
 */
function plainKey(event: KeyEventLike): string | undefined {
  const letter = event.keyCode && event.keyCode >= 65 && event.keyCode <= 90 ? String.fromCharCode(event.keyCode) : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : undefined;
  if (letter) return event.shiftKey ? letter : letter.toLowerCase();
  return legends[event.code]?.[event.shiftKey ? 1 : 0];
}

const typesCharacter = (key: string) => [...key].length === 1 && !/[\p{Cc}\p{Cf}]/u.test(key);

/** What the native core should be sent for this event on this platform; `optionAsMeta` is the setting of the same name. */
export function coreKeyInput(event: KeyEventLike, platform: KeyboardPlatform, optionAsMeta: boolean): CoreKeyInput {
  const mods = {shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey};
  let key = event.key;
  if (typesCharacter(key)) {
    const altGraph = !!event.getModifierState?.('AltGraph');
    const optionOnly = platform === 'mac' && mods.alt && !mods.ctrl && !mods.meta;
    // A Windows Ctrl+Alt is AltGr; it typed a character only when the key is not the plain one.
    const windowsAltGr = platform === 'windows' && mods.alt && mods.ctrl && !mods.meta && key !== plainKey(event);
    if (altGraph || windowsAltGr || (optionOnly && !optionAsMeta)) { mods.alt = false; mods.ctrl = false; }
    else if (optionOnly) key = plainKey(event) ?? key;
  }
  let code = event.code;
  // xterm.js sends macOS's word movement (ESC b, ESC f) for Option+Left and Option+Right, which zsh and readline there expect.
  if (platform === 'mac' && mods.alt && !mods.shift && !mods.ctrl && !mods.meta && (code === 'ArrowLeft' || code === 'ArrowRight')) [code, key] = code === 'ArrowLeft' ? ['KeyB', 'b'] : ['KeyF', 'f'];
  return {type: 'key', code, key, mods, repeat: !!event.repeat, release: event.type === 'keyup', composing: !!event.isComposing};
}
