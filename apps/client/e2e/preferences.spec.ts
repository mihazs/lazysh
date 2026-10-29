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
    const contrast = await page.getByRole('dialog').evaluate(element => {
      const context = document.createElement('canvas').getContext('2d')!;
      function rgba(color: string) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data).map(n => n / 255);
      }
      function luminance(rgb: number[]) {
        const [r, g, b] = rgb.map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
        return .2126 * r + .7152 * g + .0722 * b;
      }
      return Array.from(element.querySelectorAll('h2, p, label, input:not([type=checkbox]), select, button')).filter(child => child.checkVisibility() && getComputedStyle(child).opacity === '1').map(child => {
        let background = [1, 1, 1];
        const ancestors: Element[] = [];
        for (let node: Element | null = child; node; node = node.parentElement) ancestors.unshift(node);
        for (const node of ancestors) {
          const [r, g, b, alpha] = rgba(getComputedStyle(node).backgroundColor);
          background = [r, g, b].map((c, i) => c * alpha + background[i] * (1 - alpha));
        }
        const bg = luminance(background);
        const fg = luminance(rgba(getComputedStyle(child).color).slice(0, 3));
        return {text: child.textContent?.slice(0, 80), tag: child.tagName, ratio: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05)};
      });
    });
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
