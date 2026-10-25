import { expect, test } from '@playwright/test';

test('host actions remain reachable by touch and keyboard without connecting', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isTauri', {value:true});
    let hosts = [{id:'fixture-host', name:'Touch workstation', hostname:'fixture.invalid', username:'test', port:22}];
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === 'list_hosts') return hosts;
        if (command === 'local_capability') return {available:false, reason:'Test fixture'};
        if (command === 'delete_host') { hosts=[]; return; }
        if (command.startsWith('plugin:event|')) return 1;
        throw new Error(`Unexpected native command: ${command}`);
      },
    } });
  });
  await page.goto('/');
  const phone = testInfo.project.name === 'phone';
  if (phone) await page.getByRole('button', {name:'Open hosts', exact:true}).tap();
  const connect = page.getByRole('button', {name:'Connect to Touch workstation', exact:true});
  await expect(connect).toBeVisible();
  if (!phone) await connect.focus();
  const edit = page.getByRole('button', {name:'Edit Touch workstation', exact:true});
  const remove = page.getByRole('button', {name:'Delete Touch workstation', exact:true});
  await expect(edit).toBeVisible();
  await expect(remove).toBeVisible();
  if (phone) {
    for (const button of [edit, remove]) {
      const bounds = await button.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await remove.tap();
  } else {
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(remove).toBeFocused();
    await page.keyboard.press('Enter');
  }
  const dialog = page.getByRole('dialog', {name:'Delete host', exact:true});
  await expect(dialog).toBeVisible();
  await expect(connect).toHaveCount(1);
  await dialog.getByRole('button', {name:'Delete host', exact:true}).click();
  await expect(connect).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
