import {$} from '@wdio/globals';
import Page from '../page';

/** The Add host dialog. */
class HostEditorComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('[role="dialog"][aria-label="Add a host"]'); }
  get name() { return $('aria/Name'); }
  get hostname() { return $('aria/Hostname or IP'); }
  get port() { return $('aria/Port'); }
  get username() { return $('aria/Username'); }
  // The label wraps the select and `aria/` resolves to the label, not the select, so the select carries a test id.
  get transport() { return $('[data-testid="host-transport"]'); }
  get save() { return $('aria/Save host'); }

  async fill(host: {name: string; hostname: string; port: number; username: string}) {
    await this.enter(() => this.name, host.name);
    await this.enter(() => this.hostname, host.hostname);
    await this.enter(() => this.port, host.port);
    await this.enter(() => this.username, host.username);
  }
  /** The owned hosts speak SSH only: Auto would try Mosh and Eternal Terminal first and wait for each to fail. */
  async useSsh() { await this.in(async () => { await this.transport.waitForDisplayed(); await this.transport.selectByAttribute('value', 'ssh'); }); }
  async saveHost() { await this.closeKeyboard(); await this.tap(() => this.save); }
}
export default new HostEditorComponent();
