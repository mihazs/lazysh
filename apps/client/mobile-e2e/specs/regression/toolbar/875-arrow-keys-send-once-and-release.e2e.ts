/**
 * #875 and #601 Toolbar keys stayed pressed after the finger lifted (epic #1396, issue #1407).
 *
 * `e2e/toolbar-arrows.spec.ts` checks the bytes with a mocked terminal. Here a real finger presses the arrow cluster of the
 * packaged app, and the host's own shell prints the bytes it received (`cat -v`), so a key that sends twice, sends the wrong
 * sequence or never lets go shows up in what the host saw.
 */
import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import Terminal from '../../../pageobjects/terminal.page';
import Toolbar from '../../../pageobjects/components/terminal-toolbar.component';
import {resetApp} from '../../../support/app';
import {usePhoneScreen} from '../../../support/screen';

describe('#875 #601 the arrow keys', () => {
  let name: string;
  before(async () => { await usePhoneScreen(); name = await connectOwnedHost(); await Terminal.startReceiver(name); });
  after(resetApp);

  it('each send their own sequence exactly once per tap', async () => {
    for (const key of ['Arrow left', 'Arrow up', 'Arrow down', 'Arrow right']) await Toolbar.tapKey(key);
    await Terminal.receivedExactly(name, '^[[D^[[A^[[B^[[C');
  });

  it('repeat while held and stop when the finger lifts', async () => {
    const before = await Terminal.received(name);
    await Toolbar.holdKey('Arrow up', 1500);
    // A marker key after the release: every repeat must already be in front of it, and nothing may follow it.
    await Toolbar.tapKey('Arrow down');
    await browser.waitUntil(async () => (await Terminal.received(name)).endsWith('^[[B'), {timeoutMsg: 'The marker key never arrived'});
    const added = (await Terminal.received(name)).slice(before.length);
    expect(added).toMatch(/^(\^\[\[A){2,}\^\[\[B$/);
  });
});
