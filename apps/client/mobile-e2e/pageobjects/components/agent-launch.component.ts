import {$} from '@wdio/globals';
import Page from '../page';

export type LaunchLocation = 'An existing folder' | 'A new folder' | 'A new Git worktree';

/** The New agent flow of the Agent view: the button in its header and the dialog it opens (agent, place, plan, confirm). */
class AgentLaunchComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('[role="dialog"][aria-label="New agent"]'); }
  // Every session keeps its own Agent view in the page, and the dialog's own title is also "New agent", so the button is the one in the visible view.
  get openButton() { return $('[data-testid="agent-view"]:not([hidden]) button[aria-label="New agent"]'); }
  // The label wraps the select and `aria/` resolves to the label, not the select, so the select carries a test id.
  get agent() { return $('[data-testid="agent-launch-agent"]'); }
  location(name: LaunchLocation) { return $(`aria/${name}`); }
  /** The folder field is named "Host folder", or "A folder inside the Git repository" for a worktree. */
  get folder() { return $('aria/Host folder'); }
  get repositoryFolder() { return $('aria/A folder inside the Git repository'); }
  get prompt() { return $('aria/Initial prompt (optional)'); }
  get browse() { return $('[data-testid="directory-browse"]'); }
  /** A folder listed by the host's directory browser; its name is its accessible name. */
  browsed(name: string) { return $(`aria/${name}`); }
  get readRepository() { return $('aria/Read the repository'); }
  get branch() { return $('aria/New branch'); }
  get worktreePath() { return $('aria/Worktree path'); }
  get review() { return $('aria/Review commands'); }
  get plan() { return $('[data-testid="agent-launch-plan"]'); }
  get confirm() { return $('aria/Create and start agent'); }

  async open() { await this.tap(() => this.openButton); }
  /** The agents the host has are offered once its `command -v` probe answers. */
  async chooseAgent(kind: string) {
    await this.in(async () => { await this.agent.waitForDisplayed({timeoutMsg: 'The launcher did not list the host agents'}); await this.agent.selectByAttribute('value', kind); });
  }
  async chooseLocation(name: LaunchLocation) { await this.tap(() => this.location(name)); }
  async typeFolder(path: string) { await this.enter(() => this.folder, path); }
  async typeRepository(path: string) { await this.enter(() => this.repositoryFolder, path); }
  async typePrompt(text: string) { await this.enter(() => this.prompt, text); }
  async typeBranch(name: string) { await this.enter(() => this.branch, name); }
  async browseFolders() { await this.closeKeyboard(); await this.tap(() => this.browse); }
  async openBrowsed(name: string) { await this.tap(() => this.browsed(name)); }
  async readTheRepository() { await this.closeKeyboard(); await this.tap(() => this.readRepository); }
  async reviewPlan() { await this.closeKeyboard(); await this.tap(() => this.review); }
  async confirmPlan() { await this.tap(() => this.confirm); }
}
export default new AgentLaunchComponent();
