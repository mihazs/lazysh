import {openPreferenceCategory} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {installThemeLocaleBridge} from './fixtures/themeLocaleBridge';
declare global{interface Window{themeLocaleFixture:{calls:{command:string;args:Record<string,unknown>}[];reads:number;writes:number;offer:(code:string)=>void;hold:(kind:'read'|'ack')=>void;pending:()=>boolean;finish:(fail?:boolean)=>void;clipboard:(value:string)=>void;}}}
for(const initial of ['en','pt-BR','es','en-XA'])test(`${initial} theme causes/notices keep literal drafts, export bytes and held operation identity`,async({page})=>{
  await installThemeLocaleBridge(page);const external=await openLocalizedApp(page,initial==='en-XA'?'en':initial);
  const locale=async(value:string)=>page.evaluate(async value=>{const{uiI18n}=await import('/src/i18n/core.ts');if(value==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');await enablePseudoLocale(uiI18n);}else await uiI18n.changeLanguage(value);},value);
  const labels=()=>page.evaluate(async()=>{const{t}=await import('/src/i18n/core.ts');return {preferences:t('appPreferences'),summary:t('themeImportAndShareTheme'),source:t('themeThemeJSONOrShareCode'),name:t('themeThemeName'),preview:t('themePreviewTheme'),previewRegion:t('themeThemePreview'),read:t('themeReadThemeFromClipboard'),apply:t('themeApplyToAppAndTerminal'),applied:t('themeThemeAppliedToAppAndTerminal'),export:t('themeExportThemeLink'),output:t('themeExportedTheme'),exported:t('themeSelectTheExportedTextToCopyIt'),invalid:t('validationInvalidThemeColorValue1',{value1:'{{<color>}}'}),link:t('themeLinkThemeLink'),linkReview:t('themeLinkReviewLinkedTheme'),linkApply:t('themeLinkApplyLinkedTheme'),linkApplied:t('themeLinkLinkedThemeAppliedToAppAndTerminal'),ackError:t('appTheLinkedThemeIsAlreadyAppliedButItsPending')};});
  await locale(initial);let names=await labels();await page.getByRole('button',{name:names.preferences,exact:true}).click();await openPreferenceCategory(page,'Appearance');await page.getByText(names.summary,{exact:true}).click();
  const details=page.locator('details:not(.preferences-category)').filter({has:page.locator('textarea[maxlength="16384"]')});
  const rawName='RAW <name> {{key}} 中文';const theme={v:1,name:rawName,mode:'light',colors:{background:'#fafafa',foreground:'#121212'}};
  await page.getByLabel(names.name,{exact:true}).fill('RAW fallback {{name}}');
  const source=page.getByLabel(names.source,{exact:true});const invalid=JSON.stringify({background:'#000',foreground:'#fff','{{<color>}}':'#fff'});
  await source.fill(invalid);await details.getByRole('button',{name:names.preview,exact:true}).click();await source.focus();
  const inputNode=await source.elementHandle(),statusNode=await details.getByRole('status').elementHandle();
  for(const choice of ['pt-BR','es','en-XA']){
    const before=await page.evaluate(()=>window.themeLocaleFixture.calls);await locale(choice);names=await labels();
    await expect(details.getByRole('status')).toHaveText(names.invalid);await expect(page.getByLabel(names.source,{exact:true})).toHaveValue(invalid);
    expect(await inputNode!.evaluate(node=>node===document.activeElement)).toBe(true);expect(await statusNode!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await page.evaluate(()=>window.themeLocaleFixture.calls)).toEqual(before);
    const size=await page.locator('.preferences-panel').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width);
  }
  await details.getByRole('button',{name:names.read,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.themeLocaleFixture.reads)).toBe(1);
  const beforeClipboard=await page.evaluate(()=>window.themeLocaleFixture.calls);
  await locale('es');names=await labels();await expect(page.getByLabel(names.source,{exact:true})).toHaveValue(invalid);
  expect(await page.evaluate(()=>window.themeLocaleFixture.calls)).toEqual(beforeClipboard);
  await page.evaluate(value=>window.themeLocaleFixture.clipboard(JSON.stringify(value)),theme);
  await expect(page.getByRole('heading',{name:rawName,exact:true})).toBeVisible();
  const previewNode=await page.getByRole('region',{name:names.previewRegion,exact:true}).elementHandle();
  const beforeApply=await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'));
  for(const choice of ['pt-BR','es','en-XA']){await locale(choice);names=await labels();expect(await previewNode!.evaluate(node=>node.isConnected)).toBe(true);expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBe(beforeApply);}
  await details.getByRole('button',{name:names.apply,exact:true}).click();await expect(details.getByRole('status')).toHaveText(names.applied);
  await details.getByRole('button',{name:names.export,exact:true}).click();
  const output=page.getByLabel(names.output,{exact:true});const exported=await output.inputValue();
  const expected=await page.evaluate(async value=>{const{parseThemeImport,exportTheme}=await import('/src/themeImport.ts');return exportTheme(parseThemeImport(JSON.stringify(value),{name:'unused',mode:'dark'})).link;},theme);
  expect(exported).toBe(expected);
  for(const choice of ['pt-BR','es','en-XA']){await locale(choice);names=await labels();await expect(details.getByRole('status')).toHaveText(names.exported);await expect(page.getByLabel(names.output,{exact:true})).toHaveValue(exported);}
  const linkedName='Linked <raw> {{name}} 中文';
  await page.evaluate(async name=>{const{exportTheme}=await import('/src/themeImport.ts');window.themeLocaleFixture.hold('read');window.themeLocaleFixture.offer(exportTheme({v:1,name,mode:'dark',colors:{background:'#101010',foreground:'#eeeeee'}}).code);},linkedName);
  await page.getByRole('button',{name:names.linkReview,exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.themeLocaleFixture.pending())).toBe(true);
  const heldRead=await page.evaluate(()=>window.themeLocaleFixture.calls);
  await locale('es');names=await labels();await expect(page.getByRole('button',{name:names.linkReview,exact:true})).toBeDisabled();expect(await page.evaluate(()=>window.themeLocaleFixture.calls)).toEqual(heldRead);
  await page.evaluate(()=>window.themeLocaleFixture.finish());await expect(page.getByRole('heading',{name:linkedName,exact:true})).toBeVisible();
  await page.evaluate(()=>window.themeLocaleFixture.hold('ack'));await page.getByRole('button',{name:names.linkApply,exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.themeLocaleFixture.pending())).toBe(true);
  const heldAck=await page.evaluate(()=>window.themeLocaleFixture.calls),persisted=await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'));
  for(const choice of ['pt-BR','es','en-XA']){await locale(choice);names=await labels();await expect(page.getByRole('complementary',{name:names.link,exact:true}).getByRole('status')).toHaveText(names.linkApplied);expect(await page.evaluate(()=>window.themeLocaleFixture.calls)).toEqual(heldAck);expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBe(persisted);}
  await page.evaluate(()=>window.themeLocaleFixture.finish(true));
  for(const choice of ['pt-BR','es','en-XA']){await locale(choice);names=await labels();const link=page.getByRole('complementary',{name:names.link,exact:true});await expect(link.getByRole('alert')).toHaveText(names.ackError);await expect(link.getByRole('status')).toHaveText(names.linkApplied);expect(await page.evaluate(()=>window.themeLocaleFixture.calls)).toEqual(heldAck);}
  expect(heldAck.filter(call=>call.command==='theme_link_ack').map(call=>call.args.receipt)).toEqual(['11111111-1111-4111-8111-000000000001']);
  expect(await page.evaluate(()=>({reads:window.themeLocaleFixture.reads,writes:window.themeLocaleFixture.writes}))).toEqual({reads:1,writes:0});
  expect(external).toEqual([]);
});
