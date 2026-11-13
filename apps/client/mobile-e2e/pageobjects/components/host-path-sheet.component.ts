import {$, browser} from '@wdio/globals';
import Page from '../page';
import {inWebView} from '../../support/contexts';
import {devicePixelRatio, gestureUntil, tap, webViewRect} from '../../support/navigation';

/** The sheet a host file path in the terminal output opens: the path, with View, Download and Copy path. */
class HostPathSheetComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Host file'); }
  get dismiss() { return $('aria/Dismiss file'); }

  async close() { await this.tap(() => this.dismiss); }

  /**
   * Where `text` is on the screen in device pixels: its row is found in xterm's own DOM, its column from the width of one
   * character cell. The point is the middle of the text, so it holds a few characters of slack either side.
   */
  private async locate(text: string) {
    const css = await inWebView(() => browser.execute((needle: string) => {
      const rows = Array.from(document.querySelectorAll('.xterm-rows > div'));
      const row = rows.find(candidate => (candidate.textContent ?? '').includes(needle));
      const probe = document.querySelector('.xterm-char-measure-element');
      if (!row || !probe) return null;
      const box = row.getBoundingClientRect();
      const cell = probe.getBoundingClientRect().width / Math.max(1, (probe.textContent ?? '').length);
      const column = (row.textContent ?? '').indexOf(needle) + needle.length / 2;
      return {x: box.left + column * cell, y: box.top + box.height / 2, offsetTop: window.visualViewport?.offsetTop ?? 0};
    }, text));
    if (!css) throw new Error(`"${text}" is not on the terminal screen`);
    const [view, ratio] = [await webViewRect(), await devicePixelRatio()];
    return {x: view.x + css.x * ratio, y: view.y + (css.y + css.offsetTop) * ratio};
  }

  /** Taps `text` until the sheet opens: the terminal only offers a link once the pointer has reached it, and asks the host first. */
  async openByTapping(text: string) {
    await gestureUntil(async () => tap(await this.locate(text)), () => this.in(() => this.root.waitForDisplayed({timeout: 1500}).then(() => true, () => false)), 'The host file sheet');
  }
}
export default new HostPathSheetComponent();
