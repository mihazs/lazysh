import {$, browser} from '@wdio/globals';
import Page from './page';
import {inNative} from '../support/contexts';

/** The terminal of the connected session. */
class TerminalPage extends Page {
  readonly context = 'WEBVIEW' as const;
  screen(hostName: string) { return $(`aria/Terminal for ${hostName}`); }
  get root() { return $('aria/Terminal'); }

  /**
   * Types as a person does with the soft keyboard open: the characters reach the page as Android key events, not as DevTools
   * input, and the toolbar's Enter key ends the line. Tapping the terminal first gives it the focus.
   */
  async type(hostName: string, text: string) {
    await this.tap(() => this.screen(hostName));
    await inNative(() => browser.keys([...text]));
  }
}
export default new TerminalPage();
