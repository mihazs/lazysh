import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {identityInfo,identityPassphrase,identityPrivateKey} from '../src/test/identityData';

type Call={command:string;args:Record<string,unknown>};
declare global {interface Window {identityFileCalls:Call[]}}
const publicKeyMessage='This is a public key. Import its corresponding private key instead.';

/** Synthetic key text only: the native decoder is mocked and never sees real credentials. */
test('imports a private key file, shows its fingerprint and connects with exactly that key',async({page},testInfo)=>{
  await installNativeBridge(page);
  await page.addInitScript(({identityInfo,identityPassphrase,publicKeyMessage})=>{
    const calls:Call[]=[];window.identityFileCalls=calls;
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [{id:'key-host',name:'Key fixture',hostname:'fixture.invalid',username:'owner',port:22}];
      if(['local_capability','apple_status_capability'].includes(command))return {available:false,reason:'Synthetic identity file fixture.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command.startsWith('plugin:event|')||['resize','ack_output','disconnect','cancel_credential_auth'].includes(command))return;
      calls.push({command,args});
      if(command==='inspect_identity'){
        const key=String(args.privateKey);
        if(key.startsWith('ssh-ed25519 '))throw {kind:'public_key_identity',message:publicKeyMessage};
        if(!key.includes('PRIVATE KEY')||args.passphrase!==identityPassphrase)throw {kind:'identity_invalid',message:'Synthetic decode failure'};
        return identityInfo;
      }
      if(command==='connect')return {sessionId:'identity-file-session'};
      throw new Error(`Unexpected identity file command: ${command}`);
    };
  },{identityInfo,identityPassphrase,publicKeyMessage});
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Key fixture',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Connect to Key fixture',exact:true});
  await dialog.getByRole('button',{name:'Private key',exact:true}).click();
  await dialog.getByText('Generate or inspect an identity',{exact:true}).click();
  const panel=dialog.getByRole('region',{name:'SSH key management',exact:true});
  await panel.getByRole('combobox',{name:'Identity source',exact:true}).selectOption('import');
  const file=panel.getByLabel('Private key file',{exact:true});
  const inspect=panel.getByRole('button',{name:'Inspect identity',exact:true});
  const calls=()=>page.evaluate(()=>window.identityFileCalls);

  await file.setInputFiles({name:'oversized_key',mimeType:'application/octet-stream',buffer:Buffer.alloc(64*1024+1,'A')});
  await expect(panel.getByRole('alert')).toHaveText('Choose a private key file no larger than 64 KiB.');
  await expect(inspect).toBeDisabled();

  await file.setInputFiles({name:'id_ed25519.pub',mimeType:'application/octet-stream',buffer:Buffer.from(`${identityInfo.publicKey} fixture\n`)});
  await expect(panel.getByText('Loaded id_ed25519.pub. Its contents stay in memory.',{exact:true})).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await inspect.click();
  await expect(panel.getByRole('alert')).toHaveText(publicKeyMessage);
  await expect(panel.getByRole('button',{name:'Use for connection',exact:true})).toHaveCount(0);

  await file.setInputFiles({name:'id_ed25519',mimeType:'application/octet-stream',buffer:Buffer.from(identityPrivateKey)});
  await expect(panel.getByText('Loaded id_ed25519. Its contents stay in memory.',{exact:true})).toBeVisible();
  // A loaded file replaces the paste field so its private contents are never rendered.
  await expect(panel.getByRole('textbox',{name:'Private key',exact:true})).toHaveCount(0);
  await expect(panel).not.toContainText('SYNTHETIC');
  await panel.getByLabel('Key passphrase',{exact:true}).fill(identityPassphrase);
  await inspect.click();
  await expect(panel.getByText(identityInfo.fingerprint,{exact:true})).toBeVisible();
  await expect(panel.getByRole('textbox',{name:'Public key',exact:true})).toHaveValue(identityInfo.publicKey);
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await panel.getByRole('button',{name:'Use for connection',exact:true}).click();

  await expect(dialog.getByRole('textbox',{name:'Private key (OpenSSH or PEM)',exact:true})).toHaveValue(identityPrivateKey);
  await expect(dialog.getByLabel('Key passphrase (if encrypted)',{exact:true})).toHaveValue(identityPassphrase);
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  const inspected=(await calls()).filter(call=>call.command==='inspect_identity');
  expect(inspected.map(call=>call.args.privateKey)).toEqual([`${identityInfo.publicKey} fixture\n`,identityPrivateKey]);
  const connects=(await calls()).filter(call=>call.command==='connect');
  expect(connects).toHaveLength(1);
  expect(connects[0].args).toMatchObject({hostId:'key-host',privateKey:identityPrivateKey,passphrase:identityPassphrase});
  expect(connects[0].args).not.toHaveProperty('rememberCredentials',true);
  expect(await page.evaluate(({key,passphrase})=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>value.includes(key)||value.includes(passphrase)),{key:identityPrivateKey,passphrase:identityPassphrase})).toBe(false);
});
