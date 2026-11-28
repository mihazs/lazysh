import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import HostsList from '../../../pageobjects/components/hosts-list.component';
import NavigationTabs from '../../../pageobjects/components/navigation-tabs.component';
import SideMenu from '../../../pageobjects/components/side-menu.component';
import {resetApp} from '../../../support/app';

describe('#1395 side menu order', () => {
  describe('without a connection', () => {
    it('lists Connections, Workspaces, Agents and opens on Connections', async () => {
      await HostsList.openMenu();
      expect(await NavigationTabs.order()).toEqual(['Connections', 'Workspaces', 'Agents']);
      expect(await NavigationTabs.current()).toBe('Connections');
    });
  });

  describe('in a connected session', () => {
    before(async () => { await resetApp(); await connectOwnedHost(); });
    after(resetApp);

    it('lists Agents, Workspaces, Connections and opens on Agents', async () => {
      await SideMenu.openByEdgeSwipe();
      expect(await NavigationTabs.order()).toEqual(['Agents', 'Workspaces', 'Connections']);
      expect(await NavigationTabs.current()).toBe('Agents');
    });
  });
});
