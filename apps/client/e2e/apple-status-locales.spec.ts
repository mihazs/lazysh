import {expectPanelInsets} from './fixtures/panelLayout';
import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {appleStatusLocales,appleStatusNativeReason,appleStatusSession} from '../src/test/appleStatusData';
import type {mountAppleStatusHarness} from './fixtures/AppleStatusHarness';
declare global{interface Window{appleStatusLocale:ReturnType<typeof mountAppleStatusHarness>;}}
for(const initial of appleStatusLocales)test(`${initial.locale} Apple status labels keep the original subscription and redacted publication schedule`,async({page})=>{
  const external=await openLocalizedApp(page,initial.locale);
  await page.clock.install({time:new Date('2026-10-26T12:00:00Z')});
  await page.clock.pauseAt(new Date('2026-10-26T12:00:01Z'));
  await page.evaluate(async()=>{const{mountAppleStatusHarness}=await import('/e2e/fixtures/AppleStatusHarness.tsx');window.appleStatusLocale=mountAppleStatusHarness();});
  const start=page.getByRole('button',{name:initial.start,exact:true});await expect(start).toBeEnabled();
  const button=await start.elementHandle();await button!.focus();
  const before=await page.evaluate(()=>window.appleStatusLocale.calls);
  for(const labels of appleStatusLocales){
    await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},labels.locale);
    await expect(page.getByRole('region',{name:labels.title,exact:true})).toBeVisible();
    await expect(page.getByText(appleStatusNativeReason,{exact:false})).toBeVisible();
    expect(await button!.evaluate(node=>node===document.activeElement)).toBe(true);
    expect(await page.evaluate(()=>window.appleStatusLocale.calls)).toEqual(before);
  }
  await page.getByRole('button',{name:appleStatusLocales[2].start,exact:true}).click();
  const pending=await page.evaluate(()=>window.appleStatusLocale.calls);
  expect(pending.filter(call=>call.command==='apple_status_configure')).toHaveLength(1);
  for(const labels of appleStatusLocales){
    await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},labels.locale);
    await expect(page.getByRole('button',{name:labels.start,exact:true})).toBeDisabled();
    expect(await page.evaluate(()=>window.appleStatusLocale.calls)).toEqual(pending);
  }
  await page.evaluate(()=>window.appleStatusLocale.complete());
  const publications=()=>page.evaluate(()=>window.appleStatusLocale.calls.filter(call=>call.command==='apple_status_publish'));
  await expect.poll(async()=>await publications()).toHaveLength(1);
  const first=(await publications())[0].args as {snapshot:{subscriptionId:string;sessionId:string;sequence:number;observedAt:number;expiresAt:number;usage:{freshness:string;recordedAt:number;freshUntil:number}};startActivity:boolean};
  expect(first.startActivity).toBe(true);expect(first.snapshot).toMatchObject({sessionId:appleStatusSession,sequence:1,running:1,waiting:0,expiresAt:first.snapshot.observedAt+60,usage:{freshness:'stale'}});
  expect(JSON.stringify(first)).not.toMatch(/SECRET|private|project|summary|paneId|toolInput|command|credential/);
  const subscribed=await page.evaluate(()=>window.appleStatusLocale.calls);
  for(const labels of appleStatusLocales){
    await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},labels.locale);
    const panel=page.getByRole('region',{name:labels.title,exact:true});
    await expect(panel.getByRole('button',{name:labels.stop,exact:true})).toBeVisible();
    expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await expectPanelInsets(panel);
    expect(await page.evaluate(()=>window.appleStatusLocale.calls)).toEqual(subscribed);
  }
  await page.clock.fastForward(9999);expect(await publications()).toHaveLength(1);
  await page.clock.fastForward(1);await expect.poll(async()=>await publications()).toHaveLength(2);
  expect((await publications())[1].args).toMatchObject({startActivity:false,snapshot:{subscriptionId:first.snapshot.subscriptionId,sequence:2,usage:first.snapshot.usage}});
  await page.getByRole('button',{name:appleStatusLocales[2].stop,exact:true}).click();
  for(const labels of appleStatusLocales){
    await page.evaluate(async locale=>{const{uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},labels.locale);
    await expect(page.getByRole('alert')).toHaveText(labels.stopFailed);
  }
  expect((await page.evaluate(()=>window.appleStatusLocale.calls)).filter(call=>call.command==='apple_status_configure')).toEqual([
    {command:'apple_status_configure',args:{subscriptionId:first.snapshot.subscriptionId,enabled:true}},
    {command:'apple_status_configure',args:{subscriptionId:first.snapshot.subscriptionId,enabled:false}},
  ]);
  expect(external).toEqual([]);
});
