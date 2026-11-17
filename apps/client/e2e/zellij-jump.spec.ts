import {expect,test} from '@playwright/test';
import {workspaceControl} from './fixtures/workspaceControl';
import {installNativeBridge} from './fixtures/nativeBridge';
import {connectHost} from './fixtures/connectHost';

type Call = {command:string;args:Record<string,unknown>};
declare global { interface Window { zellijJump: {calls: Call[]} } }

const tabs=[{id:4,position:0,name:'shell',active:true},{id:9,position:1,name:"logs '$(touch NO)'",active:false},{id:12,position:2,name:'build',active:false}];

async function open(page:import('@playwright/test').Page,{support,missing}:{support:'full'|'degraded';missing:string[]},phone:boolean) {
  await installNativeBridge(page);
  await page.addInitScript(({support,missing,tabs})=>{
    window.zellijJump={calls:[]};
    let connections=0,active=tabs[0].id;
    window.nativeFixtureInvoke=async (command,args={})=>{
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'localhost',port:22,username:'test'}];
      if(command==='local_capability')return {available:false,reason:'SSH fixture only.'};
      if(command==='connect')return {sessionId:`ssh-${++connections}`};
      if(command==='attach_multiplexer')return {sessionId:'display'};
      if(command==='multiplexer_sessions')return [{name:'work'}];
      if(command==='multiplexer_tree')return {tmuxAvailable:false,herdrAvailable:false,zellijAvailable:true,tools:[{kind:'zellij',version:support==='full'?'0.45.1':'0.44.3',support,missing}],sessions:[]};
      if(command==='zellij_tabs')return tabs.map(({position,name,id})=>({position,name,active:id===active}));
      if(command==='zellij_tree'){window.zellijJump.calls.push({command,args});return {tabs:tabs.map(tab=>({...tab,active:tab.id===active,panes:[{id:tab.id*2,title:'sh',focused:true}]}))};}
      if(command==='zellij_action'){window.zellijJump.calls.push({command,args});active=(args.action as {tabId:number}).tabId;return;}
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Browser fixture.'};
      if(['resize','ack_output','disconnect'].includes(command) || command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected Zellij jump fixture command: ${command}`);
    };
  },{support,missing,tabs});
  await connectHost(page,'Fixture',phone);
  await (await workspaceControl(page,'Sessions')).click();
  await page.getByRole('button',{name:'List zellij sessions',exact:true}).click();
  await page.getByRole('button',{name:'Attach zellij work',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Fixture / work',exact:true})).toBeVisible();
}

test('Zellij Jump To lists the tabs with exactly one current row and jumps by the tab id',async({page},testInfo)=>{
  await open(page,{support:'full',missing:[]},testInfo.project.name==='phone');
  await (await workspaceControl(page,'Jump To')).click();
  const panel=page.getByRole('region',{name:'Zellij Jump To',exact:true});
  await expect(panel.getByRole('button',{name:'1: shell · Current',exact:true})).toHaveAttribute('aria-current','location');
  await expect(panel.getByRole('button',{name:"2: logs '$(touch NO)'",exact:true})).toBeVisible();
  await expect(panel.locator('[aria-current]')).toHaveCount(1);
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await panel.getByRole('button',{name:"2: logs '$(touch NO)'",exact:true}).click();
  expect((await page.evaluate(()=>window.zellijJump.calls)).filter(call=>call.command==='zellij_action')).toEqual([
    {command:'zellij_action',args:{sessionId:'display',name:'work',action:{type:'jump',tabId:9}}},
  ]);
  // A phone closes the menu after a jump; the next read shows the moved current row.
  if(testInfo.project.name==='phone'){await expect(panel).toHaveCount(0);await (await workspaceControl(page,'Jump To')).click();}
  await expect(panel.getByRole('button',{name:"2: logs '$(touch NO)' · Current",exact:true})).toHaveAttribute('aria-current','location');
  await expect(panel.locator('[aria-current]')).toHaveCount(1);
});

test('Zellij 0.44 without the tree capability offers no Jump To',async({page},testInfo)=>{
  await open(page,{support:'degraded',missing:['tree','close','resize','launch','confirmedInput']},testInfo.project.name==='phone');
  await expect(page.locator('button').filter({hasText:/^Jump To$/})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Zellij Jump To',exact:true})).toHaveCount(0);
  expect((await page.evaluate(()=>window.zellijJump.calls)).filter(call=>call.command==='zellij_tree')).toEqual([]);
});
