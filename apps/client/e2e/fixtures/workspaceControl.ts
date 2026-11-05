import {expect,type Page} from '@playwright/test';

/** Reach the real visible workspace control, including compact mobile navigation. */
export async function workspaceControl(page:Page,name:string) {
  const button=page.getByRole('button',{name,exact:true}).first();
  const dialogButton=page.getByRole('dialog').getByRole('button',{name,exact:true}).first();
  await expect.poll(async()=>await dialogButton.isVisible() || await button.isVisible() || await page.locator('.workspace-tools-trigger:visible').isVisible()).toBe(true);
  if(await dialogButton.isVisible())return dialogButton;
  const menu=page.getByRole('dialog').filter({has:page.locator('.workspace-tools-content')});
  if(!await menu.isVisible()) {
    if(await button.isVisible())return button;
    await page.locator('.workspace-tools-trigger:visible').click();
  }
  await openToolsPageWith(page,name);
  const revealed=menu.getByRole('button',{name,exact:true}).first();
  await expect(revealed).toBeVisible();
  return revealed;
}

/** Swipe-free page change: select the Workspace tools page that owns the named action. */
export async function openToolsPageWith(page:Page,name:string) {
  const menu=page.getByRole('dialog').filter({has:page.locator('.workspace-tools-content')});
  const owner=await menu.locator('.workspace-tools-page').evaluateAll((pages,name)=>pages.find(node=>
    Array.from(node.querySelectorAll('button')).some(button=>button.textContent?.trim()===name||button.getAttribute('aria-label')===name))?.id??'',name);
  if(!owner)return;
  const tab=menu.locator(`[role=tab][aria-controls="${owner}"]`);
  if(await tab.count()&&await tab.getAttribute('aria-selected')!=='true')await tab.click();
  const shown=menu.locator(`#${owner}`);
  await expect(shown).not.toHaveAttribute('aria-hidden','true');
  // Settle the page turn first; scrolling a control into view mid-turn would choose another page.
  await expect.poll(()=>shown.evaluate(node=>Math.abs(node.getBoundingClientRect().left-node.parentElement!.getBoundingClientRect().left)<2)).toBe(true);
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

/** Exit the complete settings task, rather than navigating to its parent category. */
export async function closePreferences(page:Page) {
  const labels=await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return {title:t('appPreferences'),close:t('appCloseValue1',{value1:t('appPreferences')})};});
  const dialog=page.getByRole('dialog',{name:labels.title,exact:true});
  await dialog.getByRole('button',{name:labels.close,exact:true}).click();
  await expect(dialog).toHaveCount(0);
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
