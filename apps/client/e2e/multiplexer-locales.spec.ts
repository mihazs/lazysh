import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {muxLocales,remoteMuxName,remoteMuxDirectory,remoteMuxError} from '../src/test/multiplexerFixture';
import type {mountMultiplexerHarness} from './fixtures/MultiplexerHarness';
declare global {interface Window {multiplexerLocale:ReturnType<typeof mountMultiplexerHarness>;}}

for(const initial of muxLocales)test(`${initial.locale} multiplexer labels expand responsively without altering drafts or native identity`,async({page})=>{
  const external=await openLocalizedApp(page,initial.locale);
  await page.evaluate(async()=>{const{mountMultiplexerHarness}=await import('/e2e/fixtures/MultiplexerHarness.tsx');window.multiplexerLocale=mountMultiplexerHarness();});
  await expect(page.getByRole('button',{name:initial.rename,exact:true})).toBeEnabled();
  // Open the real child controls through their shipping parent and inherited layout.
  for(const [kind,key] of [['herdr','muxBrowseHerdr'],['zellij','muxControlZellij']] as const){
    const names=await page.evaluate(async({kind,key,name})=>{const{t}=await import('/src/i18n/core.ts');return {list:t('muxListSessions',{kind}),open:t(key,{name})};},{kind,key,name:remoteMuxName});
    await page.getByRole('button',{name:names.list,exact:true}).click();
    await page.getByRole('button',{name:names.open,exact:true}).click();
  }
  const zellij=page.getByRole('region',{name:initial.zellijRegion,exact:true});
  await zellij.getByRole('textbox',{name:initial.tab,exact:true}).fill(remoteMuxName);
  await zellij.getByRole('textbox',{name:initial.directory,exact:true}).fill(remoteMuxDirectory);
  const input=await zellij.getByRole('textbox',{name:initial.tab,exact:true}).elementHandle();
  await input!.focus();
  const calls=await page.evaluate(()=>window.multiplexerLocale.calls);
  for(const labels of muxLocales){
    await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},labels.locale);
    const mux=page.getByRole('region',{name:labels.region,exact:true});
    const herd=page.getByRole('region',{name:labels.herdrRegion,exact:true});
    const controls=page.getByRole('region',{name:labels.zellijRegion,exact:true});
    await expect(mux.getByRole('button',{name:`${labels.attach} ${remoteMuxName}`,exact:true})).toBeVisible();
    await expect(herd).toContainText('w7:p9 · unknown');
    await expect(controls.getByRole('textbox',{name:labels.tab,exact:true})).toHaveValue(remoteMuxName);
    expect(await input!.evaluate(node=>node===document.activeElement)).toBe(true);
    expect(await page.evaluate(()=>window.multiplexerLocale.calls)).toEqual(calls);
    for(const panel of [mux,herd,controls]){
      const size=await panel.evaluate(node=>({name:node.getAttribute('aria-label'),width:node.clientWidth,scroll:node.scrollWidth}));
      expect(size.scroll,JSON.stringify(size)).toBeLessThanOrEqual(size.width);
    }
  }
  const english=muxLocales[0];
  await page.evaluate(async()=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('en');});
  await page.getByRole('button',{name:english.create,exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Sending action…');
  await page.evaluate(()=>window.multiplexerLocale.finish());
  for(const labels of muxLocales){
    await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},labels.locale);
    await expect(page.getByRole('status')).toHaveText(labels.sent);
  }
  const spanish=muxLocales[2];
  await page.getByRole('button',{name:spanish.rename,exact:true}).click();
  await page.getByRole('button',{name:spanish.save,exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText(remoteMuxError);
  expect(await page.evaluate(()=>window.multiplexerLocale.calls)).toEqual([
    {command:'multiplexer_tree',args:{sessionId:'browser-control'}},
    {command:'multiplexer_sessions',args:{sessionId:'browser-control',kind:'herdr'}},
    {command:'herdr_tree',args:{sessionId:'browser-control',name:remoteMuxName}},
    {command:'multiplexer_sessions',args:{sessionId:'browser-control',kind:'zellij'}},
    {command:'zellij_action',args:{sessionId:'browser-control',name:remoteMuxName,action:{type:'newTab',name:remoteMuxName,directory:remoteMuxDirectory}}},
    {command:'tmux_action',args:{sessionId:'browser-control',action:{type:'renameSession',target:'$41',name:remoteMuxName}}},
  ]);
  expect(external).toEqual([]);
});
