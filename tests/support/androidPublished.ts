import {isAbsolute,join,resolve} from 'node:path';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {OwnedProcess} from './ownedProcess';
import {attestQrCamera,type QrOwnership} from './androidQrOwnership';
import {digestFile} from '../../.changeset/release-artifacts';
import {preparePublishedApk,publishedAssetFailure} from './androidPublishedAssets';

export type PublishedCommand=(program:string,args:string[],milliseconds:number)=>Promise<string>;
export const publishedPackage='app.lazysh.client',driverPackage='app.lazysh.acceptance';
const component=`${driverPackage}/androidx.test.runner.AndroidJUnitRunner`;
type CommandFailure='deadline'|'nonzero'|'start'|'teardown'|'output-bound'|'unavailable';
class PublishedCommandError extends Error {
  readonly #outcome:CommandFailure;
  readonly #progress:DriverProgress;
  constructor(outcome:CommandFailure,progress:DriverProgress){
    super('Published APK command failed');this.#outcome=outcome;this.#progress=Object.freeze(progress);
  }
  get outcome(){return this.#outcome;}
  get progress(){return this.#progress;}
}
export function publishedCommandProgress(error:unknown):DriverProgress{
  try{if(error instanceof PublishedCommandError)return error.progress;}catch{}
  return {state:'unavailable'};
}
export function publishedCommandFailure(error:unknown):CommandFailure{
  try{
    if(error instanceof PublishedCommandError)return error.outcome;
    const message=error instanceof Error?error.message:'';
    if(typeof message!=='string'||message.length>256)return 'unavailable';
    if(message==='Owned fixture deadline: published APK command')return 'deadline';
    if(message==='Owned fixture process could not start')return 'start';
    if(message==='Owned fixture process teardown deadline')return 'teardown';
    if(message==='Published APK output exceeded bound')return 'output-bound';
    const exit=/^Owned fixture failed: published APK command; exit=([1-9]\d{0,2})$/.exec(message);
    if(exit&&Number(exit[1])<=255)return 'nonzero';
  }catch{}
  return 'unavailable';
}
export function publishedCliFailure(error:unknown){
  const asset=publishedAssetFailure(error);
  if(asset!=='unavailable')return `asset:${asset}`;
  const labels=[['Published APK environment required','environment'],['Published APK requires an absent fresh AVD','avd-present'],
    ['Published APK private state rejected','private-state'],['Published APK private path rejected','private-path'],
    ['Published APK image revision rejected','image-revision'],['Published APK owned emulator admission failed','emulator-admission'],
    ['Published APK acceptance failed','acceptance']] as const;
  try{const message=error instanceof Error?error.message:'';return typeof message==='string'&&message.length<=256?labels.find(([label])=>label===message)?.[1]??'unavailable':'unavailable';}catch{return 'unavailable';}
}
export async function publishedOutput(program:string,args:string[],milliseconds:number):Promise<string>{
  if(!Number.isInteger(milliseconds)||milliseconds<1||milliseconds>60000)throw new Error('Published APK command deadline rejected');
  const process=new OwnedProcess(program,args,undefined,undefined,false);
  const chunks:Buffer[]=[];let bytes=0;
  process.child.stdout!.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes<=65536)chunks.push(chunk);});
  try{
    await process.finish('published APK command',milliseconds);
    if(bytes>65536)throw new Error('Published APK output exceeded bound');
    return Buffer.concat(chunks).toString('utf8').trim();
  }catch(error){
    throw new PublishedCommandError(publishedCommandFailure(error),bytes>65536?{state:'unavailable'}:publishedDriverProgress(Buffer.concat(chunks).toString('utf8')));
  }
}
export function publishedInstrumentation(output:string,phase:'create'|'verify'){
  if(output.length>65536||output.includes('\0'))return false;
  const lines=output.split(/\r?\n/);
  return lines.filter(line=>line==='INSTRUMENTATION_CODE: -1').length===1
    && lines.filter(line=>line===`INSTRUMENTATION_STATUS: lazyshPublishedPhase=${phase}`).length===1
    && lines.filter(line=>line==='INSTRUMENTATION_STATUS: lazyshPublishedPassed=true').length===1
    && lines.some(line=>line==='INSTRUMENTATION_STATUS: numtests=1')
    && lines.filter(line=>line.startsWith('INSTRUMENTATION_STATUS: numtests=')).every(line=>line==='INSTRUMENTATION_STATUS: numtests=1')
    && !lines.some(line=>/^INSTRUMENTATION_STATUS_CODE: -|^INSTRUMENTATION_FAILED|^INSTRUMENTATION_RESULT: shortMsg=/.test(line));
}
const driverStages=['ARGUMENTS','DEVICE_ADMISSION','LAUNCH','LAUNCH_WINDOW','WORKSPACE','WORKSPACE_READINESS','WORKSPACE_ADD_HOST','DRAWER','ADD_HOST','NAME','HOSTNAME','USERNAME','KEYBOARD','SCROLL_OWNER','FORM_SCROLL','SAVE_HOST','SAVED_HOST','EDIT_HOST','READBACK','COMPLETE'] as const;
type DriverProgress={state:'unavailable'}|{state:'available';stage:typeof driverStages[number];event:'entry'|'exit';depth:0|1|2|null};
export function publishedDriverProgress(output:string):DriverProgress{
  const unavailable=():DriverProgress=>({state:'unavailable'});
  if(Buffer.byteLength(output)>65536||output.includes('\0'))return unavailable();
  const lines=output.split('\n');lines.pop();
  const prefix='INSTRUMENTATION_STATUS: lazyshPublishedProgress=';
  let last:DriverProgress=unavailable(),records=0;
  for(let index=0;index<lines.length;index++){
    const line=lines[index].replace(/\r$/,'');
    if(!line.startsWith(prefix))continue;
    if(++records>256||line.length>256)return unavailable();
    // A complete marker requires its own completed sendStatus(0) frame.
    if(index+1===lines.length)break;
    if(lines[index+1].replace(/\r$/,'')!=='INSTRUMENTATION_STATUS_CODE: 0')return unavailable();
    try{
      const value=JSON.parse(line.slice(prefix.length));
      const keys=value&&typeof value==='object'?Object.keys(value).sort().join(','):'';
      if(!value||Array.isArray(value)||JSON.stringify(value)!==line.slice(prefix.length)||!['event,stage','depth,event,stage'].includes(keys)
        ||!driverStages.includes(value.stage)||(value.event!=='entry'&&value.event!=='exit'))return unavailable();
      // FORM_SCROLL→SCROLL_OWNER→input and WORKSPACE→DRAWER→named reach depth2.
      if(keys==='depth,event,stage'&&(!Number.isInteger(value.depth)||value.depth<0||value.depth>2))return unavailable();
      last={state:'available',stage:value.stage,event:value.event,depth:keys==='event,stage'?null:value.depth};
    }catch{return unavailable();}
  }
  return last;
}
export function publishedDriverStage(output:string):typeof driverStages[number]|'unavailable'{
  if(output.length>65536||output.includes('\0'))return 'unavailable';
  const reported=[...output.matchAll(/^INSTRUMENTATION_STATUS: stack=java\.lang\.AssertionError: Published APK UI: ([A-Z_]+)\r?$/gm)].map(match=>match[1]);
  const distinct=[...new Set(reported)];
  return distinct.length===1?driverStages.find(stage=>stage===distinct[0])??'unavailable':'unavailable';
}
const inputOperations=['NONE','LOOKUP','CLICK','SET','READBACK'] as const;
const inputFields=['NONE','NAME','HOSTNAME','USERNAME'] as const;
const hintShapes=['empty','other','unavailable','name-label','name-placeholder','name-label-placeholder','hostname-label','hostname-placeholder','hostname-label-placeholder','username-label','username-placeholder','username-label-placeholder'] as const;
const captionMatches=['zero','one','multiple','unavailable'] as const;
const readinessOutcomes=['true','false','exception','unavailable'] as const;
type ReadinessTrace={outcome:typeof readinessOutcomes[number];elapsedMs:number|null;polls:number;overflow:boolean;lastAdd:typeof captionMatches[number];lastOpen:typeof captionMatches[number]};
const saveOperations=['unavailable','lookup','click','complete'] as const;
type SaveTrace={operation:typeof saveOperations[number];raw:typeof captionMatches[number];visible:typeof captionMatches[number]};
type DriverObservation={state:'unavailable'}|{state:'available';inputOperation:typeof inputOperations[number];inputField:typeof inputFields[number];readbackMatched:boolean|null;foreground:'target'|'driver'|'other'|'unavailable';screenOn:boolean|null;keyguardLocked:boolean|null;editableCount:number|null;editableOverflow:boolean|null;hintShapes:typeof hintShapes[number][];addHostMatches:typeof captionMatches[number];openHostsMatches:typeof captionMatches[number];webView:boolean|null;readiness:ReadinessTrace;save:SaveTrace};
export function publishedDriverObservation(output:string):DriverObservation{
  const unavailable=():DriverObservation=>({state:'unavailable'});
  if(output.length>65536||output.includes('\0'))return unavailable();
  const prefix='INSTRUMENTATION_STATUS: lazyshPublishedObservation=';
  const reported=output.split(/\r?\n/).filter(line=>line.startsWith(prefix)).map(line=>line.slice(prefix.length));
  if(reported.length!==1||reported[0].length>2048)return unavailable();
  try{
    const data=JSON.parse(reported[0]),flag=(value:unknown)=>value===null||typeof value==='boolean';
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!=='addHostMatches,editableCount,editableOverflow,foreground,hintShapes,inputField,inputOperation,keyguardLocked,openHostsMatches,readbackMatched,readiness,save,screenOn,webView'
      ||!inputOperations.includes(data.inputOperation)||!inputFields.includes(data.inputField)
      ||!['target','driver','other','unavailable'].includes(data.foreground)
      ||![data.readbackMatched,data.screenOn,data.keyguardLocked,data.webView].every(flag)
      ||![data.addHostMatches,data.openHostsMatches].every(value=>captionMatches.includes(value))
      ||!Array.isArray(data.hintShapes)||data.hintShapes.length>8||data.hintShapes.some((value:unknown)=>!hintShapes.includes(value as typeof hintShapes[number])))return unavailable();
    const trace=data.readiness;
    if(!trace||typeof trace!=='object'||Array.isArray(trace)||Object.keys(trace).sort().join(',')!=='elapsedMs,lastAdd,lastOpen,outcome,overflow,polls'
      ||!readinessOutcomes.includes(trace.outcome)||!Number.isInteger(trace.polls)||trace.polls<0||trace.polls>64||typeof trace.overflow!=='boolean'
      ||(trace.overflow&&trace.polls!==64)||![trace.lastAdd,trace.lastOpen].every(value=>captionMatches.includes(value))
      ||(trace.lastOpen!=='unavailable'&&trace.lastAdd!=='zero'))return unavailable();
    if(trace.outcome==='unavailable'){
      if(trace.elapsedMs!==null||trace.polls!==0||trace.overflow||trace.lastAdd!=='unavailable'||trace.lastOpen!=='unavailable')return unavailable();
    }else if(!Number.isInteger(trace.elapsedMs)||trace.elapsedMs<0||trace.elapsedMs>60000
      ||(trace.outcome!=='exception'&&trace.polls===0)
      ||(trace.polls===0&&(trace.lastAdd!=='unavailable'||trace.lastOpen!=='unavailable')))return unavailable();
    const save=data.save;
    if(!save||typeof save!=='object'||Array.isArray(save)||Object.keys(save).sort().join(',')!=='operation,raw,visible'
      ||!saveOperations.includes(save.operation)||![save.raw,save.visible].every(value=>captionMatches.includes(value))
      ||(save.operation==='unavailable'&&(save.raw!=='unavailable'||save.visible!=='unavailable'))
      ||(save.raw==='unavailable'&&save.visible!=='unavailable')
      ||(save.raw==='zero'&&!['zero','unavailable'].includes(save.visible))
      ||(save.raw==='one'&&save.visible==='multiple')
      ||(['click','complete'].includes(save.operation)&&(save.visible!=='one'||!['one','multiple'].includes(save.raw))))return unavailable();
    const absent=data.editableCount===null&&data.editableOverflow===null&&data.hintShapes.length===0;
    const present=Number.isInteger(data.editableCount)&&data.editableCount>=0&&data.editableCount<=8&&typeof data.editableOverflow==='boolean'
      &&data.hintShapes.length===data.editableCount&&(!data.editableOverflow||data.editableCount===8);
    if((!absent&&!present)||(data.readbackMatched!==null&&data.inputOperation!=='READBACK')
      ||(data.inputOperation==='NONE')!==(data.inputField==='NONE'))return unavailable();
    return {state:'available',inputOperation:data.inputOperation,inputField:data.inputField,readbackMatched:data.readbackMatched,
      foreground:data.foreground,screenOn:data.screenOn,keyguardLocked:data.keyguardLocked,
      editableCount:data.editableCount,editableOverflow:data.editableOverflow,hintShapes:[...data.hintShapes],
      addHostMatches:data.addHostMatches,openHostsMatches:data.openHostsMatches,webView:data.webView,
      readiness:{outcome:trace.outcome,elapsedMs:trace.elapsedMs,polls:trace.polls,overflow:trace.overflow,lastAdd:trace.lastAdd,lastOpen:trace.lastOpen},save:{operation:save.operation,raw:save.raw,visible:save.visible}};
  }catch{return unavailable();}
}
export function translatedGuest(values:string[]){
  const [api,abis,bridge,mapping]=values;
  return values.length===4&&api==='35'&&abis==='x86_64,arm64-v8a'&&bridge==='libndk_translation.so'&&mapping==='x86_64';
}
type Asset=Awaited<ReturnType<typeof preparePublishedApk>>;
export async function publishedAcceptance(asset:Asset,driver:string,nonce:string,env=process.env,run:PublishedCommand=publishedOutput,attest:(env:NodeJS.ProcessEnv,root:string)=>Promise<QrOwnership>=attestQrCamera){
  const serial=env.ANDROID_SERIAL,sdk=env.ANDROID_HOME;
  if(process.platform!=='linux'||!sdk||!/^emulator-[0-9]{4,5}$/.test(serial??'')||!/^[a-f0-9]{32}$/.test(nonce))throw new Error('Published APK owned emulator admission failed');
  const root=resolve(import.meta.dir,'../..'),ownership=await attest(env,root),adb=join(sdk,'platform-tools/adb');
  const deadline=performance.now()+240000;
  const command=async(args:string[],limit=10000)=>{
    await ownership.check();const remaining=Math.floor(deadline-performance.now());
    if(remaining<limit+5000)throw new Error('Published APK overall deadline');
    return run(adb,['-s',serial!,...args],limit);
  };
  const owned:string[]=[],cleanup:string[]=[];let stage='guest-admission',failure=false;
  const receipt={schema:1,flavor:asset.flavor,version:asset.version,source:asset.sha,apkSha256:asset.sha256,certificateSha256:asset.certificateSha256,scope:'translated-arm64' as const,guestAdmitted:false,created:false,relaunched:false,reinstalled:false,preserved:false,guestBootSha256:null as string|null,guestFingerprintSha256:null as string|null,cleanup:'pending' as 'pending'|'passed'|'failed'|'unconfirmed',failureStage:null as string|null,driverStage:null as ReturnType<typeof publishedDriverStage>|null,driverObservation:null as DriverObservation|null,driverProgress:null as DriverProgress|null,driverCommand:{outcome:'unavailable' as ReturnType<typeof publishedCommandFailure>|'completed',elapsedMs:null as number|null}};
  const instrument=async(phase:'create'|'verify')=>{
    receipt.driverStage='unavailable';receipt.driverObservation={state:'unavailable'};receipt.driverProgress={state:'unavailable'};
    receipt.driverCommand={outcome:'unavailable',elapsedMs:null};const started=performance.now();let output:string;
    try{
      output=await command(['shell','am','instrument','-w','-r','-e','class','app.lazysh.acceptance.PublishedApkTest#publishedHost','-e','phase',phase,'-e','nonce',nonce,component],45000);
      receipt.driverCommand.outcome='completed';
    }catch(error){receipt.driverCommand.outcome=publishedCommandFailure(error);receipt.driverProgress=publishedCommandProgress(error);throw error;}
    finally{receipt.driverCommand.elapsedMs=Math.floor(Math.max(0,Math.min(60000,performance.now()-started)));}
    if(!publishedInstrumentation(output,phase)){
      receipt.driverStage=publishedDriverStage(output);receipt.driverObservation=publishedDriverObservation(output);receipt.driverProgress=publishedDriverProgress(output);
      throw new Error('Published APK UI phase incomplete');
    }
    receipt.driverStage=null;receipt.driverObservation=null;receipt.driverProgress=null;
  };
  try{
    const values=[];
    for(const name of ['ro.build.version.sdk','ro.product.cpu.abilist','ro.dalvik.vm.native.bridge','ro.dalvik.vm.isa.arm64'])values.push(await command(['shell','getprop',name]));
    if(!translatedGuest(values))throw new Error('Published APK translation admission failed');
    const boot=await command(['shell','cat','/proc/sys/kernel/random/boot_id']);
    const fingerprint=await command(['shell','getprop','ro.build.fingerprint']);
    if(!/^[a-f0-9-]{36}$/.test(boot)||!fingerprint||fingerprint.length>512||fingerprint.includes('\n'))throw new Error('Published APK guest identity unavailable');
    receipt.guestBootSha256=createHash('sha256').update(boot).digest('hex');
    receipt.guestFingerprintSha256=createHash('sha256').update(fingerprint).digest('hex');
    receipt.guestAdmitted=true;
    stage='package-absence';
    for(const name of [publishedPackage,driverPackage])if(await command(['shell','pm','list','packages',name])!=='')throw new Error('Published APK package already present');
    stage='asset-continuity';
    const actual=await digestFile(asset.apk,asset.bytes);
    if(actual.bytes!==asset.bytes||actual.sha256!==asset.sha256)throw new Error('Published APK changed after verification');
    stage='install';await command(['install',asset.apk],30000);owned.push(publishedPackage);
    stage='driver-install';await command(['install','-t',driver],30000);owned.push(driverPackage);
    if(await command(['shell','pm','list','instrumentation',driverPackage])!==`instrumentation:${component} (target=${driverPackage})`)throw new Error('Published APK driver must target itself');
    stage='create';await instrument('create');receipt.created=true;
    stage='relaunch';await command(['shell','am','force-stop',publishedPackage]);await instrument('verify');receipt.relaunched=true;
    stage='reinstall';await command(['shell','am','force-stop',publishedPackage]);
    const unchanged=await digestFile(asset.apk,asset.bytes);
    if(unchanged.sha256!==asset.sha256||unchanged.bytes!==asset.bytes)throw new Error('Published APK reinstall bytes changed');
    await command(['install','-r',asset.apk],30000);receipt.reinstalled=true;
    stage='preservation';await instrument('verify');receipt.preserved=true;
  }catch{failure=true;receipt.failureStage=stage;}
  finally{
    for(const name of owned.reverse())try{await ownership.check();await run(adb,['-s',serial!,'uninstall',name],10000);}catch{cleanup.push(name===driverPackage?'driver':'application');}
    receipt.cleanup=cleanup.length?'failed':failure&&['install','driver-install'].includes(stage)?'unconfirmed':'passed';
  }
  return {receipt,passed:!failure&&cleanup.length===0};
}

export function publishedState(value:unknown,base:string):value is Asset&{nonce:string}{
  if(!value||typeof value!=='object')return false;
  const state=value as Asset&{nonce:string};
  return Object.keys(state).sort().join(',')==='apk,bytes,certificateSha256,flavor,nonce,sha,sha256,tag,version'
    &&['google','foss'].includes(state.flavor)&&typeof state.version==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(state.version)
    &&state.tag===`v${state.version}`&&typeof state.sha==='string'&&/^[a-f0-9]{40}$/.test(state.sha)
    &&[state.sha256,state.certificateSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))
    &&Number.isSafeInteger(state.bytes)&&state.bytes>0&&state.bytes<=64*1024*1024
    &&typeof state.nonce==='string'&&/^[a-f0-9]{32}$/.test(state.nonce)
    &&state.apk===join(base,'assets',`lazysh-${state.version}-android-${state.flavor}-arm64.apk`);
}

export async function publishedMain(phase:string,env=process.env){
  const base=join(env.RUNNER_TEMP??'', 'lazysh-published-android');
  if(!env.RUNNER_TEMP||!isAbsolute(env.RUNNER_TEMP)||!env.ANDROID_HOME||!['prepare','run'].includes(phase))throw new Error('Published APK environment required');
  if(phase==='prepare'){
    const avd=join(env.HOME??'', '.android/avd/lazysh-runtime-api36');
    for(const file of [`${avd}.avd`,`${avd}.ini`]){
      try{await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      throw new Error('Published APK requires an absent fresh AVD');
    }
    await mkdir(base,{mode:0o700});await mkdir(join(base,'results'),{mode:0o700});
    const asset=await preparePublishedApk(env.PUBLISHED_RELEASE_TAG??'',env.PUBLISHED_FLAVOR as 'google'|'foss',join(base,'assets'),env.ANDROID_SIGNER_SHA256??'',env);
    await writeFile(join(base,'state.json'),JSON.stringify({...asset,nonce:randomBytes(16).toString('hex')}),{flag:'wx',mode:0o600});
  }else{
    const file=join(base,'state.json'),info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||info.size>4096||(info.mode&0o777)!==0o600)throw new Error('Published APK private state rejected');
    const state=JSON.parse(await readFile(file,'utf8'));
    if(!publishedState(state,base))throw new Error('Published APK private path rejected');
    const properties=await readFile(join(env.ANDROID_HOME,'system-images/android-35/google_apis/x86_64/source.properties'),'utf8');
    if(properties.length>16384||!/^Pkg.Revision=9\s*$/m.test(properties)||!/^AndroidVersion.ApiLevel=35\s*$/m.test(properties)||!/^SystemImage.Abi=x86_64\s*$/m.test(properties)||!/^SystemImage.TagId=google_apis\s*$/m.test(properties))throw new Error('Published APK image revision rejected');
    const driver=resolve(import.meta.dir,'../../apps/client/src-tauri/gen/android/published-acceptance/build/outputs/apk/debug/published-acceptance-debug.apk');
    const result=await publishedAcceptance(state,driver,state.nonce,env);
    await writeFile(join(base,'results',`${state.flavor}.json`),`${JSON.stringify(result.receipt,null,2)}\n`,{flag:'wx',mode:0o600});
    if(!result.passed)throw new Error('Published APK acceptance failed');
  }
}
if(import.meta.main)publishedMain(process.argv[2]??'').catch(error=>{console.error(`Published APK gate failed: ${publishedCliFailure(error)}; inspect finite receipt if available`);process.exitCode=1;});
