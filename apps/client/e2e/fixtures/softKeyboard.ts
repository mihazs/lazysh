import type {Page} from '@playwright/test';

const full = new WeakMap<Page, {width: number; height: number}>();
/** Plays an on-screen keyboard that shrinks the window, as Android's does; `shown` false restores the full size. */
export async function setKeyboard(page: Page, shown: boolean, height = 320) {
  // A landscape phone is short: the keyboard takes at most 40% of it, and never less than the shrink the page counts as a keyboard.
  const size = full.get(page) ?? page.viewportSize()!;
  full.set(page, size);
  await page.setViewportSize({width: size.width, height: shown ? size.height - Math.min(height, Math.round(size.height * 0.4)) : size.height});
}

/**
 * Plays WebKit's keyboard, which keeps the layout viewport and only shrinks the visual viewport. Returns the
 * function that raises a keyboard of the given height (0 lowers it).
 */
export async function emulateVisualViewportKeyboard(page: Page) {
  await page.evaluate(() => {
    const target = new EventTarget(), keyboard = {height: window.innerHeight};
    Object.defineProperties(target, {offsetTop: {value: 0}, offsetLeft: {value: 0}, scale: {value: 1}, width: {value: window.innerWidth}, height: {get: () => keyboard.height}});
    Object.defineProperty(window, 'visualViewport', {configurable: true, value: target});
    Reflect.set(window, 'showKeyboard', (height: number) => {keyboard.height = window.innerHeight - height; target.dispatchEvent(new Event('resize'));});
  });
  return (height: number) => page.evaluate(height => (Reflect.get(window, 'showKeyboard') as (height: number) => void)(height), height);
}
