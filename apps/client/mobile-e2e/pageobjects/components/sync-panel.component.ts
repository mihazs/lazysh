import {$, $$} from '@wdio/globals';
import Page from '../page';

/** The Encrypted sync dialog: enrollment, the recovery key, per-category upload and preview, and the review before apply. */
class SyncPanelComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('section[aria-label="Encrypted sync"]'); }
  // The header icon is hidden on wide layouts, so every layout reaches the panel through Workspace tools, as a user does.
  get tools() { return $('button[aria-label="Workspace tools"]'); }
  get opener() { return $('aria/Open encrypted sync'); }
  get closer() { return $('button[aria-label="Close Encrypted sync"]'); }
  get directory() { return $('aria/WebDAV directory'); }
  get username() { return $('aria/WebDAV username'); }
  get password() { return $('aria/WebDAV password'); }
  get recoveryImport() { return $('aria/Recovery key from another device'); }
  get settingsToggle() { return $('aria/Enable settings sync'); }
  get credentialsToggle() { return $('aria/Enable credentials sync'); }
  get configureButton() { return $('aria/Configure sync'); }
  get showRecovery() { return $('aria/Show recovery key'); }
  get hideRecovery() { return $('aria/Hide recovery key'); }
  // The read-only field is named "Recovery key"; the import field's name only starts with those words.
  get recoveryKey() { return $('textarea[aria-label="Recovery key"]'); }
  get uploadSettings() { return $('aria/Upload settings'); }
  get uploadCredentials() { return $('aria/Upload credentials'); }
  get previewSettings() { return $('aria/Preview remote settings'); }
  get previewCredentials() { return $('aria/Preview remote credentials'); }
  get apply() { return $('aria/Apply reviewed changes'); }
  get status() { return $('[role="status"]'); }
  get alert() { return $('[role="alert"]'); }
  get review() { return $('section[aria-label="Review sync changes"]'); }
  get reviewedHosts() { return $$('section[aria-label="Review sync changes"] article'); }

  async open() { await this.tap(() => this.tools); await this.tap(() => this.opener); }
  close() { return this.tap(() => this.closer); }

  /** Fills the enrollment form the way a user does and submits it. `recoveryKey` is the key of another device; without it the app creates a new one. */
  async configure(account: {url: string; username: string; password: string; settings: boolean; credentials?: boolean; recoveryKey?: string}) {
    await this.enter(() => this.directory, account.url);
    await this.enter(() => this.username, account.username);
    await this.enter(() => this.password, account.password);
    if (account.recoveryKey) await this.enter(() => this.recoveryImport, account.recoveryKey);
    if (account.settings) await this.tap(() => this.settingsToggle);
    if (account.credentials) await this.tap(() => this.credentialsToggle);
    await this.closeKeyboard();
    await this.tap(() => this.configureButton);
  }
  /** The recovery key the panel shows, once it is displayed. */
  shownRecoveryKey() {
    return this.in(async () => { await this.recoveryKey.waitForDisplayed({timeoutMsg: 'The recovery key was not shown'}); return this.recoveryKey.getValue(); });
  }
  async hideRecoveryKey() { await this.tap(() => this.hideRecovery); }
  async showRecoveryKey() { await this.tap(() => this.showRecovery); }
  async uploadSettingsNow() { await this.tap(() => this.uploadSettings); }
  async previewRemoteSettings() { await this.tap(() => this.previewSettings); }
  async applyReviewed() { await this.tap(() => this.apply); }
}
export default new SyncPanelComponent();
