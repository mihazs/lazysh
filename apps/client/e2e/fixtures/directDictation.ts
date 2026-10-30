import {workspaceControl} from './workspaceControl';
import {installNativeBridge,installSyntheticAudio} from './nativeBridge';
import {expect,type Page} from '@playwright/test';

declare global {interface Window {
  dictationFixture:{calls:{command:string;args:Record<string,unknown>}[];staged:unknown[];sessionId?:string;writes:{sessionId:string;data:string}[];complete?: (text:string)=>void;rejectWrite:boolean;close:()=>void;deferDisconnect?:boolean;failDisconnect?:()=>void;};
}}
export async function dictationFixture(page:Page, parakeet=false){
  await installNativeBridge(page);
  await installSyntheticAudio(page);
  await page.addInitScript(({parakeet})=>{
    let parakeetBusy=false,parakeetCancelled=false,parakeetId:string|null=null;
    window.dictationFixture={calls:[],staged:[],writes:[],rejectWrite:false,close:()=>{}};
    window.addEventListener('lazysh-prompt-draft',event=>window.dictationFixture.staged.push((event as CustomEvent).detail));
    window.nativeFixtureInvoke = async(command: string, args: Record<string, unknown> = {}) => {
        window.dictationFixture.calls.push({command,args});
        if(command==='list_hosts')return [];
        if(command==='local_capability')return {available:true,reason:'Native IO test fixture; no real shell is started.'};
        if(command==='local_connect'){
          const events=args.events as {onmessage:(event:unknown)=>void};
          window.dictationFixture.close=()=>events.onmessage({type:'closed',message:'Fixture connection closed'});
          window.dictationFixture.sessionId=`local:${crypto.randomUUID()}`;
          return {sessionId:window.dictationFixture.sessionId};
        }
        if(command==='local_write'){
          window.dictationFixture.writes.push({sessionId:args.sessionId as string,data:args.data as string});
          if(window.dictationFixture.rejectWrite)throw new Error('Terminal input queue is full or disconnected');
          return;
        }
        if(command==='local_disconnect' && window.dictationFixture.deferDisconnect)return new Promise<void>((_resolve,reject)=>{window.dictationFixture.failDisconnect=()=>reject(new Error('Fixture teardown failed'));});
        if(['local_resize','local_ack','local_disconnect','voice_cancel','voice_download_cancel'].includes(command))return;
        if(command==='voice_models')return [{id:'tiny.bin',bytes:1024}];
        if(command==='voice_parakeet_status')return {available:parakeet,reason:'Synthetic browser IPC fixture; no native model is run.',installed:parakeet,ready:parakeet,busy:parakeetBusy,stage:parakeetCancelled&&parakeetBusy?'finishing':parakeetBusy?'transcribing':'idle',requestId:parakeetBusy?parakeetId:null,received:0,total:487170055};
        if(command==='voice_parakeet_transcribe'){
          parakeetBusy=true;parakeetCancelled=false;parakeetId=args.requestId as string;
          return new Promise(resolve=>{window.dictationFixture.complete=text=>{parakeetBusy=false;resolve({requestId:parakeetId,text});};});
        }
        if(command==='voice_parakeet_cancel'){parakeetCancelled=true;return {cancelled:true,finishing:parakeetBusy};}
        if(command==='voice_model_catalog')return [];
        if(command==='apple_speech_capability')return {available:false,reason:'Test uses synthetic final Whisper results.',supportedLanguages:[],installedLanguages:[],reservedLanguages:[]};
        if(command==='voice_transcribe')return new Promise<string>(resolve=>{window.dictationFixture.complete=resolve;});
        if(command.startsWith('plugin:event|'))return 1;
        throw new Error(`Unexpected fixture command: ${command}`);
    };
  }, {parakeet});
  await page.goto('/');
  const local=page.getByRole('button',{name:'Open local terminal',exact:true});
  if((page.viewportSize()?.width ?? 1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await local.click();await (await workspaceControl(page,'Dictate')).click();
  await expect(page.getByRole('combobox',{name:/^Model/})).toHaveValue('tiny.bin');
}
export async function recordDictation(page:Page){
  await page.evaluate(()=>{window.dictationFixture.complete=undefined;});
  await page.getByRole('button',{name:'Record speech',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.dictationFixture.complete)).toBe('function');
}
export async function completeDictation(page:Page,text:string){await page.evaluate(text=>window.dictationFixture.complete!(text),text);}

