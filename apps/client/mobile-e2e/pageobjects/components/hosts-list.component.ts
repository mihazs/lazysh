import {$} from '@wdio/globals';
import Page from '../page';

/** The saved hosts in the sidebar. */
class HostsListComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Hosts and connections'); }
  connectButton(name: string) { return $(`aria/Connect to ${name}`); }
  get openMenuButton() { return $('aria/Open hosts'); }

  /** A phone keeps the list behind the Open hosts button, a wide window shows it beside the terminal. */
  async openMenu() { await this.tap(() => this.openMenuButton); }
  async connectTo(name: string) {
    await this.in(async () => { if (!await this.connectButton(name).isDisplayed({withinViewport: true})) await this.openMenuButton.click(); });
    await this.tap(() => this.connectButton(name));
  }
}
export default new HostsListComponent();
