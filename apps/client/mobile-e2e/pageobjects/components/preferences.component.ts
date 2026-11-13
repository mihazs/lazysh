import {$, browser} from '@wdio/globals';
import Page from '../page';
import {cssBox, screenBox} from '../../support/geometry';
import {swipe} from '../../support/gestures';

/** Preferences, reached from the terminal as a phone user does: the left edge opens the side menu, whose Connections page lists it. */
class PreferencesComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Close Preferences'); }
  get closeHosts() { return $('aria/Close hosts'); }
  get privateKeyboard() { return $('[data-testid="preferences-private-keyboard"]'); }
  get resetPreferences() { return $('aria/Reset preferences'); }

  /** Opens Preferences on `category` (its title in the list, for example "Keyboard and gestures"). */
  async open(category: string) {
    const area = await screenBox(() => $('aria/Terminal keys'));
    const edge = {x: 3, y: Math.round(area.top / 2)};
    // The edge swipe is now and then taken for a scroll: swipe again while the side menu is not open.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await swipe(edge, {x: Math.round(edge.x + 800), y: edge.y}, 300);
      if (await this.in(() => $('aria/Connections').waitForClickable({timeout: 3000}).then(() => true, () => false))) break;
    }
    await this.tap(() => $('aria/Connections'));
    await this.tap(() => $('aria/Preferences'));
    await this.tap(() => $(`button=${category}`));
  }
  /** Leaves Preferences, which closes the side menu behind it too, back to the terminal. */
  async close() {
    await this.tap(() => this.root);
    // The closed menu stays in the page, slid off screen.
    await browser.waitUntil(async () => {
      const menu = await cssBox(() => this.closeHosts), width = await this.in(() => browser.execute(() => window.innerWidth));
      return menu.right <= 0 || menu.left >= width;
    }, {timeoutMsg: 'The side menu stayed open after Preferences closed'});
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
