import {$$, browser} from '@wdio/globals';
import type {ChainablePromiseElement} from 'webdriverio';
import {inNative, inWebView} from './contexts';

/** Edges of a rectangle: CSS pixels from the WebView viewport, or device pixels from the screen, as the function says. */
export interface Box {left: number; top: number; right: number; bottom: number}
export const centre = (box: Box) => ({x: Math.round((box.left + box.right) / 2), y: Math.round((box.top + box.bottom) / 2)});

const WEBVIEW = 'android=new UiSelector().className("android.webkit.WebView")';
/** TYPE_INPUT_METHOD of AccessibilityWindowInfo. */
const INPUT_METHOD_WINDOW = 2;

/** The element's box in CSS pixels, unrounded, relative to the WebView viewport. `select` runs in the WebView. */
export function cssBox(select: () => ChainablePromiseElement): Promise<Box> {
  return inWebView(async () => {
    const element = await select();
    await element.waitForDisplayed();
    return browser.execute((node: Element) => { const r = node.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; }, element as unknown as Element);
  });
}

/** WebView CSS pixels to screen pixels: the WebView's corner on the screen plus the density (the layout viewport is not zoomed or scrolled). */
export async function toScreen(box: Box): Promise<Box> {
  const density = await inWebView(() => browser.execute(() => window.devicePixelRatio));
  // The hierarchy holds the WebView twice (the view and its focusable web content), both at the same origin.
  const origin = await inNative(async () => (await $$(WEBVIEW))[0].getLocation());
  return {left: origin.x + box.left * density, top: origin.y + box.top * density, right: origin.x + box.right * density, bottom: origin.y + box.bottom * density};
}
export const screenBox = async (select: () => ChainablePromiseElement) => toScreen(await cssBox(select));

/** The soft keyboard's top edge on the screen in pixels, or null while no keyboard window is open. */
export async function keyboardTop(): Promise<number | null> {
  const windows = await inNative(() => browser.execute('mobile: listWindows', {filters: {type: INPUT_METHOD_WINDOW}, skipScreenshots: true})) as {rect: {y: number}}[];
  return windows.length ? Math.min(...windows.map(window => window.rect.y)) : null;
}
