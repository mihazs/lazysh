import {browser} from '@wdio/globals';
import {inNative} from './contexts';

// Android's own input paths, delivered through the system to the focused editor, not through the WebView's key dispatch:
// key events for single keys, and `mobile: type` for text, which Appium Settings commits through the input connection the way a
// soft keyboard commits a word (it switches to its own input method for the call and back). Neither uses `setValue`.

const CODES: Record<string, number> = {backspace: 67, enter: 66, escape: 111, tab: 61, space: 62, ' ': 62, up: 19, down: 20, left: 21, right: 22};
for (let index = 0; index < 26; index++) CODES[String.fromCharCode(97 + index)] = 29 + index; // KEYCODE_A..Z
for (let digit = 0; digit < 10; digit++) CODES[String(digit)] = 7 + digit; // KEYCODE_0..9

/** Presses one key by name: a lowercase letter, a digit, space, enter, backspace, escape or tab. */
export function pressKey(name: string) {
  const keycode = CODES[name];
  if (keycode === undefined) throw new Error(`No Android key code for "${name}"`);
  return inNative(() => browser.execute('mobile: pressKey', {keycode}));
}

/** Commits `text` to the focused editor in one input-connection transaction, as a keyboard commits a word. */
export const typeText = (text: string) => inNative(() => browser.execute('mobile: type', {text}));

/** Whether the soft keyboard is on screen. */
export const keyboardShown = () => inNative(() => browser.isKeyboardShown());
