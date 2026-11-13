import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import SideMenu from '../../../pageobjects/components/side-menu.component';
import UsageItem from '../../../pageobjects/components/usage-item.component';
import {resetApp} from '../../../support/app';
import {agentsFixture} from '../../../support/agents';

// The host reports Claude at 100 %, Codex at 35 % and GitHub Copilot at 7 % as its default, so each line below names the account the
// bar chose, not one it happened to start on.
const shows = (text: string) => UsageItem.in(() => expect(UsageItem.root).toHaveText(text, {wait: 30_000}));

describe('#1266 the usage item follows the agent in the focused pane', () => {
  before(async () => {
    await connectOwnedHost({kind: 'herdr-agents', label: 'usage'});
    // The session is a plain SSH shell until a Herdr agent is chosen from the side menu, which attaches the app to the Herdr server.
    await SideMenu.openByEdgeSwipe();
    await SideMenu.openHerdrAgentIn(agentsFixture.codexTab);
  });
  after(resetApp);

  it('shows the account of the agent in the focused pane, follows the focus, and falls back to the default for a pane with no agent', async () => {
    await shows('Codex 35% used');
    await SideMenu.openByEdgeSwipe();
    await SideMenu.openHerdrAgentIn(agentsFixture.claudeTab);
    await shows('Claude 100% used');
    await SideMenu.openByEdgeSwipe();
    await SideMenu.openHerdrTab(agentsFixture.shellTab);
    await shows('GitHub Copilot 7% used');
  });
});
