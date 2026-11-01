import {openPreferenceCategory} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {openLocalizedApp} from './fixtures/localizedApp';
import {notoFont} from '../src/fontDownload';
import type {policy} from './fixtures/FontPolicyHarness';
declare global{interface Window{notoPolicy:typeof policy;}}
const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
async function preferences(page:import('@playwright/test').Page){
  await openLocalizedApp(page,'en');await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await openPreferenceCategory(page,'Appearance');
  await page.getByText('Imported fonts',{exact:true}).click();
}
test('font download stays explicit and preserves an existing font after an invalid response',async({page})=>{
  let requests=0;
  await page.route(notoFont.url,route=>{requests++;return route.fulfill({status:200,headers:{'access-control-allow-origin':'*'},body:'short'});});
  await preferences(page);
  await page.getByLabel('Import font file').setInputFiles(new URL('./fixtures/LiberationMono-Regular.ttf',import.meta.url).pathname);
  const selector=page.getByRole('combobox',{name:'Imported CJK fallback',exact:true});
  const original=await selector.getByRole('option',{name:'LiberationMono-Regular.ttf',exact:true}).getAttribute('value');
  await selector.selectOption(original!);await expect(selector).toHaveValue(original!);
  expect(requests).toBe(0);
  await page.getByRole('button',{name:'Download Noto Sans Mono CJK SC',exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText('The font response has an unexpected status or byte length. Nothing was imported.');
  await expect(selector).toHaveValue(original!);expect(requests).toBe(1);
  await expect(page.getByRole('button',{name:'Download Noto Sans Mono CJK SC',exact:true})).toBeEnabled();
});
test('actual native CSP admits only the pinned font path and blocks an unrelated external request',async({page})=>{
  const requests:string[]=[];
  await page.route('https://raw.githubusercontent.com/**',route=>{requests.push(route.request().url());return route.fulfill({status:200,headers:{'access-control-allow-origin':'*'},body:'short'});});
  await page.route('**/font-policy',route=>route.fulfill({contentType:'text/html',headers:{'content-security-policy':config.app.security.csp},body:'<!doctype html><script type="module" src="/e2e/fixtures/FontPolicyHarness.ts"></script>'}));
  await page.goto('/font-policy');await page.waitForFunction(()=>window.notoPolicy?.ready());
  expect(await page.evaluate(()=>window.notoPolicy.download())).toContain('unexpected status or byte length');
  const denied=await page.evaluate(async url=>{try{await fetch(url,{credentials:'omit',redirect:'error'});return false;}catch{return true;}},notoFont.url.replace('Regular.otf','Bold.otf'));
  expect(denied).toBe(true);expect(requests).toEqual([notoFont.url]);
});
test('actual official pinned CJK bytes decode, remain opt-in, reselect offline and delete through the existing store',async({page,context})=>{
  test.skip(process.env.LAZYSH_NOTO_LIVE!=='1','Explicit public16MiB asset acceptance only; default suites never fetch a font.');
  test.setTimeout(150_000); // Existing120s transfer budget plus browser decode/storage acceptance.
  let requests=0;
  page.on('request',request=>{if(request.url()===notoFont.url)requests++;});
  await preferences(page);
  const selector=page.getByRole('combobox',{name:'Imported CJK fallback',exact:true});
  await expect(selector).toHaveValue('');expect(requests).toBe(0);
  const sample=page.locator('.font-sample');
  const latin=()=>sample.evaluate(element=>{const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d')!;const style=getComputedStyle(element);ctx.font=`${style.fontSize} ${style.fontFamily}`;return ctx.measureText('lazysh0123456789').width;});
  const before=await latin();
  await page.getByRole('button',{name:'Download Noto Sans Mono CJK SC',exact:true}).click();
  await expect(page.getByText('Font saved locally. Choose it in Imported CJK fallback; selection was not changed automatically.',{exact:true})).toBeVisible({timeout:130_000});
  await expect(selector).toHaveValue('');expect(requests).toBe(1);
  const selected=await selector.getByRole('option',{name:notoFont.file,exact:true}).getAttribute('value');
  expect(selected).toMatch(/^[a-f0-9-]{36}$/);await selector.selectOption(selected!);await expect(selector).toHaveValue(selected!);
  await expect(sample).toHaveCSS('font-family',new RegExp(`lazysh-font-${selected}-cjk`));
  expect(await latin()).toBe(before);
  const loaded=await page.evaluate(()=>[...document.fonts].filter(face=>face.family.includes('-cjk')).map(face=>({status:face.status,range:face.unicodeRange})));
  expect(loaded).toHaveLength(1);expect(loaded[0].status).toBe('loaded');expect(loaded[0].range).toContain('U+2E80-9FFF');
  await context.setOffline(true);
  await selector.selectOption('');await expect(selector).toHaveValue('');
  await selector.selectOption(selected!);await expect(selector).toHaveValue(selected!);
  await expect(sample).toHaveCSS('font-family',new RegExp(`lazysh-font-${selected}-cjk`));expect(requests).toBe(1);
  await page.getByRole('button',{name:`Delete font ${notoFont.file}`,exact:true}).click();
  await expect(selector).toHaveValue('');await expect(selector.getByRole('option',{name:notoFont.file,exact:true})).toHaveCount(0);
  expect(requests).toBe(1);
});
