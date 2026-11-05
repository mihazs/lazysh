import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';

declare global{interface Window{biometricFixture:{calls:string[];exports:number;rejectExport:boolean;deleted:string[]}}}
const key='-----BEGIN OPENSSH PRIVATE KEY-----\nmocked-export-fixture\n-----END OPENSSH PRIVATE KEY-----';
const unavailable='Biometric credential protection is unavailable on this platform';
/** Mocked bridge only: native prompts, keystores and deletion are proven by Android instrumentation. */
async function open(page:Page,protection:{available:boolean;reason:string},lock:{supported:boolean;reason:string}) {
  await installNativeBridge(page,{generation:'0',...lock});
  await page.addInitScript(({protection,key})=>{
    const fixture=window.biometricFixture={calls:[],exports:0,rejectExport:true,deleted:[]};
    const hosts=[{id:'protected-host',name:'Protected host',hostname:'protected.invalid',username:'fixture',port:22,fingerprint:'SHA256:fixture',credentialsStored:true,biometricUnlock:true}];
    window.nativeFixtureInvoke=async(command,args)=>{
      fixture.calls.push(command);
      if(command==='list_hosts')return hosts.filter(host=>!fixture.deleted.includes(host.id));
      if(command==='credential_protection')return protection;
      if(command==='has_credentials')return true;
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='local_capability')return {available:false,reason:'Mocked bridge'};
      if(command==='export_saved_identity'){
        fixture.exports++;
        if(fixture.rejectExport)throw 'Credential authentication cancelled or unavailable';
        return {privateKey:key};
      }
      if(command==='delete_host'){fixture.deleted.push(String(args.hostId));return;}
      if(command.startsWith('plugin:')||command==='cancel_credential_auth')return;
      return undefined;
    };
  },{protection,key});
  await page.goto('/');
}
const hosts=async(page:Page)=>{
  const list=page.getByRole('button',{name:'Open hosts',exact:true});
  if(await list.isVisible())await list.click();
};

test('unsupported desktop biometrics disable both options and say why',async({page})=>{
  const reason='Native resume biometrics are unavailable on this platform';
  await open(page,{available:false,reason:unavailable},{supported:false,reason});
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Security');
  const lock=page.getByRole('checkbox',{name:'Lock when returning to the app',exact:true});
  await expect(lock).toBeDisabled();
  await expect(page.getByText(reason,{exact:true})).toBeVisible();
  await closePreferences(page);
  await hosts(page);
  await page.locator("button[aria-label='Add host']").click();
  const biometric=page.getByRole('checkbox',{name:'Require biometrics for saved credentials',exact:true});
  await expect(biometric).toBeDisabled();
  await expect(biometric).not.toBeChecked();
  await expect(page.getByText(unavailable,{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.biometricFixture.calls.includes('app_lock_configure'))).toBe(false);
});

test('private-key export reveals the key only after native confirmation succeeds',async({page})=>{
  await open(page,{available:true,reason:'Strong biometrics protect each credential operation'},{supported:true,reason:'Native biometric privacy cover is ready'});
  await hosts(page);
  await page.getByRole('button',{name:'Connect to Protected host',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Connect to Protected host'});
  const exportKey=dialog.getByRole('button',{name:'Export private key with biometrics',exact:true});
  await exportKey.click();
  await expect(dialog.getByRole('alert')).toContainText('Credential authentication cancelled or unavailable');
  await expect(dialog.getByLabel('Exported private key')).toHaveCount(0);
  await page.evaluate(()=>{window.biometricFixture.rejectExport=false;});
  await exportKey.click();
  await expect(dialog.getByLabel('Exported private key')).toHaveValue(key);
  expect(await page.evaluate(()=>window.biometricFixture.exports)).toBe(2);
  await dialog.getByRole('button',{name:'Hide exported key',exact:true}).click();
  await expect(dialog.getByLabel('Exported private key')).toHaveCount(0);
  expect(await page.evaluate(key=>document.body.innerText.includes(key)||[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes(key)),key)).toBe(false);
});

test('deleting a host with saved credentials goes through one native delete',async({page})=>{
  await open(page,{available:true,reason:'Strong biometrics protect each credential operation'},{supported:true,reason:'Native biometric privacy cover is ready'});
  await hosts(page);
  const connect=page.getByRole('button',{name:'Connect to Protected host',exact:true});
  await connect.hover();
  await page.getByRole('button',{name:'Delete Protected host',exact:true}).click();
  await page.getByRole('dialog',{name:'Delete host'}).getByRole('button',{name:'Delete host',exact:true}).click();
  await expect(connect).toHaveCount(0);
  expect(await page.evaluate(()=>window.biometricFixture.deleted)).toEqual(['protected-host']);
  expect(await page.evaluate(()=>window.biometricFixture.calls.filter(call=>call==='forget_credentials'))).toEqual([]);
});
