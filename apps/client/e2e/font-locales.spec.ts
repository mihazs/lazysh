import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {observeFontOperations} from './fixtures/fontOperations';
declare global{interface Window{fontOperations:ReturnType<typeof observeFontOperations>;}}
const fontFile=new URL('./fixtures/LiberationMono-Regular.ttf',import.meta.url).pathname;
for(const initial of ['en','pt-BR','es','en-XA'])test(`${initial} retained font messages and held import/load/delete survive locale changes without repeating work`,async({page})=>{
  const external=await openLocalizedApp(page,initial==='en-XA'?'en':initial);
  await page.evaluate(async initial=>{
    const{observeFontOperations}=await import('/e2e/fixtures/fontOperations.ts');window.fontOperations=observeFontOperations();
    if(initial==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');const{uiI18n}=await import('/src/i18n/core.ts');await enablePseudoLocale(uiI18n);}
  },initial);
  // Preferences has already initialized its font store; no locale change may reopen it.
  const preferencesName=await page.evaluate(async()=>{const{t}=await import('/src/i18n/core.ts');return t('appPreferences');});
  await page.getByRole('button',{name:preferencesName,exact:true}).click();
  const labels=()=>page.evaluate(async()=>{const{t}=await import('/src/i18n/core.ts');return {import:t('preferencesImportFontFile'),summary:t('preferencesImportedFonts'),primary:t('preferencesImportedTerminalFont'),invalid:t('validationChooseAFontFileNoLargerThan24MiB'),delete:t('preferencesDeleteFontValue1',{value1:'LiberationMono-Regular.ttf'})};});
  let names=await labels();
  await page.getByText(names.summary,{exact:true}).click();
  await page.getByLabel(names.import,{exact:true}).setInputFiles({name:'RAW {{file}}.ttf',mimeType:'font/ttf',buffer:Buffer.from('bad')});
  await expect(page.getByRole('alert')).toHaveText(names.invalid);
  const alert=await page.getByRole('alert').elementHandle();
  const idle=await page.evaluate(()=>window.fontOperations.counts);
  for(const locale of ['en','pt-BR','es','en-XA']){
    await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');if(locale==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');await enablePseudoLocale(uiI18n);}else await uiI18n.changeLanguage(locale);},locale);
    names=await labels();await expect(page.getByRole('alert')).toHaveText(names.invalid);
    expect(await alert!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await page.evaluate(()=>window.fontOperations.counts)).toEqual(idle);
  }
  for(const operation of ['import','load','delete']){
    await page.evaluate(operation=>window.fontOperations.hold(operation==='delete'?'delete':'load'),operation);
    names=await labels();
    if(operation==='import')await page.getByLabel(names.import,{exact:true}).setInputFiles(fontFile);
    else if(operation==='load'){
      const id=await page.evaluate(async()=>{const{getDeviceFonts}=await import('/src/fonts.ts');return getDeviceFonts().fonts[0].id;});
      await page.getByRole('combobox',{name:names.primary,exact:true}).selectOption(id);
    }else await page.getByRole('button',{name:names.delete,exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.fontOperations.pending())).toBe(true);
    const held=await page.evaluate(()=>window.fontOperations.counts);
    for(const locale of ['pt-BR','es','en-XA']){
      await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},locale);
      names=await labels();await expect(page.getByLabel(names.import,{exact:true})).toBeDisabled();
      expect(await page.evaluate(()=>window.fontOperations.counts)).toEqual(held);
    }
    await page.evaluate(()=>window.fontOperations.finish());
    await expect(page.getByLabel(names.import,{exact:true})).toBeEnabled();
    if(operation==='delete')await expect(page.getByRole('button',{name:names.delete,exact:true})).toHaveCount(0);
    else await expect(page.getByRole('button',{name:names.delete,exact:true})).toBeVisible();
  }
  expect(external).toEqual([]);
});

test('retained missing-role and rejected-font warnings translate without font or storage retries',async({page})=>{
  const external=await openLocalizedApp(page,'en');
  const rawName='RAW font {{value1}} <tag> 中文';
  await page.evaluate(async name=>{
    const id='11111111-1111-4111-8111-111111111111';
    const bytes=new ArrayBuffer(12);new DataView(bytes).setUint32(0,0x00010000);
    await new Promise<void>((resolve,reject)=>{
      const open=indexedDB.open('lazysh-fonts-v1',1);
      open.onsuccess=()=>{const db=open.result;const tx=db.transaction('fonts','readwrite');tx.objectStore('fonts').add({id,name,size:12,bytes});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};
    });
    localStorage.setItem('lazysh.device-fonts.v1',JSON.stringify({primary:id,cjk:'22222222-2222-4222-8222-222222222222'}));
  },rawName);
  await page.reload();await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await page.getByText('Imported fonts',{exact:true}).click();
  const warnings=page.locator('details').filter({has:page.locator('input[accept=".ttf,.otf,.woff,.woff2,.ttc"]')}).getByRole('status');
  await expect(warnings).toHaveCount(2);
  await page.evaluate(async()=>{const{observeFontOperations}=await import('/e2e/fixtures/fontOperations.ts');window.fontOperations=observeFontOperations();});
  const nodes=await warnings.elementHandles();
  const snapshot=await page.evaluate(()=>window.fontOperations.counts);
  for(const locale of ['pt-BR','es','en-XA']){
    const labels=await page.evaluate(async({locale,name})=>{
      const{t,uiI18n}=await import('/src/i18n/core.ts');
      if(locale==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');await enablePseudoLocale(uiI18n);}else await uiI18n.changeLanguage(locale);
      return [t('fontCannotLoadValue1UsingTheFallbackFontStack',{value1:name}),t('fontTheSelectedValue1FontIsMissingOnThisDevice',{value1:t('fontRoleCjk')})];
    },{locale,name:rawName});
    await expect(warnings).toHaveText(labels);
    for(const node of nodes)expect(await node.evaluate(element=>element.isConnected)).toBe(true);
    expect(await page.evaluate(()=>window.fontOperations.counts)).toEqual(snapshot);
    const size=await page.locator('.preferences-panel').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await expect(page.getByRole('button',{name:await page.evaluate(async name=>{const{t}=await import('/src/i18n/core.ts');return t('preferencesDeleteFontValue1',{value1:name});},rawName)})).toBeVisible();
  }
  expect(external).toEqual([]);
});
