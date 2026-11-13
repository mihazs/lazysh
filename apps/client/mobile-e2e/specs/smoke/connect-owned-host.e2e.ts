import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import Terminal from '../../pageobjects/terminal.page';
import {resetApp} from '../../support/app';
import {readEndpoint} from '../../support/hosts';

describe('Owned SSH host', () => {
  let name: string;
  before(async () => { name = await connectOwnedHost(); });
  after(resetApp);

  it('connects with the generated key and shows the host shell prompt in its terminal', async () => {
    const {prompt} = await readEndpoint();
    await Terminal.in(() => expect(Terminal.screen(name)).toHaveText(expect.stringContaining(prompt)));
  });
});
