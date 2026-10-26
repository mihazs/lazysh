import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountAwakeShortcutsHarness} from './fixtures/AwakeShortcutsHarness';
declare global {interface Window {awakeShortcuts:ReturnType<typeof mountAwakeShortcutsHarness>;}}

for(const locale of ['en','pt-BR','es','en-XA'])test(`${locale} display and prefix controls retain ownership, input and held dispatch across locale changes`,async({page})=>{
  await installNativeBridge(page,undefined,{nativeEvents:true});
  await page.addInitScript(()=>{window.nativeFixtureInvoke=async()=>{throw new Error('Unexpected bootstrap fixture request');};});
  const external=await openLocalizedApp(page,locale==='en-XA'?'en':locale);
  await page.evaluate(async locale=>{
    if(locale==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');const{uiI18n}=await import('/src/i18n/core.ts');await enablePseudoLocale(uiI18n);}
    const{mountAwakeShortcutsHarness}=await import('/e2e/fixtures/AwakeShortcutsHarness.tsx');window.awakeShortcuts=mountAwakeShortcutsHarness();
  },locale);
  const names=()=>page.evaluate(async()=>{const{t}=await import('/src/i18n/core.ts');return {awake:t('keepAwakeLabel'),region:t('keepAwakeRegion'),tmux:t('muxShortcutRegion',{kind:'tmux'}),herdr:t('muxShortcutRegion',{kind:'herdr'}),prefix:t('muxShortcutPrefix'),save:t('muxShortcutSave'),create:t('muxShortcutNewWindow'),active:t('keepAwakeActive')};});
  let labels=await names();
  const checkbox=page.getByRole('checkbox',{name:labels.awake,exact:true});await expect(checkbox).toBeEnabled();
  await checkbox.check();await expect(page.getByRole('status')).toHaveText(labels.active);
  const tmux=page.getByRole('region',{name:labels.tmux,exact:true});
  const input=tmux.getByRole('textbox',{name:labels.prefix,exact:true});
  await input.fill('Ctrl+a');const inputNode=await input.elementHandle();await input.focus();
  const initialCalls=await page.evaluate(()=>window.awakeShortcuts.calls);
  for(const choice of ['pt-BR','es',locale]){
    await page.evaluate(async choice=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(choice);},choice);
    labels=await names();
    await expect(page.getByRole('status')).toHaveText(labels.active);
    await expect(page.getByRole('region',{name:labels.tmux,exact:true}).getByRole('textbox')).toHaveValue('Ctrl+a');
    expect(await inputNode!.evaluate(node=>node===document.activeElement)).toBe(true);
    expect(await page.evaluate(()=>window.awakeShortcuts.calls)).toEqual(initialCalls);
    for(const name of [labels.region,labels.tmux,labels.herdr]){
      const size=await page.getByRole('region',{name,exact:true}).evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
      expect(size.scroll).toBeLessThanOrEqual(size.width);
    }
  }
  const button=page.getByRole('region',{name:labels.tmux,exact:true}).getByRole('button',{name:labels.create,exact:true});
  const buttonNode=await button.elementHandle();await button.click();await expect(button).toBeDisabled();
  await page.evaluate(async()=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('es');});
  labels=await names();
  expect(await buttonNode!.evaluate((node,label)=>node.textContent===label,labels.create)).toBe(true);
  const writes=await page.evaluate(()=>window.awakeShortcuts.calls.filter(call=>call.command==='write_stdin'));
  expect(writes).toEqual([{command:'write_stdin',args:{sessionId:'locale-tmux',data:'',steps:['\x01','c']}}]);
  await page.evaluate(()=>window.awakeShortcuts.finish());
  await expect(page.getByRole('region',{name:labels.tmux,exact:true}).getByRole('button',{name:labels.create,exact:true})).toBeEnabled();
  expect(external).toEqual([]);
});
