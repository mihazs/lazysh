import {browser} from '@wdio/globals';
import {inNative} from './contexts';

/** TYPE_INPUT_METHOD of AccessibilityWindowInfo. */
const INPUT_METHOD_WINDOW = 2;

/** Whether the soft keyboard is on screen. */
export const keyboardShown = () => inNative(() => browser.isKeyboardShown());

/** The soft keyboard's top edge on the screen in device pixels, or null while no keyboard window is open. */
export async function keyboardTop(): Promise<number | null> {
  const windows = await inNative(() => browser.execute('mobile: listWindows', {filters: {type: INPUT_METHOD_WINDOW}, skipScreenshots: true})) as {rect: {y: number}}[];
  return windows.length ? Math.min(...windows.map(window => window.rect.y)) : null;
}
