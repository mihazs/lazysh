import {join,resolve} from 'node:path';
import {OwnedProcess} from './androidSsh';
import {attestQrCamera,type QrOwnership} from './androidQrOwnership';
import {exportQrFrame,qrFrameRelativePath,qrFrameFailureMetadata,type QrFrameExport,type QrFrameFailure} from './androidQrFrame';
import {randomBytes} from 'node:crypto';

export type QrCommand=(stage:string,program:string,args:string[],milliseconds:number)=>Promise<unknown>;
const execute:QrCommand=(stage,program,args,milliseconds)=>new OwnedProcess(program,args).finish(stage,milliseconds);
export async function androidQrAcceptance(env=process.env,run:QrCommand=execute,root=resolve(import.meta.dir,'../..'),platform=process.platform,attest:(env:NodeJS.ProcessEnv,root:string)=>Promise<QrOwnership>=attestQrCamera,capture:{nonce?:string;exportFrame?:QrFrameExport;now?:()=>number}={}) {
  const now=capture.now??(()=>performance.now()),deadline=now()+610_000;
  const teardown=2_000,margin=1_000,permissionReserve=10_000+teardown,removalReserve=3_000+teardown;
  const remaining=()=>Math.max(0,Math.floor(deadline-now()));
  const allowance=(requested:number,reserve=0,slack=margin)=>Math.max(0,Math.min(requested,remaining()-reserve-teardown-slack));
  const unavailable=()=>new Error('Owned QR overall budget unavailable');
  if(platform!=='linux')throw new Error('Owned Android QR acceptance requires Linux');
  const serial=env.ANDROID_SERIAL;
  if(!serial||!/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  const nonce=capture.nonce??randomBytes(16).toString('hex'),relative=qrFrameRelativePath(nonce);
  const ownership=await attest(env,root);
  async function ownedRun(stage:string,program:string,args:string[],requested:number,reserve=0,full=true){
    await ownership.check();
    const wait=allowance(requested,reserve);
    if(wait<1||(full&&wait!==requested))throw unavailable();
    return run(stage,program,args,wait);
  }
  const adb=env.ANDROID_HOME?join(env.ANDROID_HOME,'platform-tools/adb'):'adb';
  const android=join(root,'apps/client/src-tauri/gen/android');
  await ownedRun('owned QR APK install',adb,['-s',serial,'install','-r','-t',join(android,'app/build/outputs/apk/universal/debug/app-universal-debug.apk')],30_000);
  const permission=['android.permission.CAMERA'];
  const shell=(stage:string,args:string[],flags:string[]=[])=>ownedRun(stage,adb,['-s',serial,'shell','pm',...args,'app.lazysh.client',...permission,...flags],10_000);
  // Reset BEFORE instrumentation: revoking a permission may kill the target process.
  await shell('owned QR permission reset',['revoke']);
  await shell('owned QR permission flags',['clear-permission-flags'],['user-set','user-fixed']);
  let failed=false,captureEnabled=false;
  try {
    await ownership.check();
    // Preserve the full acceptance wait and required revoke/teardown. Diagnostics
    // may be disabled before native dispatch; they never borrow these reserves.
    if(allowance(540_000,permissionReserve)<540_000)throw unavailable();
    captureEnabled=allowance(540_000,permissionReserve+removalReserve)===540_000;
    if(!captureEnabled)console.error('Owned QR frame capture disabled by overall budget');
    await run('actual Android QR camera UI instrumentation',join(android,'gradlew'),[
    '-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
    '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
    '-PlazyshQrCameraAcceptance=true',
    '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#ownedQrCameraRequiresPermissionAndExplicitPreview',
    `-Pandroid.testInstrumentationRunnerArguments.lazyshQrFrameNonce=${nonce}`,
    `-Pandroid.testInstrumentationRunnerArguments.lazyshQrFrameEnabled=${captureEnabled}`,
  ],540_000);} catch(error){failed=true;throw error;}
  finally {
    let cleanupError:unknown;
    async function cleanup(action:()=>Promise<unknown>){try{await action();}catch(error){cleanupError??=error;}}
    if(captureEnabled){
      await cleanup(async()=>{
        await ownership.check();
        const wait=allowance(3_000,permissionReserve+removalReserve);
        if(wait<1){console.error('Owned QR frame export skipped to reserve cleanup budget');return;}
        let diagnostic:Readonly<QrFrameFailure>|undefined;
        try{await (capture.exportFrame??exportQrFrame)(adb,['-s',serial,'exec-out','run-as','app.lazysh.client','cat',relative],join(android,'app/build/outputs/androidTest-results/qr-camera',`owned-frame-${nonce}.png`),wait,value=>{diagnostic=qrFrameFailureMetadata(value);});}
        catch{
          try{
            console.error('Owned QR frame diagnostic unavailable');
            if(diagnostic)console.error('Owned QR frame failure metadata',JSON.stringify(diagnostic));
          }catch{/* Optional reporter output cannot replace the original acceptance result. */}
        }
      });
      await cleanup(()=>ownedRun('owned QR frame cleanup',adb,['-s',serial,'exec-out','run-as','app.lazysh.client','rm','-f',relative],3_000,permissionReserve,false));
    }
    await cleanup(async()=>{
      await ownership.check();
      // Final required cleanup may use the scheduling margin reserved for its
      // ownership read, but never the two-second process teardown allocation.
      const wait=allowance(10_000,0,0);if(wait<1)throw unavailable();
      await run('owned QR permission cleanup',adb,['-s',serial,'shell','pm','revoke','app.lazysh.client',...permission],wait);
    });
    if(cleanupError){if(!failed)throw cleanupError;console.error('Owned QR cleanup failed after original failure');}
  }
}
