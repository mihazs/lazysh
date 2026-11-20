import {workspaceControl} from './fixtures/workspaceControl';
import { expect, test, type Page } from '@playwright/test';

declare global { interface Window {
  tmuxJumpFixture: { jumps: Record<string, unknown>[]; attachments: Record<string,unknown>[]; reads: number; defer: boolean; finish?: () => void };
} }

type JumpPane = {id:string;index:number;title:string;command:string;active:boolean};
type JumpSnapshot = {generation:string;current:{sessionId:string;windowId:string;paneId?:string};
  sessions:{id:string;name:string;restoreName:string;windows:{id:string;index:number;name:string;zoomed?:boolean;panes?:JumpPane[]}[]}[]};
const windowSnapshot:JumpSnapshot = {generation:'retained-actor',current:{sessionId:'$1',windowId:'@1'},sessions:[
  {id:'$1',name:'work',restoreName:'work',windows:[{id:'@1',index:0,name:'agent'}]},
  {id:'$2',name:'builds',restoreName:'builds',windows:[{id:'@2',index:1,name:'compiler'}]},
]};
/** Runs in the page: a host whose attached tmux display answers Jump To with `initial` and records every jump it is asked for. */
function installTmuxFixture({server,initial,reports,layout='grid'}:{server?:string;initial:JumpSnapshot;reports:Record<string,unknown>[];layout?:string}) {
  localStorage.setItem('lazysh.workspace.v1', JSON.stringify([{hostId:'fixture'},{hostId:'fixture',attached:{kind:'tmux',name:'work',...(server===undefined?{}:{tmuxServer:server})}}]));
  localStorage.setItem('lazysh.multiplexer.layout', layout);
  window.tmuxJumpFixture = {jumps:[],attachments:[],reads:0,defer:false};
  let snapshot = initial;
  let connections=0;
  Object.defineProperty(window,'isTauri',{value:true});
  Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{
    transformCallback:()=>1,unregisterCallback:()=>{},
    invoke:async(command:string,args:Record<string,unknown>={})=>{
      if(command==='app_lock_status')return {initialized:true,supported:false,reason:'Synthetic tmux UI fixture; no remote process runs.',enabled:false,locked:false,generation:'0'};
      if(command==='ui_locale_status')return {nativeAuthority:false};
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'localhost',port:22,username:'test'}];
      if(command==='local_capability')return {available:false,reason:'SSH fixture only.'};
      if(command==='connect')return {sessionId:`ssh-${++connections}`};
      if(command==='attach_tmux'){window.tmuxJumpFixture.attachments.push(args);return {sessionId:'display'};}
      if(command==='multiplexer_tree')return {tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}]};
      if(command==='tmux_jump_snapshot'){window.tmuxJumpFixture.reads++;return snapshot;}
      if(command==='tmux_jump'){
        window.tmuxJumpFixture.jumps.push(args);
        const target=snapshot.sessions.find(item=>item.id===args.targetSessionId)?.windows.find(item=>item.id===args.windowId);
        const paneId=args.paneId??target?.panes?.find(pane=>pane.active)?.id;
        const result={...snapshot,generation:`returned-${window.tmuxJumpFixture.jumps.length}`,current:{sessionId:String(args.targetSessionId),windowId:String(args.windowId),...(paneId===undefined?{}:{paneId:String(paneId)})}};
        if(window.tmuxJumpFixture.defer)return new Promise(resolve=>{window.tmuxJumpFixture.finish=()=>{snapshot=result;resolve(result);};});
        snapshot=result;return result;
      }
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:reports};
      if(command==='apple_status_capability')return {available:false,reason:'Browser fixture.'};
      if(['app_lock_ready','adopt_session','resize','ack_output','disconnect'].includes(command))return;
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected tmux UI fixture command: ${command}`);
    },
  }});
}

async function restoreWorkspace(page:Page) {
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
}

for(const server of [undefined, "世界 '$(touch NO);"])test(`attached display Jump To preserves server ${server ?? 'default'} and drops a late result after switching terminals`, async ({ page },testInfo) => {
  await page.addInitScript(installTmuxFixture,{server,initial:windowSnapshot,reports:[]});
  await restoreWorkspace(page);
  expect(await page.evaluate(()=>window.tmuxJumpFixture.attachments.map(({sessionId,name,tmuxServer})=>({sessionId,name,...(tmuxServer===undefined?{}:{tmuxServer})})))).toEqual([{sessionId:'ssh-2',name:'work',...(server===undefined?{}:{tmuxServer:server})}]);
  await expect(page.getByRole('button',{name:'Jump To',exact:true})).toHaveCount(0);
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click();
  const trigger=await workspaceControl(page,'Jump To');
  await expect(trigger).toBeVisible();
  const bounds=await trigger.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await trigger.click();
  const dialog=page.locator('.workspace-navigation-content').getByRole('region');
  await expect(page.getByRole('dialog',{name:'Jump To',exact:true})).toHaveCount(0);
  const layout=dialog.getByRole('combobox',{name:'Jump To layout',exact:true});
  await expect(layout).toHaveValue('grid');
  await expect(dialog.getByRole('button',{name:'0: agent · Current',exact:true})).toHaveAttribute('aria-current','location');
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  const reads=await page.evaluate(()=>window.tmuxJumpFixture.reads);
  await layout.focus();
  const select=await layout.elementHandle();
  for(const [language,caption,current] of [['pt-BR','Visualização do Ir para','Atual'],['es','Vista de Ir a','Actual'],['en','Jump To layout','Current']] as const){
    await page.evaluate(async language=>{
      const {nativeLocale}=await import('/src/i18n/nativeLocale.ts');
      await nativeLocale.change(language);
    },language);
    const localized=dialog;
    const field=localized.getByRole('combobox',{name:caption,exact:true});
    await expect(field).toHaveValue('grid');
    expect(await field.evaluate((element,original)=>element===original,select)).toBe(true);
    await expect(field).toBeFocused();
    await expect(localized.getByRole('button',{name:`0: agent · ${current}`,exact:true})).toHaveAttribute('aria-current','location');
    expect(await localized.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    expect(await page.evaluate(()=>window.tmuxJumpFixture.reads)).toBe(reads);
    expect(await page.evaluate(()=>window.tmuxJumpFixture.jumps)).toEqual([]);
  }
  for(const value of ['list','accordion']){
    await layout.selectOption(value);
    await dialog.getByRole('button',{name:'0: agent · Current',exact:true}).click();
    if(testInfo.project.name==='phone'){await expect(dialog).toHaveCount(0);await (await workspaceControl(page,'Jump To')).click();}
    else await expect(dialog).toBeVisible();
    await expect(layout).toHaveValue(value);
  }
  expect(await page.evaluate(()=>window.tmuxJumpFixture.jumps)).toEqual([]);
  await layout.selectOption('list');
  await dialog.getByRole('button',{name:'1: compiler',exact:true}).click();
  if(testInfo.project.name==='phone'){await expect(dialog).toHaveCount(0);await (await workspaceControl(page,'Jump To')).click();}
  await expect(dialog.getByRole('button',{name:'1: compiler · Current',exact:true})).toHaveAttribute('aria-current','location');
  await dialog.getByRole('button',{name:'0: agent',exact:true}).click();
  if(testInfo.project.name==='phone'){await expect(dialog).toHaveCount(0);await (await workspaceControl(page,'Jump To')).click();}
  await expect(dialog.getByRole('button',{name:'0: agent · Current',exact:true})).toHaveAttribute('aria-current','location');
  expect((await page.evaluate(()=>window.tmuxJumpFixture.jumps))[1]).toMatchObject({generation:'returned-1',targetSessionId:'$1',windowId:'@1'});
  await page.screenshot({path:testInfo.outputPath('workspace-navigation.png')});
  await page.evaluate(()=>{window.tmuxJumpFixture.defer=true;});
  await dialog.getByRole('button',{name:'1: compiler',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.tmuxJumpFixture.finish)).toBe('function');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Return to terminal',exact:true}).click();
  else await page.getByRole('button',{name:'Connections',exact:true}).click();
  await page.getByRole('tab',{name:'Fixture',exact:true}).click();
  await page.evaluate(()=>window.tmuxJumpFixture.finish!());
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'Fixture',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'Fixture / work',exact:true})).toBeVisible();
  expect((await page.evaluate(()=>window.tmuxJumpFixture.jumps)).at(-1)).toEqual({sessionId:'display',generation:'returned-2',targetSessionId:'$2',windowId:'@2'});
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.workspace.v1')!));
  expect(saved).toEqual([{hostId:'fixture'},{hostId:'fixture',attached:{kind:'tmux',name:'work',...(server===undefined?{}:{tmuxServer:server})}}]);
});

const paneSnapshot:JumpSnapshot = {generation:'retained-actor',current:{sessionId:'$1',windowId:'@1',paneId:'%2'},sessions:[
  {id:'$1',name:'work',restoreName:'work',windows:[
    {id:'@1',index:0,name:'agent',zoomed:false,panes:[{id:'%1',index:0,title:'',command:'vim',active:false},{id:'%2',index:1,title:'review',command:'node',active:true}]},
    {id:'@3',index:1,name:'build',zoomed:true,panes:[{id:'%3',index:0,title:'',command:'cargo',active:true},{id:'%4',index:1,title:'',command:'tail',active:false}]},
  ]},
  {id:'$2',name:'builds',restoreName:'builds',windows:[{id:'@2',index:0,name:'compiler',zoomed:false,panes:[{id:'%5',index:0,title:'',command:'make',active:true}]}]},
]};

test('Jump To shows each window\'s panes with one current marker and moves to the exact pane',async ({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  const report={sessionId:'agent-1',agent:'Codex',project:'/work',state:'working',updatedAt:'2026-11-15T12:00:00.000Z',summary:'Reading the tests',paneId:'%2',eventCount:1};
  await page.addInitScript(installTmuxFixture,{initial:paneSnapshot,reports:[report],layout:'list'});
  await restoreWorkspace(page);
  const dialog=page.locator('.workspace-navigation-content').getByRole('region');
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click();
  await (await workspaceControl(page,'Jump To')).click();
  const marked=dialog.locator('[aria-current="location"]');
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveText('Pane 1: review · Codex · Current');
  await expect(dialog.getByRole('button',{name:'0: agent',exact:true})).not.toHaveAttribute('aria-current','location');
  for(const name of ['Pane 0: vim','Pane 0: cargo · Zoomed','Pane 1: tail','Pane 0: make'])await expect(dialog.getByRole('button',{name,exact:true})).toBeVisible();
  const pane=dialog.getByRole('button',{name:'Pane 1: tail',exact:true});
  expect((await pane.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('jump-to-panes.png')});
  await page.evaluate(async()=>{
    const {nativeLocale}=await import('/src/i18n/nativeLocale.ts');
    await nativeLocale.change('pt-BR');
  });
  await expect(marked).toHaveText('Painel 1: review · Codex · Atual');
  await expect(dialog.getByRole('button',{name:'Painel 0: cargo · Ampliado',exact:true})).toBeVisible();
  await page.evaluate(async()=>{
    const {nativeLocale}=await import('/src/i18n/nativeLocale.ts');
    await nativeLocale.change('en');
  });
  await pane.click();
  if(phone)await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(()=>window.tmuxJumpFixture.jumps)).toEqual([{sessionId:'display',generation:'retained-actor',targetSessionId:'$1',windowId:'@3',paneId:'%4'}]);
  // The window row, with no pane, asks for the window only.
  if(phone)await (await workspaceControl(page,'Jump To')).click();
  await expect(marked).toHaveText('Pane 1: tail · Current');
  await dialog.getByRole('button',{name:'0: agent',exact:true}).click();
  expect((await page.evaluate(()=>window.tmuxJumpFixture.jumps)).at(-1)).toEqual({sessionId:'display',generation:'returned-1',targetSessionId:'$1',windowId:'@1'});
});
