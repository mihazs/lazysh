import {$} from '@wdio/globals';
import Page from '../page';

/** The saved hosts in the sidebar. */
class HostsListComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Hosts and connections'); }
  connectButton(name: string) { return $(`aria/Connect to ${name}`); }
  async connectTo(name: string) { await this.tap(() => this.connectButton(name)); }
}
export default new HostsListComponent();
