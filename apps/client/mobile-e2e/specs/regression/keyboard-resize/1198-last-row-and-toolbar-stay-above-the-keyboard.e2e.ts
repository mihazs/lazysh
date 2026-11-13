/**
 * #1198 #1178 #1096 The soft keyboard hid the bottom of the terminal (epic #1396, issue #1403).
 *
 * Playwright resizes the viewport to stand in for the keyboard (`e2e/soft-keyboard.spec.ts`, `terminal-fills-pane.spec.ts`); only
 * the packaged app on a device raises the real keyboard window and has the WebView resize around it. The physical bounds come
 * from the WebView's own boxes (unrounded CSS pixels scaled by the device density) and from the keyboard window's rectangle.
 *
 * Not covered here, tracked on #1403: the Mosh screen keeping its newest output (needs the Mosh fixture) and navigating
 * between Herdr terminals with the keyboard closed (needs the Herdr fixture; see the scroll spec for that dependency).
 */
import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import Terminal from '../../../pageobjects/terminal.page';
import Toolbar from '../../../pageobjects/components/terminal-toolbar.component';
import {resetApp} from '../../../support/app';
import {keyboardTop, screenBox, toScreen} from '../../../support/geometry';
import {keyboardShown} from '../../../support/keyboard';
import {usePhoneScreen} from '../../../support/screen';

/** Device pixels. The WebView's native bounds are whole pixels and reach up to two pixels under the keyboard window's top edge. */
const EDGE = 3;

describe('#1198 the soft keyboard and the terminal', () => {
  let name: string;
  before(async () => { await usePhoneScreen(); name = await connectOwnedHost(); });
  after(resetApp);

  it('leaves the last terminal row and the toolbar above the keyboard when it is open', async () => {
    await Terminal.tapScreen(name);
    await browser.waitUntil(async () => await keyboardShown() && await keyboardTop() !== null, {timeoutMsg: 'The soft keyboard did not open'});
    const top = (await keyboardTop())!;
    // The page resizes around the keyboard a moment after it opens: wait for the toolbar to settle above it.
    let toolbarBottom = 0;
    await browser.waitUntil(async () => (toolbarBottom = (await screenBox(() => Toolbar.root)).bottom) <= top + EDGE)
      .catch(() => { throw new Error(`The toolbar stayed under the keyboard: toolbar bottom ${toolbarBottom}px, keyboard top ${top}px`); });
    const {grid, rows} = await Terminal.grid();
    const lastRow = await toScreen(rows[rows.length - 1]);
    const toolbar = await screenBox(() => Toolbar.root);
    expect(lastRow.bottom).toBeLessThanOrEqual(top);
    expect(toolbar.bottom).toBeLessThanOrEqual(top + EDGE);
    expect(lastRow.bottom).toBeLessThanOrEqual(toolbar.top + 0.5);
    expect((await toScreen(grid)).bottom).toBeLessThanOrEqual(top);
  });
});
