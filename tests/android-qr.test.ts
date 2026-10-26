import {expect,test,spyOn} from 'bun:test';
import {androidQrAcceptance,type QrCommand} from './support/androidQr';
const admitted=async()=>({check:async()=>{}});

test('QR acceptance restricts setup to an explicit owned Linux emulator',async()=>{
  const run:QrCommand=async()=>{throw new Error('Must not run');};
  await expect(androidQrAcceptance({},run,'/owned','linux')).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidQrAcceptance({ANDROID_SERIAL:'physical-device'},run,'/owned','linux')).rejects.toThrow('Use an explicitly selected owned emulator');
  await expect(androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},run,'/owned','darwin')).rejects.toThrow('Owned Android QR acceptance requires Linux');
});
test('QR native selection follows camera-only reset without granting permission',async()=>{
  const calls:{stage:string;program:string;args:string[];milliseconds:number}[]=[];
  await androidQrAcceptance({ANDROID_SERIAL:'emulator-5580',ANDROID_HOME:'/sdk'},async(stage,program,args,milliseconds)=>{calls.push({stage,program,args,milliseconds});},'/owned','linux',admitted);
  expect(calls.map(call=>call.args)).toEqual([
    ['-s','emulator-5580','install','-r','-t','/owned/apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'],
    ['-s','emulator-5580','shell','pm','revoke','app.lazysh.client','android.permission.CAMERA'],
    ['-s','emulator-5580','shell','pm','clear-permission-flags','app.lazysh.client','android.permission.CAMERA','user-set','user-fixed'],
    ['-p','/owned/apps/client/src-tauri/gen/android',':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
      '-PlazyshQrCameraAcceptance=true',
      '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#ownedQrCameraRequiresPermissionAndExplicitPreview'],
    ['-s','emulator-5580','shell','pm','revoke','app.lazysh.client','android.permission.CAMERA'],
  ]);
  expect(calls.map(call=>call.program)).toEqual(['/sdk/platform-tools/adb','/sdk/platform-tools/adb','/sdk/platform-tools/adb','/owned/apps/client/src-tauri/gen/android/gradlew','/sdk/platform-tools/adb']);
  expect(calls.map(call=>call.milliseconds)).toEqual([30_000,10_000,10_000,540_000,10_000]);
});
test.each([0,1,2,3])('QR setup/instrumentation failure at step %i stops the exact selection',async failure=>{
  let calls=0;
  const original=new Error('owned failure');
  await expect(androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async()=>{if(calls++===failure)throw original;},'/owned','linux',admitted)).rejects.toBe(original);
  expect(calls).toBe(failure+1+(failure===3?1:0));
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
    },'/owned','linux',admitted);
    await expect(result).rejects.toBe(failed?primary:cleanup);
    expect(calls).toBe(5);
    if(failed)expect(warning).toHaveBeenCalledWith('Owned QR cleanup failed after original failure');
    else expect(warning).not.toHaveBeenCalled();
  }finally{warning.mockRestore();}
});
test.each([0,1,2,3,4])('lost emulator ownership before mutation %i never dispatches it',async lost=>{
  let checks=0,calls=0;
  const original=new Error('attestation failed');
  const warning=spyOn(console,'error').mockImplementation(()=>{});
  try {
    await expect(androidQrAcceptance({ANDROID_SERIAL:'emulator-5580'},async()=>{calls++;},'/owned','linux',async()=>({check:async()=>{
      if(checks++>=lost)throw original;
    }}))).rejects.toBe(original);
    expect(calls).toBe(lost);
  }finally{warning.mockRestore();}
});
