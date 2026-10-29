import { installNativeBridge } from './fixtures/nativeBridge';
import { expect, test, type Page } from '@playwright/test';

async function openSessions(page: Page) {
  for (let index = 0; index < 2; index++) {
    if ((page.viewportSize()?.width ?? 1280) <= 600)
      await page.getByRole('button', {name: 'Open hosts', exact: true}).click();
    await page.getByRole('button', {name: 'Open local terminal', exact: true}).click();
    await expect(page.getByRole('tab', {name: /Local terminal/})).toHaveCount(index + 1);
  }
  await expect(page.locator('.terminal-canvas:visible .xterm-helper-textarea')).toHaveCount(1);
  const trigger = page.getByRole('button', {name: 'Switch terminal session', exact: true});
  expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await trigger.click();
  return page.getByRole('dialog', {name: 'Switch terminal session', exact: true});
}

test.beforeEach(async ({page}) => {
  await installNativeBridge(page, {reason:'Synthetic native access fixture.',generation:'1'});
  await page.addInitScript(() => {
    let connections = 0;
    const sizes: {cols: number; rows: number}[] = [];
    Object.assign(window, {terminalSizes: sizes});
    window.nativeFixtureInvoke = async(command: string, args: Record<string, unknown> = {}) => {
        if (command === 'list_hosts') return [];
        if (command === 'app_icon_status') return {available: false, current: 'unknown', reason: 'Alternate Home Screen icons require iOS; synthetic fixture.'};
        if (command === 'local_capability') return {available: true, reason: 'Synthetic terminal fixture; no shell starts.'};
        if (command === 'local_connect') return {sessionId: `local:fixture-${++connections}`};
        if (command === 'local_resize') { sizes.push(args as {cols: number; rows: number}); return; }
        if (['local_ack', 'local_disconnect'].includes(command)) return;
        if (command.startsWith('plugin:event|')) return 1;
        throw new Error(`Unexpected fixture command: ${command}`);
    };
  });
});

test('list remains default; cards persist across reload and select the exact existing session', async ({page}) => {
  await page.goto('/');
  let dialog = await openSessions(page);
  await expect(dialog.locator('.session-switcher')).toHaveAttribute('data-layout', 'list');
  const choices = dialog.locator('.session-choice');
  await expect(choices).toHaveCount(2);
  const first = await choices.nth(0).boundingBox(), second = await choices.nth(1).boundingBox();
  expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Preferences', exact: true}).click();
  await page.getByRole('combobox', {name: 'Session switcher layout', exact: true}).selectOption('cards');
  await page.keyboard.press('Escape');
  await page.reload();
  dialog = await openSessions(page);
  await expect(dialog.locator('.session-switcher')).toHaveAttribute('data-layout', 'cards');
  await expect(dialog.locator('.session-choice-name').first()).toHaveCSS('display', 'block');
  await expect(dialog.locator('.session-choice-destination').first()).toHaveCSS('display', 'block');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const card = dialog.locator('.session-choice').first();
  if ((page.viewportSize()?.width ?? 1280) > 600) {
    const left = await card.boundingBox(), right = await dialog.locator('.session-choice').nth(1).boundingBox();
    expect(right!.y).toBe(left!.y);
    expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width);
  }
  const bounds = await card.boundingBox();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', {name: /Local terminal/}).nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', {name: /Local terminal/})).toHaveCount(2);
  await page.getByRole('button', {name: 'Switch terminal session', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Switch terminal session'}).locator('.session-choice').first()).toHaveAttribute('aria-current', 'true');
});

test('invalid persisted layout falls back to list and reset clears the cards choice', async ({page}) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('lazysh.preferences.v1', JSON.stringify({version: 1, sessionLayout: '<invalid>'})));
  await page.reload();
  const dialog = await openSessions(page);
  await expect(dialog.locator('.session-switcher')).toHaveAttribute('data-layout', 'list');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Preferences', exact: true}).click();
  const layout = page.getByRole('combobox', {name: 'Session switcher layout', exact: true});
  await layout.selectOption('cards');
  await page.getByRole('button', {name: 'Reset preferences', exact: true}).click();
  await expect(layout).toHaveValue('list');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Switch terminal session', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Switch terminal session'}).locator('.session-switcher')).toHaveAttribute('data-layout', 'list');
});

for (const width of [360, 384, 393, 412]) {
  test(`terminal and special keys fit a ${width}px viewport before and after keyboard-sized shrink`, async ({page}) => {
    await page.setViewportSize({width, height: 844});
    await page.goto('/');
    await openSessions(page);
    await page.keyboard.press('Escape');
    const rows = () => page.evaluate(() => (window as Window & {terminalSizes: {rows: number}[]}).terminalSizes.at(-1)?.rows ?? 0);
    await expect.poll(rows).toBeGreaterThan(0);
    const originalRows = await rows();
    for (const height of [420, 844]) {
      await page.setViewportSize({width, height});
      const canvas = page.locator('.terminal-canvas:visible');
      const keys = page.locator('.terminal-keys:visible');
      await expect(keys).toBeVisible();
      for (const element of [page.locator('.app-viewport'), page.locator('.workspace'), canvas, keys]) {
        const bounds = (await element.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      }
      await expect(keys.getByRole('button', {name: 'esc', exact: true})).toBeInViewport();
      await expect(keys.getByRole('button', {name: 'tab', exact: true})).toBeInViewport();
      if (height === 420) await expect.poll(rows).toBeLessThan(originalRows);
      else await expect.poll(rows).toBe(originalRows);
    }
  });
}

for (const width of [360, 412]) for (const fontSize of [14, 32]) {
  test(`phone composer and special keys preserve fitted terminal rows at ${width}px width and ${fontSize}px text`, async ({page}) => {
    await page.addInitScript(size => localStorage.setItem('lazysh.preferences.v1', JSON.stringify({version: 1, fontSize: size})), fontSize);
    await page.setViewportSize({width, height: 844});
    await page.goto('/');
    await openSessions(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name: 'Compose', exact: true}).click();
    const composer = page.locator('.terminal-compose:visible');
    const naturalHeight = (await composer.boundingBox())!.height;
    for (const height of [420, 844]) {
      await page.setViewportSize({width, height});
      const canvas = page.locator('.terminal-canvas:visible');
      await expect.poll(() => canvas.evaluate(element => {
        const screen = element.querySelector('.xterm-screen')!;
        return screen.clientHeight > 0 && screen.clientHeight <= element.clientHeight;
      })).toBe(true);
      for (const element of [canvas, page.locator('.terminal-keys:visible'), page.getByRole('button', {name: 'esc', exact: true}), page.getByRole('button', {name: 'tab', exact: true})]) {
        const bounds = (await element.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      }
      if (height === 420) {
        await expect.poll(() => composer.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        await page.getByRole('button', {name: 'Close composer', exact: true}).scrollIntoViewIfNeeded();
        await expect(page.getByRole('button', {name: 'Close composer', exact: true})).toBeInViewport();
      } else expect((await composer.boundingBox())!.height).toBe(naturalHeight);
    }
  });
}
