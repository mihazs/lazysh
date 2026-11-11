import {randomBytes,randomInt} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {OwnedProcess,reportInstrumentationFailures} from './androidSsh';

export type BiometricCommand=(stage:string,program:string,args:string[],milliseconds:number)=>Promise<string>;
export type BiometricInstrumentation={finished:()=>boolean;result:Promise<unknown>;stop:()=>Promise<void>};
export type BiometricSecrets={nonce:string;pin:string};
const execute:BiometricCommand=(stage,program,args,milliseconds)=>new OwnedProcess(program,args).finish(stage,milliseconds);
export const instrument=(program:string,args:string[]):BiometricInstrumentation=>{
  const owned=new OwnedProcess(program,args);let finished=false;
  const result=owned.finish('actual Android enrolled-fingerprint vault instrumentation',600_000)
    .catch(async error=>{await reportInstrumentationFailures(join(dirname(program),'app/build/outputs/androidTest-results/biometric-vault'));throw error;})
    .finally(()=>{finished=true;});
  result.catch(()=>{});
  return {finished:()=>finished,result,stop:()=>owned.stop()};
};
const fresh=():BiometricSecrets=>({nonce:randomBytes(16).toString('hex'),pin:String(randomInt(100_000,1_000_000))});

/** Parses one instrumentation touch request; foreign nonces and unknown fingers are ignored. */
export function touchRequest(value:string,nonce:string) {
  const match=/^([0-9a-f]{32}):([1-9][0-9]{0,5}):([12])$/.exec(value.trim());
  return match&&match[1]===nonce?{sequence:Number(match[2]),finger:Number(match[3])}:undefined;
}

/**
 * Owned emulator only: sets a disposable PIN, runs NativeBiometricVaultTest and answers each of its
 * touch requests exactly once with `adb emu finger touch`. Clearing the PIN afterwards also removes
 * the fingerprint the instrumentation enrolled through Settings.
 */
export async function androidBiometricAcceptance(env=process.env,run:BiometricCommand=execute,root=resolve(import.meta.dir,'../..'),
  platform=process.platform,start=instrument,secrets:BiometricSecrets=fresh(),pause=(milliseconds:number)=>Bun.sleep(milliseconds)) {
  if(platform!=='linux')throw new Error('Owned Android biometric acceptance requires Linux');
  const serial=env.ANDROID_SERIAL;
  if(!serial||!/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  const adb=env.ANDROID_HOME?join(env.ANDROID_HOME,'platform-tools/adb'):'adb';
  const android=join(root,'apps/client/src-tauri/gen/android');
  const device=(stage:string,args:string[],milliseconds=10_000)=>run(stage,adb,['-s',serial,...args],milliseconds);
  // A secure lock turns screen-off into a PIN keyguard the instrumentation must not bypass.
  await device('owned biometric screen stay-on',['shell','svc','power','stayon','true']);
  await device('owned biometric wake',['shell','input','keyevent','KEYCODE_WAKEUP']);
  await device('owned biometric keyguard dismissal',['shell','wm','dismiss-keyguard']);
  // Without --old this fails when any lock credential exists, so the driver never replaces one it does not own.
  await device('owned biometric PIN',['shell','locksettings','set-pin',secrets.pin]);
  let failed=false;
  try {
    const gradle=start(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug','-PlazyshBiometricAcceptance=true',
      '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeBiometricVaultTest',
      `-Pandroid.testInstrumentationRunnerArguments.lazyshBiometricNonce=${secrets.nonce}`,
      `-Pandroid.testInstrumentationRunnerArguments.lazyshBiometricPin=${secrets.pin}`]);
    try {
      let delivered=0;
      while(!gradle.finished()) {
        const request=touchRequest(await device('owned biometric touch request',['shell','getprop','debug.lazysh.biometric.request'],5_000),secrets.nonce);
        if(!request||request.sequence<=delivered){await pause(250);continue;}
        await device('owned fingerprint touch',['emu','finger','touch',String(request.finger)]);
        await device('owned fingerprint lift',['emu','finger','remove']);
        await device('owned fingerprint acknowledgement',['shell','setprop','debug.lazysh.biometric.ack',`${secrets.nonce}:${request.sequence}`]);
        delivered=request.sequence;
      }
    } catch(error) {
      try{await gradle.stop();}catch{console.error('Owned biometric instrumentation stop failed after driver failure');}
      throw error;
    }
    await gradle.result;
  } catch(error){failed=true;throw error;}
  finally {
    try{await device('owned biometric PIN cleanup',['shell','locksettings','clear','--old',secrets.pin]);}
    catch(error){if(!failed)throw error;console.error('Owned biometric PIN cleanup failed after original failure');}
  }
}
