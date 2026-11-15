import {expect,test,type Page} from '@playwright/test';

/** Opens the app and its one-click local terminal, from the hosts menu a phone keeps closed. */
export async function openLocalTerminal(page:Page) {
  await page.goto('/');
  if(test.info().project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.getByText('Local PTY')).toBeVisible();
}
