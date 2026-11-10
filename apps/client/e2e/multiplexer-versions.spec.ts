import {expect,test} from '@playwright/test';
import {workspaceControl} from './fixtures/workspaceControl';
import {installNativeBridge} from './fixtures/nativeBridge';

for(const [version,support] of [['3.2a','degraded'],['3.4','full']] as const)test(`tmux ${version} discovery shows its version and ${support==='full'?'keeps':'hides'} Jump To`,async({page})=>{
  await installNativeBridge(page);
  await page.addInitScript(({version,support})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture'},{hostId:'fixture',attached:{kind:'tmux',name:'work'}}]));
    let connections=0,discoveryReleased=false;
    const pendingDiscovery:(()=>void)[]=[];
    (window as Window & {pendingMuxDiscovery?:()=>number;releaseMuxDiscovery?:()=>void}).pendingMuxDiscovery=()=>pendingDiscovery.length;
    (window as Window & {releaseMuxDiscovery?:()=>void}).releaseMuxDiscovery=()=>pendingDiscovery.shift()?.();
    window.nativeFixtureInvoke=async (command,args)=>{
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'localhost',port:22,username:'test'}];
      if(command==='local_capability')return {available:false,reason:'SSH fixture only.'};
      if(command==='connect')return {sessionId:`ssh-${++connections}`};
      if(command==='attach_tmux')return {sessionId:'display'};
      if(command==='multiplexer_tree'){
        if(args.sessionId==='display' && !discoveryReleased)await new Promise<void>(resolve=>{pendingDiscovery.push(()=>{discoveryReleased=true;resolve();});});
        return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,
          tools:[{kind:'tmux',version,support,missing:support==='full'?[]:['jump','confirmedInput']}],sessions:[{id:'$1',name:'work',windows:[]}]};
      }
      if(command==='tmux_jump_snapshot')return {generation:'g',current:{sessionId:'$1',windowId:'@1'},sessions:[{id:'$1',name:'work',restoreName:'work',windows:[{id:'@1',index:0,name:'agent'}]}]};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Browser fixture.'};
      if(['resize','ack_output','disconnect'].includes(command) || command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected multiplexer version fixture command: ${command}`);
    };
  },{version,support});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as Window & {pendingMuxDiscovery?:()=>number}).pendingMuxDiscovery?.())).toBe(1);
  await page.getByRole('tab',{name:'Fixture',exact:true}).click();
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as Window & {pendingMuxDiscovery?:()=>number}).pendingMuxDiscovery?.())).toBe(2);
  await page.evaluate(()=>(window as Window & {releaseMuxDiscovery?:()=>void}).releaseMuxDiscovery?.());
  await expect(page.locator('button').filter({hasText:/^Jump To$/})).toHaveCount(0);
  await page.evaluate(()=>(window as Window & {releaseMuxDiscovery?:()=>void}).releaseMuxDiscovery?.());
  if(support==='full')await expect(await workspaceControl(page,'Jump To')).toBeVisible();
  await (await workspaceControl(page,'Sessions')).click();
  const panel=page.getByRole('region',{name:'Multiplexer workspaces',exact:true});
  await expect(panel).toContainText(`tmux ${version} (${support==='full'?'Supported':'Limited'})`);
  await expect(panel.getByRole('note')).toHaveText(support==='full'?[]:['Jump To and Chat input need tmux 3.4 or newer.']);
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  // Every surface that offers Jump To, including hidden tool pages, follows the version gate.
  if(support==='full')await expect(await workspaceControl(page,'Jump To')).toBeVisible();
  else {
    const trigger=page.locator('.workspace-tools-trigger:visible, button[aria-label="Workspace tools"]:visible').first();
    await trigger.click();
    await expect(page.locator('.workspace-tools-content')).toBeVisible();
    await expect(page.locator('button').filter({hasText:/^Jump To$/})).toHaveCount(0);
    await expect(page.getByRole('region',{name:'tmux Jump To',exact:true})).toHaveCount(0);
  }
});
