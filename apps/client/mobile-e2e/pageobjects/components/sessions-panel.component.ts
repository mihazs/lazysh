import {$} from '@wdio/globals';
import Page from '../page';

/** The session manager of a connected host: the tmux, Zellij and Herdr servers it finds, each with a button to attach. */
class SessionsPanelComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Multiplexer workspaces'); }
  attachButton(server: string) { return $(`aria/Attach ${server}`); }

  /** Attaching opens the multiplexer as a second session of the host, titled `<host> / <server>`, and brings it to the front. */
  async attach(server: string) { await this.tap(() => this.attachButton(server), 30_000); }
}
export default new SessionsPanelComponent();
