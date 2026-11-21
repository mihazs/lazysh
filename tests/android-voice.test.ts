import {afterAll,expect,spyOn,test} from 'bun:test';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {androidVoiceAcceptance,voiceCase,type VoiceCommand} from './support/androidVoice';

const nonce='d'.repeat(32),env={ANDROID_SERIAL:'emulator-5580',ANDROID_HOME:'/sdk'};
const adb='/sdk/platform-tools/adb',staging=`/data/local/tmp/lazysh-voice-${nonce}`,gradle='/owned/apps/client/src-tauri/gen/android/gradlew';
const temporary:string[]=[];
afterAll(()=>Promise.all(temporary.map(path=>rm(path,{recursive:true,force:true}))));

type Call={stage:string;program:string;args:string[];milliseconds:number};
/** Records every command; `fail` names the stage that rejects. */
function recorder(fail?:string,cleanupFails=false) {
  const calls:Call[]=[];
  const run:VoiceCommand=async(stage,program,args,milliseconds)=>{
    calls.push({stage,program,args,milliseconds});
    if(stage===fail)throw new Error(`failed ${stage}`);
    if(cleanupFails&&stage==='owned voice fixture cleanup')throw new Error('cleanup failed');
    return '';
  };
  return {calls,run};
}
const acceptance=(device:ReturnType<typeof recorder>,environment:NodeJS.ProcessEnv=env)=>androidVoiceAcceptance(environment,device.run,'/owned','linux',nonce);

test('voice acceptance refuses hosts and devices it does not own before any command',async()=>{
  const device=recorder();
  await expect(androidVoiceAcceptance({},device.run,'/owned','linux',nonce)).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidVoiceAcceptance({ANDROID_SERIAL:'R5CT1234'},device.run,'/owned','linux',nonce)).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidVoiceAcceptance({ANDROID_SERIAL:'192.168.240.112:5555'},device.run,'/owned','linux',nonce)).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidVoiceAcceptance(env,device.run,'/owned','darwin',nonce)).rejects.toThrow('requires Linux');
  expect(device.calls).toEqual([]);
});

test('pinned fixtures are verified, staged privately, used by the one Whisper case and removed',async()=>{
  const device=recorder();
  await acceptance(device);
  const [fixtures,...rest]=device.calls;
  expect([fixtures.program,fixtures.args.slice(0,1),fixtures.args.slice(2)]).toEqual(['sh',['/owned/.github/scripts/speech-fixtures.sh'],['ggml-tiny.en.bin','jfk.wav']]);
  const host=fixtures.args[1];
  expect(rest.map(call=>[call.program,...call.args])).toEqual([
    [adb,'-s','emulator-5580','shell','mkdir','-p',staging],
    [adb,'-s','emulator-5580','push',join(host,'ggml-tiny.en.bin'),`${staging}/ggml-tiny.en.bin`],
    [adb,'-s','emulator-5580','push',join(host,'jfk.wav'),`${staging}/jfk.wav`],
    [gradle,'-p','/owned/apps/client/src-tauri/gen/android',':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug','-PlazyshVoiceAcceptance=true',
      `-Pandroid.testInstrumentationRunnerArguments.class=${voiceCase}`,
      `-Pandroid.testInstrumentationRunnerArguments.lazyshVoiceFixtures=${staging}`],
    [adb,'-s','emulator-5580','shell','rm','-rf',staging],
  ]);
  // The fixtures live in a directory this run created, so it is gone again.
  await expect(stat(host)).rejects.toThrow();
});

test('a caller-owned fixture cache survives the run',async()=>{
  const cache=await mkdtemp(join(tmpdir(),'lazysh-voice-cache-test-'));
  temporary.push(cache);
  const device=recorder();
  await acceptance(device,{...env,LAZYSH_RUNTIME_FIXTURES:cache});
  expect(device.calls[0].args[1]).toBe(cache);
  expect((await stat(cache)).isDirectory()).toBe(true);
});

test.each([
  ['owned voice pinned fixtures',['owned voice pinned fixtures','owned voice fixture cleanup']],
  ['owned voice ggml-tiny.en.bin push',['owned voice pinned fixtures','owned voice fixture directory','owned voice ggml-tiny.en.bin push','owned voice fixture cleanup']],
  ['actual Android local Whisper instrumentation',['owned voice pinned fixtures','owned voice fixture directory','owned voice ggml-tiny.en.bin push','owned voice jfk.wav push','actual Android local Whisper instrumentation','owned voice fixture cleanup']],
])('a failure at %s stops the run, removes the staged directory and is the error reported',async(stage,expected)=>{
  const device=recorder(stage);
  await expect(acceptance(device)).rejects.toThrow(`failed ${stage}`);
  expect(device.calls.map(call=>call.stage)).toEqual(expected);
});

test('a cleanup failure after an instrumentation failure never replaces it',async()=>{
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    const device=recorder('actual Android local Whisper instrumentation',true);
    await expect(acceptance(device)).rejects.toThrow('failed actual Android local Whisper instrumentation');
    expect(warning).toHaveBeenCalledWith('Owned voice fixture cleanup failed after original failure');
  } finally {warning.mockRestore();}
});

test('a cleanup failure after a passing run is reported, not swallowed',async()=>{
  await expect(acceptance(recorder(undefined,true))).rejects.toThrow('cleanup failed');
});

// moon sets LAZYSH_ANDROID_UI_VOICE for client:test-android-voice; every other run skips the device case.
test.skipIf(process.env.LAZYSH_ANDROID_UI_VOICE!=='1')('actual Android local Whisper transcription and model removal',async()=>{
  await androidVoiceAcceptance();
},2_400_000);
