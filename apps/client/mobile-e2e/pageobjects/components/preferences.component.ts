import {$, browser} from '@wdio/globals';
import Page from '../page';
import SideMenu from './side-menu.component';

/** Preferences, reached from the terminal as a phone user does: the left edge opens the side menu, whose Connections page lists it. */
class PreferencesComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Close Preferences'); }
  get privateKeyboard() { return $('aria/Private keyboard in the terminal'); }
  get resetPreferences() { return $('aria/Reset preferences'); }

  /** Opens Preferences on `category` (its title in the list, for example "Keyboard and gestures"). */
  async open(category: string) {
    await SideMenu.openByEdgeSwipe();
    await SideMenu.showConnections();
    await this.tap(() => $('aria/Preferences'));
    await this.tap(() => $(`button=${category}`));
  }
  /** Leaves Preferences, which closes the side menu behind it too, back to the terminal. */
  async close() {
    await this.tap(() => this.root);
    await this.in(() => SideMenu.root.waitForDisplayed({reverse: true, withinViewport: true, timeoutMsg: 'The side menu stayed open after Preferences closed'}));
  }

  isPrivateKeyboardOn() { return this.in(async () => { await this.privateKeyboard.waitForDisplayed(); return this.privateKeyboard.isSelected(); }); }
  /** Switches the setting to `on` through its checkbox; a checkbox already in that state is left alone. */
  async setPrivateKeyboard(on: boolean) {
    if (await this.isPrivateKeyboardOn() !== on) await this.tap(() => this.privateKeyboard);
    await this.in(() => browser.waitUntil(async () => await this.privateKeyboard.isSelected() === on, {timeoutMsg: `Private keyboard did not become ${on ? 'on' : 'off'}`}));
  }
  async reset() { await this.tap(() => this.resetPreferences); }
}
export default new PreferencesComponent();
