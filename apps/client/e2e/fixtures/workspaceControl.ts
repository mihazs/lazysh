import {expect,type Page} from '@playwright/test';

/** Reach the real visible workspace control, including compact mobile navigation. */
export async function workspaceControl(page:Page,name:string) {
  const button=page.getByRole('button',{name,exact:true}).first();
  const dialogButton=page.getByRole('dialog').getByRole('button',{name,exact:true}).first();
  await expect.poll(async()=>await dialogButton.isVisible() || await button.isVisible() || await page.locator('.workspace-terminal-focus').isVisible()).toBe(true);
  if(await dialogButton.isVisible())return dialogButton;
  if(await button.isVisible())return button;
  await page.locator('.mobile-tools:visible').click();
  for(const group of ['workspace-more-tools','workspace-connection-actions','workspace-application-options']) {
    const owner=page.getByRole('dialog').locator(`details.${group}`);
    if(await owner.count() && await owner.evaluate((node,name)=>!(node as HTMLDetailsElement).open
      && Array.from(node.querySelectorAll('button')).some(button=>button.textContent?.trim()===name && button.closest('details')===node),name)) {
      await owner.locator(':scope > summary').click();
    }
  }
  const revealed=page.getByRole('dialog').getByRole('button',{name,exact:true}).first();
  await expect(revealed).toBeVisible();
  return revealed;
}

/** Reach the category through the real list/detail navigation, in the current locale. */
export async function openPreferenceCategory(page: Page, category: 'Language'|'Appearance'|'Terminal'|'Input'|'Reset'|'Connections'|'Security'|'Notifications') {
  const label=await page.evaluate(async category=>{const {t}=await import('/src/i18n/core.ts');return t(`preferencesCategory${category}`);},category);
  const navigation=page.locator('.settings-navigation');
  const selected=navigation.locator('[data-settings-page]:visible');
  if(await selected.count() && await selected.getAttribute('aria-label')===label)return;
  const target=navigation.getByRole('button',{name:label,exact:true});
  while(!await target.isVisible())await navigation.getByRole('button',{name:await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return t('navigationBack');}),exact:true}).click();
  await target.click();
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
