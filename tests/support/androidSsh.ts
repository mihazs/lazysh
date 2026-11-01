import {OwnedProcess, OUTPUT_LIMIT, identity} from './ownedProcess';
import {SshFixture, sshCommand} from './sshFixture';
export {SshFixture, listening, stopOwnedTree, type HerdrTools} from './sshFixture';
export {OwnedProcess, identity, type OwnedPid} from './ownedProcess';
import {chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, stat, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {HerdrFixture} from './androidHerdr';
import {OwnedCaseCrashParser} from './androidCaseCrash';
import {installedCompanion,publishedCompanion} from '../../apps/client/published-native-e2e/release';
import {observeAndroidMoshBackground} from './androidMoshBackground';

// Fixed native case names only; this is the existing ntfy tag scanner, not a general XML parser.
export function nativeReportCases(text:string) {
  const xml=text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g,'');
  const cases=[...xml.matchAll(/<testcase\b[^>]*>/g)].map(([tag])=>({name:/\sname="([^"]*)"/.exec(tag)?.[1],className:/\sclassname="([^"]*)"/.exec(tag)?.[1]}));
  return {cases,failed:/<(?:failure|error|skipped)\b/.test(xml)};
}
export function validateSharedHerdrReport(text:string) {
  const {cases,failed}=nativeReportCases(text),suite=/<testsuites\b[^>]*>/.exec(text)?.[0]??'';
  if(cases.length!==1 || cases[0].className!=='app.lazysh.client.NativeWorkspaceTest' || cases[0].name!=='ownedSharedHerdrNavigationThroughRealUi' || failed
    || !['tests="1"','failures="0"','errors="0"','skipped="0"'].every(value=>suite.includes(' '+value)) || !/<\/testsuites>\s*$/.test(text))
    throw new Error('Actual shared Herdr native case did not pass exactly once without skips');
  return {nativeCase:'ownedSharedHerdrNavigationThroughRealUi',passed:1,failed:0,skipped:0};
}
const reportIdentity=(value:{dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint})=>[value.dev,value.ino,value.size,value.mtimeNs].join(':');
async function sharedHerdrReportFile(directory:string,optional=false) {
  const entries=await readdir(directory,{recursive:true}).catch(error=>{if(optional && error.code==='ENOENT')return [];throw error;});
  const files=entries.filter(name=>name.endsWith('.xml'));
  if(optional && files.length===0)return;
  if(files.length!==1)throw new Error('Expected one owned shared Herdr native report');
  const path=join(directory,files[0]),metadata=await lstat(path,{bigint:true});
  if(!metadata.isFile() || metadata.size<1n || metadata.size>262144n)throw new Error('Invalid owned shared Herdr report file');
  return {path,identity:reportIdentity(metadata)};
}
export async function sharedHerdrReportIdentity(directory:string) {return (await sharedHerdrReportFile(directory,true))?.identity;}
export async function verifySharedHerdrResult(directory:string,previous?:string) {
  const report=(await sharedHerdrReportFile(directory))!;
  if(report.identity===previous)throw new Error('Shared Herdr native report was not refreshed');
  const file=await open(report.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const metadata=await file.stat({bigint:true});
    if(!metadata.isFile() || reportIdentity(metadata)!==report.identity)throw new Error('Shared Herdr report identity changed');
    const bytes=Buffer.alloc(Number(metadata.size)+1),read=await file.read(bytes,0,bytes.length,0);
    if(read.bytesRead!==Number(metadata.size) || reportIdentity(await file.stat({bigint:true}))!==report.identity)throw new Error('Shared Herdr report changed while reading');
    return validateSharedHerdrReport(bytes.subarray(0,read.bytesRead).toString('utf8'));
  } finally {await file.close();}
}

// Android 16 ApplicationExitInfo.dump fields; free-form descriptions/traces never leave memory.
// https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/app/ApplicationExitInfo.java
export async function packageExitInfo(adb:string,serial:string) {
  const records:{timestamp:string;pid:number;reason:number;subreason:number;status:number}[]=[];
  const shape={serviceHeader:false,recordHeaders:0,timestampRows:0,ownedProcessRows:0};
  const owned=new OwnedProcess(adb,['-s',serial,'shell','dumpsys','activity','exit-info','app.lazysh.client'],undefined,process.env,false);
  let bytes=0,pending='',discardLine=false,overflow=false;
  let stamp:{timestamp:string;pid:number}|undefined;
  let header=false;
  const line=(value:string)=>{
    if(value.trim()==='ACTIVITY MANAGER PROCESS EXIT INFO (dumpsys activity exit-info)')shape.serviceHeader=true;
    if(/^\s*ApplicationExitInfo #[0-9]+:\s*$/.test(value)){shape.recordHeaders=Math.min(256,shape.recordHeaders+1);header=true;stamp=undefined;return;}
    const expectsTimestamp=header;
    header=false;
    const previous=stamp;
    stamp=undefined;
    const time=value.match(/^\s*timestamp=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) pid=([0-9]{1,10}) realUid=[0-9]+ packageUid=[0-9]+ definingUid=[0-9]+ user=[0-9]+\s*$/);
    if(time)shape.timestampRows=Math.min(256,shape.timestampRows+1);
    if(expectsTimestamp && time){stamp={timestamp:time[1],pid:Number(time[2])};return;}
    const exit=value.match(/^\s*process=app\.lazysh\.client reason=([0-9]{1,2}) \([A-Z ()_]+\) subreason=([0-9]{1,3}) \([A-Z ()_]+\) status=(-?[0-9]{1,3})\s*$/);
    if(exit)shape.ownedProcessRows=Math.min(256,shape.ownedProcessRows+1);
    if(exit && previous && records.length<8)records.push({...previous,reason:Number(exit[1]),subreason:Number(exit[2]),status:Number(exit[3])});
  };
  owned.child.stdout!.on('data',(data:Buffer)=>{
    bytes+=data.length;
    if(bytes>64*1024){overflow=true;pending='';header=false;stamp=undefined;records.length=0;return;}
    for(const character of String(data)) {
      if(character==='\n') {if(!discardLine)line(pending);pending='';discardLine=false;}
      else if(!discardLine) {if(pending.length<1024)pending+=character;else{pending='';header=false;stamp=undefined;discardLine=true;}}
    }
  });
  try {
    await owned.finish('owned package exit inspection',5000);
    if(pending && !discardLine)line(pending);
    return {state:overflow?'overflow':records.length?'available':'empty',shape,records:overflow?[]:records};
  } catch {return {state:'unavailable',shape,records:[]};}
}

// All commands target the selected emulator; neither raw output nor daemon IDs escape.
async function continuityOutput(adb:string,serial:string,args:string[],deadline:number) {
  return diagnosticOutput(adb,['-s',serial,...args],deadline);
}
async function diagnosticOutput(program:string,args:string[],deadline:number) {
  const remaining=Math.floor(deadline-performance.now());
  if(remaining<=0)return {state:'unavailable',output:''};
  const owned=new OwnedProcess(program,args,undefined,process.env,false);
  let output='',overflow=false;
  owned.child.stdout!.on('data',(data:Buffer)=>{
    if(Buffer.byteLength(output)+data.length>4096){overflow=true;output='';return;}
    if(!overflow)output+=String(data);
  });
  try {
    await owned.finish('owned emulator continuity',remaining);
    if(performance.now()>=deadline)return {state:'unavailable',output:''};
    return {state:overflow?'overflow':'available',output:overflow?'':output.trim()};
  } catch {return {state:'unavailable',output:''};}
}

export type HostAdbServerSample={state:'available'|'inconclusive',hash:string|null,reason?:'unsupported-endpoint'|'probe-unavailable'|'missing-listener'|'unrecognized-listener'|'overflow'|'ownership-unverified'};
export async function hostAdbServerIdentity(adb:string):Promise<HostAdbServerSample> {
  const inconclusive=(reason:HostAdbServerSample['reason']):HostAdbServerSample=>({state:'inconclusive',hash:null,reason});
  const port=process.env.ANDROID_ADB_SERVER_PORT??'5037';
  if(process.platform!=='linux' || process.env.ADB_SERVER_SOCKET!==undefined ||
    ![undefined,'localhost','127.0.0.1'].includes(process.env.ANDROID_ADB_SERVER_ADDRESS) ||
    !/^[1-9][0-9]{0,4}$/.test(port) || Number(port)>65535)return inconclusive('unsupported-endpoint');
  const deadline=performance.now()+1000;
  // Only the selected loopback listener; ss never starts or repairs an ADB server.
  const result=await diagnosticOutput('/usr/bin/ss',['-H','-ltnpe',`src 127.0.0.1 and sport = :${port}`],deadline);
  if(result.state!=='available')return inconclusive(result.state==='overflow'?'overflow':'probe-unavailable');
  if(!result.output)return inconclusive('missing-listener');
  const owner=/^LISTEN\s+[0-9]+\s+[0-9]+\s+127[.]0[.]0[.]1:[0-9]+\s+\S+\s+users:\(\("[^"\r\n]{1,64}",pid=([1-9][0-9]{0,9}),fd=([0-9]{1,10})\)\)(?: uid:[0-9]+)? ino:([1-9][0-9]{0,19})\b/.exec(result.output);
  const inode=owner?.[3];
  const columns=result.output.split(/\s+/);
  if(result.output.includes('\n') || columns[0]!=='LISTEN' || columns[3]!==`127.0.0.1:${port}` ||
    !owner || !inode || Number(owner[1])>2147483647 || Number(owner[2])>2147483647)return inconclusive('unrecognized-listener');
  try {
    const pid=Number(owner[1]),fd=`/proc/${pid}/fd/${owner[2]}`;
    const before=await identity(pid);
    const [executable,expected,processStat,socket]=await Promise.all([realpath(`/proc/${pid}/exe`),realpath(adb),stat(`/proc/${pid}`),readlink(fd)]);
    const after=await identity(pid);
    if(!before || !after || !/^[1-9][0-9]{0,19}$/.test(before.start) || before.start!==after.start ||
      ['Z','X'].includes(after.state) || processStat.uid!==process.getuid?.() || executable!==expected ||
      socket!==`socket:[${inode}]` || await readlink(fd)!==socket || performance.now()>=deadline)return inconclusive('ownership-unverified');
    return {state:'available',hash:createHash('sha256').update(`${pid}:${before.start}`).digest('hex')};
  } catch {return inconclusive('ownership-unverified');}
}
export function compareHostAdbServer(before:HostAdbServerSample|undefined,after:HostAdbServerSample) {
  return before?.state==='available' && after.state==='available' && before.hash && after.hash?(before.hash===after.hash?'same':'changed'):'unknown';
}

export async function emulatorContinuity(adb:string,serial:string,reverse:string|undefined,targetPort:number) {
  const summary:{connection:string;process:string;mainPids:number[];reverse:string;transport:string;transportHash:string|null;boot:string;bootHash:string|null;adbd:string;adbdHash:string|null}={connection:'unavailable',process:'unavailable',mainPids:[],reverse:reverse?'unavailable':'not-created',transport:'unavailable',transportHash:null,boot:'unavailable',bootHash:null,adbd:'unavailable',adbdHash:null};
  await Promise.all((['connection','process','reverse','transport','boot','adbd'] as const).map(async kind=>{
    if(kind==='reverse' && !reverse)return;
    const deadline=performance.now()+1000;
    const args=kind==='connection'?['get-state']:kind==='process'?['shell','pidof','app.lazysh.client']:kind==='transport'?['transport-id']:kind==='boot'?['shell','cat','/proc/sys/kernel/random/boot_id']:kind==='adbd'?['shell','pidof','adbd']:['reverse','--list'];
    const result=await continuityOutput(adb,serial,args,deadline);
    if(result.state!=='available'){summary[kind]=result.state;return;}
    const output=result.output;
    if(kind==='adbd') {
      // One exact PID, then the same process's start tick within the original 1s budget.
      if(!/^[1-9][0-9]{0,9}$/.test(output)||Number(output)>2147483647){summary.adbd='unrecognized';return;}
      const stat=await continuityOutput(adb,serial,['shell','cat',`/proc/${output}/stat`],deadline);
      if(stat.state!=='available'){summary.adbd=stat.state;return;}
      const match=/^([1-9][0-9]{0,9}) \(adbd\) ([A-Za-z] .+)$/.exec(stat.output);
      const start=match?.[2].split(/\s+/)[19];
      if(match?.[1]!==output || !start || !/^[1-9][0-9]{0,19}$/.test(start)||BigInt(start)>18446744073709551615n){summary.adbd='unrecognized';return;}
      summary.adbd='available';summary.adbdHash=createHash('sha256').update(`${output}:${start}`).digest('hex');
    }
    if(kind==='transport' || kind==='boot') {
      const valid=kind==='transport'?/^[1-9][0-9]{0,19}$/.test(output) && BigInt(output)<=18446744073709551615n:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(output);
      summary[kind]=valid?'available':'unrecognized';
      if(valid)summary[kind==='boot'?'bootHash':'transportHash']=createHash('sha256').update(output.toLowerCase()).digest('hex');
    }
    if(kind==='connection')summary.connection=['device','offline','unknown'].includes(output)?output:'unrecognized';
    if(kind==='process') {
      const tokens=output.split(/\s+/);
      if(tokens.length<=16 && tokens.every(pid=>/^[1-9][0-9]{0,9}$/.test(pid))) {summary.mainPids=tokens.map(Number);summary.process='present';}
      else summary.process='unrecognized';
    }
    // The selected transport scopes this query; Android16 emits host-N/(reverse) display labels.
    if(kind==='reverse')summary.reverse=output.split(/\r?\n/).some(row=>{
      const fields=row.trim().split(/\s+/);
      return fields.length===3 && fields[1]===`tcp:${reverse}` && fields[2]===`tcp:${targetPort}`;
    })?'present':'missing';
  }));
  return summary;
}

// Only these two fixed IDs are installed by the dedicated owned-emulator task.
const ownedAndroidPackages=['app.lazysh.client','app.lazysh.client.test'] as const;
export async function ownedAndroidPackagePresence(adb:string,serial:string) {
  const result=await continuityOutput(adb,serial,['shell','pm','list','packages','app.lazysh.client'],performance.now()+1000);
  if(result.state!=='available')return {application:result.state,instrumentation:result.state};
  const lines=result.output?result.output.split(/\r?\n/):[];
  if(!lines.every(line=>/^package:[A-Za-z0-9_.]+$/.test(line)))return {application:'unrecognized',instrumentation:'unrecognized'};
  return {application:lines.includes(`package:${ownedAndroidPackages[0]}`)?'present':'absent',instrumentation:lines.includes(`package:${ownedAndroidPackages[1]}`)?'present':'absent'};
}

// Equality brackets two samples only; identity reuse/transient disconnects remain possible.
export function compareEmulatorContinuity(before:Awaited<ReturnType<typeof emulatorContinuity>>|undefined,after:Awaited<ReturnType<typeof emulatorContinuity>>) {
  const compare=(kind:'transport'|'boot'|'adbd')=>{
    const key=kind==='boot'?'bootHash':kind==='adbd'?'adbdHash':'transportHash';
    return before?.[kind]==='available' && after[kind]==='available' && before[key] && after[key]?(before[key]===after[key]?'same':'changed'):'unknown';
  };
  return {transport:compare('transport'),boot:compare('boot'),adbd:compare('adbd'),reverseLost:before && ['present','missing'].includes(before.reverse) && ['present','missing'].includes(after.reverse)?before.reverse==='present' && after.reverse==='missing':null};
}

// Presence in the last captured output window is reported text, never a cause verdict.
export function gradleFailureClasses(stdout:string,stderr:string) {
  const output=stdout.slice(-OUTPUT_LIMIT)+'\n'+stderr.slice(-OUTPUT_LIMIT);
  const flags={
    processCrash:/\bProcess crashed\b/i.test(output),
    deviceUnavailable:/\b(?:DeviceDisconnectedException|DeviceOfflineException)\b|\bdevice (?:is )?(?:offline|disconnected)\b/i.test(output),
    adbRejected:/\bAdbCommandRejectedException\b/.test(output),
    connectionReset:/\bConnection reset(?: by peer)?\b/i.test(output),
    deadlineReported:/\b(?:TimeoutException|AdbTimeoutException|ShellCommandUnresponsiveException)\b/.test(output),
    incompleteRun:/\bTest run failed to complete\b|\bINSTRUMENTATION_FAILED\b/.test(output),
  };
  return {scope:'last-output-window-only',...flags,unclassified:!Object.values(flags).some(Boolean)};
}

type AndroidCleanupStage='reverse'|'fixture-file'|'Herdr'|'SSH'|'app-package'|'test-package'|'software-keyboard';
export async function androidSshCleanup(primary:boolean,steps:readonly (readonly [AndroidCleanupStage,()=>Promise<unknown>])[]) {
  let failed=false;
  for(const [stage,cleanup] of steps)try{await cleanup();}catch{failed=true;console.error(`Owned Android SSH cleanup stage failed: ${stage}`);}
  if(failed){if(primary)console.error('Owned Android SSH cleanup failed after original failure');else throw new Error('Owned Android SSH cleanup failed');}
}

// No raw crash output enters OwnedProcess's retained output windows. This is a
// best-effort diagnostic child on the explicitly selected owned emulator only.
export async function recoverOwnedCaseCrash(adb:string,serial:string,source:OwnedCaseCrashParser) {
  const target=source.persistedParser();
  if(!target || !/^emulator-[0-9]{4,5}$/.test(serial))return {state:'ineligible' as const,exceptions:[]};
  const child=new OwnedProcess(adb,['-s',serial,'logcat','-b','crash','-d','--pid',String(target.pid),'-T',target.time,'-v','threadtime','AndroidRuntime:E','*:S'],undefined,process.env,false);
  child.child.stdout!.on('data',(chunk:Buffer)=>{target.parser.push(chunk);if(target.parser.recoverySummary().overflow)void child.stop().catch(()=>{});});
  child.child.stderr!.on('data',(chunk:Buffer)=>{target.parser.pushStderr(chunk);if(target.parser.recoverySummary().overflow)void child.stop().catch(()=>{});});
  try {
    await child.finish('owned persisted crash inspection',1000);
    target.parser.finish();
    const summary=target.parser.recoverySummary();
    return {state:summary.overflow?'overflow':summary.exceptions.length?'available':'empty',exceptions:summary.exceptions};
  } catch {
    return {state:target.parser.recoverySummary().overflow?'overflow':'unavailable',exceptions:[]};
  }
}
export function captureOwnedCaseCrashes(adb:string,serial:string,nonce:string) {
  const started=performance.now();
  const elapsedMs=()=>Math.min(3_600_000,Math.max(0,Math.floor(performance.now()-started)));
  const parser=new OwnedCaseCrashParser(nonce);
  // ActivityManager uses Slog's system buffer for force-stop provenance.
  const child=new OwnedProcess(adb,['-s',serial,'logcat','-b','main','-b','crash','-b','system','-v','threadtime','-T','1',
    'LazyshOwnedCase:I','AndroidRuntime:E','DEBUG:F','ActivityManager:I','*:S'],undefined,process.env,false);
  let stream:'running'|'stopped'|'closed'|'unavailable'|'overflow'|'deadline'='running';
  let stopping=false;
  const close:{phase:'unobserved'|'before-stop'|'during-stop',exitCode:number|null,signal:'none'|'SIGTERM'|'SIGKILL'|'SIGPIPE'|'SIGABRT'|'SIGSEGV'|'other',processError:boolean,stopFailed:boolean,elapsedMs:number|null}={phase:'unobserved',exitCode:null,signal:'none',processError:false,stopFailed:false,elapsedMs:null};
  let timer:ReturnType<typeof setTimeout>;
  const snapshot=()=>({...parser.summary(),stream,close:{...close}});
  let finished:Promise<ReturnType<typeof snapshot>>|undefined;
  const stop=()=>{
    if(!finished) {
      stopping=true;clearTimeout(timer);
      if(stream==='running')stream='stopped';
      finished=child.stop().catch(()=>{close.stopFailed=true;stream='unavailable';}).then(()=>{parser.finish();return snapshot();});
    }
    return finished;
  };
  child.child.stdout!.on('data',(chunk:Buffer)=>{
    parser.push(chunk);
    if(parser.summary().overflow){stream='overflow';void stop();}
  });
  child.child.stderr!.on('data',(chunk:Buffer)=>{
    parser.pushStderr(chunk);
    if(parser.summary().overflow){stream='overflow';void stop();}
  });
  child.child.once('error',()=>{close.processError=true;});
  child.child.once('close',(code,signal)=>{
    close.phase=stopping?'during-stop':'before-stop';
    close.elapsedMs=elapsedMs();
    close.exitCode=code!==null && Number.isInteger(code) && code>=0 && code<=255?code:null;
    close.signal=signal==null?'none':(['SIGTERM','SIGKILL','SIGPIPE','SIGABRT','SIGSEGV'] as const).find(value=>value===signal)??'other';
    parser.finish();
  });
  void child.done.then(code=>{if(!stopping)stream=code===0?'closed':'unavailable';},()=>{stream='unavailable';});
  timer=setTimeout(()=>{stream='deadline';void stop();},600_000);
  return {stop,snapshot,elapsedMs,recover:()=>recoverOwnedCaseCrash(adb,serial,parser)};
}
// LatinIME can acknowledge a visible IME window while hardware input suppresses
// its keyboard view. Admit real software input only on the owned test emulator,
// and restore the exact previous preference before package/fixture cleanup.
// The opt-in Google profile is calibrated separately; ordinary CI stays AOSP-only.
export async function ownedSoftwareKeyboard(adb:string,serial:string,budget=5000,profile:'aosp-latin'|'google-api36-latin'='aosp-latin') {
  if(!/^emulator-[0-9]{4,5}$/.test(serial) || !Number.isSafeInteger(budget) || budget<1 || budget>5000)
    throw new Error('Owned software keyboard requires an explicit emulator and bounded budget');
  if(!['aosp-latin','google-api36-latin'].includes(profile))throw new Error('Owned software keyboard profile is unsupported');
  const key='show_ime_with_hard_keyboard';
  const deadline=performance.now()+budget;
  const probe=async(args:string[],until:number,stage:string)=>{
    const result=await continuityOutput(adb,serial,['shell',...args],until);
    if(result.state!=='available')throw new Error(`Owned software keyboard unavailable: ${stage}`);
    return result.output;
  };
  const latin=(value:string)=>(profile==='aosp-latin'
    ? ['com.android.inputmethod.latin/.LatinIME','com.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME']
    : ['com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME']).includes(value);
  if(!latin(await probe(['settings','get','secure','default_input_method'],deadline,'default IME')))
    throw new Error(`Owned software keyboard requires the image ${profile==='aosp-latin'?'AOSP':'Google'} LatinIME`);
  const installed=await probe(['ime','list','-s'],deadline,'installed IME');
  if(!installed.split(/\r?\n/).some(latin))throw new Error('Owned software keyboard image IME is not installed');
  if(profile==='google-api36-latin') {
    const [sdk,model,system]=await Promise.all([
      probe(['getprop','ro.build.version.sdk'],deadline,'Google image SDK'),
      probe(['getprop','ro.product.model'],deadline,'Google image model'),
      probe(['pm','list','packages','-s','com.google.android.inputmethod.latin'],deadline,'Google system keyboard'),
    ]);
    if(sdk!=='36' || model!=='sdk_gphone64_x86_64' || !system.split(/\r?\n/).includes('package:com.google.android.inputmethod.latin'))
      throw new Error('Owned software keyboard Google API36 system image identity was not verified');
  }
  const get=(until:number)=>probe(['settings','get','secure',key],until,'preference');
  const previous=await get(deadline);
  if(!['0','1','null'].includes(previous))throw new Error('Owned software keyboard preference is unrecognized');
  let changed=false;
  const restore=async()=>{
    if(!changed)return;
    const until=performance.now()+budget;
    const current=await get(until);
    if(current===previous){changed=false;return;}
    if(current!=='1')throw new Error('Owned software keyboard preference changed unexpectedly');
    let failure:unknown;
    try {await probe(['settings',previous==='null'?'delete':'put','secure',key,...(previous==='null'?[]:[previous])],until,'restore');}
    catch(error){failure=error;}
    if(await get(until)!==previous)throw new Error('Owned software keyboard restoration was not verified');
    changed=false;
    if(failure)throw failure;
  };
  try {
    if(previous!=='1') {
      // Retain restoration ownership before the command: a lost acknowledgement
      // or deadline can follow an already-applied secure setting.
      changed=true;
      await probe(['settings','put','secure',key,'1'],deadline,'enable');
      if(await get(deadline)!=='1')throw new Error('Owned software keyboard enabling was not verified');
    }
  } catch(error) {
    await androidSshCleanup(true,[['software-keyboard',restore]]);
    throw error;
  }
  return {observation:{ime:profile,previous:previous==='1'?'enabled' as const:previous==='0'?'disabled' as const:'unset' as const,requested:'enabled' as const},restore};
}

export function attachmentReceipt(text:string,nonce:string) {
  let parsed:unknown;
  try{if(text.length>1024)throw new Error();parsed=JSON.parse(text);}catch{throw new Error('Owned attachment receipt invalid');}
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('Owned attachment receipt invalid');
  const value=parsed as Record<string,unknown>;
  if(!/^[a-f0-9]{32}$/.test(nonce) || Object.keys(value).sort().join(',')!=='bytes,height,nonce,schemaVersion,sha256,width'
    || value.schemaVersion!==1 || value.nonce!==nonce || typeof value.bytes!=='number' || !Number.isSafeInteger(value.bytes) || value.bytes<400*1024 || value.bytes>600*1024
    || value.width!==448 || value.height!==320 || typeof value.sha256!=='string' || !/^[a-f0-9]{64}$/.test(value.sha256))
    throw new Error('Owned attachment receipt invalid');
  return value as {schemaVersion:1;nonce:string;bytes:number;width:448;height:320;sha256:string};
}
export async function attachmentIdentity(path:string) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await file.stat({bigint:true});
    if(!before.isFile() || before.uid!==BigInt(process.getuid!()) || before.size<1n || before.size>BigInt(600*1024))throw new Error('Owned attachment file invalid');
    const bytes=Buffer.alloc(Number(before.size)+1);let bytesRead=0;
    while(bytesRead<bytes.length){const result=await file.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);if(!result.bytesRead)break;bytesRead+=result.bytesRead;}
    const after=await file.stat({bigint:true});
    if(bytesRead!==Number(before.size) || reportIdentity(before)!==reportIdentity(after))throw new Error('Owned attachment changed during readback');
    return {identity:reportIdentity(after),bytes:bytesRead,sha256:createHash('sha256').update(bytes.subarray(0,bytesRead)).digest('hex')};
  } finally {await file.close();}
}

/** Deliberately raw wire bytes: DEL erases only two committed ASCII characters. */
export function verifyImeReceiverBytes(bytes:Uint8Array,nonce:string) {
  if(!/^[a-f0-9]{32}$/.test(nonce))throw new Error('Owned IME nonce invalid');
  const expected=Buffer.from(`there\x7f\x7ftheowned-current-${nonce}`);
  if(!Buffer.from(bytes).equals(expected))throw new Error('Owned IME receiver bytes differ');
}

export function dpadReceipt(text:string,nonce:string) {
  if(text.length>512 || !/^[a-f0-9]{32}$/.test(nonce))throw new Error('Owned D-pad receipt invalid');
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('Owned D-pad receipt invalid');}
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Owned D-pad receipt invalid');
  const row=value as Record<string,unknown>,names=['up','left','down','right'];
  if(Object.keys(row).sort().join(',')!=='down,left,nonce,right,schemaVersion,up' || row.schemaVersion!==1 || row.nonce!==nonce
    || names.some((name,index)=>!Number.isInteger(row[name]) || Number(row[name])<(index===0?3:2) || Number(row[name])>32))throw new Error('Owned D-pad receipt invalid');
  return names.map(name=>Number(row[name]));
}
export function verifyDpadReceiverBytes(bytes:Uint8Array,nonce:string,counts:number[]) {
  if(!/^[a-f0-9]{32}$/.test(nonce) || counts.length!==4 || counts.some((count,index)=>!Number.isInteger(count)||count<(index===0?3:2)||count>32))throw new Error('Owned D-pad counts invalid');
  const wire=['\x1b[A','\x1b[D','\x1b[B','\x1b[C'].map((arrow,index)=>arrow.repeat(counts[index])).join('')+`owned-dpad-${nonce}`;
  if(!Buffer.from(bytes).equals(Buffer.from(wire)))throw new Error('Owned D-pad receiver bytes differ');
}

export async function androidSshAcceptance(root=resolve(import.meta.dir,'../..'),herdr?:HerdrFixture,companion=false,moshBackground=false,herdrMosh=false,sharedHerdr=false,attachments=false,ime=false,dpad=false) {
  if(process.platform!=='linux')throw new Error('Owned Android SSH UI acceptance requires Linux');
  if(dpad && (herdr || companion || moshBackground || herdrMosh || sharedHerdr || attachments || ime))throw new Error('Owned D-pad mode must be isolated');
  if(ime && (herdr || companion || moshBackground || herdrMosh || sharedHerdr || attachments || dpad))throw new Error('Owned IME mode must be isolated');
  if(attachments && (herdr || companion || moshBackground || herdrMosh || sharedHerdr))throw new Error('Owned attachment mode must be isolated');
  if(sharedHerdr && (!herdr || herdrMosh || companion || moshBackground))throw new Error('Owned shared navigation requires its SSH Herdr fixture');
  if(herdrMosh && (!herdr || companion || moshBackground))throw new Error('Owned Mosh Herdr requires its separate guarded fixture');
  if(moshBackground && (herdr || companion))throw new Error('Owned Android Mosh background mode must be isolated');
  if(companion && (herdr || process.arch!=='x64' || process.env.GITHUB_ACTIONS!=='true' || process.env.RUNNER_ENVIRONMENT!=='github-hosted'))throw new Error('Published Android companion acceptance requires its explicit disposable hosted runner');
  const serial=process.env.ANDROID_SERIAL;
  if(!serial || !/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  const adb=process.env.ANDROID_HOME?join(process.env.ANDROID_HOME,'platform-tools/adb'):'adb';
  const evidence=companion?await publishedCompanion():undefined;
  const moshBinary=(moshBackground || attachments)?await realpath(process.env.LAZYSH_NATIVE_MOSH_SERVER??(await sshCommand('locate owned Android Mosh server','sh',['-c','command -v mosh-server'])).trim()):undefined;
  const rawInput=ime || dpad,rawKind=ime?'ime':'dpad';
  const fixture=herdr?.ssh??await SshFixture.start(undefined,rawInput?{privateTtyGroup:true}:companion?{companion:true}:moshBinary?{privateTtyGroup:true,moshBinary,observeMoshBootstraps:true}:{});
  const attachmentNames={newName:`owned-upload-${fixture.nonce}.png`,collisionName:`owned-collision-${fixture.nonce}.png`};
  let imeObserved:Awaited<ReturnType<typeof identity>>|undefined;
  let imeImageHash:string|undefined;
  const imeDirectory=join(fixture.directory,rawKind),receiverImage=join(fixture.directory,`${rawKind}-receiver`);
  let collisionBefore:Awaited<ReturnType<typeof attachmentIdentity>>|undefined;
  let moshWitness:ReturnType<typeof observeAndroidMoshBackground>|undefined;
  const managed=join(fixture.directory,'data/lazysh/companion/lazysh-agent');
  const remote=`/data/local/tmp/lazysh-ui-ssh-${fixture.nonce}`;
  let reverse:string|undefined;
  let remoteCreated=false;
  let retainedPackages=false;
  let before:Awaited<ReturnType<typeof emulatorContinuity>>|undefined;
  let hostServerBefore:HostAdbServerSample|undefined;
  let gradle:OwnedProcess|undefined;
  let crashes:ReturnType<typeof captureOwnedCaseCrashes>|undefined;
  let keyboard:Awaited<ReturnType<typeof ownedSoftwareKeyboard>>|undefined;
  const timing:{gradleStartMs:number|null,gradleEndMs:number|null}={gradleStartMs:null,gradleEndMs:null};
  let primary=false;
  const shell=(args:string[])=>sshCommand('owned emulator command',adb,['-s',serial,...args]);
  const navigationScreenshots=async()=>{
    const destination=join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results/herdr-navigation');
    await mkdir(destination,{recursive:true});
    await shell(['pull','/sdcard/Android/data/app.lazysh.client/files/herdr-navigation',destination]);
  };
  try {
    if(rawInput) {
      const source=process.env.LAZYSH_TEST_RECEIVER_BIN;
      if(!source || !source.startsWith('/'))throw new Error('Explicit source-bound owned receiver required');
      const image=await lstat(source);
      if(!image.isFile() || image.size<1 || image.size>64*1024*1024)throw new Error('Owned IME receiver image invalid');
      const bytes=await readFile(source);
      if(bytes.length!==image.size)throw new Error('Owned IME receiver image changed');
      imeImageHash=createHash('sha256').update(bytes).digest('hex');
      await mkdir(imeDirectory,{mode:0o700});
      await copyFile(source,receiverImage);await chmod(receiverImage,0o700);
      if(createHash('sha256').update(await readFile(receiverImage)).digest('hex')!==imeImageHash)throw new Error('Owned IME receiver copy differs');
    }
    if(attachments) {
      await writeFile(join(fixture.directory,attachmentNames.collisionName),Buffer.from(`OWNED-COLLISION:${fixture.nonce}`),{mode:0o600,flag:'wx'});
      collisionBefore=await attachmentIdentity(join(fixture.directory,attachmentNames.collisionName));
      await lstat(join(fixture.directory,attachmentNames.newName)).then(()=>{throw new Error('Owned upload destination must initially be absent');},error=>{if(error.code!=='ENOENT')throw error;});
    }
    if(moshBackground || herdrMosh || attachments) {
      const server=join(fixture.directory,'bin/mosh-server');
      if((await stat(server)).size>64*1024*1024)throw new Error('Owned Mosh server binary exceeds bound');
      const bytes=await readFile(server);
      if(bytes.length>64*1024*1024)throw new Error('Owned Mosh server read exceeds bound');
      const version=(await sshCommand('owned Android Mosh version',server,['--version'])).match(/^mosh-server \(mosh ([0-9]+(?:[.][0-9]+){1,3})\)/)?.[1];
      if(!version)throw new Error('Owned Mosh server version unavailable');
      console.log(`Owned Android Mosh fixture origin=${process.env.LAZYSH_NATIVE_MOSH_SERVER?'explicit':'system'} version=${version} sha256=${createHash('sha256').update(bytes).digest('hex')}`);
    }
    if(evidence) {
      const missing=await fixture.client(true,'if command -v lazysh-agent >/dev/null 2>&1; then exit 1; fi');
      await missing.finish('no preinstalled Android companion fixture executable',5000);
      await lstat(managed).then(()=>{throw new Error('Owned companion destination must initially be absent');},error=>{if(error.code!=='ENOENT')throw new Error('Owned companion absence could not be verified');});
      console.log(`Public Android companion receipt version=${evidence.version} source=${evidence.source} sha256=${evidence.sha256} bytes=${evidence.bytes}`);
    }
    // The host allowlist key must match the concrete device port removed in cleanup.
    if(!moshBackground && !herdrMosh && !attachments) {
      await shell(['reverse','--no-rebind',`tcp:${fixture.port}`,`tcp:${fixture.port}`]);
      reverse=String(fixture.port);
    }
    const keyboardProfile=process.env.LAZYSH_ANDROID_KEYBOARD_PROFILE??'aosp-latin';
    if(rawInput && keyboardProfile!=='aosp-latin')throw new Error('Owned SSH IME checkpoint requires the AOSP keyboard profile');
    if(keyboardProfile!=='aosp-latin' && keyboardProfile!=='google-api36-latin')throw new Error('Owned software keyboard profile is unsupported');
    keyboard=await ownedSoftwareKeyboard(adb,serial,5000,keyboardProfile);
    await shell(['shell','mkdir','-m','700',remote]);remoteCreated=true;
    const data=join(fixture.directory,'android-fixture.json');
    await writeFile(data,JSON.stringify({name:`Android SSH ${fixture.nonce}`,port:fixture.port,username:fixture.username,
      privateKey:fixture.privateKey,fingerprint:fixture.fingerprint,prompt:fixture.prompt,challenge:fixture.challenge,expected:fixture.expected,nonce:fixture.nonce,...(rawInput?{[rawKind]:{directory:imeDirectory}}:{}),...(attachments?{attachments:attachmentNames}:{}),...(herdr?{herdr:herdr.metadata(),herdrMosh}:{}),...(evidence?{companion:{version:evidence.version,path:managed}}:{}),...(moshBackground?{moshBackground:{host:'10.0.2.2',directory:fixture.directory}}:{})}),{mode:0o600});
    if(moshBackground) {
      moshWitness=observeAndroidMoshBackground(fixture);
    }
    await shell(['push',data,`${remote}/fixture.json`]);
    await shell(['shell','chmod','600',`${remote}/fixture.json`]);
    try {[before,hostServerBefore]=await Promise.all([emulatorContinuity(adb,serial,reverse,fixture.port),hostAdbServerIdentity(adb)]);} catch {/* Best-effort observation never admits or blocks the acceptance. */}
    try {crashes=captureOwnedCaseCrashes(adb,serial,fixture.nonce);} catch {/* Never change test admission for unavailable diagnostics. */}
    const android=join(root,'apps/client/src-tauri/gen/android');
    const sharedReportDirectory=join(android,'app/build/outputs/androidTest-results/herdr-ui');
    const previousSharedReport=sharedHerdr?await sharedHerdrReportIdentity(sharedReportDirectory):undefined;
    timing.gradleStartMs=crashes?.elapsedMs()??null;
    gradle=new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
      herdr?(herdrMosh?'-PlazyshHerdrMoshAcceptance=true':'-PlazyshHerdrAcceptance=true'):dpad?'-PlazyshSshDpadAcceptance=true':ime?'-PlazyshSshImeAcceptance=true':companion?'-PlazyshCompanionAcceptance=true':attachments?'-PlazyshAttachmentAcceptance=true':moshBackground?'-PlazyshMoshBackgroundAcceptance=true':'-PlazyshSshAcceptance=true',
      ...((herdr || attachments || dpad)?['-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true']:[]),
      '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#'+(herdr?(sharedHerdr?'ownedSharedHerdrNavigationThroughRealUi':herdrMosh?'ownedMoshDefaultHerdrChatThroughRealUi':'ownedGuardedHerdrChatThroughRealUi'):dpad?'ownedSshDpadPanThroughRealUi':ime?'ownedSshImeTransactionsThroughRealUi':companion?'ownedCompanionInstallsThroughRealUi':attachments?'ownedMoshUploadsLargeClipboardImageThroughRealUi':moshBackground?'ownedMoshSurvivesBusyBackgroundThroughRealUi':'ownedOpenSshConnectsThroughRealUi'),
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`],root);
    retainedPackages=!!herdr || attachments || dpad;
    let monitoring=sharedHerdr || rawInput,byteFailure:unknown;
    const byteWitness=(async()=>{while(monitoring){
      try{
        if(sharedHerdr)await herdr!.expectNavigationBytes();
        if(rawInput) {
          const text=await readFile(join(imeDirectory,'receiver-pid'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
          if(text) {
            if(!/^[1-9][0-9]{0,9}\n$/.test(text))throw new Error('Owned IME receiver PID invalid');
            const current=await identity(Number(text.trim()));
            if(current && !['Z','X'].includes(current.state)) {
              if(imeObserved && current.start!==imeObserved.start)throw new Error('Owned IME receiver replaced');
              let ancestor=current,owned=false;
              for(let depth=0;depth<16;depth++) {
                if(ancestor.pid===fixture.daemon.child.pid){owned=true;break;}
                const parent=await identity(ancestor.parent);if(!parent)break;ancestor=parent;
              }
              if(!owned || createHash('sha256').update(await readFile(`/proc/${current.pid}/exe`)).digest('hex')!==imeImageHash
                || (await identity(current.pid))?.start!==current.start)throw new Error('Owned IME receiver identity unavailable');
              imeObserved=current;
            }
          }
        }
      }catch(error){
        byteFailure=error;
        try{await gradle!.stop();}catch{console.error('Owned navigation instrumentation stop failed after receiver failure');}
        return;
      }
      await Bun.sleep(25);
    }})();
    let instrumentationFailure:unknown;
    try {await gradle.finish('actual Android SSH UI instrumentation',600_000);}
    catch(error){instrumentationFailure=error;}
    finally {monitoring=false;await byteWitness;timing.gradleEndMs=crashes?.elapsedMs()??null;}
    if(byteFailure)throw byteFailure;
    if(instrumentationFailure)throw instrumentationFailure;
    if(rawInput) {
      const pid=await readFile(join(imeDirectory,'receiver-pid'),'utf8');
      if(!imeObserved || pid!==`${imeObserved.pid}\n`)throw new Error('Original owned IME receiver was not observed');
      const file=await open(join(imeDirectory,'received-bytes'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const before=await file.stat({bigint:true});
        if(!before.isFile() || before.uid!==BigInt(process.getuid!()) || before.size>16384n)throw new Error('Owned IME receiver output invalid');
        const bytes=Buffer.alloc(16385),read=await file.read(bytes,0,bytes.length,0),after=await file.stat({bigint:true});
        if(reportIdentity(before)!==reportIdentity(after) || read.bytesRead!==Number(before.size))throw new Error('Owned IME receiver output changed');
        if(ime)verifyImeReceiverBytes(bytes.subarray(0,read.bytesRead),fixture.nonce);
        else {
          const receiptPath=`files/owned-dpad-${fixture.nonce}.json`;
          const metadata=()=>shell(['shell','run-as','app.lazysh.client','stat','-c','%F:%d:%i:%s:%Y:%Z',receiptPath]);
          const before=await metadata(),match=/^regular file:[0-9]+:[0-9]+:([0-9]+):[0-9]+:[0-9]+\s*$/.exec(before);
          if(!match || Number(match[1])<1 || Number(match[1])>512)throw new Error('Owned D-pad receipt file invalid');
          const text=await shell(['shell','run-as','app.lazysh.client','cat',receiptPath]);
          if(await metadata()!==before)throw new Error('Owned D-pad receipt file changed');
          const counts=dpadReceipt(text,fixture.nonce);
          verifyDpadReceiverBytes(bytes.subarray(0,read.bytesRead),fixture.nonce,counts);
        }
      } finally {await file.close();}
      if(createHash('sha256').update(await readFile(receiverImage)).digest('hex')!==imeImageHash)throw new Error('Owned IME receiver image changed');
      console.log(ime?'Owned packaged SSH IME: exact ASCII correction/repeat/current bytes and no stale marker verified':'Owned packaged SSH D-pad: ordered runs equal native stopped-count snapshot and one fixed drain marker');
    }
    if(sharedHerdr){
      const receipt=await verifySharedHerdrResult(sharedReportDirectory,previousSharedReport);
      console.log('Owned shared Herdr native result '+JSON.stringify(receipt));
      await navigationScreenshots();
    }
    await crashes?.stop();
    await moshWitness?.assertVerified();
    if(evidence) {
      await installedCompanion(fixture,evidence);
      if(JSON.stringify(await publishedCompanion())!==JSON.stringify(evidence))throw new Error('Published Android companion nomination changed during acceptance');
      console.log(`Owned packaged companion Install/reuse: public version=${evidence.version} sha256=${evidence.sha256}; installed bytes/version and staging cleanup verified`);
    }
    if(attachments) {
      const expected=attachmentReceipt(await shell(['shell','run-as','app.lazysh.client','cat',`files/owned-attachment-${fixture.nonce}.json`]),fixture.nonce);
      const actual=await attachmentIdentity(join(fixture.directory,attachmentNames.newName));
      if(actual.bytes!==expected.bytes || actual.sha256!==expected.sha256)throw new Error('Manual native attachment bytes differ from the valid provider PNG');
      const collisionAfter=await attachmentIdentity(join(fixture.directory,attachmentNames.collisionName));
      if(JSON.stringify(collisionBefore)!==JSON.stringify(collisionAfter))throw new Error('Existing attachment inode, size, mtime or hash changed');
      const attachmentFiles=(await readdir(fixture.directory)).filter(name=>/^owned-(?:upload|collision)-/.test(name)).sort();
      if(JSON.stringify(attachmentFiles)!==JSON.stringify(Object.values(attachmentNames).sort()))throw new Error('Unexpected owned attachment destination created');
      console.log('Owned manual Mosh attachment: valid PNG size/hash exact; pre-existing collision inode/size/mtime/hash unchanged');
    }
    if(sharedHerdr)await herdr!.expectNavigationBytes();
    else if(herdr){await herdr.expectBytes(Buffer.from(herdr.draft+'\r\x1b'));await herdr.expectHistoryScrolled();}
    if((herdrMosh || attachments) && await readFile(join(fixture.directory,'mosh-bootstraps'),'utf8')!=='bootstrap\n')throw new Error('Owned Mosh entry must bootstrap exactly once');
    console.log(sharedHerdr?'Owned stock Herdr shared navigation: all three receiver identities alive and zero bytes verified':herdr?'Owned packaged Herdr Chat: exact receiver bytes and original receiver identity verified':'Owned packaged SSH: native instrumentation completed');
  } catch(error) {
    primary=true;
    // Read only: identity-checked visible history and receiver liveness before teardown.
    const herdrHistory=herdr && !sharedHerdr?await herdr.historyDiagnostic().catch(()=>({state:'unavailable'})):undefined;
    if(herdrHistory)console.error('Owned Herdr failure history '+JSON.stringify(herdrHistory));
    // Preserve the existing witness's closed stage before removing its owned host.
    // The instrumentation error remains primary, including if observation fails.
    let moshBackgroundObservation:ReturnType<ReturnType<typeof observeAndroidMoshBackground>['diagnostic']>|{state:'unavailable'}|undefined;
    if(moshWitness)try {
      await moshWitness.stop();
      moshBackgroundObservation=moshWitness.diagnostic();
      if(moshBackgroundObservation.failure)console.error('Owned Mosh secondary witness failure: witness-failure');
    } catch {moshBackgroundObservation={state:'unavailable'};}
    if(sharedHerdr)try{await navigationScreenshots();}catch{console.error('Owned navigation screenshots unavailable');}
    try {
      const directory=join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results',herdr?(herdrMosh?'herdr-mosh-ui':'herdr-ui'):dpad?'ssh-dpad-ui':ime?'ssh-ime-ui':companion?'companion-ui':attachments?'attachment-ui':moshBackground?'mosh-background-ui':'ssh-ui');
      const crash=await crashes?.stop();
      // Sample before an inspection adb command could implicitly restart its server.
      const hostServerAfter=await hostAdbServerIdentity(adb);
      const persistedCrash={scope:'persisted-crash-buffer-sample',...await crashes?.recover()??{state:'ineligible',exceptions:[]}};
      const [exitInfo,continuity,packages]=await Promise.all([packageExitInfo(adb,serial),emulatorContinuity(adb,serial,reverse,fixture.port),retainedPackages?ownedAndroidPackagePresence(adb,serial):Promise.resolve(undefined)]);
      const summary={...exitInfo,...(moshBackgroundObservation?{moshBackground:moshBackgroundObservation}:{}),...(herdrHistory?{herdrHistory}:{}),...(packages?{packages}:{}),softwareKeyboard:keyboard?.observation??{state:'unavailable'},timing,crash:crash??{stream:'unavailable'},persistedCrash,gradle:gradleFailureClasses(gradle?.stdout??'',gradle?.stderr??''),continuity:{before:before??null,after:continuity,comparison:compareEmulatorContinuity(before,continuity)},hostAdbServer:{before:hostServerBefore??null,after:hostServerAfter,comparison:compareHostAdbServer(hostServerBefore,hostServerAfter)}};
      await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'package-exit.json'),JSON.stringify(summary)+'\n',{mode:0o600});
    } catch {console.error('Owned Android SSH exit diagnostics unavailable');}
    throw error;
  } finally {
    await moshWitness?.stop();
    await crashes?.stop();
    await androidSshCleanup(primary,[
      ['software-keyboard',()=>keyboard?.restore()??Promise.resolve()],
      ['reverse',()=>reverse?shell(['reverse','--remove',`tcp:${reverse}`]):Promise.resolve()],
      ['fixture-file',()=>remoteCreated?shell(['shell','rm','-rf','--',remote]):Promise.resolve()],
      ...(retainedPackages?[
        ['test-package',()=>shell(['uninstall',ownedAndroidPackages[1]])] as const,
        ['app-package',()=>shell(['uninstall',ownedAndroidPackages[0]])] as const,
      ]:[]),
      [herdr?'Herdr':'SSH',()=>herdr?herdr.stop():fixture.stop()],
    ]);
  }
}
