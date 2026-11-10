import {workspaceControl} from './fixtures/workspaceControl';
import {expect, test, type Locator, type Page} from '@playwright/test';

const name=(row:Locator)=>row.evaluate(node=>document.getElementById(node.getAttribute('aria-labelledby')??'')?.textContent??'');
const value=(row:Locator)=>row.evaluate(node=>document.getElementById(node.getAttribute('aria-describedby')??'')?.textContent??null);
/** Opens Preferences and returns its dialog, search field and search results. */
async function openSearch(page:Page) {
  await page.goto('/');
  await (await workspaceControl(page,'Preferences')).click();
  const dialog=page.getByRole('dialog',{name:'Preferences',exact:true});
  return {dialog,search:dialog.getByRole('searchbox',{name:'Search settings',exact:true}),results:dialog.getByRole('navigation',{name:'Search results',exact:true})};
}

test('Preferences opens a grouped list whose rows preview values and lead into sub-pages and back',async({page},testInfo)=>{
  await page.goto('/');
  await (await workspaceControl(page,'Preferences')).click();
  const dialog=page.getByRole('dialog',{name:'Preferences',exact:true});
  const index=dialog.locator('.settings-index');
  await expect(dialog.getByRole('button',{name:'Close Preferences',exact:true})).toBeFocused();
  expect(await index.locator('.settings-section-title').allTextContents()).toEqual(['Terminal','Input','Agents and notifications','Security and sync','General','Help']);
  const section=(title:string)=>index.getByRole('navigation',{name:title,exact:true});
  const rows=async(title:string)=>Promise.all((await section(title).getByRole('button').all()).map(name));
  expect(await rows('Terminal')).toEqual(['Appearance and fonts','Terminal and accessibility']);
  expect(await rows('Input')).toEqual(['Keyboard and gestures']);
  expect(await rows('Agents and notifications')).toEqual(['Notifications','Notification inbox','Agents','Dictate']);
  expect(await rows('Security and sync')).toEqual(['Security and app lock','Encrypted sync']);
  expect(await rows('General')).toEqual(['Language and region','Shareable uploads']);
  expect(await rows('Help')).toEqual(['About lazysh']);
  const appearance=index.getByRole('button',{name:'Appearance and fonts',exact:true});
  expect(await value(appearance)).toBe('lazysh · 14 px');
  expect(await value(index.getByRole('button',{name:'Terminal and accessibility',exact:true}))).toBe('bar · 5,000 lines');
  expect(await value(index.getByRole('button',{name:'Language and region',exact:true}))).toBe('System');
  const agents=index.getByRole('button',{name:'Agents',exact:true});
  await expect(agents).toBeDisabled();
  expect(await value(agents)).toBe('Open a session first');
  await agents.focus();await expect(agents).toBeFocused();
  await agents.dispatchEvent('click');await expect(dialog).toBeVisible();
  expect(await value(index.getByRole('button',{name:'Encrypted sync',exact:true}))).toBe('Desktop and mobile apps only');
  expect(await index.getByRole('region').count()).toBe(0);
  await expect(index.getByRole('button',{name:'Reset settings',exact:true})).toHaveAttribute('data-tone','danger');
  await expect(index.getByText(/^lazysh \d+\.\d+\.\d+/)).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('settings-root.png')});

  await index.getByRole('button',{name:'Terminal and accessibility',exact:true}).click();
  const terminal=dialog.locator('[data-settings-page="terminal"]');
  await expect(terminal.getByRole('heading',{name:'Terminal and accessibility',level:2})).toBeFocused();
  expect(await terminal.locator('h3.settings-group-title').allTextContents()).toEqual(['Cursor and history','Accessibility']);
  await page.screenshot({path:testInfo.outputPath('settings-terminal.png')});
  await terminal.getByRole('radio',{name:'block',exact:true}).check();
  await expect(terminal.getByRole('radio',{name:'block',exact:true})).toBeChecked();
  await terminal.getByRole('radio',{name:'block',exact:true}).press('ArrowRight');
  await expect(terminal.getByRole('radio',{name:'underline',exact:true})).toBeChecked();
  await terminal.getByRole('radio',{name:'block',exact:true}).check();
  await terminal.getByRole('spinbutton',{name:'History lines',exact:true}).fill('1200');
  if(testInfo.project.name==='phone') {
    await expect(index).toBeHidden();
    await dialog.getByRole('button',{name:'Back',exact:true}).click();
  } else {
    await expect(index).toBeVisible();
    await expect(index.getByRole('button',{name:'Terminal and accessibility',exact:true})).toHaveAttribute('aria-current','page');
    await page.keyboard.press('Escape');
  }
  await expect(index.getByRole('button',{name:'Terminal and accessibility',exact:true})).toBeFocused();
  expect(await value(index.getByRole('button',{name:'Terminal and accessibility',exact:true}))).toBe('block · 1,200 lines');

  await index.getByRole('button',{name:'Keyboard and gestures',exact:true}).click();
  const input=dialog.locator('[data-settings-page="input"]');
  await expect(input.getByRole('checkbox',{name:'Use Option as Meta on macOS',exact:true})).toBeVisible();
  await input.getByRole('button',{name:'Text snippets',exact:true}).click();
  await expect(dialog.getByRole('heading',{name:'Text snippets',level:2})).toBeFocused();
  await dialog.getByRole('button',{name:'Back',exact:true}).click();
  await expect(input.getByRole('button',{name:'Text snippets',exact:true})).toBeFocused();
  await dialog.getByRole('button',{name:'Back',exact:true}).click();
  await expect(index.getByRole('button',{name:'Keyboard and gestures',exact:true})).toBeVisible();
  await expect(dialog.locator('[data-settings-page]:visible')).toHaveCount(0);

  await index.getByRole('button',{name:'About lazysh',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('dialog',{name:'About lazysh',exact:true})).toBeVisible();
});

test('cursor search focuses the selected segmented option',async({page})=>{
  const {dialog,search,results}=await openSearch(page);
  await search.fill('Cursor');
  await results.getByRole('button',{name:'Cursor',exact:true}).click();
  await expect(dialog.getByRole('radio',{name:'bar',exact:true})).toBeFocused();
});

test('Preferences search finds settings inside sub-pages and opens the matching control',async({page},testInfo)=>{
  const {dialog,search,results}=await openSearch(page);
  await search.fill('history');
  const found=results.getByRole('button',{name:'History lines',exact:true});
  expect(await value(found)).toBe('Terminal and accessibility');
  await expect(dialog.locator('.settings-section-title')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('settings-search.png')});
  await found.click();
  const field=dialog.locator('[data-settings-page="terminal"]').getByRole('spinbutton',{name:'History lines',exact:true});
  await expect(field).toBeFocused();await expect(field).toBeInViewport();

  if(testInfo.project.name==='phone')await dialog.getByRole('button',{name:'Back',exact:true}).click();
  else await search.focus();
  await expect(search).toHaveValue('history');
  await search.fill('cjk');
  await results.getByRole('button',{name:'Imported CJK fallback',exact:true}).click();
  await expect(dialog.locator('[data-settings-page="appearance"] details').filter({has:page.getByText('Imported fonts',{exact:true})})).toHaveAttribute('open','');
  await expect(dialog.getByRole('combobox',{name:'Imported CJK fallback',exact:true})).toBeFocused();

  if(testInfo.project.name==='phone')await dialog.getByRole('button',{name:'Back',exact:true}).click();
  await search.fill('Snippet');
  const snippets=results.getByRole('button',{name:'Text snippets',exact:true});
  expect(await value(snippets)).toBe('Keyboard and gestures › Text snippets');
  await search.fill('no such setting');
  await expect(dialog.locator('.settings-index').getByRole('status')).toHaveText('No settings match “no such setting”.');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.settings-section-title').first()).toHaveText('Terminal');
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});

test('Preferences search reveals every result chosen in turn and Back clears it before closing',async({page},testInfo)=>{
  const {dialog,search,results}=await openSearch(page);
  const appearance=dialog.locator('[data-settings-page="appearance"]');
  const back=()=>page.evaluate(()=>window.dispatchEvent(new Event('lazysh-workspace-back',{cancelable:true})));
  // Phones hide the results while a page is open; wide screens keep them beside the page.
  const toResults=async(row:string)=>{
    if(testInfo.project.name!=='phone')return;
    await back();
    await expect(results.getByRole('button',{name:row,exact:true})).toBeFocused();
  };
  await search.fill('font');
  await expect(dialog.locator('.settings-index').getByRole('status')).toHaveText(/^\d+ settings found$/);
  await results.getByRole('button',{name:'Font size',exact:true}).click();
  await expect(appearance.getByRole('spinbutton',{name:'Font size',exact:true})).toBeFocused();
  await toResults('Font size');
  await results.getByRole('button',{name:'Font family',exact:true}).click();
  await expect(appearance.getByRole('textbox',{name:'Font family',exact:true})).toBeFocused();
  await toResults('Font family');
  const summary=appearance.locator('summary').filter({hasText:/^Imported fonts$/}),imported=summary.locator('..');
  await expect(imported).not.toHaveAttribute('open','');
  await results.getByRole('button',{name:'Imported fonts',exact:true}).click();
  await expect(imported).toHaveAttribute('open','');
  await expect(summary).toBeFocused();
  await expect(summary).toBeInViewport();

  await back();
  await expect(results.getByRole('button',{name:'Imported fonts',exact:true})).toBeFocused();
  await back();
  await expect(search).toHaveValue('');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.settings-section-title').first()).toHaveText('Terminal');
  await back();
  await expect(dialog).toHaveCount(0);
});

test('cursor segments remain touchable and distinguish selection in forced colors', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ forcedColors: 'active' });
  const { dialog } = await openSearch(page);
  await dialog.getByRole('button', { name: 'Terminal and accessibility', exact: true }).click();
  const picker = dialog.getByRole('group', { name: 'Cursor', exact: true });
  const segments = picker.locator('label');
  await expect(segments).toHaveCount(3);
  for (const label of await segments.all()) {
    await expect.poll(async () => (await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const checked = picker.getByRole('radio', { name: 'bar', exact: true });
  await expect(checked).toBeChecked();
  const borders = await segments.evaluateAll(labels => labels.map(label =>
    parseFloat(getComputedStyle(label.querySelector('span')!).borderTopWidth),
  ));
  expect(borders[0]).toBeGreaterThan(borders[1]);
  await dialog.locator('[data-settings-page="terminal"] h2').focus();
  await page.keyboard.press('Tab');
  await expect(checked).toBeFocused();
  expect(await checked.evaluate(input => getComputedStyle(input.nextElementSibling!).outlineStyle)).not.toBe('none');
  expect(await picker.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('language choices are touchable and search focuses the selected radio',async({page})=>{
  await page.setViewportSize({width:320,height:640});
  const {dialog,search,results}=await openSearch(page);
  await search.fill('App language');
  await results.getByRole('button',{name:'App language',exact:true}).click();
  const group=dialog.getByRole('group',{name:'App language',exact:true});
  const selected=group.getByRole('radio',{name:'System',exact:true});
  await expect(selected).toBeChecked();await expect(selected).toBeFocused();
  for(const label of await group.locator('label').all())expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('ArrowDown');
  await expect(group.getByRole('radio',{name:'English',exact:true})).toBeChecked();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).uiLanguage)).toBe('en');
  if((await page.viewportSize())!.width<=600)await dialog.getByRole('button',{name:'Back',exact:true}).click();
  await search.fill('App language');
  await results.getByRole('button',{name:'App language',exact:true}).click();
  await expect(group.getByRole('radio',{name:'English',exact:true})).toBeFocused();
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});
