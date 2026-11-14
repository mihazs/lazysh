import {browser, expect} from '@wdio/globals';
import Home from '../../pageobjects/home.page';
import SystemDialog from '../../pageobjects/components/system-dialog.component';

describe('Launch', () => {
  it('starts a fresh install into the empty home, with no crash dialog and the app WebView available', async () => {
    await SystemDialog.in(() => expect(SystemDialog.root).not.toBeExisting());
    await Home.in(async () => {
      await expect(browser).toHaveTitle('lazysh');
      await expect(Home.addFirstHost).toBeDisplayed();
    });
  });
});
