import {expect,spyOn,test} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {androidBiometricAcceptance,instrument,touchRequest,type BiometricCommand,type BiometricInstrumentation} from './support/androidBiometric';

const nonce='c'.repeat(32),secrets={nonce,pin:'482915'},env={ANDROID_SERIAL:'emulator-5580',ANDROID_HOME:'/sdk'};
const adb='/sdk/platform-tools/adb',noPause=async()=>{};
type Call={stage:string;args:string[]};
/** Simulates the device property channel and an instrumentation that asks for `fingers` in order. */
function emulator(fingers:number[],options:{foreign?:boolean;fail?:string;instrumentation?:Error}={}) {
  const calls:Call[]=[];let request='',asked=0,finished=false,stopped=false,foreign=options.foreign===true;
  let settle:(value:unknown)=>void=()=>{},reject:(error:unknown)=>void=()=>{};
  const result=new Promise((resolve,fail)=>{settle=resolve;reject=fail;});result.catch(()=>{});
  const next=()=>{
    if(asked<fingers.length){asked++;request=`${nonce}:${asked}:${fingers[asked-1]}`;return;}
    finished=true;if(options.instrumentation)reject(options.instrumentation);else settle('');
  };
  const run:BiometricCommand=async(stage,program,args)=>{
    expect(program).toBe(adb);expect(args.slice(0,2)).toEqual(['-s','emulator-5580']);
    calls.push({stage,args:args.slice(2)});
    if(stage===options.fail)throw new Error(`failed ${stage}`);
    if(args[3]==='getprop'){if(foreign){foreign=false;return `${'d'.repeat(32)}:9:1`;}return request;}
    if(args[4]==='debug.lazysh.biometric.ack'){expect(args[5]).toBe(request.split(':').slice(0,2).join(':'));next();}
    return '';
  };
  const start=(program:string,args:string[]):BiometricInstrumentation=>{
    expect(program).toBe('/owned/apps/client/src-tauri/gen/android/gradlew');
    expect(args).toContain('-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeBiometricVaultTest');
    expect(args).toContain(`-Pandroid.testInstrumentationRunnerArguments.lazyshBiometricNonce=${nonce}`);
    expect(args).toContain('-Pandroid.testInstrumentationRunnerArguments.lazyshBiometricPin=482915');
    next();
    return {finished:()=>finished,result,stop:async()=>{stopped=true;finished=true;}};
  };
  return {calls,run,start,stopped:()=>stopped,touches:()=>calls.filter(call=>call.args[0]==='emu'&&call.args[2]==='touch').map(call=>Number(call.args[3]))};
}
const acceptance=(device:ReturnType<typeof emulator>)=>androidBiometricAcceptance(env,device.run,'/owned','linux',device.start,secrets,noPause);

test('biometric acceptance refuses hosts and devices it does not own before any command',async()=>{
  const device=emulator([]);
  await expect(androidBiometricAcceptance({},device.run,'/owned','linux',device.start,secrets,noPause)).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidBiometricAcceptance({ANDROID_SERIAL:'R5CT1234'},device.run,'/owned','linux',device.start,secrets,noPause)).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidBiometricAcceptance(env,device.run,'/owned','darwin',device.start,secrets,noPause)).rejects.toThrow('requires Linux');
  expect(device.calls).toEqual([]);
});

test('each instrumentation request becomes exactly one touch and lift before its acknowledgement',async()=>{
  const device=emulator([1,1,2,1],{foreign:true});
  await acceptance(device);
  expect(device.touches()).toEqual([1,1,2,1]);
  const mutations=device.calls.filter(call=>call.args[0]!=='shell'||call.args[1]!=='getprop').map(call=>call.args.join(' '));
  expect(mutations).toEqual([
    'shell svc power stayon true','shell input keyevent KEYCODE_WAKEUP','shell wm dismiss-keyguard','shell locksettings set-pin 482915',
    ...[1,1,2,1].flatMap((finger,index)=>[`emu finger touch ${finger}`,'emu finger remove',`shell setprop debug.lazysh.biometric.ack ${nonce}:${index+1}`]),
    'shell locksettings clear --old 482915',
  ]);
});

test('an existing device lock stops acceptance without instrumentation or clearing that lock',async()=>{
  const device=emulator([1],{fail:'owned biometric PIN'});
  await expect(acceptance(device)).rejects.toThrow('failed owned biometric PIN');
  expect(device.touches()).toEqual([]);
  expect(device.calls.some(call=>call.args.includes('clear'))).toBe(false);
});

test('instrumentation failure still clears the disposable PIN and keeps the first failure',async()=>{
  const primary=new Error('instrumentation failed');
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    const passed=emulator([1],{instrumentation:primary});
    await expect(acceptance(passed)).rejects.toBe(primary);
    expect(passed.calls.at(-1)?.args).toEqual(['shell','locksettings','clear','--old','482915']);
    const cleanup=emulator([1],{instrumentation:primary,fail:'owned biometric PIN cleanup'});
    await expect(acceptance(cleanup)).rejects.toBe(primary);
    expect(warning).toHaveBeenCalledWith('Owned biometric PIN cleanup failed after original failure');
  } finally {warning.mockRestore();}
});

test('a lost touch channel stops instrumentation and clears the PIN',async()=>{
  const device=emulator([1,2],{fail:'owned fingerprint touch'});
  await expect(acceptance(device)).rejects.toThrow('failed owned fingerprint touch');
  expect(device.stopped()).toBe(true);
  expect(device.calls.at(-1)?.args).toEqual(['shell','locksettings','clear','--old','482915']);
});

test('touch requests accept only this run, a positive sequence and the two fixture fingers',()=>{
  expect(touchRequest(`${nonce}:12:2\n`,nonce)).toEqual({sequence:12,finger:2});
  for(const value of ['',`${nonce}:0:1`,`${nonce}:1:3`,`${nonce}:1:1;reboot`,`${'d'.repeat(32)}:1:1`,`${nonce}:1234567:1`])
    expect(touchRequest(value,nonce)).toBeUndefined();
});

test.skipIf(process.env.LAZYSH_ANDROID_UI_BIOMETRIC!=='1')('actual Android enrolled fingerprint unlock, resume lock, export and host deletion',async()=>{
  await androidBiometricAcceptance();
},660_000);

test('a failed biometric instrumentation names its failed case in the job log and keeps the original error',async()=>{
  const android=await mkdtemp(join(tmpdir(),'lazysh-biometric-report-')),logged=spyOn(console,'error').mockImplementation(()=>{});
  try {
    const results=join(android,'app/build/outputs/androidTest-results/biometric-vault/connected/debug/flavors/universal');
    const gradlew=join(android,'gradlew');
    await writeFile(gradlew,`#!/bin/sh\nmkdir -p '${results}'\ncat > '${results}/TEST-device-_app-universal.xml' <<'XML'\n<testsuites><testsuite><testcase name="null"><failure>java.lang.IllegalStateException: Fingerprint enrollment did not complete after 311 touches\nat app.lazysh.client.NativeBiometricVaultTest$Companion.enroll(NativeBiometricVaultTest.kt:130)\n</failure></testcase></testsuite></testsuites>\nXML\nexit 1\n`,{mode:0o700});
    const run=instrument(gradlew,[]);
    await expect(run.result).rejects.toThrow('Owned fixture failed: actual Android enrolled-fingerprint vault instrumentation; exit=1');
    expect(logged).toHaveBeenCalledWith('Owned instrumentation failure '+JSON.stringify([{test:'null',
      failure:'java.lang.IllegalStateException: Fingerprint enrollment did not complete after 311 touches',
      at:'at app.lazysh.client.NativeBiometricVaultTest$Companion.enroll(NativeBiometricVaultTest.kt:130)'}]));
  } finally {logged.mockRestore();await rm(android,{recursive:true,force:true});}
});
