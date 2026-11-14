import {$} from '@wdio/globals';
import Page from '../page';

/** The Agent view of a session: the conversation of its agent and the composer under it. */
class AgentViewComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  // Every session keeps its own Agent view in the page and hides the ones that are not in front, so the visible one is the root.
  get root() { return $('[data-testid="agent-view"]:not([hidden])'); }
}
export default new AgentViewComponent();
