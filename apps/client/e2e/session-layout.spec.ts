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
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isTauri', {value: true});
    let connections = 0;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {value: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === 'app_lock_status') return {initialized: true, supported: false, reason: 'Synthetic native access fixture.', enabled: false, locked: false, generation: '1'};
        if (['app_lock_ready', 'adopt_session'].includes(command)) return;
        if (command === 'list_hosts') return [];
        if (command === 'local_capability') return {available: true, reason: 'Synthetic terminal fixture; no shell starts.'};
        if (command === 'local_connect') return {sessionId: `local:fixture-${++connections}`};
        if (['local_resize', 'local_ack', 'local_disconnect'].includes(command)) return;
        if (command.startsWith('plugin:event|')) return 1;
        throw new Error(`Unexpected fixture command: ${command}`);
      },
    }});
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
