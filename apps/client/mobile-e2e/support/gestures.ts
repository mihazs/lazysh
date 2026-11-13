import {browser} from '@wdio/globals';
import {inNative} from './contexts';

/** A point on the screen in device pixels. */
export interface Point {x: number; y: number}

// Real touches through UiAutomator2, injected by the system and not by the WebView, so they reach the app as a finger does.

export const tapAt = ({x, y}: Point) => inNative(() => browser.execute('mobile: clickGesture', {x, y}));
/** Holds a finger down at `at` for `ms`, then lifts it. */
export const holdAt = ({x, y}: Point, ms: number) => inNative(() => browser.execute('mobile: longClickGesture', {x, y, duration: ms}));
/** One finger down at `from`, moved to `to` over `ms`, lifted. A plain touch drag: no press-and-hold first, so pages scroll and snap. */
export const swipe = (from: Point, to: Point, ms = 400) => inNative(async () => {
  await browser.action('pointer', {parameters: {pointerType: 'touch'}})
    .move({x: from.x, y: from.y}).down().move({duration: ms, x: to.x, y: to.y}).up().perform();
  await browser.releaseActions();
});
