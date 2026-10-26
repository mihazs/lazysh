import {installNativeBridge,installSyntheticAudio} from './nativeBridge';
import {expect,type Page} from '@playwright/test';
import {cloudSnapshot} from '../../src/test/cloudVoiceData';

declare global { interface Window { cloudVoiceFixture: {
  calls: {command:string;args:Record<string,unknown>}[]; writes:string[];
  complete?: (text:string)=>void; begin?:()=>void; deferBegin:boolean;
}; } }
export async function cloudVoiceFixture(page:Page) {
  await installNativeBridge(page);
  await installSyntheticAudio(page);
  await page.addInitScript(snapshot=>{
    const id='12345678-1234-4234-8234-123456789abc';
    window.cloudVoiceFixture={calls:[],writes:[],deferBegin:false};
    window.nativeFixtureInvoke = async(command: string, args: Record<string, unknown> = {}) => {
        window.cloudVoiceFixture.calls.push({command,args});
        if(command==='list_hosts' || command==='voice_models' || command==='voice_model_catalog')return [];
        if(command==='local_capability')return {available:true,reason:'Synthetic Cloud fixture; no shell or remote service.'};
        if(command==='local_connect')return {sessionId:'local:cloud-fixture'};
        if(command==='local_write'){window.cloudVoiceFixture.writes.push(args.data as string);return;}
        if(['local_resize','local_ack','local_disconnect','voice_cancel'].includes(command))return;
        if(command==='apple_speech_capability')return {available:false,reason:'Synthetic fixture.',supportedLanguages:[],installedLanguages:[],reservedLanguages:[]};
        if(command==='voice_cloud_status')return {configured:false};
        if(command==='voice_cloud_enroll' || command==='voice_cloud_refresh')return snapshot;
        if(command==='voice_cloud_forget')return;
        if(command==='voice_cloud_begin')return window.cloudVoiceFixture.deferBegin ? new Promise<string>(resolve=>{window.cloudVoiceFixture.begin=()=>resolve(id);}) : id;
        if(command==='voice_cloud_transcribe')return new Promise(resolve=>{window.cloudVoiceFixture.complete=text=>resolve({requestId:args.requestId,text,quota:snapshot.quota,checkedAt:snapshot.checkedAt+1000});});
        if(command==='voice_cloud_cancel')return {cancelled:true,cleanup:'confirmed'};
        if(command.startsWith('plugin:event|'))return 1;
        throw new Error(`Unexpected fixture command: ${command}`);
    };
  },cloudSnapshot());
  await page.goto('/');
  if((page.viewportSize()?.width ?? 1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await page.getByRole('button',{name:'Dictate',exact:true}).click();
}
export async function enrollCloud(page:Page) {
  await page.getByLabel('Speech engine').selectOption('cloud');
  await page.getByLabel('Cloud service origin').fill('https://voice.example.com');
  await page.getByLabel('Device token').fill('a'.repeat(64));
  await page.getByRole('button',{name:'Verify and save Cloud device'}).click();
  await expect(page.getByText(/Service audio quota remaining/)).toContainText('device 30.0 seconds; shared 60.0 seconds');
}
export async function recordCloud(page:Page) {
  await page.evaluate(()=>{window.cloudVoiceFixture.complete=undefined;});
  await page.getByRole('button',{name:'Record speech',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.cloudVoiceFixture.complete)).toBe('function');
}
export async function completeCloud(page:Page,text:string){await page.evaluate(text=>window.cloudVoiceFixture.complete!(text),text);}

