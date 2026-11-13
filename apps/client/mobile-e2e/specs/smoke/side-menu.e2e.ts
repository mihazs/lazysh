import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import SideMenu from '../../pageobjects/components/side-menu.component';
import {resetApp} from '../../support/app';

describe('Side menu', () => {
  let name: string;
  before(async () => { name = await connectOwnedHost(); });
  after(resetApp);

  it('opens from a swipe at the left edge with the connected session and its sections, and closes on the return to terminal button', async () => {
    await SideMenu.in(() => expect(SideMenu.root).not.toBeDisplayedInViewport());
    await SideMenu.openByEdgeSwipe();
    await SideMenu.in(async () => {
      await expect(SideMenu.session).toHaveText(expect.stringContaining(name));
      for (const section of ['Agents', 'Workspaces', 'Connections']) await expect(SideMenu.sections).toHaveText(expect.stringContaining(section));
    });
    await SideMenu.close();
    await SideMenu.in(() => expect(SideMenu.root).not.toBeDisplayedInViewport());
  });
});
