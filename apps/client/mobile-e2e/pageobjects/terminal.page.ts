import {$} from '@wdio/globals';
import Page from './page';

/** The terminal of the connected session. */
class TerminalPage extends Page {
  readonly context = 'WEBVIEW' as const;
  screen(hostName: string) { return $(`aria/Terminal for ${hostName}`); }
  get root() { return $('aria/Terminal'); }
}
export default new TerminalPage();
