/**
 * #1208 #1213 Typing through a real keyboard lost characters or duplicated text, and Backspace and corrections failed after a
 * toolbar key (fixed in #1213; epic #1396, issue #1404).
 *
 * Where each behaviour is tested:
 *  - `e2e/terminal-swiftkey.spec.ts`, `NativeWorkspaceTest.kt` and `OwnedImeService.java` model SwiftKey's composition
 *    transactions (predictive words, gesture words, composing Backspace, erase-and-commit corrections). Real SwiftKey cannot be
 *    installed on Waydroid or the CI emulator, so that exact traffic stays at those layers.
 *  - This spec adds what only the device shows: text and keys travelling through the real Android input path and the real AOSP
 *    Latin IME into the WebView, and arriving at a host that prints the bytes it received (`cat -v`).
 * A correction is modelled the way an autocorrecting keyboard sends it: erase the word, then commit its replacement.
 */
import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import Terminal from '../../../pageobjects/terminal.page';
import Toolbar from '../../../pageobjects/components/terminal-toolbar.component';
import {resetApp} from '../../../support/app';
import {swipe} from '../../../support/gestures';
import {centre, screenBox} from '../../../support/geometry';
import {pressKey, typeText} from '../../../support/keyboard';
import {usePhoneScreen} from '../../../support/screen';

describe('#1208 #1213 typing and Backspace', () => {
  let name: string;
  before(async () => {
    await usePhoneScreen();
    name = await connectOwnedHost();
    // History to scroll through later, printed before the host starts echoing raw bytes.
    await Terminal.run('i=0; while [ $i -lt 150 ]; do echo HISTORY_LINE_$i; i=$((i+1)); done');
    await Terminal.textEventually(name, /HISTORY_LINE_149/);
    await Terminal.startReceiver(name);
  });
  after(resetApp);

  it('delivers a word, a correction, a toolbar key and Backspace once each, in order', async () => {
    await typeText('ten ');
    for (let erased = 0; erased < 4; erased++) await pressKey('backspace');
    await typeText('tan ');
    await Toolbar.tapKey('esc');
    await pressKey('backspace');
    await typeText('web');
    await Terminal.receivedExactly(name, 'ten ^?^?^?^?tan ^[^?web');
  });

  it('still erases a character with Backspace after the terminal history was scrolled', async () => {
    const before = await Terminal.received(name);
    const middle = centre(await screenBox(() => Terminal.screen(name)));
    await swipe({x: middle.x, y: middle.y - 300}, {x: middle.x, y: middle.y + 500}, 300);
    await pressKey('backspace');
    await browser.waitUntil(async () => (await Terminal.received(name)).endsWith('^?'), {timeoutMsg: 'Backspace after scrolling was not delivered'});
    expect((await Terminal.received(name)).length).toBe(before.length + 2);
  });
});
