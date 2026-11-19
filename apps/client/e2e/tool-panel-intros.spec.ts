import {expect,test,type Locator,type Page} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {routePreviewPage} from './fixtures/previewPage';
import {dictationFixture} from './fixtures/directDictation';
import {remoteMuxName} from '../src/test/multiplexerFixture';
import type {mountMultiplexerHarness} from './fixtures/MultiplexerHarness';
import type {mountDevices} from './fixtures/DeviceHarness';
import type {mountPreviewHarness} from './fixtures/PreviewHarness';
declare global {interface Window {introMux:ReturnType<typeof mountMultiplexerHarness>;introDevices:ReturnType<typeof mountDevices>;introPreview:ReturnType<typeof mountPreviewHarness>;}}

/** The panel's optional intro sits behind one closed 44px line, in every language, and its trust text never folds. */
async function expectFoldedIntro(page:Page,scope:Locator,about:string,intro:string,retained:string[]=[]){
  for(const language of ['pt-BR','es','en']){
    const [aboutText,introText,...retainedText]=await page.evaluate(async({language,keys})=>{
      const {uiI18n,t}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(language);
      return keys.map(key=>t(key as never));
    },{language,keys:[about,intro,...retained]});
    const line=scope.getByText(aboutText,{exact:true}),text=scope.getByText(introText,{exact:true});
    await expect(line).toBeVisible();
    expect((await line.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(text).toBeHidden();
    for(const kept of retainedText)await expect(scope.getByText(kept,{exact:true})).toBeVisible();
    await line.click();await expect(text).toBeVisible();
    await line.click();await expect(text).toBeHidden();
  }
}
test.beforeEach(async({page})=>{await page.setViewportSize({width:393,height:852});});
test('the Zellij quick-tab hint stays closed until its disclosure is opened',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountMultiplexerHarness}=await import('/e2e/fixtures/MultiplexerHarness.tsx');window.introMux=mountMultiplexerHarness();});
  await page.getByRole('button',{name:'List zellij sessions',exact:true}).click();
  await page.getByRole('button',{name:`Control Zellij ${remoteMuxName}`,exact:true}).click();
  await expect(page.getByRole('group',{name:'Zellij quick tabs',exact:true}).getByRole('button')).toHaveCount(20);
  await expectFoldedIntro(page,page.locator('body'),'zellijQuickAbout','zellijQuickHint');
});
test('the Devices hint stays closed until its disclosure is opened',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountDevices}=await import('/e2e/fixtures/DeviceHarness.tsx');window.introDevices=mountDevices();});
  const root=page.locator('.device-fixture');
  await expect(root.getByRole('button',{name:'Find devices',exact:true})).toBeVisible();
  await expectFoldedIntro(page,root,'devicesAbout','devicesHint');
});
test('the Preview automatic-refresh hint folds while the SSH exposure text stays visible',async({page})=>{
  await routePreviewPage(page);
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountPreviewHarness}=await import('/e2e/fixtures/PreviewHarness.tsx');window.introPreview=mountPreviewHarness();});
  await expect(page.getByRole('button',{name:'Select page element',exact:true})).toBeEnabled();
  await expectFoldedIntro(page,page.locator('.preview-panel'),'previewAutomaticAbout','previewAutomaticHint',['previewConnectionHint']);
});
test('the Dictation intro and engine details fold while each engine privacy line and the auto-send warning stay visible',async({page})=>{
  await dictationFixture(page,true);
  const panel=page.locator('.voice-panel');
  await expectFoldedIntro(page,panel,'voiceAbout','voiceIntro',['voiceWhisperHint','voiceDeliveryHint']);
  await expectFoldedIntro(page,panel,'voiceWhisperAbout','voiceWhisperDetails',['voiceWhisperHint']);
  await page.getByRole('combobox',{name:'Speech engine',exact:true}).selectOption('parakeet');
  await expectFoldedIntro(page,panel,'voiceParakeetAbout','voiceParakeetDetails',['voiceParakeetHint','voiceDeliveryHint']);
});
