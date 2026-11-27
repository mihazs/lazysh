import {$} from '@wdio/globals';
import Page from '../page';

/** The Agent view of a session: the conversation of its agent and the composer under it. */
class AgentViewComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  // Every session keeps its own Agent view in the page and hides the ones that are not in front, so the visible one is the root.
  get root() { return $('[data-testid="agent-view"]:not([hidden])'); }
  get draft() { return $('aria/Draft for this terminal'); }
  get send() { return $('aria/Send to the agent'); }
  // The composer shows at most one notice, and the page has no other alert inside the Agent view.
  get notice() { return $('[data-testid="agent-view"]:not([hidden]) [role="alert"]'); }
  get dismissNotice() { return $('aria/Dismiss'); }

  /** Types in the composer the way the soft keyboard does, then presses the Send button: Enter is a new line on a touch screen. */
  async write(text: string) { await this.enter(() => this.draft, text); }
  async submit() { await this.tap(() => this.send); }
  async dismiss() { await this.tap(() => this.dismissNotice); }
}
export default new AgentViewComponent();
