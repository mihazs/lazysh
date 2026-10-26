import {expect,test} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {installNativeBridge} from './fixtures/nativeBridge';
import {openLocalizedApp} from './fixtures/localizedApp';
const pngPath=new URL('../src-tauri/fixtures/theme-qr.png',import.meta.url).pathname;
const png=Array.from(readFileSync(pngPath));
const payload='moshi-theme:'+Buffer.from(JSON.stringify({v:1,name:'QR fixture',mode:'dark',colors:{background:'#000000',foreground:'#ffffff'}})).toString('base64');
declare global{interface Window{themeQrFixture:{requests:number[][];permissions:MediaStreamConstraints[];stops:number;encodes:{width:number;height:number;type:string|undefined;quality:number|undefined}[];finish:(value:string|null)=>void;permission:()=>void;}}}
async function fixture(page:import('@playwright/test').Page){
  await installNativeBridge(page,undefined,{nativeEvents:true});
  await page.addInitScript(()=>{
    let complete:((value:string|null)=>void)|undefined,permission:((media:MediaStream)=>void)|undefined;
    const probe={requests:[] as number[][],permissions:[] as MediaStreamConstraints[],stops:0,encodes:[] as {width:number;height:number;type:string|undefined;quality:number|undefined}[],finish(value:string|null){complete?.(value);complete=undefined;},permission(){
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const context=canvas.getContext('2d')!;context.fillStyle='white';context.fillRect(0,0,640,480);
      const media=canvas.captureStream(1);for(const track of media.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{probe.stops++;stop();};}permission?.(media);permission=undefined;
    }};
    window.themeQrFixture=probe;
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:(constraints:MediaStreamConstraints)=>{probe.permissions.push(constraints);return new Promise<MediaStream>(resolve=>{permission=resolve;});}}});
    const encode=HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){probe.encodes.push({width:this.width,height:this.height,type,quality});encode.call(this,callback,type,quality);};
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Synthetic QR fixture; no terminal starts.'};
      if(command==='app_icon_status')return {available:false,current:'unknown',reason:'Synthetic QR fixture'};
      if(command==='theme_link_status')return false;
      if(command==='theme_qr_decode'){probe.requests.push(args.bytes as number[]);return new Promise<string|null>(resolve=>{complete=resolve;});}
      throw new Error(`Unexpected QR fixture command: ${command}`);
    };
  });
}
const language=async(page:import('@playwright/test').Page,value:string)=>page.evaluate(async value=>{const{uiI18n}=await import('/src/i18n/core.ts');if(value==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');await enablePseudoLocale(uiI18n);}else await uiI18n.changeLanguage(value);},value);
const labels=(page:import('@playwright/test').Page)=>page.evaluate(async()=>{const{t}=await import('/src/i18n/core.ts');return {preferences:t('appPreferences'),summary:t('themeImportAndShareTheme'),file:t('themeQrFile'),scan:t('themeQrScan'),cancel:t('themeQrCancel'),source:t('themeThemeJSONOrShareCode'),apply:t('themeApplyToAppAndTerminal'),title:t('themeQrTitle'),finishing:t('themeQrFinishing')};});
for(const initial of ['en','pt-BR','es','en-XA'])test(`${initial} owned PNG bytes reach native decoding once and only explicit Apply changes the theme`,async({page})=>{
  await fixture(page);const external=await openLocalizedApp(page,initial==='en-XA'?'en':initial);await language(page,initial);let names=await labels(page);
  await page.getByRole('button',{name:names.preferences,exact:true}).click();await page.getByText(names.summary,{exact:true}).click();
  const draft=page.getByLabel(names.source,{exact:true});await draft.fill('unfinished manual theme');
  expect(await page.evaluate(()=>({permissions:window.themeQrFixture.permissions,requests:window.themeQrFixture.requests}))).toEqual({permissions:[],requests:[]});
  const before=await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'));
  await page.getByLabel(names.file,{exact:true}).setInputFiles(pngPath);await expect.poll(()=>page.evaluate(()=>window.themeQrFixture.requests.length)).toBe(1);
  expect(await page.evaluate(()=>window.themeQrFixture.requests[0])).toEqual(png);
  const region=await page.getByRole('region',{name:names.title,exact:true}).elementHandle();
  for(const choice of ['pt-BR','es','en-XA']){
    await language(page,choice);names=await labels(page);await expect(page.getByLabel(names.file,{exact:true})).toBeDisabled();await expect(page.getByLabel(names.source,{exact:true})).toHaveValue('unfinished manual theme');
    expect(await region!.evaluate(node=>node.isConnected)).toBe(true);expect(await page.evaluate(()=>window.themeQrFixture.requests.length)).toBe(1);expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBe(before);
    const size=await page.locator('.preferences-panel').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width);
  }
  await page.evaluate(value=>window.themeQrFixture.finish(value),payload);await expect(page.getByRole('heading',{name:'QR fixture',exact:true})).toBeVisible();
  await expect(page.getByLabel(names.source,{exact:true})).toHaveValue('unfinished manual theme');expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBe(before);
  await page.getByRole('button',{name:names.apply,exact:true}).click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).customThemeInfo)).toEqual({name:'QR fixture',mode:'dark'});
  expect(await page.evaluate(()=>window.themeQrFixture.permissions)).toEqual([]);expect(external).toEqual([]);
});
test('explicit synthetic camera permission/capture stops on collapse and cancellation without reviving old work',async({page})=>{
  await fixture(page);await openLocalizedApp(page,'en');let names=await labels(page);
  await page.getByRole('button',{name:names.preferences,exact:true}).click();await page.getByText(names.summary,{exact:true}).click();
  await page.getByRole('button',{name:names.scan,exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.themeQrFixture.permissions.length)).toBe(1);
  await page.getByText(names.summary,{exact:true}).click();await page.getByText(names.summary,{exact:true}).click();await page.evaluate(()=>window.themeQrFixture.permission());
  await expect.poll(()=>page.evaluate(()=>window.themeQrFixture.stops)).toBe(1);expect(await page.evaluate(()=>window.themeQrFixture.requests)).toEqual([]);
  await expect(page.getByRole('button',{name:names.scan,exact:true})).toBeEnabled();await page.getByRole('button',{name:names.scan,exact:true}).click();await page.evaluate(()=>window.themeQrFixture.permission());
  await expect.poll(()=>page.evaluate(()=>window.themeQrFixture.requests.length)).toBe(1);
  expect(await page.evaluate(()=>window.themeQrFixture.requests[0].slice(0,3))).toEqual([255,216,255]);
  expect(await page.evaluate(()=>window.themeQrFixture.encodes[0])).toEqual({width:500,height:375,type:'image/jpeg',quality:.85});
  for(const choice of ['pt-BR','es','en-XA']){await language(page,choice);names=await labels(page);expect(await page.evaluate(()=>window.themeQrFixture.stops)).toBe(1);expect(await page.evaluate(()=>window.themeQrFixture.requests.length)).toBe(1);}
  await page.getByRole('button',{name:names.cancel,exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.themeQrFixture.stops)).toBe(2);await expect(page.getByText(names.finishing,{exact:true})).toBeVisible();
  await page.evaluate(value=>window.themeQrFixture.finish(value),payload);await expect(page.getByRole('heading',{name:'QR fixture',exact:true})).toHaveCount(0);await expect(page.getByLabel(names.file,{exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>window.themeQrFixture.permissions)).toEqual(Array(2).fill({audio:false,video:{facingMode:{ideal:'environment'}}}));
});
