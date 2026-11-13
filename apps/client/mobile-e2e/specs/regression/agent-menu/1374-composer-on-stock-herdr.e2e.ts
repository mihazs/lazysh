import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import AgentView from '../../../pageobjects/components/agent-view.component';
import SideMenu from '../../../pageobjects/components/side-menu.component';
import {resetApp} from '../../../support/app';
import {agentsFixture, receivedNothing, waitForReceived} from '../../../support/agents';
import {runNonce} from '../../../support/hosts';

/** The session is on the Agent view of the agent in the pane Herdr focuses. */
async function showAgentView() { await SideMenu.openByEdgeSwipe(); await SideMenu.chooseAgentView(); }

describe('#1374 the Agent view composer on a stock Herdr host', () => {
  before(async () => { await connectOwnedHost({kind: 'herdr-agents', label: 'agents'}); });
  after(resetApp);

  it('shows the conversation of the agent in the focused pane, and a sent prompt reaches that agent once, as typed', async () => {
    await showAgentView();
    await AgentView.in(() => expect(AgentView.root).toHaveText(expect.stringContaining(agentsFixture.reply)));
    const prompt = `check the build ${runNonce()}`;
    await AgentView.write(prompt);
    await AgentView.submit();
    // Stock Herdr has no guard: the app delivers through Herdr's own agent prompt, which ends the line with Enter.
    await waitForReceived('receiver', `${prompt}\r`);
    await AgentView.in(async () => {
      await expect(AgentView.draft).toHaveValue('');
      await expect(AgentView.notice).not.toBeExisting();
    });
  });

  it('refuses a send to an agent that waits for an answer with one notice, keeps the draft and sends nothing', async () => {
    await SideMenu.openByEdgeSwipe();
    await SideMenu.openHerdrAgentIn(agentsFixture.blockedTab);
    await showAgentView();
    const draft = `next step ${runNonce()}`;
    await AgentView.write(draft);
    await AgentView.submit();
    await AgentView.in(async () => {
      await expect(AgentView.notice).toHaveText(expect.stringContaining('Message not sent'));
      await expect(AgentView.notice).toHaveText(expect.stringContaining('waiting for an answer or approval'));
      await expect(AgentView.draft).toHaveValue(draft);
    });
    expect(await receivedNothing('blockedReceiver')).toBe(true);
    await AgentView.dismiss();
    await AgentView.in(async () => {
      await expect(AgentView.notice).not.toBeExisting();
      await expect(AgentView.draft).toHaveValue(draft);
    });
  });
});
