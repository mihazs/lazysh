import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {remoteMuxName,remoteMuxDirectory} from '../src/test/multiplexerFixture';
import type {mountMultiplexerHarness} from './fixtures/MultiplexerHarness';
declare global{interface Window{zellijQuickFixture:ReturnType<typeof mountMultiplexerHarness>;}}

test('Zellij quick tabs retain drafts and send only explicit numeric actions across locales',async({page})=>{
  const external=await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountMultiplexerHarness}=await import('/e2e/fixtures/MultiplexerHarness.tsx');window.zellijQuickFixture=mountMultiplexerHarness();});
  await page.getByRole('button',{name:'List zellij sessions',exact:true}).click();
  await page.getByRole('button',{name:`Control Zellij ${remoteMuxName}`,exact:true}).click();
  const panel=page.getByRole('region',{name:`Zellij ${remoteMuxName} controls`,exact:true});
  const title=panel.getByRole('textbox',{name:'New tab name',exact:true});
  await title.fill('  unchanged tab draft  ');
  await panel.getByRole('textbox',{name:'Zellij project directory',exact:true}).fill(remoteMuxDirectory);
  await panel.getByRole('spinbutton',{name:'Tab number',exact:true}).fill('42');
  const original=await title.elementHandle();
  const row=panel.getByRole('group',{name:'Zellij quick tabs',exact:true});
  await expect(row.getByRole('button')).toHaveCount(20);
  expect(await page.evaluate(()=>window.zellijQuickFixture.calls.filter(call=>call.command==='zellij_action'))).toEqual([]);
  await row.getByRole('button',{name:'Tab 10',exact:true}).click();
  for(const locale of ['pt-BR','es']){
    const labels=await page.evaluate(async({locale,name})=>{const{uiI18n,t}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);return{group:t('zellijQuickTabs'),title:t('zellijTitle',{name}),tab:t('zellijNewTabName'),sending:t('muxSending')};},{locale,name:remoteMuxName});
    const current=page.getByRole('region',{name:labels.title,exact:true});
    const group=current.getByRole('group',{name:labels.group,exact:true});
    await expect(group.getByRole('button')).toHaveCount(20);
    expect(await group.getByRole('button').evaluateAll(nodes=>nodes.every(node=>(node as HTMLButtonElement).disabled))).toBe(true);
    await expect(current.getByRole('textbox',{name:labels.tab,exact:true})).toHaveValue('  unchanged tab draft  ');
    expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
    await expect(current.getByRole('status')).toHaveText(labels.sending);
    const size=await group.evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
  }
  expect(await page.evaluate(()=>window.zellijQuickFixture.calls.filter(call=>call.command==='zellij_action'))).toEqual([{command:'zellij_action',args:{sessionId:'browser-control',name:remoteMuxName,action:{type:'goToTab',index:10}}}]);
  await page.evaluate(()=>window.zellijQuickFixture.finish());
  await expect(page.getByText('Acción enviada a Zellij.',{exact:true})).toBeVisible();
  await original!.focus();
  await page.evaluate(async()=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('en');});
  await expect(panel.getByRole('spinbutton',{name:'Tab number',exact:true})).toHaveValue('42');
  expect(await original!.evaluate(node=>document.activeElement===node)).toBe(true);
  await panel.getByRole('group',{name:'Zellij quick tabs',exact:true}).getByRole('button',{name:'Tab 20',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.zellijQuickFixture.calls.filter(call=>call.command==='zellij_action').length)).toBe(2);
  await page.evaluate(()=>window.zellijQuickFixture.finish());
  expect(await page.evaluate(()=>window.zellijQuickFixture.calls.filter(call=>call.command==='zellij_action'))).toEqual([10,20].map(index=>({command:'zellij_action',args:{sessionId:'browser-control',name:remoteMuxName,action:{type:'goToTab',index}}})));
  expect(await page.evaluate(()=>window.zellijQuickFixture.calls.some(call=>['write_stdin','local_write'].includes(call.command)))).toBe(false);
  expect(external).toEqual([]);
});
