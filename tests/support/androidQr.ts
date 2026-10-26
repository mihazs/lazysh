import {join,resolve} from 'node:path';
import {OwnedProcess} from './androidSsh';
import {attestQrCamera,type QrOwnership} from './androidQrOwnership';

export type QrCommand=(stage:string,program:string,args:string[],milliseconds:number)=>Promise<unknown>;
const execute:QrCommand=(stage,program,args,milliseconds)=>new OwnedProcess(program,args).finish(stage,milliseconds);
export async function androidQrAcceptance(env=process.env,run:QrCommand=execute,root=resolve(import.meta.dir,'../..'),platform=process.platform,attest:(env:NodeJS.ProcessEnv,root:string)=>Promise<QrOwnership>=attestQrCamera) {
  if(platform!=='linux')throw new Error('Owned Android QR acceptance requires Linux');
  const serial=env.ANDROID_SERIAL;
  if(!serial||!/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  const ownership=await attest(env,root);
  const ownedRun:QrCommand=async(...args)=>{await ownership.check();return run(...args);};
  const adb=env.ANDROID_HOME?join(env.ANDROID_HOME,'platform-tools/adb'):'adb';
  const android=join(root,'apps/client/src-tauri/gen/android');
  await ownedRun('owned QR APK install',adb,['-s',serial,'install','-r','-t',join(android,'app/build/outputs/apk/universal/debug/app-universal-debug.apk')],30_000);
  const permission=['android.permission.CAMERA'];
  const shell=(stage:string,args:string[],flags:string[]=[])=>ownedRun(stage,adb,['-s',serial,'shell','pm',...args,'app.lazysh.client',...permission,...flags],10_000);
  // Reset BEFORE instrumentation: revoking a permission may kill the target process.
  await shell('owned QR permission reset',['revoke']);
  await shell('owned QR permission flags',['clear-permission-flags'],['user-set','user-fixed']);
  let failed=false;
  try {await ownedRun('actual Android QR camera UI instrumentation',join(android,'gradlew'),[
    '-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
    '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
    '-PlazyshQrCameraAcceptance=true',
    '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#ownedQrCameraRequiresPermissionAndExplicitPreview',
  ],540_000);} catch(error){failed=true;throw error;}
  finally {try{await shell('owned QR permission cleanup',['revoke']);}catch(error){if(!failed)throw error;console.error('Owned QR cleanup failed after original failure');}}
}
