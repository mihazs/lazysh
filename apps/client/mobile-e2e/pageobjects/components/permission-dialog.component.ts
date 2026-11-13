import {$} from '@wdio/globals';
import type {ChainablePromiseElement} from 'webdriverio';
import Page from '../page';

/** The system's runtime permission dialog, in the native layer over the app. */
class PermissionDialogComponent extends Page {
  readonly context = 'NATIVE_APP' as const;
  // The permission controller's package differs between Android builds; its resource names do not.
  get root() { return $('android=new UiSelector().resourceIdMatches(".*:id/permission_message")'); }
  get allow() { return $('android=new UiSelector().resourceIdMatches(".*:id/permission_allow_button")'); }
  get deny() { return $('android=new UiSelector().resourceIdMatches(".*:id/permission_deny_button")'); }

  // `waitForClickable` exists only for web pages; a native element is waited for by its display. The dialog opens a moment after
  // the connection is adopted, so the first wait is long.
  private press(button: () => ChainablePromiseElement) {
    return this.in(async () => { const element = button(); await element.waitForDisplayed({timeout: 30_000, timeoutMsg: 'The permission dialog did not appear'}); await element.click(); });
  }
  async allowIt() { await this.press(() => this.allow); }
  async denyIt() { await this.press(() => this.deny); }
}
export default new PermissionDialogComponent();
