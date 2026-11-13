import type {Page} from '@playwright/test';

/** Connects a synthetic host by its name with a password; on a phone the host list sits behind its own button. */
export async function connectHost(page:Page,name:string,phone:boolean) {
  await page.goto('/');
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:`Connect to ${name}`,exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-entry');await page.getByRole('button',{name:'Connect',exact:true}).click();
}
