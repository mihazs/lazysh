import {expect,test} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl} from './fixtures/workspaceControl';

declare global {interface Window {choiceCalls:string[];}}

test('connecting with the session choice lists multiplexer sessions first and keeps the plain terminal',async({page})=>{
  await installNativeBridge(page);
  await page.addInitScript(()=>{
    window.choiceCalls=[];
    window.nativeFixtureInvoke=async command=>{
      window.choiceCalls.push(command);
      if(command==='list_hosts')return [{id:'choice',name:'Choice fixture',hostname:'fixture.invalid',username:'fixture-user',port:22}];
      if(command==='local_capability')return {available:false,reason:'SSH fixture only.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'choice-ssh'};
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,
        tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[{id:'$1',name:'work',windows:[]}]};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Browser fixture.'};
      if(['cancel_credential_auth','resize','ack_output','disconnect'].includes(command) || command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected session choice fixture command: ${command}`);
    };
  });
  await page.goto('/');
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Choice fixture',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Connect to Choice fixture',exact:true});
  await dialog.getByLabel('Password',{exact:true}).fill('fixture-only');
  const choice=dialog.getByRole('checkbox',{name:'Choose a multiplexer session after connecting',exact:true});
  await expect(choice).not.toBeChecked();
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await choice.check();
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();

  const panel=page.getByRole('region',{name:'Multiplexer workspaces',exact:true});
  await expect(panel.getByRole('button',{name:'Attach work',exact:true})).toBeVisible();
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  // Choosing is explicit: nothing was attached or typed, and the plain terminal stays open behind Sessions.
  expect(await page.evaluate(()=>window.choiceCalls.filter(command=>['attach_tmux','attach_multiplexer','write'].includes(command)))).toEqual([]);
  await (await workspaceControl(page,'Terminal')).click();
  await expect(page.locator('.xterm').first()).toBeVisible();
  expect(await page.evaluate(()=>window.choiceCalls.includes('disconnect'))).toBe(false);
});
