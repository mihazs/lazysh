import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../pageobjects/connect-owned-host';
import Toolbar from '../../pageobjects/components/toolbar.component';
import Terminal from '../../pageobjects/terminal.page';
import {resetApp} from '../../support/app';
import {loadData} from '../../support/data';
import {readEndpoint, runNonce} from '../../support/hosts';

declare global {
  interface Window {
    ownedTerminalKeyTrace?: {stop: AbortController; events: string[]};
  }
}

describe('Terminal input and output', () => {
  let name: string;
  before(async () => { name = await connectOwnedHost(); });
  after(resetApp);

  it('runs a command typed on the soft keyboard and ended with the toolbar Enter, then shows its output and the next prompt', async () => {
    const {echo} = await loadData<{echo: {command: string; expected: string}}>('commands', runNonce());
    const {prompt} = await readEndpoint();
    await Terminal.in(() => browser.execute(() => {
      const stop = new AbortController(), events: string[] = [];
      window.ownedTerminalKeyTrace = {stop, events};
      const record = (event: KeyboardEvent | InputEvent) => {
        if (events.length < 192 && event.target instanceof Element && event.target.closest('.terminal-pane')) {
          events.push(event instanceof KeyboardEvent ? `key:${event.key}` : `edit:${event.inputType}:${event.data?.slice(0, 16) ?? ''}`);
        }
      };
      const options = {capture: true, signal: stop.signal};
      document.addEventListener('keydown', record, options);
      document.addEventListener('beforeinput', record, options);
    }));
    let passed = false;
    try {
      await Terminal.type(name, echo.command);
      await Toolbar.press('enter');
      // The echoed command line holds `E2E_%s_END`, so the expected text can only come from the command's own output.
      await Terminal.in(() => expect(Terminal.screen(name)).toHaveText(expect.stringMatching(new RegExp(`${echo.expected}\\s*${prompt}`))));
      passed = true;
    } finally {
      const trace = await Terminal.in(() => browser.execute(() => {
        const trace = window.ownedTerminalKeyTrace;
        trace?.stop.abort();
        delete window.ownedTerminalKeyTrace;
        const canvas = document.querySelector('.terminal-canvas');
        const backend = canvas?.getAttribute('data-terminal-surface') ?? (canvas?.querySelector('.xterm-screen') ? 'xterm' : 'unknown');
        return {backend, events: trace?.events ?? []};
      })).catch(() => undefined);
      if (!passed) console.info('Owned terminal input trace', JSON.stringify(trace));
    }
  });
});
