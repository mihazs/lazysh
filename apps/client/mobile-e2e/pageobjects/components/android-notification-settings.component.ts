import {$} from '@wdio/globals';
import Page from '../page';
import SideMenu from './side-menu.component';

/** Preferences, Android notifications: the way back to the system's notification settings for the app. */
class AndroidNotificationSettingsComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Android notifications'); }
  get category() { return $('button=Android notifications'); }
  get openSystemSettings() { return $('aria/Open Android notification settings'); }

  /** Opens the page the way a phone user does: the side menu, Connections, Preferences, then the category. */
  async open() {
    await SideMenu.openByEdgeSwipe();
    await SideMenu.showConnections();
    await this.tap(() => $('aria/Preferences'));
    await this.tap(() => this.category);
  }
  async openAndroidSettings() { await this.tap(() => this.openSystemSettings); }
}
export default new AndroidNotificationSettingsComponent();
