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
   * Where `text` is on the screen in device pixels: its row is found in xterm's own DOM and the browser measures the text itself
   * (a range over the characters), so no cell width is assumed. The point is the middle of the text, with slack either side.
   */
  private async locate(text: string) {
    const css = await inWebView(() => browser.execute((needle: string) => {
      const row = Array.from(document.querySelectorAll('.xterm-rows > div')).find(candidate => (candidate.textContent ?? '').includes(needle));
      if (!row) return null;
      const from = (row.textContent ?? '').indexOf(needle), to = from + needle.length, range = document.createRange();
      let seen = 0, started = false;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (!started && from < seen + length) { range.setStart(node, from - seen); started = true; }
        if (started && to <= seen + length) { range.setEnd(node, to - seen); break; }
        seen += length;
      }
      const box = range.getBoundingClientRect();
      return {x: box.left + box.width / 2, y: box.top + box.height / 2, offsetTop: window.visualViewport?.offsetTop ?? 0};
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
