import { expect, test } from '@playwright/test';
import { installNativeBridge } from './fixtures/nativeBridge';

// The screen-reader mirror (#1329) in a real browser's accessibility tree. jsdom has none: it cannot tell a region a
// screen reader reaches from one it does not (`display: none` and `aria-hidden` remove a node from the tree, clipping does not).
// The page is the benchmark page with the mirror mounted on the session's adapter, as a native backend would while the preference is on.
test.skip(({ isMobile }) => isMobile, 'One viewport is enough.');
test.beforeEach(async ({ page }) => {
  await installNativeBridge(page, { reason: 'Synthetic fixture.', generation: '1' });
  await page.addInitScript(() => { window.nativeFixtureInvoke = async command => (command.startsWith('plugin:event|') ? 1 : undefined); });
  await page.goto('/bench/terminal-bench.html?write=adapter&mirror=on');
  await page.waitForFunction(() => !!window.terminalBench);
  await page.evaluate(() => window.terminalBench.open());
});

test('the visible rows are a list in the accessibility tree and new output is announced in a log', async ({ page }) => {
  await page.evaluate(() => window.terminalBench.write('first line\r\nsecond line\r\n'));
  const rows = page.getByRole('list', { name: 'Terminal screen text' });
  await expect(rows.getByRole('listitem').filter({ hasText: /^first line$/ })).toHaveCount(1);
  await expect(rows.getByRole('listitem').filter({ hasText: /^second line$/ })).toHaveCount(1);
  // The cursor row is marked; its text is empty after the last newline.
  await expect(rows.locator('[aria-current=location]')).toHaveCount(1);

  await page.evaluate(() => window.terminalBench.write('third line\r\n'));
  const log = page.getByRole('log');
  await expect(log).toContainText('third line');
  // Announced once: a later, unrelated settle does not repeat it.
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.terminalBench.write('fourth line\r\n'));
  await expect(log).toContainText('fourth line');
  expect(await log.getByText('third line').count()).toBe(1);
});

test('the region is invisible and inert on screen yet exposed to assistive technology', async ({ page }) => {
  await page.evaluate(() => window.terminalBench.write('hello\r\n'));
  const list = page.getByRole('list', { name: 'Terminal screen text' });
  await expect(list).toHaveCount(1);
  const region = list.locator('xpath=..');
  expect(await region.evaluate(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { width: box.width, height: box.height, pointerEvents: style.pointerEvents, display: style.display, visibility: style.visibility };
  })).toEqual({ width: 1, height: 1, pointerEvents: 'none', display: 'block', visibility: 'visible' });
  expect(await page.getByRole('list', { name: 'Terminal screen text' }).getByRole('listitem').first().evaluate(element => element.closest('[aria-hidden=true]'))).toBeNull();
});
