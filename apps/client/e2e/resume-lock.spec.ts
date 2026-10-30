import {workspaceControl} from './fixtures/workspaceControl';
import { expect, test } from '@playwright/test';

declare global { interface Window { resumeLockFixture: {
  lock:()=>void; unlock:()=>void; releaseReady:()=>void; send:(index:number,text:string)=>void;
  connects:number; adopted:string[]; disconnects:string[]; acknowledgements:number[];
  writes:string[]; ready:string[]; held:boolean; readySawOldDraft:boolean[];
}; } }

test('the real App and indexed bridge retain one terminal, pause output, and clear drafts before ready',async({page},testInfo)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,screenReader:true}));
    const callbacks=new Map<number,(value:unknown)=>void>();let callbackId=0;let terminalChannel=0;
    const handlers=new Map<string,Set<number>>();
    const sessionId='local:12345678-1234-4234-8234-123456789abc';
    let status:{initialized:boolean;supported:boolean;reason:string;enabled:boolean;locked:boolean;generation:string;nonce?:string}={initialized:true,supported:true,reason:'Synthetic native access fixture; no OS authentication or shell.',enabled:true,locked:false,generation:'1',nonce:'a'.repeat(64)};
    let finishReady:(()=>void)|undefined;
    const emit=()=>{for(const id of handlers.get('lazysh-app-lock')??[])callbacks.get(id)?.({event:'lazysh-app-lock',id,payload:status});};
    window.resumeLockFixture={connects:0,adopted:[],disconnects:[],acknowledgements:[],writes:[],ready:[],held:false,readySawOldDraft:[],
      lock(){status={...status,locked:true,generation:'2',nonce:undefined};emit();},
      unlock(){this.held=true;status={...status,locked:false,generation:'3',nonce:'b'.repeat(64)};emit();},
      releaseReady(){this.held=false;finishReady?.();},
      send(index,text){callbacks.get(terminalChannel)!({index,message:{type:'data',data:Array.from(new TextEncoder().encode(text))}});},
    };
    Object.defineProperty(window,'isTauri',{value:true});
    Object.defineProperty(window,'__TAURI_EVENT_PLUGIN_INTERNALS__',{value:{unregisterListener(event:string,id:number){handlers.get(event)?.delete(id);}}});
    Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{
      transformCallback(callback:(value:unknown)=>void){const id=++callbackId;callbacks.set(id,callback);return id;},
      unregisterCallback(id:number){callbacks.delete(id);},
      invoke:async(command:string,args:Record<string,unknown>={},options?:{headers?:Record<string,string>})=>{
        const fixture=window.resumeLockFixture;
        if(command==='plugin:event|listen'){const name=args.event as string;const ids=handlers.get(name)??new Set<number>();ids.add(args.handler as number);handlers.set(name,ids);return args.handler;}
        if(command==='plugin:event|unlisten')return;
        if(command==='app_lock_status')return status;
        if(command==='app_lock_ready'){
          if(args.generation!==status.generation || status.locked)throw new Error('Stale ready fixture');
          fixture.ready.push(args.generation as string);
          fixture.readySawOldDraft.push(!!document.querySelector('[aria-label="Dictation draft"]'));
          if(fixture.held)await new Promise<void>(resolve=>{finishReady=resolve;});return;
        }
        if(command==='local_ack'){if(args.sessionId!==sessionId)throw new Error('Wrong ACK session');fixture.acknowledgements.push(args.bytes as number);return;}
        if(command==='local_disconnect'){fixture.disconnects.push(args.sessionId as string);return;}
        if(status.locked || options?.headers?.['X-Lazysh-Access']!==status.nonce)throw new Error('Native access fixture rejected stale nonce');
        if(command==='list_hosts')return [];
        if(command==='local_capability')return {available:true,reason:'Fixture only'};
        if(command==='local_connect'){fixture.connects++;terminalChannel=(args.events as {id:number}).id;return {sessionId};}
        if(command==='adopt_session'){fixture.adopted.push(args.sessionId as string);return;}
        if(command==='local_resize')return;
        if(command==='local_write'){fixture.writes.push(args.data as string);return;}
        if(command==='voice_models')return [{id:'tiny.bin',bytes:1024}];
        if(command==='voice_model_catalog')return [];
        if(command==='apple_speech_capability')return {available:false,reason:'Fixture only',supportedLanguages:[],installedLanguages:[],reservedLanguages:[]};
        if(command==='voice_cancel')return;
        throw new Error(`Unexpected fixture command: ${command}`);
      },
    }});
  });
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.resumeLockFixture.adopted.length)).toBe(1);
  await page.evaluate(()=>window.resumeLockFixture.send(0,'BEFORE\r\n'));
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('BEFORE');
  await (await workspaceControl(page,'Dictate')).click();
  await page.getByLabel('Dictation draft').fill('private unsent draft');
  await page.evaluate(()=>window.resumeLockFixture.lock());
  await expect(page.getByRole('heading',{name:'lazysh is locked'})).toBeVisible();
  await expect(page.getByLabel('Dictation draft')).toHaveCount(0);
  // Deliberately deliver out-of-order IPC indices while locked; actual Tauri Channel must retain both.
  await page.evaluate(()=>{window.resumeLockFixture.send(2,'LOCKED-B\r\n');window.resumeLockFixture.send(1,'LOCKED-A ');});
  await page.evaluate(()=>window.resumeLockFixture.unlock());
  await expect.poll(()=>page.evaluate(()=>window.resumeLockFixture.ready.includes('3'))).toBe(true);
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('BEFORE');
  await expect(page.locator('.xterm-accessibility-tree')).not.toContainText('LOCKED');
  await page.evaluate(()=>window.resumeLockFixture.releaseReady());
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('LOCKED-A LOCKED-B');
  await page.evaluate(()=>window.resumeLockFixture.send(3,'AFTER 世界\r\n'));
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('AFTER 世界');
  const text=await page.locator('.xterm-accessibility-tree').innerText();expect(text.indexOf('BEFORE')).toBeLessThan(text.indexOf('LOCKED-A'));expect(text.indexOf('LOCKED-B')).toBeLessThan(text.indexOf('AFTER'));
  await (await workspaceControl(page,'Dictate')).click();
  await expect(page.getByLabel('Dictation draft')).toHaveValue('');
  const result=await page.evaluate(()=>window.resumeLockFixture);
  expect(result.connects).toBe(1);expect(result.adopted).toHaveLength(1);expect(result.disconnects).toEqual([]);expect(result.writes).toEqual([]);expect(result.readySawOldDraft).not.toContain(true);
  const bytes=new TextEncoder().encode('BEFORE\r\nLOCKED-A LOCKED-B\r\nAFTER 世界\r\n').length;
  await expect.poll(()=>page.evaluate(()=>window.resumeLockFixture.acknowledgements.reduce((sum,bytes)=>sum+bytes,0))).toBe(bytes);
  expect(errors).toEqual([]);
});
