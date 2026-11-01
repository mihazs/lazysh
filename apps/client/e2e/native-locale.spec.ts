import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {openPreferenceCategory} from './fixtures/workspaceControl';

test('native choice wins on cold load; explicit changes, reload and reset use native persistence',async({page})=>{
  let choice='pt-BR',revision='0';const calls:string[]=[];
  await page.exposeFunction('localeFixture',async(command:string,args:Record<string,string>)=>{
    calls.push(command);
    if(command==='ui_locale_set') {
      expect(args.expectedRevision).toBe(revision);choice=args.choice;revision=crypto.randomUUID();
    }
    return {nativeAuthority:true,choice,revision,resolvedLocale:choice==='system'?'en-GB':choice};
  });
  await installNativeBridge(page,undefined,{nativeLocale:true});
  await page.addInitScript(()=>{
    if(!localStorage.getItem('lazysh.preferences.v1'))localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,uiLanguage:'en'}));
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command.startsWith('ui_locale_'))return (window as unknown as {localeFixture:(command:string,args:unknown)=>Promise<unknown>}).localeFixture(command,args);
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Owned browser fixture; no shell.'};
      if(command==='app_icon_status')return {available:false,current:'unknown',reason:'Owned browser fixture.'};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected native fixture command: ${command}`);
    };
  });
  await page.goto('/');await expect(page.locator('html')).toHaveAttribute('lang','pt-BR');
  expect(calls).toEqual(['ui_locale_status']);
  await page.locator('.preferences-button').click();
  await openPreferenceCategory(page,'Language');
  await page.getByRole('combobox',{name:'Idioma do aplicativo',exact:true}).selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang','es');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','es');
  await page.locator('.preferences-button').click();
  await openPreferenceCategory(page,'Language');
  await expect(page.getByRole('combobox',{name:'Idioma de la aplicación',exact:true})).toHaveValue('es');
  await openPreferenceCategory(page,'Reset');
  await page.getByRole('button',{name:'Restablecer preferencias',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','en-GB');
  expect(choice).toBe('system');
});

test('a failed cosmetic getter shows retry without inventing a native setter',async({page})=>{
  let readable=false;let writes=0;
  await page.exposeFunction('localeFailureFixture',async(command:string)=>{
    if(command==='ui_locale_set'){writes++;throw new Error('Unexpected setter');}
    if(!readable)throw new Error('Owned unavailable preference fixture');
    return {nativeAuthority:true,choice:'pt-BR',resolvedLocale:'pt-BR',revision:'0'};
  });
  await installNativeBridge(page,undefined,{nativeLocale:true});
  await page.addInitScript(()=>{
    window.nativeFixtureInvoke=async(command)=>{
      if(command.startsWith('ui_locale_'))return (window as unknown as {localeFailureFixture:(command:string)=>Promise<unknown>}).localeFailureFixture(command);
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Owned browser fixture.'};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected fixture command: ${command}`);
    };
  });
  await page.goto('/');
  await expect(page.getByText('The native interface language could not be read. Your saved browser choice has not been applied.')).toBeVisible();
  const workspace=await page.locator('.app-shell').boundingBox();
  const notice=await page.getByRole('alert').boundingBox();
  expect(workspace).not.toBeNull();expect(notice).not.toBeNull();
  expect(workspace!.y).toBeGreaterThanOrEqual(notice!.y+notice!.height);
  expect(workspace!.y+workspace!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  readable=true;await page.getByRole('button',{name:'Retry language check',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','pt-BR');expect(writes).toBe(0);
});
