import {$, browser} from '@wdio/globals';
import Page from '../page';
import {screenSize, swipe} from '../../support/gestures';

/** The side menu: the full-screen page of the connected session, its Agents, Workspaces and Connections. Phone layout only. */
class SideMenuComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Hosts and connections'); }
  get session() { return $('aria/Session'); }
  get sections() { return $('aria/Workspace navigation'); }
  get agentsSection() { return $('aria/Agents navigation'); }
  get workspacesSection() { return $('aria/Workspaces'); }
  get connectionsSection() { return $('aria/Connections'); }
  get returnToTerminal() { return $('aria/Return to terminal'); }
  get terminalView() { return $('[data-testid="session-view-terminal"]'); }
  get agentView() { return $('[data-testid="session-view-agent"]'); }
  endConnection(host: string) { return $(`aria/End ${host} connection`); }
  /** The agents Herdr lists on the connected host, in the Agents section. */
  get herdrAgent() { return $('[data-testid="herdr-agent-row"]'); }

  /**
   * The left-edge swipe a person starts a few pixels from the screen edge. The app ignores an edge swipe for a moment after typing
   * (the connect flow ends with one), so, as a person would, the swipe is repeated until the menu is in view.
   */
  async openByEdgeSwipe() {
    const {width, height} = await screenSize();
    await browser.waitUntil(async () => {
      await swipe({x: 2, y: height / 2}, {x: width * 0.7, y: height / 2});
      return this.in(() => this.root.waitForDisplayed({withinViewport: true, timeout: 1500}).then(() => true, () => false));
    }, {timeout: 20_000, timeoutMsg: 'The side menu did not open from the left-edge swipe'});
  }
  async showConnections() { await this.tap(() => this.connectionsSection); }
  async close() { await this.tap(() => this.returnToTerminal); }
  /** Choosing a view ends the visit: the menu closes over the view it chose. */
  async chooseTerminalView() { await this.tap(() => this.terminalView); }
  async chooseAgentView() { await this.tap(() => this.agentView); }
  async endConnectionOf(host: string) { await this.tap(() => this.endConnection(host)); }
  /** Opens the pane of the listed agent; Herdr reads its workspaces first, which can take a few seconds. */
  async openHerdrAgent() { await this.tap(() => this.herdrAgent, 30_000); }
}
export default new SideMenuComponent();
