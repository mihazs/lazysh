import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {deviceFrame,deviceRecord,iosDeviceRecord} from '../src/test/deviceData';
import type {mountDevices} from './fixtures/DeviceHarness';
declare global {interface Window {devicePreview:ReturnType<typeof mountDevices>;}}
for(const locale of ['en','pt-BR','es'])test(`${locale} preserves decoded device frames, held video ownership and explicit input through language changes`,async({page})=>{
  await openLocalizedApp(page,locale);
  await page.evaluate(async()=>{const {mountDevices}=await import('/e2e/fixtures/DeviceHarness.tsx');window.devicePreview=mountDevices();});
  const root=page.locator('.device-fixture');
  async function labels(language=locale){return page.evaluate(async language=>{
    const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:language as 'pt-BR'|'es'|'en'});
    const {t}=await import('/src/i18n/core.ts');return {find:t('devicesFind'),device:t('devicesDevice'),capture:t('devicesCapture'),enable:t('devicesEnableInput'),verify:t('devicesVerifyAndroid'),start:t('devicesStartVideo'),stop:t('devicesStopVideo'),home:t('devicesHome'),reboot:t('devicesReboot'),screen:t('devicesScreen',{name:'Emulator {{raw}}'})};
  },language);}
  let copy=await labels();await root.getByRole('button',{name:copy.find,exact:true}).click();await root.getByRole('combobox',{name:copy.device,exact:true}).selectOption(deviceFrame.id);await root.getByRole('button',{name:copy.capture,exact:true}).click();
  const image=root.getByRole('img');await expect(image).toBeVisible();expect(await image.evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBe(108);
  const imageNode=await image.elementHandle();const originalSrc=await image.getAttribute('src');const snapshot=await page.evaluate(()=>window.devicePreview.calls);
  for(const language of ['es','pt-BR','en']){
    copy=await labels(language);await expect(image).toHaveAttribute('alt',copy.screen);await expect(image).toHaveAttribute('src',originalSrc!);expect(await imageNode!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await page.evaluate(()=>window.devicePreview.calls)).toEqual(snapshot);await expect(root.getByRole('button',{name:copy.home,exact:true})).toBeDisabled();
  }
  await root.getByLabel(copy.enable,{exact:true}).check();
  await root.getByRole('button',{name:copy.home,exact:true}).click();
  expect((await page.evaluate(()=>window.devicePreview.calls)).find(call=>call.command==='device_action')?.args).toEqual({sessionId:'browser-device-host',devicePlatform:'android',id:deviceFrame.id,action:{type:'key',key:'home'}});
  let question='';page.once('dialog',async dialog=>{question=dialog.message();await dialog.dismiss();});await root.getByRole('button',{name:copy.reboot,exact:true}).click();expect(question).toBe(`reboot ${deviceRecord.name}?`);
  expect((await page.evaluate(()=>window.devicePreview.calls)).filter(call=>call.command==='device_action')).toHaveLength(1);
  await root.getByRole('button',{name:copy.verify,exact:true}).click();await root.getByRole('button',{name:copy.start,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.devicePreview.calls.filter(call=>call.command==='device_stream_start').length)).toBe(1);
  const startup=await page.evaluate(()=>window.devicePreview.calls);
  for(const language of ['pt-BR','es','en']){copy=await labels(language);await expect(root.getByRole('button',{name:copy.stop,exact:true})).toBeVisible();await expect(root.getByLabel(copy.enable,{exact:true})).toBeDisabled();expect(await page.evaluate(()=>window.devicePreview.calls)).toEqual(startup);}
  await page.evaluate(()=>window.devicePreview.begin());await expect.poll(()=>page.evaluate(()=>window.devicePreview.calls.filter(call=>call.command==='device_stream_next').length)).toBe(1);
  await page.evaluate(()=>window.devicePreview.deliver(1));await expect.poll(()=>page.evaluate(()=>window.devicePreview.calls.filter(call=>call.command==='device_stream_next').length)).toBe(2);
  const streaming=await page.evaluate(()=>window.devicePreview.calls);
  copy=await labels('es');await expect(image).toHaveAttribute('alt',copy.screen);await expect(image).toHaveAttribute('src',originalSrc!);expect(await imageNode!.evaluate(node=>node.isConnected)).toBe(true);expect(await page.evaluate(()=>window.devicePreview.calls)).toEqual(streaming);
  await root.getByRole('button',{name:copy.stop,exact:true}).click();await expect(root.getByLabel(copy.enable,{exact:true})).toBeDisabled();
  expect((await page.evaluate(()=>window.devicePreview.calls)).filter(call=>call.command==='device_stream_stop')).toEqual([{command:'device_stream_stop',args:{sessionId:'browser-device-host',streamId:'browser-device-stream'}}]);
  await root.getByRole('button',{name:copy.capture,exact:true}).click();await expect(root.getByLabel(copy.enable,{exact:true})).toBeEnabled();
  expect(await root.getByRole('img').evaluate(node=>node.getBoundingClientRect().width<=node.parentElement!.clientWidth)).toBe(true);
  await page.evaluate(()=>window.devicePreview.dispose());
});
test('iOS socket draft, focus and verified companion identity remain independent of interface language',async({page})=>{
  await openLocalizedApp(page,'en');await page.evaluate(async()=>{const {mountDevices}=await import('/e2e/fixtures/DeviceHarness.tsx');window.devicePreview=mountDevices();});
  const root=page.locator('.device-fixture');await root.getByRole('combobox',{name:'Platform',exact:true}).selectOption('ios');await root.getByRole('button',{name:'Find devices',exact:true}).click();await root.getByRole('combobox',{name:'Device',exact:true}).selectOption(iosDeviceRecord.id);
  const socket=root.getByLabel('idb companion socket',{exact:true});const draft='/private/raw {{socket}}.sock';await socket.fill(draft);await socket.focus();const node=await socket.elementHandle();const calls=await page.evaluate(()=>window.devicePreview.calls);
  for(const language of ['pt-BR','es','en']){
    const caption=await page.evaluate(async language=>{const {uiI18n,t}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(language);return t('devicesSocket');},language);
    await expect(root.getByLabel(caption,{exact:true})).toHaveValue(draft);expect(await node!.evaluate(element=>element===document.activeElement)).toBe(true);expect(await page.evaluate(()=>window.devicePreview.calls)).toEqual(calls);
  }
  await root.getByRole('button',{name:'Verify iOS companion',exact:true}).click();await root.getByLabel('Enable device input',{exact:true}).check();await root.getByRole('button',{name:'power',exact:true}).click();
  expect((await page.evaluate(()=>window.devicePreview.calls)).find(call=>call.command==='ios_device_action')?.args).toEqual({sessionId:'browser-device-host',id:iosDeviceRecord.id,socket:draft,width:390,height:844,action:{type:'key',key:'power'}});
  await page.evaluate(()=>window.devicePreview.dispose());
});
