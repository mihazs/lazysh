import {$} from '@wdio/globals';
import Page from './page';

/** The home screen of an app with no hosts yet. */
class HomePage extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Add your first host'); }
  get addFirstHost() { return this.root; }
}
export default new HomePage();
