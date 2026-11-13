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
      await browser.pressKeyCode(279); // KEYCODE_PASTE
    });
  }
  async connectWithKey() { await this.closeKeyboard(); await this.tap(() => this.connect); }
  /** Signs in with the identity; a host whose key is already trusted connects here without the host key review. */
  async signIn(privateKey: string) { await this.pasteIdentity(privateKey); await this.connectWithKey(); }
  // The review appears after the SSH handshake, which a loaded guest can take a while to finish.
  async shownFingerprint() { return this.in(async () => { await this.fingerprint.waitForDisplayed({timeout: 30_000, timeoutMsg: 'The host key review did not appear'}); return this.fingerprint.getText(); }); }
  async trustHostKey() { await this.tap(() => this.trust); }
}
export default new ConnectDialogComponent();
