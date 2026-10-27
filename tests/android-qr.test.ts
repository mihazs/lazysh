import {expect,test,spyOn} from 'bun:test';
import {androidQrAcceptance,type QrCommand} from './support/androidQr';
const admitted=async()=>({check:async()=>{}});
const nonce='a'.repeat(32),relative=`cache/lazysh-qr-frame-${nonce}.png`;
const capture={nonce,exportFrame:async()=>{}};

test('QR acceptance restricts setup to an explicit owned Linux emulator',async()=>{
  const run:QrCommand=async()=>{throw new Error('Must not run');};
  await expect(androidQrAcceptance({},run,'/owned','linux')).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidQrAcceptance({ANDROID_SERIAL:'physical-device'},run,'/owned','linux')).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},run,'/owned','darwin')).rejects.toThrow('Owned Android QR acceptance requires Linux');
});
test('QR native selection follows camera-only reset without granting permission',async()=>{
  const calls:{stage:string;program:string;args:string[];milliseconds:number}[]=[];
  await androidQrAcceptance({ANDROID_SERIAL:'emulator-5580',ANDROID_HOME:'/sdk'},async(stage,program,args,milliseconds)=>{calls.push({stage,program,args,milliseconds});},'/owned','linux',admitted,capture);
  expect(calls.map(call=>call.args)).toEqual([
    ['-s','emulator-5580','install','-r','-t','/owned/apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'],
    ['-s','emulator-5580','shell','pm','revoke','app.lazysh.client','android.permission.CAMERA'],
    ['-s','emulator-5580','shell','pm','clear-permission-flags','app.lazysh.client','android.permission.CAMERA','user-set','user-fixed'],
    ['-p','/owned/apps/client/src-tauri/gen/android',':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
      '-PlazyshQrCameraAcceptance=true',
      '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#ownedQrCameraRequiresPermissionAndExplicitPreview',
      `-Pandroid.testInstrumentationRunnerArguments.lazyshQrFrameNonce=${nonce}`,
      '-Pandroid.testInstrumentationRunnerArguments.lazyshQrFrameEnabled=true'],
    ['-s','emulator-5580','exec-out','run-as','app.lazysh.client','rm','-f',relative],
    ['-s','emulator-5580','shell','pm','revoke','app.lazysh.client','android.permission.CAMERA'],
  ]);
  expect(calls.map(call=>call.program)).toEqual(['/sdk/platform-tools/adb','/sdk/platform-tools/adb','/sdk/platform-tools/adb','/owned/apps/client/src-tauri/gen/android/gradlew','/sdk/platform-tools/adb','/sdk/platform-tools/adb']);
  expect(calls.map(call=>call.milliseconds)).toEqual([30_000,10_000,10_000,540_000,3_000,10_000]);
});
test.each([0,1,2,3])('QR setup/instrumentation failure at step %i stops the exact selection',async failure=>{
  let calls=0;
  const original=new Error('owned failure');
  await expect(androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async()=>{if(calls++===failure)throw original;},'/owned','linux',admitted,capture)).rejects.toBe(original);
  expect(calls).toBe(failure+1+(failure===3?2:0));
});
test.skipIf(process.env.LAZYSH_ANDROID_UI_QR!=='1')('actual Android QR camera permission and decoded preview',async()=>{
  await androidQrAcceptance();
},610_000);
test.each([false,true])('QR cleanup preserves the first failure, prior instrumentation failure=%s',async failed=>{
  const primary=new Error('instrumentation failed'),cleanup=new Error('cleanup failed');
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    let calls=0;
    const result=androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async()=>{
      calls++;
      if(calls===4&&failed)throw primary;
      if(calls===5)throw cleanup;
    },'/owned','linux',admitted,capture);
    await expect(result).rejects.toBe(failed?primary:cleanup);
    expect(calls).toBe(6);
    if(failed)expect(warning).toHaveBeenCalledWith('Owned QR cleanup failed after original failure');
    else expect(warning).not.toHaveBeenCalled();
  }finally{warning.mockRestore();}
});
test.each([0,1,2,3,4,5,6])('lost emulator ownership before mutation %i never dispatches it',async lost=>{
  let checks=0,calls=0;
  const original=new Error('attestation failed');
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    await expect(androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async()=>{calls++;},'/owned','linux',async()=>({check:async()=>{
      if(checks++>=lost)throw original;
    }}),capture)).rejects.toBe(original);
    expect(calls).toBe([0,1,2,3,4,4,5][lost]);
  }finally{warning.mockRestore();}
});
test.each([false,true])('one optional frame export preserves acceptance result, instrumentation failed=%s',async failed=>{
  const events:string[]=[],failure=new Error('native failed');
  const exports:{program:string;args:string[];destination:string;milliseconds:number}[]=[];
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    const result=androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async stage=>{
      events.push(stage);if(failed&&stage==='actual Android QR camera UI instrumentation')throw failure;
    },'/owned','linux',admitted,{nonce,exportFrame:async(program,args,destination,milliseconds)=>{
      events.push('export');exports.push({program,args,destination,milliseconds});
      throw new Error('unlogged diagnostic bytes');
    }});
    if(failed)await expect(result).rejects.toBe(failure);else await result;
    expect(exports).toEqual([{program:'adb',args:['-s','emulator-5580','exec-out','run-as','app.lazysh.client','cat',relative],
      destination:`/owned/apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results/qr-camera/owned-frame-${nonce}.png`,milliseconds:3_000}]);
    expect(events.slice(-3)).toEqual(['export','owned QR frame cleanup','owned QR permission cleanup']);
    expect(warning).toHaveBeenCalledWith('Owned QR frame diagnostic unavailable');
  }finally{warning.mockRestore();}
});
test.each([
  {setup:40_000,enabled:true,exportWait:3_000,instrument:true,elapsed:604_000},
  {setup:47_000,enabled:true,exportWait:1_000,instrument:true,elapsed:609_000},
  {setup:49_000,enabled:true,exportWait:0,instrument:true,elapsed:608_000},
  {setup:51_000,enabled:false,exportWait:0,instrument:true,elapsed:605_000},
  {setup:56_000,enabled:false,exportWait:0,instrument:false,elapsed:68_000},
])('overall budget includes every two-second teardown and keeps full acceptance: %j',async scenario=>{
  let clock=0;
  const stages:{stage:string;wait:number;args:string[]}[]=[],exports:number[]=[];
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    const pending=androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async(stage,_program,args,wait)=>{
      stages.push({stage,wait,args});
      if(stage==='owned QR permission flags')clock=scenario.setup;
      else if(stage==='actual Android QR camera UI instrumentation'||stage.endsWith('cleanup'))clock+=wait+2_000;
    },'/owned','linux',admitted,{nonce,now:()=>clock,exportFrame:async(_program,_args,_destination,wait)=>{exports.push(wait);clock+=wait+2_000;}});
    if(scenario.instrument)await pending;else await expect(pending).rejects.toThrow('Owned QR overall budget unavailable');
    const native=stages.find(item=>item.stage==='actual Android QR camera UI instrumentation');
    expect(!!native).toBe(scenario.instrument);
    if(native){expect(native.wait).toBe(540_000);expect(native.args.at(-1)).toBe(`-Pandroid.testInstrumentationRunnerArguments.lazyshQrFrameEnabled=${scenario.enabled}`);}
    expect(exports).toEqual(scenario.exportWait?[scenario.exportWait]:[]);
    expect(stages.filter(item=>item.stage==='owned QR frame cleanup')).toHaveLength(scenario.enabled?1:0);
    expect(stages.at(-1)?.stage).toBe('owned QR permission cleanup');expect(stages.at(-1)?.wait).toBe(10_000);
    expect(clock).toBe(scenario.elapsed);expect(clock).toBeLessThanOrEqual(610_000);
  }finally{warning.mockRestore();}
});
test.each([false,true])('cleanup reserve survives full-duration failure and optional export failure=%s',async exportFails=>{
  let clock=0;
  const primary=new Error('original native failure'),stages:string[]=[];
  const waits:number[]=[];
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    await expect(androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async(stage,_program,_args,wait)=>{
      stages.push(stage);
      if(stage==='owned QR permission flags')clock=47_000;
      else if(stage==='actual Android QR camera UI instrumentation'){clock+=wait+2_000;throw primary;}
      else if(stage.endsWith('cleanup')){clock+=wait+2_000;if(stage==='owned QR frame cleanup')throw new Error('secondary removal failure');}
    },'/owned','linux',admitted,{nonce,now:()=>clock,exportFrame:async(_program,_args,_destination,wait)=>{
      waits.push(wait);clock+=wait+2_000;if(exportFails)throw new Error('secondary diagnostic failure');
    }})).rejects.toBe(primary);
    expect(stages.slice(-2)).toEqual(['owned QR frame cleanup','owned QR permission cleanup']);
    expect(waits).toEqual([1_000]);
    expect(clock).toBe(609_000);
  }finally{warning.mockRestore();}
});
