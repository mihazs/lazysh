import {readFileSync} from 'node:fs';
import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {aboutLegalFiles,aboutLocales} from '../src/test/aboutData';
declare global {interface Window {aboutOpened:string[][];}}
const bodies=aboutLegalFiles.map(path=>readFileSync(new URL('../../../'+path,import.meta.url),'utf8'));
for(const labels of aboutLocales)test(`${labels.locale} About preserves legal bytes and corresponding source through a live locale switch`,async({page})=>{
  const external=await openLocalizedApp(page,labels.locale);
  await page.evaluate(()=>{window.aboutOpened=[];window.open=(url,target,features)=>{window.aboutOpened.push([String(url),target??'',features??'']);return null;};});
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:labels.openHosts,exact:true}).click();
  await page.getByRole('button',{name:labels.region+' · 0.1.0',exact:true}).click();
  const about=page.getByRole('region',{name:labels.region,exact:true});
  await expect(about.getByText(labels.license,{exact:true})).toBeVisible();
  const code=about.locator('code');const revision=await code.textContent();expect(revision).toMatch(/^[0-9a-f]{40}$/);
  await about.getByRole('button',{name:labels.source,exact:true}).click();
  expect(await page.evaluate(()=>window.aboutOpened)).toEqual([[`https://github.com/mihazs/lazysh/tree/${revision}`,'_blank','noopener,noreferrer']]);
  for(const details of await about.locator('details').all())await details.locator('summary').click();
  expect(await about.locator('pre').allTextContents()).toEqual(bodies);
  const source=about.getByRole('button',{name:labels.source,exact:true});await source.focus();const node=await source.elementHandle();const license=await about.locator('pre').first().elementHandle();
  await page.evaluate(async()=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('en');});
  expect(await node!.evaluate(button=>button===document.activeElement)).toBe(true);expect(await license!.evaluate(pre=>pre.isConnected)).toBe(true);
  const english=page.getByRole('region',{name:'About lazysh',exact:true});
  await expect(english.getByRole('button',{name:aboutLocales[0].source,exact:true})).toBeVisible();
  expect(await english.locator('pre').allTextContents()).toEqual(bodies);
  for(const panel of [english,page.getByRole('dialog')])expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(external).toEqual([]);expect(await page.locator('[role=dialog] img,[role=dialog] iframe').count()).toBe(0);
});
