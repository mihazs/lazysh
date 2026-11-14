import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl} from './fixtures/workspaceControl';
import {companionSettings} from '../src/test/agentBoardData';

declare global { interface Window { companionCalls:{command:string;sessionId:unknown}[];reportedEvents:number;localConnects:number } }
const tabs=['local:12345678-1234-4234-8234-123456789abc','local:87654321-1234-4234-8234-123456789abc'];
const report={sessionId:'claude-1',agent:'Claude Code',project:'/home/dev/lazysh',state:'needs_attention',updatedAt:'2026-10-25T12:34:56.000Z',summary:'Wants to run the tests',paneId:null,eventCount:1};
const companionCommands=['agent_snapshot','agent_approvals','get_companion_settings','notify_agent_attention'];

/** A local target whose reported tools are `companion`; the bridge records every companion call with the session it names. */
async function openLocal(page:Page,companion:boolean|undefined,inbox:{monitoring:boolean;notifications:boolean}={monitoring:false,notifications:false}) {
  await installNativeBridge(page);
  await page.addInitScript(({tabs,companion,report,settings,inbox,companionCommands})=>{
    window.companionCalls=[];
    window.localConnects=0;
    window.reportedEvents=1;
    // The plugin trusts the web permission when it is not undecided; the fixture grants it.
    Object.defineProperty(window.Notification,'permission',{get:()=>'granted'});
    localStorage.setItem('lazysh.inbox.v1',JSON.stringify({version:1,...inbox,rows:[],latest:{}}));
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:true,reason:'Synthetic local fixture; no shell runs.',targets:[{id:'default',label:'bash',kind:'posix',tools:{files:false,repository:false,...(companion===undefined?{}:{companion})}}]};
      if(command==='local_connect')return {sessionId:tabs[window.localConnects++]};
      if(command.startsWith('plugin:')||['local_resize','local_ack','local_write','local_disconnect','notification_test'].includes(command))return;
      if(command==='account_usage')return {schemaVersion:1,state:'unavailable',source:null,report:null};
      if(command==='board_keep_awake_status')return {available:false,active:false,reason:'Synthetic',epoch:'0/11111111-1111-4111-8111-111111111111',ticket:1};
      if(companionCommands.includes(command)){
        window.companionCalls.push({command,sessionId:args.sessionId});
        if(command==='agent_snapshot')return {schemaVersion:1,sessions:[{...report,eventCount:window.reportedEvents,updatedAt:new Date(Date.parse(report.updatedAt)+window.reportedEvents*60000).toISOString()}]};
        if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
        if(command==='get_companion_settings')return settings;
        return;
      }
      throw new Error(`Unexpected local fixture command: ${command}`);
    };
  },{tabs,companion,report,settings:companionSettings,inbox,companionCommands});
  await page.goto('/');
  await openTab(page,1);
}
async function openTab(page:Page,count:number) {
  if(test.info().project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const open=page.getByRole('button',{name:'Open local terminal',exact:true});
  // A session with a companion opens the menu on Agents; the connections page lists the local terminal.
  if(!await open.isVisible())await page.locator('[data-workspace-mode=connections]').click();
  await open.click();
  await expect(page.getByText('Local PTY').first()).toBeVisible();
  expect(await page.evaluate(()=>window.localConnects)).toBe(count);
}
const calls=(page:Page,command:string)=>page.evaluate(command=>window.companionCalls.filter(call=>call.command===command),command);

test('a local session with the companion shows its Agents board under This device',async({page})=>{
  await openLocal(page,true);
  await expect(page.locator('.security-note')).toContainText('agents, transcripts and usage use this device');
  await (await workspaceControl(page,'Agents')).click();
  const group=page.getByRole('region',{name:'lazysh on This device',exact:true});
  await expect(group).toContainText('Wants to run the tests');
  expect((await calls(page,'agent_snapshot')).every(call=>call.sessionId===tabs[0])).toBe(true);
  expect((await calls(page,'agent_approvals')).length).toBeGreaterThan(0);
});

test('a local target without the companion hides the views and says why',async({page})=>{
  await openLocal(page,false);
  await expect(page.locator('.security-note')).toContainText('need lazysh-agent, which was not found on this device');
  await workspaceControl(page,'Dictate');
  for(const name of ['Agents','Transcript','Apple status'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>window.companionCalls)).toEqual([]);
});

test('two local tabs on one target poll the companion once and an attention event raises a notification',async({page})=>{
  await openLocal(page,true,{monitoring:true,notifications:true});
  await openTab(page,2);
  const inbox=await openInbox(page);
  await expect(inbox.getByRole('article',{name:'Claude Code'})).toContainText('This device');
  await expect.poll(async()=>(await calls(page,'agent_snapshot')).length).toBeGreaterThan(0);
  await page.evaluate(()=>{window.companionCalls=[];});
  await inbox.getByRole('button',{name:'Refresh inbox',exact:true}).click();
  await expect.poll(async()=>(await calls(page,'agent_snapshot')).length).toBe(1);
  expect(await calls(page,'notify_agent_attention')).toEqual([]);
  await page.evaluate(()=>{window.reportedEvents=2;window.companionCalls=[];});
  await inbox.getByRole('button',{name:'Refresh inbox',exact:true}).click();
  await expect.poll(async()=>(await calls(page,'notify_agent_attention')).length).toBe(1);
  expect((await calls(page,'agent_snapshot')).length).toBe(1);
  expect(tabs).toContain((await calls(page,'notify_agent_attention'))[0].sessionId);
});

async function openInbox(page:Page) {
  await (await workspaceControl(page,'Open notification inbox')).click();
  const inbox=page.getByRole('region',{name:'Agent inbox',exact:true});
  await expect(inbox).toBeVisible();
  return inbox;
}
