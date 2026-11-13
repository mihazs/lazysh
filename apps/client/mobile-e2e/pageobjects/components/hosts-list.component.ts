import {$} from '@wdio/globals';
import Page from '../page';

/** The saved hosts: in the sidebar on a wide screen, behind the "Open hosts" button on a phone. */
class HostsListComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Hosts and connections'); }
  get openHosts() { return $('aria/Open hosts'); }
  connectButton(name: string) { return $(`aria/Connect to ${name}`); }
  async connectTo(name: string) {
    await this.in(async () => { const open = this.openHosts; if (await open.isDisplayed()) await open.click(); });
    await this.tap(() => this.connectButton(name));
  }
}
export default new HostsListComponent();
