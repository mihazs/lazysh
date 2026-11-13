import {$, browser} from '@wdio/globals';
import Page from '../page';

/** The Connect to <host> dialog and the first-use host key review that follows it. */
class ConnectDialogComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  // `aria/` is an XPath that ChromeDriver cannot evaluate from a scoped element, so these lookups start at the document; `$` is
  // strict and fails on an ambiguous name.
  get root() { return $('[role="dialog"]'); }
  get privateKeyMethod() { return $('aria/Private key'); }
  get identity() { return $('aria/Private key (OpenSSH or PEM)'); }
  get connect() { return $('aria/Connect'); }
  get fingerprint() { return $('[data-testid="host-key-fingerprint"]'); }
  get trust() { return $('aria/Trust key and connect'); }

  /** Pastes the identity from the clipboard, the way a user does, so no key is typed character by character. */
  async pasteIdentity(privateKey: string) {
    await this.tap(() => this.privateKeyMethod);
    await this.tap(() => this.identity);
    await this.in(async () => {
      await browser.setClipboard(Buffer.from(privateKey).toString('base64'), 'plaintext');
      // The paste is delivered asynchronously and now and then not at all: press again only when the field is still empty after
      // a few seconds, and clear the clipboard only once the field holds the key.
      for (let attempt = 1; ; attempt++) {
        await browser.pressKeyCode(279); // KEYCODE_PASTE
        const pasted = await browser.waitUntil(async () => (await this.identity.getValue()).length > 0, {timeout: 3000}).then(() => true, () => false);
        if (pasted) break;
        if (attempt === 3) throw new Error('The identity was not pasted into the field');
      }
      // The key must not outlive the paste: Android's clipboard preview and the keyboard's clipboard strip would show it over the
      // terminal's toolbar for a while, and anything else on the device could read it.
      await browser.setClipboard(Buffer.from('cleared').toString('base64'), 'plaintext');
    });
  }
  async connectWithKey() { await this.closeKeyboard(); await this.tap(() => this.connect); }
  async shownFingerprint() { return this.in(async () => { await this.fingerprint.waitForDisplayed({timeoutMsg: 'The host key review did not appear'}); return this.fingerprint.getText(); }); }
  async trustHostKey() { await this.tap(() => this.trust); }
}
export default new ConnectDialogComponent();
