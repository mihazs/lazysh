/**
 * #1248 The compact toolbar lost sliding between its Keys and Tools pages (fixed in #1253; epic #1396, issue #1407).
 *
 * `e2e/toolbar-pages.spec.ts` drives the page with emulated touch. This one swipes the packaged app's toolbar with a real finger
 * on the device, through the system's input path and the WebView's own scroll snapping.
 */
import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import Toolbar from '../../../pageobjects/components/terminal-toolbar.component';
import {resetApp} from '../../../support/app';
import {usePhoneScreen} from '../../../support/screen';

describe('#1248 the toolbar slides between its pages', () => {
  before(async () => { await usePhoneScreen(); await connectOwnedHost(); });
  after(resetApp);

  it('moves to the Tools page when swiped left and back to the Keys page when swiped right', async () => {
    expect(await Toolbar.currentPage()).toBe('Keys');
    await Toolbar.swipe(0.85, 0.15);
    await browser.waitUntil(async () => await Toolbar.currentPage() === 'Tools', {timeoutMsg: 'The toolbar did not slide to the Tools page'});
    await browser.waitUntil(async () => Math.abs(await Toolbar.pagesOffset() - 1) < 0.01, {timeoutMsg: 'The Tools page did not snap into view'});
    await Toolbar.swipe(0.15, 0.85);
    await browser.waitUntil(async () => await Toolbar.currentPage() === 'Keys', {timeoutMsg: 'The toolbar did not slide back to the Keys page'});
    await browser.waitUntil(async () => await Toolbar.pagesOffset() < 0.01, {timeoutMsg: 'The Keys page did not snap into view'});
  });
});
