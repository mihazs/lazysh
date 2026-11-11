import type {Page} from '@playwright/test';

const full = new WeakMap<Page, {width: number; height: number}>();
/** Plays an on-screen keyboard that shrinks the window, as Android's does; `shown` false restores the full size. */
export async function setKeyboard(page: Page, shown: boolean, height = 320) {
  // A landscape phone is short: the keyboard takes at most 40% of it, and never less than the shrink the page counts as a keyboard.
  const size = full.get(page) ?? page.viewportSize()!;
  full.set(page, size);
  await page.setViewportSize({width: size.width, height: shown ? size.height - Math.min(height, Math.round(size.height * 0.4)) : size.height});
}
