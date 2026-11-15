import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import AgentView from '../../pageobjects/components/agent-view.component';
import SideMenu from '../../pageobjects/components/side-menu.component';
import {resetApp} from '../../support/app';

describe('Agent view of an owned Herdr host', () => {
  before(async () => {
    await connectOwnedHost({kind: 'herdr', label: 'herdr'});
    // The Herdr agent the fixture reported opens in its own pane, the one the Agent view follows.
    await SideMenu.openByEdgeSwipe();
    await SideMenu.openHerdrAgent();
  });
  after(resetApp);

  // The fixture's agent is a pane that Herdr detects and Herdr has not yet reported a conversation for, so the view has no composer.
  it('opens from the side menu on the agent in the focused pane, and the Terminal view brings the terminal back', async () => {
    await SideMenu.openByEdgeSwipe();
    await SideMenu.chooseAgentView();
    await AgentView.in(async () => {
      await expect(AgentView.root).toBeDisplayed();
      await expect(AgentView.root).toHaveText(expect.stringContaining('codex runs in the focused pane'));
    });
    await SideMenu.openByEdgeSwipe();
    await SideMenu.chooseTerminalView();
    await AgentView.in(() => expect(AgentView.root).not.toBeDisplayed());
  });
});
