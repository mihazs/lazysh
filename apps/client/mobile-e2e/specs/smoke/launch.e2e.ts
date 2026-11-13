import {browser, expect} from '@wdio/globals';
import Home from '../../pageobjects/home.page';

describe('Launch', () => {
  it('shows the app title in the WebView of a fresh install', async () => {
    await Home.in(() => expect(browser).toHaveTitle('lazysh'));
  });

  it('reaches the empty home with an invitation to add the first host', async () => {
    await Home.in(() => expect(Home.addFirstHost).toBeDisplayed());
  });
});
