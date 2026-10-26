import type { Page } from '@playwright/test';
declare global { interface Window {
  nativeFixtureInvoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  nativeFixtureEmit: (event:string,payload:unknown)=>void;
} }
/** Shared synthetic native admission; each spec retains its own command behavior. */
export async function installNativeBridge(page: Page, access = {reason:'Browser fixture', generation:'0'}, options:{nativeLocale?:boolean;nativeEvents?:boolean}={}) {
  await page.addInitScript(({access,options}) => {
    let next=0;
    const callbacks=new Map<number,(value:unknown)=>void>();
    const listeners=new Map<number,{event:string;handler:number}>();
    if(options.nativeEvents) {
      Object.defineProperty(window,'__TAURI_EVENT_PLUGIN_INTERNALS__',{value:{unregisterListener(_event:string,id:number){listeners.delete(id);}}});
      window.nativeFixtureEmit=(event,payload)=>{for(const [id,listener] of listeners)if(listener.event===event)callbacks.get(listener.handler)?.({event,id,payload});};
    }
    Object.defineProperty(window, 'isTauri', {value:true});
    Object.defineProperty(window, '__TAURI_INTERNALS__', {value: {
      transformCallback: (callback:(value:unknown)=>void) => {if(!options.nativeEvents)return 1;const id=++next;callbacks.set(id,callback);return id;},
      unregisterCallback: (id:number) => {callbacks.delete(id);},
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if(options.nativeEvents && command==='plugin:event|listen'){const id=++next;listeners.set(id,{event:String(args.event),handler:Number(args.handler)});return id;}
        if(options.nativeEvents && command==='plugin:event|unlisten'){listeners.delete(Number(args.eventId));return;}
        if (command === 'app_lock_status') return {initialized:true,supported:false,enabled:false,locked:false,...access};
        if (command === 'ui_locale_status' && !options.nativeLocale) return {nativeAuthority:false};
        if (command === 'app_lock_ready' || command === 'adopt_session') return;
        if (command === 'desktop_launch_read') return {directoryReceipt:null,hostReceipt:null,notice:null};
        return window.nativeFixtureInvoke(command, args);
      },
    }});
  }, {access,options});
}
/** Synthetic final audio only: never asks the host browser for a microphone. */
export async function installSyntheticAudio(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
    Object.defineProperty(window,'MediaRecorder',{value:class {
      state='inactive';mimeType='audio/webm';onstop?:()=>void;ondataavailable?:(event:{data:Blob})=>void;
      start(){this.state='recording';}
      stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([new Uint8Array([0])])});this.onstop?.();}
    }});
    Object.defineProperty(window,'AudioContext',{value:class {
      async decodeAudioData(){return {sampleRate:16000,numberOfChannels:1,getChannelData:()=>new Float32Array(1600)};}
      async close(){}
    }});
  });
}
