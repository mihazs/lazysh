import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl} from './fixtures/workspaceControl';
import {openLocalFromConnections} from './fixtures/localTerminal';

type Call={command:string;args:Record<string,unknown>};
declare global { interface Window { localMuxCalls:Call[] } }
const shell='local:11111111-1111-4111-8111-111111111111';
const display='local:22222222-2222-4222-8222-222222222222';
const tools={files:true,repository:true,companion:false,tmux:true,herdr:false,zellij:false};
const sent=(page:Page,...commands:string[])=>page.evaluate(commands=>window.localMuxCalls.filter(call=>commands.includes(call.command)),commands);

/** Installs a native bridge whose local target reports `targetTools`; `local_connect` with an `attach` entry opens a second local terminal, as the native side does. */
async function installFixture(page:Page,targetTools:Record<string,boolean>,seed?:{workspace?:unknown[];tabStrip?:'on'}) {
  await installNativeBridge(page);
  await page.addInitScript(({shell,display,targetTools,seed})=>{
    window.localMuxCalls=[];
    if(seed?.workspace)localStorage.setItem('lazysh.workspace.v1',JSON.stringify(seed.workspace));
    if(seed?.tabStrip)localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,tabStrip:seed.tabStrip}));
    let snapshot={generation:'g'.repeat(36),current:{sessionId:'$1',windowId:'@1'},sessions:[{id:'$1',name:'work',restoreName:'work',windows:[{id:'@1',index:0,name:'agent'},{id:'@2',index:1,name:'compiler'}]}]};
    let opened=0;
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:true,reason:'Synthetic local fixture; no shell runs.',targets:[{id:'default',label:'bash',kind:'posix',tools:targetTools}]};
      if(command==='local_connect'){
        window.localMuxCalls.push({command,args:{attach:args.attach}});
        return {sessionId:args.attach?`${display}-${++opened}`:shell};
      }
      if(command==='board_keep_awake_status')return {available:false,active:false,reason:'Synthetic',epoch:'0/11111111-1111-4111-8111-111111111111',ticket:1};
      if(command.startsWith('plugin:')||['local_resize','local_ack','local_write','local_disconnect'].includes(command))return;
      if(command==='account_usage')return {schemaVersion:1,state:'unavailable',source:null,report:null};
      window.localMuxCalls.push({command,args});
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],
        sessions:[{id:'$1',name:'work',windows:[{id:'@1',index:0,name:'agent',active:true,panes:[]}]}]};
      if(command==='tmux_jump_snapshot')return snapshot;
      if(command==='tmux_jump'){snapshot={...snapshot,generation:'h'.repeat(36),current:{sessionId:String(args.targetSessionId),windowId:String(args.windowId)}};return snapshot;}
      throw new Error(`Unexpected local multiplexer fixture command: ${command}`);
    };
  },{shell,display,targetTools,seed});
}

test('a local session lists its tmux sessions, attaches one and jumps windows on the attached terminal',async({page})=>{
  await installFixture(page,tools);
  await page.goto('/');await openLocalFromConnections(page,test.info());
  await (await workspaceControl(page,'Sessions')).click();
  const manager=page.getByRole('region',{name:'Multiplexer workspaces',exact:true});
  await expect(manager.getByText('tmux 3.4 (Supported)')).toBeVisible();
  await manager.getByRole('button',{name:'Attach work',exact:true}).click();
  await expect(page.getByRole('tab',{name:/Local terminal \/ work/})).toHaveAttribute('aria-selected','true');
  // Discovery reads the shell the manager belongs to, then the attached terminal the way it reads any displayed session.
  expect([...new Set((await sent(page,'multiplexer_tree')).map(call=>call.args.sessionId))]).toEqual([shell,`${display}-1`]);
  expect(await page.evaluate(()=>window.localMuxCalls.filter(call=>call.command==='local_connect').map(call=>call.args))).toEqual([{attach:undefined},{attach:{kind:'tmux',name:'work'}}]);
  await (await workspaceControl(page,'Jump To')).click();
  const jump=page.locator('.workspace-navigation-content').getByRole('region');
  await jump.getByRole('button',{name:'1: compiler',exact:true}).click();
  await expect.poll(()=>sent(page,'tmux_jump')).toHaveLength(1);
  const [jumped]=await sent(page,'tmux_jump');
  expect(jumped.args).toMatchObject({sessionId:`${display}-1`,targetSessionId:'$1',windowId:'@2'});
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.workspace.v1')!))).toEqual([{local:true},{local:true,attached:{kind:'tmux',name:'work'}}]);
});

test('a local session whose target reports no multiplexer hides Sessions and says why',async({page})=>{
  await installFixture(page,{...tools,tmux:false});
  await page.goto('/');await openLocalFromConnections(page,test.info());
  await workspaceControl(page,'Dictate');
  await expect(page.getByRole('button',{name:'Sessions',exact:true})).toHaveCount(0);
  await expect(page.getByText("Sessions and Jump To need tmux, Zellij or Herdr on this device's PATH. None was found.")).toBeVisible();
  expect(await sent(page,'multiplexer_tree','tmux_jump_snapshot')).toEqual([]);
});

test('a restored local tmux terminal shows its tab strip and a local Herdr terminal stays a plain terminal',async({page})=>{
  await installFixture(page,{...tools,herdr:true},{tabStrip:'on',workspace:[{local:true,attached:{kind:'tmux',name:'work'}},{local:true,attached:{kind:'herdr',name:'dev'}}]});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(await page.evaluate(()=>window.localMuxCalls.filter(call=>call.command==='local_connect').map(call=>call.args))).toEqual([{attach:{kind:'tmux',name:'work',createIfMissing:false}},{attach:{kind:'herdr',name:'dev',createIfMissing:false}}]);
  await page.getByRole('tab',{name:/Local terminal \/ work/}).click();
  await expect(page.getByRole('group',{name:'tmux tabs',exact:true}).locator('.mux-chip')).toHaveCount(2);
  await page.getByRole('tab',{name:/Local terminal \/ dev/}).click();
  await expect(page.getByRole('tab',{name:/Local terminal \/ dev/})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('group',{name:'herdr tabs',exact:true})).toHaveCount(0);
  await expect.poll(()=>sent(page,'herdr_tree','herdr_action')).toEqual([]);
});
