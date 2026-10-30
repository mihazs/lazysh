import {workspaceControl} from './workspaceControl';
import {expect, type Page} from '@playwright/test';
export async function openGestureSettings(page: Page) {
  await (await workspaceControl(page,'Preferences')).click();
  await page.getByText('Terminal touch gestures',{exact:true}).click();
}
export async function saveAdvancedGesture(page: Page, slot: string, keys: string) {
  await page.getByRole('combobox',{name:slot,exact:true}).selectOption('custom');
  await page.getByLabel(`${slot} chord`,{exact:true}).fill(keys);
  await page.getByRole('button',{name:`Save ${slot} chord`,exact:true}).click();
}
export async function expectGestureBinding(page: Page, slot: string, keys: string) {
  await expect(page.getByLabel(`${slot} chord`,{exact:true})).toHaveValue(keys);
}
