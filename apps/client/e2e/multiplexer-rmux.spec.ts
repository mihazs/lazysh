import {expect,test,type Page} from '@playwright/test';
import {workspaceControl} from './fixtures/workspaceControl';
import {installNativeBridge} from './fixtures/nativeBridge';

type Tool={kind:'tmux'|'rmux';version:string;support:'full'|'degraded'|'unsupported';missing:string[];reason?:'capabilities'|'daemonWire'};
type Calls=Window&{muxCalls?:{command:string;args:Record<string,unknown>}[]};
const tmuxTool:Tool={kind:'tmux',version:'3.5a',support:'full',missing:[]};
const limited:Tool={kind:'rmux',version:'0.10.0',support:'degraded',missing:['jump','confirmedInput']};
const window1={id:'@1',index:0,name:'agent',active:true,panes:[{id:'%1',index:0,active:true,command:'bash',path:'/work'}]};

/** A host whose discovery reports the given tools; tmux and rmux each own one session. */
async function openSessions(page:Page,rmux:Tool,workspace:object[]=[{hostId:'fixture'}],tab?:string) {
  await installNativeBridge(page);
  await page.addInitScript(({rmux,workspace,tmuxTool,window1})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify(workspace));
    const calls:{command:string;args:Record<string,unknown>}[]=[];
    (window as Window&{muxCalls?:typeof calls}).muxCalls=calls;
    window.nativeFixtureInvoke=async (command,args)=>{
      if(!['resize','ack_output','disconnect','tmux_jump_snapshot'].includes(command) && !command.startsWith('plugin:event|'))calls.push({command,args});
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'localhost',port:22,username:'test'}];
      if(command==='local_capability')return {available:false,reason:'SSH fixture only.'};
      if(command==='connect')return {sessionId:`ssh-${calls.length}`};
      if(command==='attach_multiplexer'||command==='attach_tmux')return {sessionId:'display'};
      if(command==='multiplexer_tree'){
        const mine=args.kind==='rmux'?{id:'$7',name:'work',windows:[window1]}:{id:'$1',name:'shell',windows:[window1]};
        return {tmuxAvailable:true,rmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[tmuxTool,rmux],sessions:[mine]};
      }
      if(command==='tmux_jump_snapshot')return {generation:'g',current:{sessionId:'$7',windowId:'@1'},sessions:[{id:'$7',name:'work',restoreName:'work',windows:[{id:'@1',index:0,name:'agent'}]}]};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Browser fixture.'};
      if(['resize','ack_output','disconnect'].includes(command) || command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected rmux fixture command: ${command}`);
    };
  },{rmux,workspace,tmuxTool,window1});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  // One restored session shows no tab strip; the Sessions panel belongs to whichever session is visible.
  if(tab)await page.getByRole('tab',{name:tab,exact:true}).click();
  await (await workspaceControl(page,'Sessions')).click();
  const panel=page.getByRole('region',{name:'Multiplexer workspaces',exact:true});
  await expect(panel).toBeVisible();
  return panel;
}

test('rmux is labelled in Sessions, browsed as its own family and attached with the rmux kind',async({page})=>{
  const panel=await openSessions(page,limited);
  await expect(panel).toContainText('tmux 3.5a (Supported)');
  await expect(panel).toContainText('rmux 0.10.0 (Limited)');
  await expect(panel.getByRole('note')).toHaveText([/as a terminal with window and pane actions/]);
  await expect(panel.locator('.mux-list > details > summary')).toHaveText([/^shell · /]);
  await panel.getByRole('button',{name:'Browse rmux sessions',exact:true}).click();
  await expect(panel.getByText('rmux server',{exact:true})).toBeVisible();
  await expect(panel.locator('.mux-list > details > summary')).toHaveText([/^rmux: work · /]);
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await panel.getByRole('button',{name:'Attach work',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Fixture / work',exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>(window as Calls).muxCalls!);
  expect(calls.find(call=>call.command==='attach_multiplexer')?.args).toMatchObject({kind:'rmux',name:'work'});
  // The tree request that listed these sessions named the rmux family; tmux's own request names none.
  expect(calls.filter(call=>call.command==='multiplexer_tree').map(call=>call.args.kind)).toContain('rmux');
});

for(const [reason,notice] of [
  ['daemonWire','Restart the rmux daemon after upgrading.'],
  ['capabilities','This rmux is not supported. It must report binary contract 1, wire version 8 and control mode (rmux 0.10.x).'],
] as const)test(`an unsupported rmux (${reason}) is reported with its own notice and cannot be browsed`,async({page})=>{
  const panel=await openSessions(page,{kind:'rmux',version:'0.10.0',support:'unsupported',missing:[],reason});
  await expect(panel).toContainText('rmux 0.10.0 (Unsupported)');
  await expect(panel.getByRole('note')).toHaveText([notice]);
  await expect(panel.getByRole('button',{name:'Browse rmux sessions',exact:true})).toHaveCount(0);
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});

test('an attached limited rmux session offers no Jump To and keeps its rmux identity across a restore',async({page})=>{
  const panel=await openSessions(page,limited,[{hostId:'fixture'},{hostId:'fixture',attached:{kind:'rmux',name:'work'}}],'Fixture / work');
  await expect(panel.getByRole('note')).toHaveText([/as a terminal with window and pane actions/]);
  await expect(page.locator('button').filter({hasText:/^Jump To$/})).toHaveCount(0);
  const calls=await page.evaluate(()=>(window as Calls).muxCalls!);
  expect(calls.find(call=>call.command==='attach_multiplexer')?.args).toMatchObject({kind:'rmux',name:'work'});
});
