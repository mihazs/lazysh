import {$, $$} from '@wdio/globals';
import Page from '../page';

export type NavigationTab = 'Agents' | 'Workspaces' | 'Connections';

/** The three entries at the top of the navigation page: Agents, Workspaces and Connections. */
class NavigationTabsComponent extends Page {
  readonly context = 'WEBVIEW' as const;
  get root() { return $('aria/Workspace navigation'); }

  /** Each tab with the name it shows, left to right as a person reads them, and whether the page is open on it. */
  private tabs() {
    return this.in(async () => {
      await this.root.waitForDisplayed();
      // A scoped lookup from an element found by `aria/` is not supported, so the buttons are found from the document.
      const tabs: {name: NavigationTab; current: boolean}[] = [];
      for (const button of await $$('[aria-label="Workspace navigation"] button')) {
        tabs.push({name: (await button.getText()).trim() as NavigationTab, current: await button.getAttribute('aria-current') === 'page'});
      }
      return tabs;
    });
  }
  async order(): Promise<NavigationTab[]> { return (await this.tabs()).map(tab => tab.name); }
  /** The tab the page is open on, which is the one marked as the current page. */
  async current(): Promise<NavigationTab | undefined> { return (await this.tabs()).find(tab => tab.current)?.name; }
}
export default new NavigationTabsComponent();
