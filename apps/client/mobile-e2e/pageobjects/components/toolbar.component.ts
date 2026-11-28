import {$, browser} from '@wdio/globals';
import Page from '../page';
import {holdAt, screenBox, swipe, tapAt} from '../../support/gestures';

/** Edges of an element's box in CSS pixels, unrounded. */
export interface KeyBox {label: string; box: {left: number; top: number; right: number; bottom: number}; cut: boolean}

export type ToolbarPageId = 'keys' | 'tools' | 'snippets';

/** The terminal toolbar: pages of keys that scroll sideways, with a row of page dots. */
class ToolbarComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Terminal keys'); }
  /** A key of the keys page by its accessible name (`c`, `enter`, `Arrow left`). */
  key(name: string) { return $(`aria/${name}`); }
  get find() { return $('aria/Find'); }
  dot(page: ToolbarPageId) { return $(`[data-testid="toolbar-page-dot-${page}"]`); }

  async press(name: string) { await this.tap(() => this.key(name)); }
  /** Drags the toolbar sideways with one finger, from near its right end to near its left end, to reach the next page. */
  async swipeToNextPage() { await this.swipeAcross(0.85, 0.15); }
  async swipeToPreviousPage() { await this.swipeAcross(0.15, 0.85); }
  /** Taps or holds a key with a real finger at the middle of its box. */
  async tapKey(name: string) { await tapAt(await this.middleOf(name)); }
  async holdKey(name: string, ms: number) { await holdAt(await this.middleOf(name), ms); }
  private async middleOf(name: string) {
    const {x, y, width, height} = await screenBox(() => this.key(name));
    return {x: Math.round(x + width / 2), y: Math.round(y + height / 2)};
  }

  /** The page the dots mark as current, or null. */
  currentPage() {
    return this.in(() => browser.execute(() => document.querySelector('[data-testid^="toolbar-page-dot-"][aria-current="true"]')?.getAttribute('data-testid')?.replace('toolbar-page-dot-', '') ?? null));
  }
  /** How visible the dots are, from 0 (hidden) to 1: the opacity of the most visible one. */
  dotsOpacity() {
    return this.in(() => browser.execute(() => Math.max(0, ...Array.from(document.querySelectorAll('[data-testid^="toolbar-page-dot-"] span')).map(dot => Number(getComputedStyle(dot).opacity)))));
  }
  /** How far the pages have slid, in widths of the toolbar: 0 on the first page, 1 on the second. */
  pagesOffset() {
    return this.in(() => browser.execute(() => { const track = document.querySelector('.terminal-keys-pages')!; return track.scrollLeft / track.clientWidth; }));
  }
  /** Boxes of the buttons of one page, with the label each shows and whether the label is cut off. */
  keyBoxes(page: ToolbarPageId) {
    return this.in(() => browser.execute((id: string): KeyBox[] => Array.from(document.querySelectorAll(`[data-toolbar-page="${id}"] button`)).map(button => {
      const r = button.getBoundingClientRect();
      return {label: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '', box: {left: r.left, top: r.top, right: r.right, bottom: r.bottom}, cut: button.scrollWidth > button.clientWidth + 0.5};
    }), page));
  }
  private async swipeAcross(from: number, to: number) {
    const {x, y, width, height} = await screenBox(() => this.root);
    await swipe({x: x + width * from, y: y + height / 2}, {x: x + width * to, y: y + height / 2});
  }
}
export default new ToolbarComponent();
