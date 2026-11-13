import {$, browser} from '@wdio/globals';
import Page from './page';
import {centre, screenBox, type Box} from '../support/geometry';
import {tapAt} from '../support/gestures';
import {READY, receivedBytes} from '../support/receiver';

/** The terminal of the connected session. */
class TerminalPage extends Page {
  readonly context = 'WEBVIEW' as const;
  screen(hostName: string) { return $(`aria/Terminal for ${hostName}`); }
  get root() { return $('aria/Terminal'); }
  get input() { return $('aria/Terminal input'); }

  async waitForTerminal(hostName: string) {
    await this.in(() => this.screen(hostName).waitForDisplayed({timeoutMsg: `The terminal of ${hostName} was not displayed`}));
  }

  /** Everything on the screen, rows joined by line breaks. */
  text(hostName: string) { return this.in(() => this.screen(hostName).getText()); }

  /** Waits until the screen text matches `pattern`. */
  async textEventually(hostName: string, pattern: RegExp) {
    await browser.waitUntil(async () => pattern.test(await this.text(hostName)), {timeoutMsg: `The terminal never showed ${pattern}`});
  }

  /** Taps the terminal as a finger does: focuses the input and raises the soft keyboard. */
  async tapScreen(hostName: string) { await tapAt(centre(await screenBox(() => this.screen(hostName)))); }

  /**
   * The text grid in CSS pixels, unrounded: its box, the box of each row and the viewport it lies in. The grid and its rows are
   * xterm.js's own elements; they carry no accessible name of their own.
   */
  grid() {
    return this.in(() => browser.execute(() => {
      const box = (node: Element): Box => { const r = node.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; };
      const rows = Array.from(document.querySelectorAll('.xterm-rows > div'));
      return {grid: box(document.querySelector('.xterm-screen')!), rows: rows.map(box), viewport: {width: window.innerWidth, height: window.innerHeight}};
    }));
  }

  /**
   * Makes the host's shell print the tty size it sees (`stty size`) a few times a second, so it can be read without typing: the
   * keyboard may be closed, and then the terminal has no focus. Read the latest with `ptySize`.
   */
  async watchPtySize() {
    await this.run('while :; do echo "PTY_$(stty size)"; sleep 0.3; done');
  }

  /** The latest size the host reported since `watchPtySize`. */
  async ptySize(hostName: string) {
    const reported = [...(await this.text(hostName)).matchAll(/PTY_(\d+) (\d+)/g)].at(-1);
    return reported ? {rows: Number(reported[1]), cols: Number(reported[2])} : null;
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
