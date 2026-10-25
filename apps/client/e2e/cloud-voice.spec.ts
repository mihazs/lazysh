import { installNativeBridge, installSyntheticAudio } from './fixtures/nativeBridge';
import { expect, test, type Page } from '@playwright/test';

declare global { interface Window { cloudVoiceFixture: {
  calls: {command:string;args:Record<string,unknown>}[]; writes:string[];
  complete?: (text:string)=>void; begin?:()=>void; deferBegin:boolean;
}; } }
async function fixture(page:Page) {
  await installNativeBridge(page);
  await installSyntheticAudio(page);
  await page.addInitScript(()=>{
    const id='12345678-1234-4234-8234-123456789abc';
    const quota={windowStart:1792800000,windowEnd:1792886400,deviceLimitSamples:480000,deviceUsedSamples:0,deviceRemainingSamples:480000,
      globalLimitSamples:960000,globalUsedSamples:0,globalRemainingSamples:960000};
    const snapshot={origin:'https://voice.example.com',checkedAt:1792900000000,quota,
      capabilities:{schemaVersion:1,model:'gpt-transcribe',languages:['auto','pt'],maxWavBytes:960044,sampleRate:16000,maxSamples:480000}};
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
        if(command==='voice_cloud_transcribe')return new Promise(resolve=>{window.cloudVoiceFixture.complete=text=>resolve({requestId:args.requestId,text,quota,checkedAt:snapshot.checkedAt+1000});});
        if(command==='voice_cloud_cancel')return {cancelled:true,cleanup:'confirmed'};
        if(command.startsWith('plugin:event|'))return 1;
        throw new Error(`Unexpected fixture command: ${command}`);
    };
  });
  await page.goto('/');
  if((page.viewportSize()?.width ?? 1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await page.getByRole('button',{name:'Dictate',exact:true}).click();
}
async function enroll(page:Page) {
  await page.getByLabel('Speech engine').selectOption('cloud');
  await page.getByLabel('Cloud service origin').fill('https://voice.example.com');
  await page.getByLabel('Device token').fill('a'.repeat(64));
  await page.getByRole('button',{name:'Verify and save Cloud device'}).click();
  await expect(page.getByText(/Service audio quota remaining/)).toContainText('device 30.0 seconds; shared 60.0 seconds');
}
async function record(page:Page) {
  await page.evaluate(()=>{window.cloudVoiceFixture.complete=undefined;});
  await page.getByRole('button',{name:'Record speech',exact:true}).click();
  await page.getByRole('button',{name:'Stop and transcribe',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.cloudVoiceFixture.complete)).toBe('function');
}
async function complete(page:Page,text:string){await page.evaluate(text=>window.cloudVoiceFixture.complete!(text),text);}

test('Cloud is explicit, validates enrollment, then shares review and opt-in direct delivery',async({page})=>{
  await fixture(page);
  expect(await page.evaluate(()=>window.cloudVoiceFixture.calls.filter(call=>call.command.startsWith('voice_cloud_')))).toEqual([]);
  await page.getByLabel('Speech engine').selectOption('cloud');
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeDisabled();
  await expect(page.getByLabel('Device token')).toHaveAttribute('type','password');
  await enroll(page);await expect(page.getByLabel('Device token')).toHaveValue('');
  await expect(page.getByLabel('Cloud speech language').locator('option')).toHaveCount(2);
  await record(page);await complete(page,'review Cloud result');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review Cloud result');
  expect(await page.evaluate(()=>window.cloudVoiceFixture.writes)).toEqual([]);
  await page.getByLabel('Type final result directly into terminal').check();
  await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await complete(page,'echo hello');
  await expect.poll(()=>page.evaluate(()=>window.cloudVoiceFixture.writes)).toEqual(['echo hello\r']);
  await page.getByRole('button',{name:'Forget Cloud device'}).click();
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeDisabled();
});

test('cancelled begin and late final results never upload or type',async({page})=>{
  await fixture(page);await enroll(page);
  await page.evaluate(()=>{window.cloudVoiceFixture.deferBegin=true;});
  await page.getByRole('button',{name:'Record speech',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.cloudVoiceFixture.begin)).toBe('function');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.evaluate(()=>window.cloudVoiceFixture.begin!());
  await expect.poll(()=>page.evaluate(()=>window.cloudVoiceFixture.calls.filter(call=>call.command==='voice_cloud_cancel').length)).toBe(1);
  expect(await page.evaluate(()=>window.cloudVoiceFixture.calls.some(call=>call.command==='voice_cloud_transcribe'))).toBe(false);
  await page.evaluate(()=>{window.cloudVoiceFixture.deferBegin=false;});
  await page.getByLabel('Type final result directly into terminal').check();
  await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await page.getByRole('button',{name:'Terminal',exact:true}).click();await complete(page,'stale command');
  expect(await page.evaluate(()=>window.cloudVoiceFixture.writes)).toEqual([]);
});
