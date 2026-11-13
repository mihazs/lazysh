import {$, browser} from '@wdio/globals';
import {adbFor, setNavigation, type Adb} from './device';
import {inNative, inWebView} from './contexts';
import {screenSize, swipe, type ScreenPoint} from './gestures';
import {relaunchApp} from './app';
import {parseFocusedPackage, parseSystemZones} from './zones';

export type {SystemZones} from './zones';

// Android's navigation modes as the app meets them: `cmd overlay` (through device.ts, which records and restores the baseline),
// the live gesture zones the system reports, and the system Back as a person gives it in each mode.

/** The navigation overlays of AOSP: three buttons and the gestural overlays that differ in how wide the Back zone is. */
export const OVERLAYS = ['threebutton', 'gestural', 'gestural_wide_back', 'gestural_extra_wide_back'] as const;
export type Overlay = (typeof OVERLAYS)[number];
export const isGestural = (overlay: Overlay) => overlay !== 'threebutton';

const CATEGORY = 'com.android.internal.systemui.navbar.';
const serial = () => process.env.ANDROID_SERIAL ?? '';

/** A box in device pixels: where a handle, a bar or a window is on the screen. */
export interface Rect {x: number; y: number; width: number; height: number}

/** Enabled navigation overlay names, as `cmd overlay list` prints them (a `[x]` row). */
async function enabledOverlays(adb: Adb) {
  return (await adb('shell', 'cmd', 'overlay', 'list', '--user', '0')).split('\n')
    .filter(line => line.startsWith('[x] ' + CATEGORY)).map(line => line.trim().slice(4 + CATEGORY.length));
}

/**
 * Switches the guest to `overlay` and starts the app again in it. The change recreates the running activity, so the app is
 * restarted rather than followed: the next session starts in the new navigation mode. Skips (returns false) when the guest has
 * no such overlay. device.ts puts the recorded navigation mode back after the spec file, even when a test fails.
 */
export async function useNavigation(overlay: Overlay) {
  const adb = adbFor(serial());
  if (!(await adb('shell', 'cmd', 'overlay', 'list', '--user', '0')).includes(CATEGORY + overlay)) return false;
  await setNavigation(adb, CATEGORY + overlay);
  await browser.waitUntil(async () => (await enabledOverlays(adb)).includes(overlay), {timeoutMsg: `The ${overlay} navigation overlay was not enabled`});
  await relaunchApp();
  return true;
}

/** The live gesture zones from the window manager, read while the overlay is active. */
export async function readSystemZones() { return parseSystemZones(await adbFor(serial())('shell', 'dumpsys', 'window', 'displays')); }

/** The zones the Android shell of the app reports to its page, in CSS pixels (dp), as the page asks for them. */
export interface AppInsets {left: number; right: number; bottom: number; mandatoryBottom: number; navigation: 'gesture' | 'buttons' | 'unknown'}
export const readAppInsets = () => inWebView(() => browser.execute(async () =>
  (window as unknown as {__TAURI_INTERNALS__: {invoke(command: string): Promise<AppInsets>}}).__TAURI_INTERNALS__.invoke('edge_gesture_insets')));

/** The WebView's box on the screen: the page area, below the status bar and above a button navigation bar. */
export const webViewRect = (): Promise<Rect> => inNative(async () => {
  const view = $('android=new UiSelector().className("android.webkit.WebView")', {strict: false});
  return {...await view.getLocation(), ...await view.getSize()};
});

export const devicePixelRatio = () => inWebView(() => browser.execute(() => window.devicePixelRatio));

export const centreOf = ({x, y, width, height}: Rect): ScreenPoint => ({x: x + width / 2, y: y + height / 2});

/** One touch down and up at `at`, as a finger taps. */
export const tap = (at: ScreenPoint) => swipe(at, at, 0);

/**
 * The package in front, which is the launcher after the app went back. Read from the window manager, not through Appium: once the app
 * has left, a command that switches back to its WebView waits for a page that is gone.
 */
export async function foregroundPackage() { return parseFocusedPackage(await adbFor(serial())('shell', 'dumpsys', 'window', 'displays')); }

/**
 * Android's own Back, given the way each mode gives it: the Back button of three-button navigation, and a swipe in from the side
 * edge of the screen on the gestural overlays. The swipe starts at 2 px, inside the system's Back zone, and moves inward. It starts
 * at 65 % of the height: the app claims the edge from the system only in the rows of its handles (measured on the guest: about 30 %
 * and 85 % of the height), and a swipe that begins in a claimed row is the app's own, so a person who wants Back swipes elsewhere.
 */
export async function systemBack(overlay: Overlay) {
  if (!isGestural(overlay)) { await inNative(() => browser.back()); return; }
  const {width, height} = await screenSize();
  await swipe({x: 2, y: height * 0.65}, {x: width * 0.4, y: height * 0.65}, 180);
}

/**
 * Repeats `gesture` until `shown` is true. The app ignores an edge or handle touch for a moment after typing (the connect flow ends
 * with one), so the first swipe after a connect may be refused, exactly as for a person; later swipes are single attempts.
 */
export const gestureUntil = (gesture: () => Promise<unknown>, shown: () => Promise<boolean>, what: string) =>
  browser.waitUntil(async () => { await gesture(); return shown(); }, {timeout: 20_000, timeoutMsg: `${what} did not appear after the gesture`});
