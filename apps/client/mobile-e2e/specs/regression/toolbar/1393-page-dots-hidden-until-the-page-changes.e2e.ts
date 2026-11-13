/**
 * #1393 The toolbar page indicator is hidden by default and shows as fading dots only when the page changes (fixed in #1414;
 * epic #1396, issue #1407). Red on the parent of #1414, where the dots were drawn all the time.
 */
import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import Toolbar from '../../../pageobjects/components/terminal-toolbar.component';
import {resetApp} from '../../../support/app';
import {usePhoneScreen} from '../../../support/screen';

/** Longer than the indicator's own delay (2 s) and its fade. */
const FADE_TIMEOUT = 8000;

describe('#1393 the page dots', () => {
  before(async () => { await usePhoneScreen(); await connectOwnedHost(); });
  after(resetApp);

  it('are hidden while the toolbar rests, appear when the page changes and fade out again', async () => {
    expect(await Toolbar.dotsOpacity()).toBe(0);
    await Toolbar.swipe(0.85, 0.15);
    await browser.waitUntil(async () => await Toolbar.dotsOpacity() > 0.5, {timeoutMsg: 'The dots did not appear when the page changed'});
    await browser.waitUntil(async () => await Toolbar.dotsOpacity() === 0, {timeout: FADE_TIMEOUT, timeoutMsg: 'The dots did not fade out after the page change'});
  });
});
