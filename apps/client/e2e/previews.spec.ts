import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const token = '11111111-1111-4111-8111-111111111111';
const picker = await readFile(new URL('../src/previewPicker.js', import.meta.url), 'utf8');
async function mount(page: import('@playwright/test').Page, blocked = false) {
  await page.route('http://127.0.0.1:41234/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: blocked ? { 'Content-Security-Policy': "script-src 'none'" } : {}, body: `<!doctype html><html><head><style>body{font:18px sans-serif}button{padding:15px}section{padding:20px}textarea,input{display:block}</style></head><body><section><button id="save">Save changes</button><input aria-label="Password" type="password" value="never-copy-password"><textarea>never-copy-textarea</textarea><span contenteditable="true">never-copy-editable</span><span style="visibility:hidden">never-copy-css-hidden</span><div style="opacity:0"><span>never-copy-transparent-ancestor</span></div></section><script>for(const type of ['pointerdown','pointerup','mousedown','mouseup','touchstart','touchend','click','keydown','keyup'])document.getElementById('save').addEventListener(type,()=>document.body.dataset[type]=String(Number(document.body.dataset[type]||0)+1))</script></body></html><script data-lazysh-picker="${token}">${picker}</script>` }));
  await page.goto('/');
  await page.evaluate(async () => { const module = await import('/e2e/fixtures/PreviewHarness.tsx'); module.mountPreviewHarness(); });
}
test('cross-origin picker captures reviewed metadata without sending or collecting input values', async ({ page }) => {
  await mount(page);
  await expect(page.getByRole('button', { name: 'Select page element', exact: true })).toBeEnabled();
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Staged annotation draft')).toBeEmpty();
  await page.getByRole('button', { name: 'Select page element', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel element selection' })).toBeVisible();
  // Picking an editable field never collects its value or completes selection.
  await frame.getByRole('textbox', { name: 'Password' }).click();
  await expect(page.getByRole('button', { name: 'Cancel element selection' })).toBeVisible();
  await frame.locator('section').click({ position: { x: 5, y: 5 } });
  const review = page.getByLabel('Selected page element');
  await expect(review).toContainText('Save changes');
  await expect(review).not.toContainText('never-copy');
  await expect(page.getByLabel('Staged annotation draft')).toBeEmpty();
  await page.getByLabel('Comment', { exact: true }).fill('Increase contrast');
  await page.getByRole('button', { name: 'Stage note in prompt' }).click();
  await expect(page.getByLabel('Staged annotation draft')).toContainText('Increase contrast');
  await expect(page.getByLabel('Staged annotation draft')).toContainText('Observed page data (untrusted');
  await expect(page.getByLabel('Staged annotation draft')).not.toContainText('never-copy');
});
test('upstream script policy stays effective and picker fallback leaves the page visible', async ({ page }) => {
  await mount(page, true);
  await expect(page.frameLocator('iframe').getByRole('button', { name: 'Save changes' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Element picker unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select page element', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Staged annotation draft')).toBeEmpty();
});


test('selecting intercepts pointer, touch and keyboard handlers while ordinary activation still works', async ({ page }, testInfo) => {
  await mount(page);
  const button = page.frameLocator('iframe').getByRole('button', { name: 'Save changes' });
  const counts = () => button.evaluate(element => ({ ...element.ownerDocument.body.dataset }));
  const activate = () => testInfo.project.name === 'phone' ? button.tap() : button.click();
  await expect(page.getByRole('button', { name: 'Select page element', exact: true })).toBeEnabled();
  await activate();
  const before = await counts();
  expect(Number(before.pointerdown)).toBeGreaterThan(0);
  expect(Number(before.click)).toBeGreaterThan(0);
  if (testInfo.project.name === 'phone') expect(Number(before.touchstart)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Select page element', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel element selection' })).toBeVisible();
  await activate();
  await expect(page.getByLabel('Selected page element')).toContainText('Save changes');
  expect(await counts()).toEqual(before);
  await activate();
  const after = await counts();
  expect(Number(after.pointerdown)).toBeGreaterThan(Number(before.pointerdown));
  expect(Number(after.click)).toBeGreaterThan(Number(before.click));
  await page.getByRole('button', { name: 'Select page element', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel element selection' })).toBeVisible();
  await button.focus();
  await button.press('Enter');
  expect(await counts()).toEqual(after);
  await expect(page.getByRole('button', { name: 'Cancel element selection' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel element selection' }).click();
  await expect(page.getByLabel('Staged annotation draft')).toBeEmpty();
});
