import {$, browser} from '@wdio/globals';
import type {ChainablePromiseElement} from 'webdriverio';
import {inNative, inWebView} from './contexts';

/** Device pixels on the screen, the unit of the native touch pointer (the WebView reports CSS pixels). */
export interface ScreenPoint {x: number; y: number}

/** Moves one finger through real Android touch events: the system sees an edge swipe exactly as it would from a person. */
export function swipe(from: ScreenPoint, to: ScreenPoint, durationMs = 250) {
  return inNative(() => browser.action('pointer', {parameters: {pointerType: 'touch'}})
    .move({x: Math.round(from.x), y: Math.round(from.y)}).down().pause(30)
    .move({duration: durationMs, x: Math.round(to.x), y: Math.round(to.y)}).up().perform());
}

/** The size of the screen in device pixels. */
export const screenSize = () => inNative(() => browser.getWindowSize());

/**
 * Where a WebView element is on the screen in device pixels: its CSS box, scaled by the device pixel ratio and shifted by where
 * the WebView sits below the status bar. `element` is a thunk so the lookup runs inside the WebView context.
 */
export async function screenBox(element: () => ChainablePromiseElement) {
  const {box, ratio, scrollY} = await inWebView(async () => ({
    box: await browser.execute(node => { const {x, y, width, height} = node.getBoundingClientRect(); return {x, y, width, height}; }, await element()),
    ratio: await browser.execute(() => window.devicePixelRatio),
    scrollY: await browser.execute(() => window.visualViewport?.offsetTop ?? 0),
  }));
  // The accessibility tree can show the WebView as two nested nodes with the same bounds; either one gives the origin.
  const origin = await inNative(() => $('android=new UiSelector().className("android.webkit.WebView")', {strict: false}).getLocation());
  return {x: origin.x + box.x * ratio, y: origin.y + (box.y + scrollY) * ratio, width: box.width * ratio, height: box.height * ratio};
}
