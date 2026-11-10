import {workspaceControl,openPreferenceCategory,closePreferences} from './workspaceControl';
import type {Page} from '@playwright/test';

/** Select through real Preferences before mounting a feature acceptance fixture. */
export async function openLocalizedApp(page: Page, locale: string) {
  const external:string[]=[];
  page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:1420'))external.push(request.url());});
  await page.goto('/');
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Language');
  await page.getByRole('group',{name:'App language',exact:true}).locator(`input[value="${locale}"]`).check();
  await closePreferences(page);
  return external;
}
