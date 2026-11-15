import {expect} from '@wdio/globals';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import Toolbar from '../../pageobjects/components/toolbar.component';
import Terminal from '../../pageobjects/terminal.page';
import {resetApp} from '../../support/app';
import {loadData} from '../../support/data';
import {readEndpoint, runNonce} from '../../support/hosts';

describe('Terminal input and output', () => {
  let name: string;
  before(async () => { name = await connectOwnedHost(); });
  after(resetApp);

  it('runs a command typed on the soft keyboard and ended with the toolbar Enter, then shows its output and the next prompt', async () => {
    const {echo} = await loadData<{echo: {command: string; expected: string}}>('commands', runNonce());
    const {prompt} = await readEndpoint();
    await Terminal.type(name, echo.command);
    await Toolbar.press('enter');
    // The echoed command line holds `E2E_%s_END`, so the expected text can only come from the command's own output.
    await Terminal.in(() => expect(Terminal.screen(name)).toHaveText(expect.stringMatching(new RegExp(`${echo.expected}\\s*${prompt}`))));
  });
});
