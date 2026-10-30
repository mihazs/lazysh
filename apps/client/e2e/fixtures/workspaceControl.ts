import {expect,type Page} from '@playwright/test';

/** Reach the real visible workspace control, including compact mobile navigation. */
export async function workspaceControl(page:Page,name:string) {
  const button=page.getByRole('button',{name,exact:true}).first();
  const dialogButton=page.getByRole('dialog').getByRole('button',{name,exact:true}).first();
  await expect.poll(async()=>await dialogButton.isVisible() || await button.isVisible() || await page.locator('.workspace-terminal-focus').isVisible()).toBe(true);
  if(await dialogButton.isVisible())return dialogButton;
  if(await button.isVisible())return button;
  await page.locator('.mobile-tools:visible').click();
  const revealed=page.getByRole('dialog').getByRole('button',{name,exact:true}).first();
  await expect(revealed).toBeVisible();
  return revealed;
}
