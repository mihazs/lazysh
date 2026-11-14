import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import ConnectDialog from '../../pageobjects/components/connect-dialog.component';
import HostsList from '../../pageobjects/components/hosts-list.component';
import SideMenu from '../../pageobjects/components/side-menu.component';
import Home from '../../pageobjects/home.page';
import Terminal from '../../pageobjects/terminal.page';
import {resetApp} from '../../support/app';
import {readEndpoint} from '../../support/hosts';

describe('Disconnect and reconnect', () => {
  let name: string;
  before(async () => { name = await connectOwnedHost(); });
  after(resetApp);

  it('keeps the host when its connection ends, and shows its terminal again when the host connects', async () => {
    const {privateKey, prompt} = await readEndpoint();
    await SideMenu.openByEdgeSwipe();
    await SideMenu.showConnections();
    await SideMenu.endConnectionOf(name);
    await Home.in(() => expect(Home.connectToHost).toBeDisplayed());
    await HostsList.connectTo(name);
    // Its host key was trusted the first time, so signing in is the last step.
    await ConnectDialog.signIn(privateKey);
    await Terminal.in(() => expect(Terminal.screen(name)).toHaveText(expect.stringContaining(prompt)));
  });
});
