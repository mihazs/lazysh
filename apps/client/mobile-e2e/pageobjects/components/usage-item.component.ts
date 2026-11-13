import {$} from '@wdio/globals';
import Page from '../page';

/** The usage item of the status bar: the AI account of the agent in the focused pane, with how much of it is used. */
class UsageItemComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Open AI account usage'); }
}
export default new UsageItemComponent();
