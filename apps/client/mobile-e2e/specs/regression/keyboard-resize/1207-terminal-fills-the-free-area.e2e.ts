/**
 * #1207 The terminal no longer filled the free area: margins and chrome wasted space (fixed in #1212; epic #1396, issue #1403).
 *
 * `e2e/terminal-fills-pane.spec.ts` measures a mocked terminal in a browser. On the device the PTY size is what the host's shell
 * sees (`stty size`), so the grid, the free area and the host's idea of the terminal can all be compared, with the keyboard
 * closed and open and back.
 */
import {browser, expect} from '@wdio/globals';
import {connectOwnedHost} from '../../../pageobjects/connect-owned-host';
import Terminal from '../../../pageobjects/terminal.page';
import Toolbar from '../../../pageobjects/components/toolbar.component';
import {resetApp} from '../../../support/app';
import {keyboardShown} from '../../../support/softKeyboard';

/** The terminal's grid against the free area it may use (the screen down to the toolbar), and the PTY the host reports. */
async function measure(name: string) {
  const {grid, rows, viewport} = await Terminal.grid();
  const toolbarTop = await Toolbar.in(async () => browser.execute(node => node.getBoundingClientRect().top, await Toolbar.root));
  const row = (rows[rows.length - 1].bottom - rows[0].top) / rows.length;
  return {grid, rows: rows.length, row, viewport, toolbarTop, pty: await Terminal.ptySize(name)};
}

/** Waits until the layout has settled in the given keyboard state: the rows that fit are the rows the host was told. */
async function settled(name: string, open: boolean) {
  await browser.waitUntil(async () => await keyboardShown() === open, {timeoutMsg: `The soft keyboard did not ${open ? 'open' : 'close'}`});
  let latest = await measure(name);
  await browser.waitUntil(async () => { latest = await measure(name); return latest.pty?.rows === latest.rows; })
    .catch(() => { throw new Error(`The host was never told the size the terminal drew: ${JSON.stringify({drawn: latest.rows, told: latest.pty})}`); });
  return latest;
}

describe('#1207 the terminal fills the free area', () => {
  let name: string;
  before(async () => { name = await connectOwnedHost(); });
  after(resetApp);

  it('edge to edge with the keyboard open and closed, with the host told how many rows fit', async () => {
    await Terminal.tapScreen(name);
    await Terminal.watchPtySize();
    const open = await settled(name, true);
    await Toolbar.press('Toggle keyboard');
    const closed = await settled(name, false);
    for (const state of [open, closed]) {
      expect(state.grid.left).toBeLessThanOrEqual(1);
      expect(state.grid.top).toBeLessThanOrEqual(1);
      // A classic scrollbar may take a few pixels at the right; the grid still reaches within a cell of it.
      expect(state.viewport.width - state.grid.right).toBeLessThan(state.row);
      // No chrome gap: less than one row of unused space between the grid and the toolbar.
      expect(state.toolbarTop - state.grid.bottom).toBeLessThan(state.row);
      expect(state.grid.bottom).toBeLessThanOrEqual(state.toolbarTop + 0.5);
    }
    expect(open.rows).toBeLessThan(closed.rows);
    expect(open.pty!.rows).toBeLessThan(closed.pty!.rows);
    // Closing and opening again must give back the same rows: nothing is left over from the other state.
    await Toolbar.press('Toggle keyboard');
    expect((await settled(name, true)).rows).toBe(open.rows);
  });
});
