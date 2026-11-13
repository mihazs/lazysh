/**
 * #1214 Private keyboard mode (implemented in #1221; epic #1396, issue #1405).
 *
 * Some keyboards lose or corrupt terminal input, so a setting asks the soft keyboard to act as a plain key source. The
 * Playwright spec `e2e/private-keyboard.spec.ts` covers the page side with a mocked bridge. What only the packaged app can show
 * is that the setting reaches Android's real input connection: the focused terminal input is given a different `EditorInfo`,
 * read here from the system's input method service. The terminal input is the only field affected.
 */
import {browser, expect} from '@wdio/globals';
import {connectOwnedHost, signInOwnedHost} from '../../../pageobjects/connect-owned-host';
import Preferences from '../../../pageobjects/components/preferences.component';
import Terminal from '../../../pageobjects/terminal.page';
import {relaunchApp, resetApp} from '../../../support/app';
import {focusedEditor, isPrivate} from '../../../support/ime';
import {usePhoneScreen} from '../../../support/screen';

/** Taps the terminal and waits until the keyboard has been given the setup of its input. */
async function focusTerminal(name: string, expectPrivate: boolean) {
  await Terminal.tapScreen(name);
  await browser.waitUntil(async () => isPrivate(await focusedEditor()) === expectPrivate,
    {timeoutMsg: `The terminal input was not given ${expectPrivate ? 'private' : 'ordinary'} keyboard options`});
}

describe('#1214 private keyboard mode', () => {
  let name: string;
  before(async () => { await usePhoneScreen(); name = await connectOwnedHost(); });
  after(resetApp);
  beforeEach(async () => { await Preferences.open('Keyboard and gestures'); await Preferences.setPrivateKeyboard(false); await Preferences.close(); });

  it('is offered on Android, off by default, and leaves the terminal input with the keyboard\'s ordinary setup', async () => {
    await Preferences.open('Keyboard and gestures');
    expect(await Preferences.isPrivateKeyboardOn()).toBe(false);
    await Preferences.close();
    await focusTerminal(name, false);
  });

  it('gives the focused terminal input private keyboard options once it is switched on', async () => {
    await Preferences.open('Keyboard and gestures');
    await Preferences.setPrivateKeyboard(true);
    await Preferences.close();
    await focusTerminal(name, true);
  });

  it('stops reporting private options when it is switched off, without reconnecting the terminal', async () => {
    await Preferences.open('Keyboard and gestures');
    await Preferences.setPrivateKeyboard(true);
    await Preferences.close();
    await focusTerminal(name, true);
    await Terminal.run('echo KEPT_$$_SESSION');
    await Terminal.textEventually(name, /KEPT_\d+_SESSION/);
    await Preferences.open('Keyboard and gestures');
    await Preferences.setPrivateKeyboard(false);
    await Preferences.close();
    await focusTerminal(name, false);
    // A reconnect would start a fresh screen: the line printed before the switch is still there.
    await Terminal.textEventually(name, /KEPT_\d+_SESSION/);
  });

  it('keeps the choice across an app restart and applies it to the next terminal', async () => {
    await Preferences.open('Keyboard and gestures');
    await Preferences.setPrivateKeyboard(true);
    await Preferences.close();
    await relaunchApp();
    // The host and its key stay trusted across the restart: only the sign-in is repeated.
    await signInOwnedHost(name, 'ssh', true);
    await Terminal.waitForTerminal(name);
    await focusTerminal(name, true);
  });

  it('is cleared by Reset preferences', async () => {
    await Preferences.open('Keyboard and gestures');
    await Preferences.setPrivateKeyboard(true);
    await Preferences.close();
    await Preferences.open('Reset settings');
    await Preferences.reset();
    await Preferences.close();
    await focusTerminal(name, false);
  });
});
