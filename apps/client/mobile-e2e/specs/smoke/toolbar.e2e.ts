import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import Toolbar from '../../pageobjects/components/toolbar.component';
import Terminal from '../../pageobjects/terminal.page';
import {resetApp} from '../../support/app';
import {readEndpoint} from '../../support/hosts';

describe('Terminal toolbar', () => {
  let name: string;
  before(async () => { name = await connectOwnedHost(); });
  after(resetApp);

  it('sends the key of the keys page to the host terminal', async () => {
    const {prompt} = await readEndpoint();
    await Toolbar.press('c');
    await Terminal.in(() => expect(Terminal.screen(name)).toHaveText(expect.stringMatching(new RegExp(`${prompt}\\s*c`))));
  });

  // The default toolbar has two pages: the keys, and Find and Copy, which act on the terminal and send nothing to the host.
  it('turns to the tools page with a swipe and back to the keys page with the opposite swipe', async () => {
    await Toolbar.swipeToNextPage();
    await Toolbar.in(async () => {
      await expect(Toolbar.dot('tools')).toHaveAttribute('aria-current', 'true');
      await expect(Toolbar.find).toBeDisplayedInViewport();
      await expect(Toolbar.key('enter')).not.toBeDisplayedInViewport();
    });
    await Toolbar.swipeToPreviousPage();
    await Toolbar.in(async () => {
      await expect(Toolbar.dot('keys')).toHaveAttribute('aria-current', 'true');
      await expect(Toolbar.key('enter')).toBeDisplayedInViewport();
    });
  });
});
