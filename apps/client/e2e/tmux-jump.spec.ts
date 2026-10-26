import { expect, test } from '@playwright/test';

declare global { interface Window {
  tmuxJumpFixture: { jumps: Record<string, unknown>[]; attachments: Record<string,unknown>[]; defer: boolean; finish?: () => void };
} }

for(const server of [undefined, "世界 '$(touch NO);"])test(`attached display Jump To preserves server ${server ?? 'default'} and drops a late result after switching terminals`, async ({ page }) => {
  await page.addInitScript(({server}) => {
    localStorage.setItem('lazysh.workspace.v1', JSON.stringify([{hostId:'fixture'},{hostId:'fixture',attached:{kind:'tmux',name:'work',...(server===undefined?{}:{tmuxServer:server})}}]));
    localStorage.setItem('lazysh.multiplexer.layout', 'grid');
    window.tmuxJumpFixture = {jumps:[],attachments:[],defer:false};
    const snapshot = {generation:'retained-actor',current:{sessionId:'$1',windowId:'@1'},sessions:[
      {id:'$1',name:'work',restoreName:'work',windows:[{id:'@1',index:0,name:'agent'}]},
      {id:'$2',name:'builds',restoreName:'builds',windows:[{id:'@2',index:1,name:'compiler'}]},
    ]};
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
        if(command==='tmux_jump_snapshot')return snapshot;
        if(command==='tmux_jump'){
          window.tmuxJumpFixture.jumps.push(args);
          const result={...snapshot,current:{sessionId:'$2',windowId:'@2'}};
          if(window.tmuxJumpFixture.defer)return new Promise(resolve=>{window.tmuxJumpFixture.finish=()=>resolve(result);});
          return result;
        }
        if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
        if(command==='apple_status_capability')return {available:false,reason:'Browser fixture.'};
        if(['app_lock_ready','adopt_session','resize','ack_output','disconnect'].includes(command))return;
        if(command.startsWith('plugin:event|'))return 1;
        throw new Error(`Unexpected tmux UI fixture command: ${command}`);
      },
    }});
  },{server});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(await page.evaluate(()=>window.tmuxJumpFixture.attachments.map(({sessionId,name,tmuxServer})=>({sessionId,name,...(tmuxServer===undefined?{}:{tmuxServer})})))).toEqual([{sessionId:'ssh-2',name:'work',...(server===undefined?{}:{tmuxServer:server})}]);
  await expect(page.getByRole('button',{name:'Jump To',exact:true})).toHaveCount(0);
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click();
  const trigger=page.getByRole('button',{name:'Jump To',exact:true});
  await expect(trigger).toBeVisible();
  const bounds=await trigger.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  await trigger.click();
  const dialog=page.getByRole('dialog',{name:'Jump To',exact:true});
  const layout=dialog.getByRole('combobox',{name:'Jump To layout',exact:true});
  await expect(layout).toHaveValue('grid');
  await expect(dialog.getByRole('button',{name:'0: agent · Current',exact:true})).toHaveAttribute('aria-current','location');
  expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  for(const value of ['list','accordion']){
    await layout.selectOption(value);
    await dialog.getByRole('button',{name:'0: agent · Current',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await trigger.click();
    await expect(layout).toHaveValue(value);
  }
  expect(await page.evaluate(()=>window.tmuxJumpFixture.jumps)).toEqual([]);
  await layout.selectOption('list');
  await page.evaluate(()=>{window.tmuxJumpFixture.defer=true;});
  await dialog.getByRole('button',{name:'1: compiler',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.tmuxJumpFixture.finish)).toBe('function');
  await dialog.getByRole('button',{name:'Close Jump To',exact:true}).click();
  await page.getByRole('tab',{name:'Fixture',exact:true}).click();
  await page.evaluate(()=>window.tmuxJumpFixture.finish!());
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab',{name:'Fixture',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'Fixture / work',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.tmuxJumpFixture.jumps)).toEqual([{sessionId:'display',generation:'retained-actor',targetSessionId:'$2',windowId:'@2'}]);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.workspace.v1')!));
  expect(saved).toEqual([{hostId:'fixture'},{hostId:'fixture',attached:{kind:'tmux',name:'work',...(server===undefined?{}:{tmuxServer:server})}}]);
});
