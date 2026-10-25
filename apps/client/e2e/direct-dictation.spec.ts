import { expect, test, type Page } from '@playwright/test';

declare global {interface Window {
  dictationFixture:{writes:{sessionId:string;data:string}[];complete?: (text:string)=>void;rejectWrite:boolean;close:()=>void;deferDisconnect?:boolean;failDisconnect?:()=>void;};
}}
async function fixture(page:Page, parakeet=false){
  await page.addInitScript(({parakeet})=>{
    window.dictationFixture={writes:[],rejectWrite:false,close:()=>{}};
    let parakeetBusy=false,parakeetCancelled=false,parakeetId:string|null=null;
    Object.defineProperty(window,'isTauri',{value:true});
    Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{
      transformCallback:()=>1,unregisterCallback:()=>{},
      invoke:async(command:string,args:Record<string,unknown>={})=>{
        if(command==='app_lock_status')return {initialized:true,supported:false,reason:'Browser fixture',enabled:false,locked:false,generation:'0'};
        if(command==='app_lock_ready' || command==='adopt_session')return;
        if(command==='list_hosts')return [];
        if(command==='local_capability')return {available:true,reason:'Native IO test fixture; no real shell is started.'};
        if(command==='local_connect'){
          const events=args.events as {onmessage:(event:unknown)=>void};
          window.dictationFixture.close=()=>events.onmessage({type:'closed',message:'Fixture connection closed'});
          return {sessionId:`local:${crypto.randomUUID()}`};
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
      },
    }});
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
  },{parakeet});
  await page.goto('/');
  const local=page.getByRole('button',{name:'Open local terminal',exact:true});
  if((page.viewportSize()?.width ?? 1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await local.click();await page.getByRole('button',{name:'Dictate',exact:true}).click();
  await expect(page.getByRole('combobox',{name:/^Model/})).toHaveValue('tiny.bin');
}
async function record(page:Page){
  await page.evaluate(()=>{window.dictationFixture.complete=undefined;});
  await page.getByRole('button',{name:'Record speech',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.dictationFixture.complete)).toBe('function');
}
async function complete(page:Page,text:string){await page.evaluate(text=>window.dictationFixture.complete!(text),text);}

test('review remains default; direct opt-in writes exactly one final payload with optional Enter',async({page})=>{
  await fixture(page);
  const direct=page.getByLabel('Type final result directly into terminal'),enter=page.getByLabel('Auto-send: press Enter');
  await expect(direct).not.toBeChecked();await expect(enter).not.toBeChecked();await expect(enter).toBeDisabled();
  await record(page);await complete(page,'review only');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review only');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  await direct.check();await record(page);
  await expect(direct).toBeDisabled();await expect(enter).toBeDisabled();
  await complete(page,'echo 世界');
  await expect.poll(()=>page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['echo 世界']);
  await enter.check();await record(page);await complete(page,'pwd');
  await expect.poll(()=>page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['echo 世界','pwd\r']);
  const ids=await page.evaluate(()=>window.dictationFixture.writes.map(write=>write.sessionId));expect(new Set(ids).size).toBe(1);
  await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.getByRole('button',{name:'Dictate',exact:true}).click();
  await expect(direct).not.toBeChecked();await expect(enter).not.toBeChecked();
});

test('Parakeet keeps editable review and cancelled native finishing cannot type or press Enter',async({page})=>{
  await fixture(page,true);
  await page.getByRole('combobox',{name:'Speech engine',exact:true}).selectOption('parakeet');
  await record(page);await complete(page,'review Parakeet result');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review Parakeet result');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  await page.getByLabel('Type final result directly into terminal').check();await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeDisabled();
  await complete(page,'cancelled command');
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeEnabled();
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review Parakeet result');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
});

test('invalid text and native queue failures preserve the draft and never append Enter later',async({page})=>{
  await fixture(page);await page.getByLabel('Type final result directly into terminal').check();await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await complete(page,'first\nsecond');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('first\nsecond');await expect(page.getByRole('alert')).toContainText('one line');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  await page.evaluate(()=>{window.dictationFixture.rejectWrite=true;});
  await record(page);await complete(page,'failed command');
  await expect(page.getByRole('alert')).toContainText('queue is full');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('failed command');
  expect(await page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['failed command\r']);
  await page.getByLabel('Dictation draft').fill('edited locally');
  await page.getByText('Recent dictation (2)',{exact:true}).click();await page.getByRole('button',{name:'Reuse dictation 1'}).click();
  await expect(page.getByLabel('Dictation draft')).toHaveValue('failed command');
  expect(await page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['failed command\r']);
});

for(const action of ['cancel','navigate','disconnect','disconnect intent','replace session'] as const){
  test(`late completion after ${action} cannot type or press Enter`,async({page})=>{
    await fixture(page);await page.getByLabel('Type final result directly into terminal').check();await page.getByLabel('Auto-send: press Enter').check();await record(page);
    if(action==='cancel')await page.getByRole('button',{name:'Cancel',exact:true}).click();
    else if(action==='navigate')await page.getByRole('button',{name:'Terminal',exact:true}).click();
    else if(action==='disconnect intent'){
      await page.evaluate(()=>{window.dictationFixture.deferDisconnect=true;});
      await page.getByRole('button',{name:'Disconnect Local terminal',exact:true}).click();
    }else if(action==='replace session'){
      if((page.viewportSize()?.width ?? 1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
      await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
      await expect(page.getByRole('tab')).toHaveCount(2);
      await expect(page.getByRole('region',{name:'Local dictation'})).toHaveCount(0);
    }else await page.evaluate(()=>window.dictationFixture.close());
    await complete(page,'stale command');
    if(action==='cancel')await expect(page.getByLabel('Dictation draft')).toHaveValue('');
    else if(action==='disconnect intent')await expect(page.getByLabel('Dictation draft')).toHaveValue('stale command');
    else await expect(page.getByRole('region',{name:'Local dictation'})).toHaveCount(0);
    expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  });
}
