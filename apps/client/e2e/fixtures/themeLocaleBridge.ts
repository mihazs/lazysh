import type {Page} from '@playwright/test';
import {installNativeBridge} from './nativeBridge';
export async function installThemeLocaleBridge(page:Page){
  await installNativeBridge(page,undefined,{nativeEvents:true});
  await page.addInitScript(()=>{
    let pending:{receipt:string;code:string}|null=null,revision=0,held:'read'|'ack'|undefined;
    let finish:((fail?:boolean)=>void)|undefined,clipboard:((value:string)=>void)|undefined;
    const calls:{command:string;args:Record<string,unknown>}[]=[];
    const fixture={calls,reads:0,writes:0,offer(code:string){pending={receipt:`11111111-1111-4111-8111-${String(++revision).padStart(12,'0')}`,code};window.nativeFixtureEmit('lazysh-theme-link',null);},hold(kind:typeof held){held=kind;},pending:()=>!!finish,finish(fail=false){const done=finish;held=undefined;finish=undefined;done?.(fail);},clipboard(value:string){const done=clipboard;clipboard=undefined;done?.(value);}};
    Object.assign(window,{themeLocaleFixture:fixture});
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:()=>{fixture.reads++;return new Promise<string>(resolve=>{clipboard=resolve;});},writeText:async()=>{fixture.writes++;}}});
    window.nativeFixtureInvoke=async(command,args)=>{
      calls.push({command,args});
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Synthetic theme fixture; no terminal starts.'};
      if(command==='app_icon_status')return {available:false,current:'unknown',reason:'RAW native icon reason'};
      if(command==='theme_link_status')return !!pending;
      if(command==='theme_link_read'){
        const original=pending;
        return held==='read'?new Promise(resolve=>{finish=()=>resolve(original);}):original;
      }
      if(command==='theme_link_ack'){
        const acknowledge=()=>{if(pending?.receipt===args.receipt)pending=null;};
        if(held==='ack')return new Promise<void>((resolve,reject)=>{finish=fail=>{if(fail)reject(new Error('RAW acknowledgement rejected'));else{acknowledge();resolve();}};});
        acknowledge();return;
      }
      throw new Error(`Unexpected theme locale command: ${command}`);
    };
  });
}
