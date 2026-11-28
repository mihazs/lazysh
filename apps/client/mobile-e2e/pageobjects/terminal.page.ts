import {$, browser} from '@wdio/globals';
import Page from './page';
import {inNative} from '../support/contexts';
import {READY, receivedBytes} from '../support/receiver';
import {screenBox, tapAt} from '../support/gestures';

/** The terminal of the connected session. */
class TerminalPage extends Page {
  readonly context = 'WEBVIEW' as const;
  screen(hostName: string) { return $(`aria/Terminal for ${hostName}`); }
  get root() { return $('aria/Terminal'); }

  /** Taps the terminal as a finger does: focuses its input and raises the soft keyboard. */
  async tapScreen(hostName: string) {
    const {x, y, width, height} = await screenBox(() => this.screen(hostName));
    await tapAt({x: x + width / 2, y: y + height / 2});
  }

  /**
   * Types as a person does with the soft keyboard open: the characters reach the page as Android key events, not as DevTools
   * input, and the toolbar's Enter key ends the line. Tapping the terminal first gives it the focus.
   */
  async type(hostName: string, text: string) {
    await this.tap(() => this.screen(hostName));
    await inNative(() => browser.keys([...text]));
  }

  /** Everything on the screen, rows joined by line breaks. */
  text(hostName: string) { return this.in(() => this.screen(hostName).getText()); }

  /** Waits until the screen text matches `pattern`. */
  async textEventually(hostName: string, pattern: RegExp) {
    await browser.waitUntil(async () => pattern.test(await this.text(hostName)), {timeoutMsg: `The terminal never showed ${pattern}`});
  }

  /** Types a command through the page's own key events (setup, not the input path under test) and presses Enter. */
  async run(command: string) {
    await this.in(async () => {
      // Keys sent before the terminal's input has focus are lost, and the start of the command goes with them.
      await browser.waitUntil(() => browser.execute(() => document.activeElement?.getAttribute('aria-label') === 'Terminal input'), {timeoutMsg: 'The terminal input never got focus'});
      await browser.keys([...command, 'Enter']);
    });
  }

  /**
   * Turns the host shell into a receiver: raw mode without echo, then `cat -v` prints every byte the terminal sends as text
   * (Escape as ^[, Delete as ^?, Tab as ^I). Returns once it is running.
   */
  async startReceiver(hostName: string) {
    await this.run(`stty -icanon -echo -isig -icrnl -ixon -ixoff; printf 'RX_%s\\n' READY; cat -v`);
    await browser.waitUntil(async () => (await this.text(hostName)).split('\n').some(row => row.trim() === READY), {timeoutMsg: 'The receiver did not start in the host shell'});
  }

  /** The bytes the receiver has printed so far (see `receivedBytes`). */
  async received(hostName: string) { return receivedBytes(await this.text(hostName)); }

  /** Waits until the receiver has printed exactly `expected` and says what it printed instead on failure. */
  async receivedExactly(hostName: string, expected: string) {
    let last = '';
    await browser.waitUntil(async () => (last = await this.received(hostName)) === expected, {timeoutMsg: 'The receiver output never became the expected bytes'})
      .catch(() => { throw new Error(`The host received ${JSON.stringify(last)} instead of ${JSON.stringify(expected)}`); });
  }
}
export default new TerminalPage();
