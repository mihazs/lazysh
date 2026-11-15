import {$} from '@wdio/globals';
import Page from '../page';
import {screenBox, swipe} from '../../support/gestures';

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
  private async swipeAcross(from: number, to: number) {
    const {x, y, width, height} = await screenBox(() => this.root);
    await swipe({x: x + width * from, y: y + height / 2}, {x: x + width * to, y: y + height / 2});
  }
}
export default new ToolbarComponent();
