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

test('whole-app light and dark themes keep dialog text readable and reset', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Preferences', exact: true}).click();
  await page.getByRole('combobox', {name: 'App theme', exact: true}).selectOption('paper');
  await expect(page.locator('html')).toHaveAttribute('data-app-theme', 'paper');
  const contrast = await page.getByRole('dialog').evaluate(element => {
    function luminance(color: string) {
      const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;});
      return .2126 * r + .7152 * g + .0722 * b;
    }
    const background = luminance(getComputedStyle(element).backgroundColor);
    return Array.from(element.querySelectorAll('h2, p, label, input:not([type=checkbox]), select, button')).filter(child => child.checkVisibility() && getComputedStyle(child).opacity === '1').map(child => {
      const foreground = luminance(getComputedStyle(child).color);
      return {text: child.textContent?.slice(0, 80), tag: child.tagName, color: getComputedStyle(child).color, background: getComputedStyle(element).backgroundColor, ratio: (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05)};
    });
  });
  expect(contrast.filter(item => item.ratio < 4.5)).toEqual([]);
  await page.screenshot({path: testInfo.outputPath('paper-preferences.png')});
  await page.getByRole('combobox', {name: 'App theme', exact: true}).selectOption('midnight');
  await expect(page.locator('html')).toHaveAttribute('data-app-theme', 'midnight');
  await page.getByRole('button', {name: 'Reset preferences', exact: true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme', 'forest');
});

test('gesture bindings and advanced chords survive reload and gesture reset preserves the shortcut library', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Preferences', exact: true}).click();
  await page.getByText('Terminal touch gestures', {exact: true}).click();
  await page.getByRole('combobox', {name: 'Double tap', exact: true}).selectOption('custom');
  await page.getByLabel('Double tap chord', {exact: true}).fill('C-b, S-t');
  await page.getByRole('button', {name: 'Save Double tap chord', exact: true}).click();
  await page.getByRole('combobox', {name: 'Swipe left', exact: true}).selectOption('nextSession');
  await page.getByRole('combobox', {name: 'D-pad left corner', exact: true}).selectOption('custom');
  await page.getByLabel('D-pad left corner chord', {exact: true}).fill('text:/clear');
  await page.getByRole('button', {name: 'Save D-pad left corner chord', exact: true}).click();
  await page.getByText('Keyboard chords', {exact: true}).click();
  await page.getByLabel('Chord name', {exact: true}).fill('Agent pane');
  await page.getByLabel('Key sequence', {exact: true}).fill('F12, M-h');
  await page.getByRole('button', {name: 'Add chord', exact: true}).click();
  await page.reload();
  await page.getByRole('button', {name: 'Preferences', exact: true}).click();
  await page.getByText('Terminal touch gestures', {exact: true}).click();
  await expect(page.getByLabel('Double tap chord', {exact: true})).toHaveValue('C-b, S-t');
  await expect(page.getByRole('combobox', {name: 'Swipe left', exact: true})).toHaveValue('nextSession');
  await expect(page.getByLabel('D-pad left corner chord', {exact: true})).toHaveValue('text:/clear');
  await page.getByRole('button', {name: 'Reset gestures', exact: true}).click();
  await expect(page.getByRole('combobox', {name: 'Double tap', exact: true})).toHaveValue('none');
  await expect(page.getByLabel('Double tap chord', {exact: true})).toHaveCount(0);
  await page.getByText('Keyboard chords', {exact: true}).click();
  await expect(page.getByText('Agent pane: F12, M-h', {exact: true})).toBeVisible();
});
