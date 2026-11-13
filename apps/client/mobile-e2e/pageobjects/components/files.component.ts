import {$} from '@wdio/globals';
import Page from '../page';
import SideMenu from './side-menu.component';

/** Files: the remote file explorer of the connected session, with its directory box, listing and file actions. */
class FilesComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Remote files'); }
  get directory() { return $('aria/Remote directory'); }
  get openDirectory() { return $('aria/Open'); }
  get download() { return $('aria/Download'); }
  // The page has other alerts: this is the one inside the Remote files region.
  get alert() { return $('[aria-label="Remote files"] [role="alert"]'); }
  /** An entry of the listing; its button reads "name size", so the name is matched as the start of its text. */
  entry(name: string) { return $(`button*=${name}`); }
  /** The line the app shows once the file is saved: "Saved to <location>." */
  get saved() { return $('//*[@role="status"][contains(., "Saved to")]'); }

  /** From the terminal the way a phone user goes: the side menu, Workspaces, then Files. */
  async show() {
    await SideMenu.openByEdgeSwipe();
    await this.tap(() => $('aria/Workspaces'));
    await this.tap(() => $('aria/Files'));
  }
  /** Types a path in the directory box and opens it. */
  async goTo(path: string) { await this.enter(() => this.directory, path); await this.tap(() => this.openDirectory); }
  async choose(name: string) { await this.tap(() => this.entry(name)); }
  async startDownload() { await this.tap(() => this.download); }
}
export default new FilesComponent();
