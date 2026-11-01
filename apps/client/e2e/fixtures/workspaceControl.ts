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

/** Open the visible category through its ordinary disclosure, in the current locale. */
export async function openPreferenceCategory(page: Page, category: 'Language'|'Appearance'|'Terminal'|'Input'|'Reset'|'Connections'|'Security'|'Notifications') {
  const label=await page.evaluate(async category=>{const {t}=await import('/src/i18n/core.ts');return t(`preferencesCategory${category}`);},category);
  const summary=page.locator('.preferences-category > summary').filter({hasText:label});
  if(!await summary.evaluate(node=>(node.parentElement as HTMLDetailsElement).open))await summary.click();
}

export async function openThemeImport(page: Page) {
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Appearance');
  await page.getByText('Import and share theme',{exact:true}).click();
}

export async function openAgentSetup(page: Page) {
  const label=await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return t('agentsSetupAction');});
  const button=page.getByRole('button',{name:label,exact:true});
  if(await button.getAttribute('aria-expanded')!=='true')await button.click();
}
