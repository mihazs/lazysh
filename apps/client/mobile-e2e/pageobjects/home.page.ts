import {$} from '@wdio/globals';
import Page from './page';

/** The home screen of an app with no session open: it invites to add the first host, or to connect when hosts are saved. */
class HomePage extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Add your first host'); }
  get addFirstHost() { return this.root; }
  /** The invitation of a home that already has hosts saved: it names the same action as the first-host one. */
  get connectToHost() { return $('aria/Connect to a host'); }
  async openHostEditor() { await this.tap(() => this.addFirstHost); }
}
export default new HomePage();
