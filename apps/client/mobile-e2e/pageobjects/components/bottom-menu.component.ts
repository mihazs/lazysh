import {$} from '@wdio/globals';
import Page from '../page';

/** The bottom menu: the sheet of the connected session that rises from the bottom edge. */
class BottomMenuComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Bottom menu'); }
  get close() { return $('aria/Close bottom menu'); }
  async closeByButton() { await this.tap(() => this.close); }
}
export default new BottomMenuComponent();
