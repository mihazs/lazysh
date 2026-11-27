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

  /** Taps the terminal with a real touch, as a finger does: it takes the focus and raises the soft keyboard. */
  async tapScreen(hostName: string) { await this.tap(() => this.screen(hostName)); }

  /** The text grid and its rows in CSS pixels, unrounded, with the viewport they lie in. These are xterm.js's own elements. */
  grid() {
    return this.in(() => browser.execute(() => {
      const box = (node: Element) => { const r = node.getBoundingClientRect(); return {left: r.left, top: r.top, right: r.right, bottom: r.bottom}; };
      return {grid: box(document.querySelector('.xterm-screen')!), rows: Array.from(document.querySelectorAll('.xterm-rows > div')).map(box), viewport: {width: window.innerWidth, height: window.innerHeight}};
    }));
  }

  /**
   * Makes the host's shell print the tty size it sees (`stty size`) a few times a second, so it can be read without typing: the
   * keyboard may be closed, and then the terminal has no focus. Read the latest with `ptySize`. The terminal must have the focus
   * (tap it first); keys sent before then are lost.
   */
  async watchPtySize() {
    await this.in(async () => {
      await browser.waitUntil(() => browser.execute(() => document.activeElement?.getAttribute('aria-label') === 'Terminal input'), {timeoutMsg: 'The terminal input never got focus'});
      await browser.keys([...'while :; do echo "PTY_$(stty size)"; sleep 0.3; done', 'Enter']);
    });
  }

  /** The latest size the host reported since `watchPtySize`. */
  async ptySize(hostName: string) {
    const reported = [...(await this.in(() => this.screen(hostName).getText())).matchAll(/PTY_(\d+) (\d+)/g)].at(-1);
    return reported ? {rows: Number(reported[1]), cols: Number(reported[2])} : null;
  }
}
export default new TerminalPage();
