import {$, browser} from '@wdio/globals';
import Page from '../page';
import {centre, screenBox, type Box} from '../../support/geometry';
import {holdAt, swipe, tapAt} from '../../support/gestures';

/** The key toolbar under the terminal. Keys are pressed with a real finger on the screen, as a user does. */
class TerminalToolbarComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Terminal keys'); }
  key(name: string) { return $(`aria/${name}`); }
  /** The dot that selects a page ("Keys", "Tools", "Snippets"); its visible part is the span inside. */
  pageDot(name: string) { return $(`button[aria-label="${name} page"]`); }

  private async centreOf(name: string) { return centre(await screenBox(() => this.key(name))); }
  async tapKey(name: string) { await tapAt(await this.centreOf(name)); }
  async holdKey(name: string, ms: number) { await holdAt(await this.centreOf(name), ms); }

  /** One drag across the middle of the toolbar, from `from` to `to` as fractions of its width. */
  async swipe(from: number, to: number) {
    const box = await screenBox(() => this.root), y = Math.round((box.top + box.bottom) / 2), width = box.right - box.left;
    await swipe({x: Math.round(box.left + width * from), y}, {x: Math.round(box.left + width * to), y}, 400);
  }

  /** The page the dots mark as current ("Keys", "Tools", ...), or null. */
  currentPage() {
    return this.in(() => browser.execute(() => document.querySelector('button[aria-current="true"][aria-label$=" page"]')?.getAttribute('aria-label')?.replace(/ page$/, '') ?? null));
  }
  /** How visible the dots are, from 0 (hidden) to 1: the opacity of the most visible one. */
  dotsOpacity() {
    return this.in(() => browser.execute(() => Math.max(0, ...Array.from(document.querySelectorAll('button[aria-label$=" page"] span')).map(dot => Number(getComputedStyle(dot).opacity)))));
  }
  /** How far the pages have slid, in widths of the toolbar: 0 on the first page, 1 on the second. */
  pagesOffset() {
    return this.in(() => browser.execute(() => {
      const track = document.querySelector('[data-toolbar-page]')!.parentElement!;
      return track.scrollLeft / track.clientWidth;
    }));
  }
  /** Boxes of the keys of one page in CSS pixels, unrounded, with the label each one shows and whether the label is cut off. */
  keyBoxes(page: string) {
    return this.in(() => browser.execute((id: string) => Array.from(document.querySelectorAll(`[data-toolbar-page="${id}"] button`)).map(button => {
      const r = button.getBoundingClientRect();
      return {label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '', box: {left: r.left, top: r.top, right: r.right, bottom: r.bottom} as Box,
        cut: button.scrollWidth > button.clientWidth + 0.5};
    }), page));
  }
}
export default new TerminalToolbarComponent();
