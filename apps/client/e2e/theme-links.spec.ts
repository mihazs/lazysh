import {openThemeImport} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';

declare global {interface Window {themeLinkFixture:{offer:(code:string)=>void;reads:number;acks:string[]}}}
const theme={v:1,name:'Linked 日本語',mode:'light',colors:{background:'#fafafa',foreground:'#121212'}};
const code='lazysh-theme:'+Buffer.from(JSON.stringify(theme)).toString('base64url');
test('incoming link keeps the manual draft, requires review/apply, survives reload and can be discarded',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    let nextId=0,revision=0,pending:{receipt:string;code:string}|null=null;
    const callbacks=new Map<number,(value:unknown)=>void>(),handlers=new Map<string,Set<number>>();
    Object.defineProperty(window,'isTauri',{value:true});
    Object.defineProperty(window,'__TAURI_EVENT_PLUGIN_INTERNALS__',{value:{unregisterListener(event:string,id:number){handlers.get(event)?.delete(id);}}});
    window.themeLinkFixture={reads:0,acks:[],offer(code){
      pending={receipt:`11111111-1111-4111-8111-${String(++revision).padStart(12,'0')}`,code};
      for(const id of handlers.get('lazysh-theme-link')??[])callbacks.get(id)?.({event:'lazysh-theme-link',id,payload:null});
    }};
    Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{
      transformCallback(callback:(value:unknown)=>void){const id=++nextId;callbacks.set(id,callback);return id;},
      unregisterCallback(id:number){callbacks.delete(id);},
      invoke:async(command:string,args:Record<string,unknown>={})=>{
        if(command==='plugin:event|listen'){const name=args.event as string;const ids=handlers.get(name)??new Set<number>();ids.add(args.handler as number);handlers.set(name,ids);return args.handler;}
        if(command==='plugin:event|unlisten')return;
        if(command==='app_lock_status')return {initialized:true,supported:false,reason:'Synthetic bridge fixture; no OS URL launch or authentication.',enabled:false,locked:false,generation:'1'};
        if(command==='app_lock_ready')return;
        if(command==='theme_link_status')return !!pending;
        if(command==='theme_link_read'){window.themeLinkFixture.reads++;return pending;}
        if(command==='theme_link_ack'){window.themeLinkFixture.acks.push(args.receipt as string);if(pending?.receipt===args.receipt)pending=null;return;}
        if(command==='list_hosts')return [];
        if(command==='local_capability')return {available:false,reason:'Fixture only'};
        if(command==='biometric_capability')return {available:false,reason:'Fixture only'};
        throw new Error(`Unexpected theme fixture command: ${command}`);
      },
    }});
  });
  await page.goto('/');
  await openThemeImport(page);
  const input=page.getByLabel('Theme JSON or share code',{exact:true});await input.fill('unfinished manual draft');
  await page.evaluate(value=>window.themeLinkFixture.offer(value),code);
  await expect(page.getByRole('button',{name:'Review linked theme'})).toBeVisible();
  expect(await page.evaluate(()=>window.themeLinkFixture.reads)).toBe(0);
  await expect(input).toHaveValue('unfinished manual draft');
  await page.getByRole('button',{name:'Review linked theme'}).click();
  await expect(page.getByRole('heading',{name:theme.name,exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','forest');
  await expect(input).toHaveValue('unfinished manual draft');
  await page.getByRole('button',{name:'Apply linked theme'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','custom');
  await expect(input).toHaveValue('unfinished manual draft');
  await page.getByRole('button',{name:'Export theme link'}).click();
  await expect(page.getByLabel('Exported theme',{exact:true})).toHaveValue(/^lazysh:\/\/theme\?data=[\w-]+$/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','custom');
  await page.evaluate(value=>window.themeLinkFixture.offer(value),code);
  await page.getByRole('button',{name:'Review linked theme'}).click();
  await page.getByRole('button',{name:'Discard theme link'}).click();
  await expect(page.getByRole('button',{name:'Review linked theme'})).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-app-theme','custom');
  expect(errors).toEqual([]);
});
