import {controlContrast} from './fixtures/controlContrast';
import { openGestureSettings, saveAdvancedGesture, expectGestureBinding } from './fixtures/gestureSettings';
import { expect, test } from '@playwright/test';

const fontFile = new URL('./fixtures/LiberationMono-Regular.ttf', import.meta.url).pathname;

async function preferences(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByText('Imported fonts', { exact: true }).click();
}

test('local fonts persist, load under the font CSP, reject bad files, and delete cleanly', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'font') requests.push(request.url()); });
  await page.goto('/');
  await preferences(page);
  await page.evaluate(() => { const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = "font-src 'self' data:"; document.head.append(meta); });
  await page.getByLabel('Import font file').setInputFiles({name: 'invalid.woff2', mimeType: 'font/woff2', buffer: Buffer.from('wOF2invalid font bytes')});
  await expect(page.getByRole('alert')).toContainText('browser rejected');
  await page.getByLabel('Import font file').setInputFiles(fontFile);
  await expect(page.getByRole('button', {name: 'Delete font LiberationMono-Regular.ttf', exact: true})).toBeVisible();
  const select = page.getByRole('combobox', {name: 'Imported terminal font', exact: true});
  const id = await select.locator('option').nth(1).getAttribute('value');
  await select.selectOption(id!);
  await page.getByRole('combobox', {name: 'Imported CJK fallback', exact: true}).selectOption(id!);
  await expect.poll(() => page.evaluate(() => Array.from(document.fonts).some(font => font.family.startsWith('lazysh-font-') && font.status === 'loaded'))).toBe(true);
  await page.reload();
  await preferences(page);
  await expect(page.getByRole('combobox', {name: 'Imported terminal font', exact: true})).toHaveValue(id!);
  await expect(page.getByRole('combobox', {name: 'Imported CJK fallback', exact: true})).toHaveValue(id!);
  await expect.poll(() => page.evaluate(() => Array.from(document.fonts).filter(font => font.family.startsWith('lazysh-font-') && font.status === 'loaded').length)).toBe(2);
  expect(requests).toEqual([]);
  await page.getByRole('button', {name: 'Delete font LiberationMono-Regular.ttf', exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Imported terminal font', exact: true})).toHaveValue('');
  await expect(page.getByRole('combobox', {name: 'Imported CJK fallback', exact: true})).toHaveValue('');
  await expect.poll(() => page.evaluate(() => Array.from(document.fonts).filter(font => font.family.startsWith('lazysh-font-')).length)).toBe(0);
});

test('font count is bounded and missing selections report fallback explicitly', async ({ page }) => {
  await page.goto('/');
  await preferences(page);
  for (let count = 1; count <= 4; count++) {
    await page.getByLabel('Import font file').setInputFiles(fontFile);
    await expect(page.getByRole('button', {name: 'Delete font LiberationMono-Regular.ttf', exact: true})).toHaveCount(count);
  }
  await page.getByLabel('Import font file').setInputFiles(fontFile);
  await expect(page.getByRole('alert')).toContainText('at most 4');
  await page.evaluate(() => localStorage.setItem('lazysh.device-fonts.v1', JSON.stringify({primary: '00000000-0000-0000-0000-000000000000'})));
  await page.reload();
  await preferences(page);
  await expect(page.getByRole('status').filter({hasText: 'font is missing on this device'})).toBeVisible();
  await page.getByRole('button', {name: 'Delete all imported fonts'}).click();
  await expect(page.getByRole('button', {name: 'Delete font LiberationMono-Regular.ttf', exact: true})).toHaveCount(0);
});

test('brand, light and dark themes keep controls readable and reset', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Preferences', exact: true}).click();
  const appTheme = page.getByRole('combobox', {name: 'App theme', exact: true});
  await expect(appTheme.locator('option[value="forest"]')).toHaveText('lazysh');
  await expect(page.getByRole('combobox', {name: 'Terminal theme', exact: true})).toHaveValue('forest');
  for (const theme of ['forest', 'paper', 'midnight']) {
    await appTheme.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-app-theme', theme);
    const contrast = await page.getByRole('dialog').evaluate(controlContrast);
    expect(contrast.filter(item => item.ratio < 4.5), theme).toEqual([]);
    await page.screenshot({path: testInfo.outputPath(`${theme}-preferences.png`)});
  }
  await page.getByRole('button', {name: 'Reset preferences', exact: true}).click();
  await expect(appTheme).toHaveValue('forest');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme', 'forest');
});

test('gesture bindings and advanced chords survive reload and gesture reset preserves the shortcut library', async ({ page }) => {
  await page.goto('/');
  await openGestureSettings(page);
  await saveAdvancedGesture(page, 'Double tap', 'C-b, S-t');
  await page.getByRole('combobox', {name: 'Swipe left', exact: true}).selectOption('nextSession');
  await page.getByRole('combobox', {name: 'D-pad left corner', exact: true}).selectOption('custom');
  await page.getByLabel('D-pad left corner chord', {exact: true}).fill('text:/clear');
  await page.getByRole('button', {name: 'Save D-pad left corner chord', exact: true}).click();
  await page.getByText('Keyboard chords', {exact: true}).click();
  await page.getByLabel('Chord name', {exact: true}).fill('Agent pane');
  await page.getByLabel('Key sequence', {exact: true}).fill('F12, M-h');
  await page.getByRole('button', {name: 'Add chord', exact: true}).click();
  await page.reload();
  await openGestureSettings(page);
  await expectGestureBinding(page, 'Double tap', 'C-b, S-t');
  await expect(page.getByRole('combobox', {name: 'Swipe left', exact: true})).toHaveValue('nextSession');
  await expect(page.getByLabel('D-pad left corner chord', {exact: true})).toHaveValue('text:/clear');
  await page.getByRole('button', {name: 'Reset gestures', exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Double tap', exact: true})).toHaveValue('none');
  await expect(page.getByLabel('Double tap chord', {exact: true})).toHaveCount(0);
  await page.getByText('Keyboard chords', {exact: true}).click();
  await expect(page.getByText('Agent pane: F12, M-h', {exact: true})).toBeVisible();
});

test('explicit Zellij tab and pane gesture actions persist without changing defaults and reset cleanly', async ({page}) => {
  await page.goto('/');
  await openGestureSettings(page);
  const bindings=[['Swipe left','nextZellijTab'],['Swipe right','previousZellijTab'],['Two-finger swipe left','nextZellijPane'],['Two-finger swipe right','previousZellijPane']];
  for(const [label,action] of bindings){
    const select=page.getByRole('combobox',{name:label,exact:true});
    await expect(select).toHaveValue('none');
    await select.selectOption(action);
  }
  await page.reload();
  await openGestureSettings(page);
  for(const [label,action] of bindings) await expect(page.getByRole('combobox',{name:label,exact:true})).toHaveValue(action);
  await expect(page.getByRole('combobox',{name:'Two-finger swipe up',exact:true})).toHaveValue('none');
  await page.getByRole('button',{name:'Reset gestures',exact:true}).click();
  for(const [label] of bindings) await expect(page.getByRole('combobox',{name:label,exact:true})).toHaveValue('none');
});


test('long settings use a mobile page with a persistent close action and short choices stay sheets',async({page},testInfo)=>{
  await page.goto('/'); await preferences(page);
  const dialog=page.getByRole('dialog',{name:'Preferences',exact:true});
  const close=dialog.getByRole('button',{name:'Close Preferences',exact:true});
  const phone=testInfo.project.name==='phone';
  if(phone){
    for(const height of [844,420]){
      await page.setViewportSize({width:393,height});
      const bounds=(await dialog.boundingBox())!;
      expect(bounds.x).toBe(0);expect(bounds.y).toBe(0);expect(bounds.width).toBe(393);expect(bounds.height).toBe(height);
      await dialog.locator('.dialog-content').evaluate(element=>{element.scrollTop=element.scrollHeight;});
      await expect(close).toBeInViewport();
      expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    }
    await page.setViewportSize({width:393,height:844});
  }else{
    const bounds=(await dialog.boundingBox())!; expect(bounds.width).toBe(480);expect(bounds.x).toBeGreaterThan(0);expect(bounds.y).toBeGreaterThan(0);
  }
  await page.screenshot({path:testInfo.outputPath('settings-presentation.png')});
  await close.click(); await page.keyboard.press('Control+k');
  const choices=page.getByRole('dialog',{name:'Jump to a host',exact:true});
  await expect(choices).toBeVisible();
  expect(await choices.locator('..').getAttribute('data-mobile-presentation')).toBe('sheet');
  if(phone){const bounds=(await choices.boundingBox())!;expect(bounds.y).toBeGreaterThan(0);expect(bounds.y+bounds.height).toBeLessThan(844);}
  await page.screenshot({path:testInfo.outputPath('choice-sheet.png')});
  await page.keyboard.press('Escape');await expect(choices).toHaveCount(0);
});
