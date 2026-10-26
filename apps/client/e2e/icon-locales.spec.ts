import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
declare global{interface Window{iconLocaleFixture:{calls:{command:string;args:Record<string,unknown>}[];allowRead:()=>void;finishApply:(value:unknown)=>void;}}}
for(const initial of ['en','pt-BR','es','en-XA'])test(`${initial} icon errors stay live while held native payload and original controls remain unchanged`,async({page})=>{
  await installNativeBridge(page,undefined,{nativeEvents:true});
  await page.addInitScript(()=>{
    let failRead=true,finishApply:(value:unknown)=>void=()=>{};
    const calls:{command:string;args:Record<string,unknown>}[]=[];
    window.iconLocaleFixture={calls,allowRead(){failRead=false;},finishApply(value){finishApply(value);}};
    window.nativeFixtureInvoke=async(command,args)=>{
      calls.push({command,args});
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Synthetic icon fixture; no shell runs.'};
      if(command==='app_icon_status'){
        if(failRead)throw new Error('RAW native read failed');
        return {available:true,current:'default',reason:'RAW native reason <{{value}}>'};
      }
      if(command==='set_app_icon')return new Promise(resolve=>{finishApply=resolve;});
      throw new Error(`Unexpected icon locale command: ${command}`);
    };
  });
  const external:string[]=[];page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:1420'))external.push(request.url());});
  await page.goto('/');await page.getByRole('button',{name:'Preferences',exact:true}).click();
  const locale=async(value:string)=>page.evaluate(async value=>{const{uiI18n}=await import('/src/i18n/core.ts');if(value==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');await enablePseudoLocale(uiI18n);}else await uiI18n.changeLanguage(value);},value);
  const labels=()=>page.evaluate(async()=>{const{t}=await import('/src/i18n/core.ts');return {group:t('iconsAppIcon'),select:t('iconsHomeScreenIcon'),readFailure:t('iconsCannotReadTheCurrentAppIconTryRefreshing'),invalid:t('iconsCannotReadTheCurrentAppIcon'),refresh:t('iconsRefreshAppIcon'),apply:t('iconsApplyAppIcon'),changing:t('iconsChangingIcon')};});
  await expect(page.getByRole('alert')).toBeVisible();await locale(initial);let names=await labels();
  const groupNode=await page.getByRole('group',{name:names.group,exact:true}).elementHandle();
  const before=await page.evaluate(()=>window.iconLocaleFixture.calls);
  // StrictMode can replay mount; explicit refresh and failure each add exactly one read.
  const initialReads=before.filter(call=>call.command==='app_icon_status').length;
  for(const choice of ['en','pt-BR','es','en-XA']){
    await locale(choice);names=await labels();const group=page.getByRole('group',{name:names.group,exact:true});
    await expect(group.getByRole('alert')).toHaveText(names.readFailure);
    expect(await groupNode!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await page.evaluate(()=>window.iconLocaleFixture.calls)).toEqual(before);
    const size=await page.locator('.preferences-panel').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width);
  }
  await page.evaluate(()=>window.iconLocaleFixture.allowRead());await page.getByRole('button',{name:names.refresh,exact:true}).click();
  const select=page.getByRole('combobox',{name:names.select,exact:true});await expect(select).toBeEnabled();await select.selectOption('amber');
  expect((await page.evaluate(()=>window.iconLocaleFixture.calls)).filter(call=>call.command==='app_icon_status')).toHaveLength(initialReads+1);
  const selectNode=await select.elementHandle();await page.getByRole('button',{name:names.apply,exact:true}).click();
  const held=await page.evaluate(()=>window.iconLocaleFixture.calls);
  expect(held.filter(call=>call.command==='app_icon_status')).toHaveLength(initialReads+1);
  for(const choice of ['pt-BR','es','en-XA']){
    await locale(choice);names=await labels();const control=page.getByRole('combobox',{name:names.select,exact:true});
    await expect(control).toHaveValue('amber');await expect(control).toBeDisabled();
    expect(await selectNode!.evaluate(node=>node.isConnected)).toBe(true);
    await expect(page.getByRole('button',{name:names.changing,exact:true})).toBeDisabled();
    expect(await page.evaluate(()=>window.iconLocaleFixture.calls)).toEqual(held);
  }
  expect(held.filter(call=>call.command==='set_app_icon')).toEqual([{command:'set_app_icon',args:{icon:'amber'}}]);
  await page.evaluate(()=>window.iconLocaleFixture.finishApply(null));
  await expect(page.getByRole('combobox',{name:names.select,exact:true})).toHaveValue('default');
  const settled=await page.evaluate(()=>window.iconLocaleFixture.calls);
  for(const choice of ['en','pt-BR','es','en-XA']){
    await locale(choice);names=await labels();const group=page.getByRole('group',{name:names.group,exact:true});
    await expect(group.getByRole('alert')).toHaveText(names.invalid);
    await expect(group.getByText('RAW native reason <{{value}}>',{exact:true})).toBeVisible();
    expect(await page.evaluate(()=>window.iconLocaleFixture.calls)).toEqual(settled);
  }
  expect(settled.filter(call=>call.command==='app_icon_status')).toHaveLength(initialReads+2);
  expect(external).toEqual([]);
});
