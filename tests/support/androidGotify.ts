import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,open,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {OwnedProcess,nativeReportCases,hostAdbServerIdentity,emulatorContinuity,compareHostAdbServer,compareEmulatorContinuity,gradleFailureClasses} from './androidSsh';
import {OUTPUT_LIMIT} from './ownedProcess';
import {sameNtfyClockOwner,privateInputCommand,writePrivateInput} from './androidNtfy';
import {attestQrCamera,readQrMetadata} from './androidQrOwnership';

const rejection=()=>new Error('Owned Gotify acceptance rejected');
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export const gotifyStates=['working','needs_attention','done'] as const;
export const gotifyCase='ownedOfficialGotifyDisplaysFiniteEventsWhileBackgrounded';
const gotifyNativeFailures=['admission','parser-calibration','fixture-input','fixture-identity','fresh-permission','record-calibration','workspace','login',
  'login-launch','login-url','login-advanced','login-ca-picker','login-ca-import','login-ca-roots','login-ca-select','login-ca-callback','login-ca-confirm','login-url-submit','login-auth-form','login-client-name',
  'notification-permission','alarm-permission','background','message-0','message-1','message-2','history'] as const;
const gotifyNativePhases=['android-native-stage-0','android-native-stage-1','android-native-stage-2','android-native-stage-3','android-native-stage-4'] as const;
const gotifyFixturePhases=['admission','clean source checkout','tracked fixture source','official Gotify artifact',
  'official Gotify APK signature','official Gotify package','official Gotify server extraction','current test-support relay build','source checkout',
  'relay-certificates','server-health','server-credentials','relay-ready','relay-enrollment','relay-events','server-messages','relay-shutdown',
  'android-device-admission','android-package-admission','android-reverse','android-gotify-install','android-client-install',
  'android-package-identity','android-certificate-transfer','android-private-handoff','android-instrumentation',
  'android-installed-artifacts','android-event-input','android-final-identity','android-instrumentation-result','android-native-stage','android-native-exit',...gotifyNativePhases,...gotifyNativeFailures.map(phase=>`android-native-${phase}` as const)] as const;
type GotifyFixturePhase=typeof gotifyFixturePhases[number];
export function gotifyFailurePhase(error:unknown):GotifyFixturePhase|'fixture' {
  try {
    if(error instanceof Error) {
      const message=error.message;
      if(typeof message==='string'&&message.length<=128)
        return gotifyFixturePhases.find(phase=>message===`Owned Gotify acceptance failed: ${phase}`)??'fixture';
    }
  }catch{/* Unknown exceptions never become public diagnostics. */}
  return 'fixture';
}
const gotifyContinuityOperations=['continuity-missing-owner','continuity-before-connection','continuity-after-connection',
  ...(['server','transport','boot','adbd'] as const).flatMap(kind=>[`continuity-${kind}-unknown`,`continuity-${kind}-changed`])];
export function gotifyContinuityOperation(before:Parameters<typeof sameNtfyClockOwner>[0]|undefined,after:Parameters<typeof sameNtfyClockOwner>[1]) {
  if(!before)return 'continuity-missing-owner';
  if(before.guest.connection!=='device')return 'continuity-before-connection';
  if(after.guest.connection!=='device')return 'continuity-after-connection';
  const guest=compareEmulatorContinuity(before.guest,after.guest);
  for(const [kind,state] of Object.entries({server:compareHostAdbServer(before.server,after.server),transport:guest.transport,boot:guest.boot,adbd:guest.adbd}))
    if(state!=='same')return `continuity-${kind}-${state}`;
  return 'continuity';
}
const gotifyGradleFailures=['processCrash','deviceUnavailable','adbRejected','connectionReset','deadlineReported','incompleteRun'] as const;
const gotifyGradleProgress=['unobserved','configure','compile','package','install','connected-task','test-count'] as const;
export function gotifyStageWaitOperation(stdout:unknown,stderr:unknown) {
  const out=typeof stdout==='string'?stdout.slice(-OUTPUT_LIMIT):'',err=typeof stderr==='string'?stderr.slice(-OUTPUT_LIMIT):'';
  const flags=gradleFailureClasses(out,err);
  for(const kind of gotifyGradleFailures)if(flags[kind])return `stage-wait-gradle-${kind}`;
  let progress:typeof gotifyGradleProgress[number]='unobserved';
  for(const line of out.split(/\r?\n/)) {
    if(/^> Configure project :app$/.test(line))progress='configure';
    if(/^> Task :app:compileUniversalDebug(?:AndroidTestKotlin|AndroidTestJavaWithJavac|Kotlin|JavaWithJavac)(?: UP-TO-DATE| FROM-CACHE| SKIPPED)?$/.test(line))progress='compile';
    if(/^> Task :app:packageUniversalDebug(?:AndroidTest)?(?: UP-TO-DATE| FROM-CACHE| SKIPPED)?$/.test(line))progress='package';
    if(/^> Task :app:installUniversalDebug(?:AndroidTest)?(?: UP-TO-DATE| FROM-CACHE| SKIPPED)?$/.test(line))progress='install';
    if(/^> Task :app:connectedUniversalDebugAndroidTest(?: FAILED)?$/.test(line))progress='connected-task';
    if(/^Starting [1-9][0-9]{0,5} tests? on /.test(line))progress='test-count';
  }
  return `stage-wait-gradle-${progress}`;
}
/** Failure-only metadata: never serialize child output or exception properties. */
export function gotifyHostDiagnostic(operation:unknown,native:unknown,signaled:unknown,nativePhase:unknown=undefined) {
  const result={operation:['continuity','continuity-ownership','continuity-server-probe','continuity-guest-probe',...gotifyContinuityOperations,...[...gotifyGradleFailures,...gotifyGradleProgress].map(kind=>`stage-wait-gradle-${kind}`),'ownership','command','stage-record','native-state','stage-wait'].includes(operation as string)?operation as string:'unavailable',
    nativePhase:['not-observed',...gotifyNativeFailures].includes(nativePhase as string)?nativePhase as string:'unavailable',
    nativeState:'unavailable',exitCode:null as number|null,signaled:typeof signaled==='boolean'?signaled:null};
  try {
    if(native===null||typeof native!=='object'||Array.isArray(native)||Object.keys(native).length!==2)return result;
    const {state,exitCode}=native as {state:unknown,exitCode:unknown};
    if(!['missing-launcher','launch-denied','launch-failed','early-exit','signaled','running','launch-unavailable'].includes(state as string))return result;
    if(state==='early-exit'?!Number.isInteger(exitCode)||Number(exitCode)<0||Number(exitCode)>255:exitCode!==null)return result;
    result.nativeState=state as string;result.exitCode=exitCode as number|null;
  }catch{/* Hostile or unsupported metadata remains unavailable, never an exception cause. */}
  return result;
}
function gotifyErrorDiagnostic(error:unknown) {
  try {
    if(error instanceof Error) {
      const metadata=(error as Error & {gotifyDiagnostic?:ReturnType<typeof gotifyHostDiagnostic>}).gotifyDiagnostic;
      if(metadata)return gotifyHostDiagnostic(metadata.operation,{state:metadata.nativeState,exitCode:metadata.exitCode},metadata.signaled,metadata.nativePhase);
    }
  }catch{/* Failure evidence cannot replace the primary error. */}
  return gotifyHostDiagnostic(undefined,undefined,undefined);
}
const nonceCheck=(nonce:string)=>{if(!/^[a-f0-9]{32}$/.test(nonce))throw rejection();};
export function gotifyPrivateCommand(nonce:string,suffix='.json') {
  nonceCheck(nonce);
  if(!/^(?:\.json|\.message-[0-2]\.tmp)$/.test(suffix))throw rejection();
  return privateInputCommand(nonce).replace(`files/.lazysh-ntfy-${nonce}.json`,`files/.lazysh-gotify-${nonce}${suffix}`);
}
export function gotifyStage(text:string,nonce:string,step:number,messageId?:number) {
  nonceCheck(nonce);
  if(Buffer.byteLength(text)>2048 || !Number.isInteger(step) || step<0 || step>4)throw rejection();
  let value:Record<string,unknown>;
  try{value=JSON.parse(text);}catch{throw rejection();}
  const expected:Record<string,unknown>={schemaVersion:1,nonce,step};
  if(step===4)expected.history=true;
  else expected.background=true;
  if(step>0&&step<4) {
    if(!Number.isInteger(messageId)||messageId!<=0||messageId!>2147483647)throw rejection();
    Object.assign(expected,{messageId,state:gotifyStates[step-1],osRecord:true,visibleCard:true});
  }
  if(value===null||Array.isArray(value)||Object.keys(value).length!==Object.keys(expected).length ||
    Object.entries(expected).some(([key,item])=>value[key]!==item))throw rejection();
  // Native JSONObject emits flat scalar fields once. Reject duplicate JSON keys,
  // which JSON.parse alone would silently accept, without imposing field order.
  const keys=[...text.matchAll(/"([^"\\]*)"\s*:/g)].map(match=>match[1]);
  if(keys.length!==Object.keys(expected).length||new Set(keys).size!==keys.length)throw rejection();
  return {step,verified:true as const};
}
function gotifyReport(xml:string) {
  if(Buffer.byteLength(xml)>262144)throw rejection();
  const {cases,failed}=nativeReportCases(xml),suite=/<testsuites?\b[^>]*>/.exec(xml)?.[0]??'';
  if(cases.length!==1||cases[0].className!=='app.lazysh.client.GotifyAndroidTest'||cases[0].name!==gotifyCase||
    !/<\/testsuite(?:s)?>\s*$/.test(xml))throw rejection();
  return {suite,failed};
}
export function gotifyNativeReport(xml:string) {
  const {suite,failed}=gotifyReport(xml);
  if(!['tests="1"','failures="0"','errors="0"','skipped="0"'].every(item=>suite.includes(' '+item))||failed)throw rejection();
  return {passed:1,failed:0,skipped:0};
}
export function gotifyNativeFailure(xml:string):GotifyFixturePhase|undefined {
  try {
    const {suite,failed}=gotifyReport(xml);
    if(!failed||!['tests="1"','failures="1"','errors="0"','skipped="0"'].every(item=>suite.includes(' '+item)))return;
    const failures=[...xml.replace(/<!--[\s\S]*?-->/g,'').matchAll(/<failure\b[^>]*>([\s\S]*?)<\/failure>/g)];
    if(failures.length!==1)return;
    const phase=/^\s*(?:<!\[CDATA\[)?java\.lang\.AssertionError: Owned Gotify acceptance failed: ([a-z0-9-]+)(?:\r?\n|$)/.exec(failures[0][1])?.[1];
    const known=gotifyNativeFailures.find(value=>value===phase);
    return known?`android-native-${known}`:undefined;
  }catch{return;}
}

export function gotifyMessage(nonce:string,step:number,messageId:number) {
  nonceCheck(nonce);
  if(!Number.isInteger(step)||step<0||step>2||!Number.isInteger(messageId)||messageId<1||messageId>2147483647)throw rejection();
  return {schemaVersion:1,nonce,step,messageId,state:gotifyStates[step],priority:step===1?5:2};
}
export function gotifyUid(text:string) {
  const match=/^package:com\.github\.gotify uid:([1-9][0-9]*)\r?\n?$/.exec(text);
  const uid=Number(match?.[1]);if(!Number.isSafeInteger(uid)||uid<10000)throw rejection();return uid;
}
export function gotifyOfficialArtifact(bytes:Buffer,pin:{size:number;sha256:string},signer?:{output:string;sha256:string}) {
  if(bytes.length!==pin.size||digest(bytes)!==pin.sha256)throw rejection();
  if(signer) {
    const values=[...signer.output.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$/gm)].map(match=>match[1]);
    if(values.length!==1||values[0]!==signer.sha256)throw rejection();
  }
}
/** The cooperating native publisher hardlinks a closed file, then removes its temp link. */
function gotifyPrivateBody(raw:string,uid:number) {
  if(Buffer.byteLength(raw)>8192)throw rejection();
  if(raw==='pending\n')return;
  const lines=raw.trimEnd().split('\n'),metadata=lines[0]?.split(' ');
  if(metadata?.length!==7||metadata[0]!==String(uid)||metadata[1]!=='600'||!['1','2'].includes(metadata[2])||
    !/^[1-9][0-9]*$/.test(metadata[3])||Number(metadata[3])>2048||!metadata.slice(4,6).every(item=>/^[0-9]+$/.test(item))||
    !/^[a-f0-9]+$/.test(metadata[6])||(Number.parseInt(metadata[6],16)&0xf000)!==0x8000)throw rejection();
  if(metadata[2]==='2')return;
  if(lines.length!==3||lines[0]!==lines[2]||Buffer.byteLength(lines[1])!==Number(metadata[3]))throw rejection();
  return lines[1];
}
export function gotifyPrivateStage(raw:string,nonce:string,step:number,uid:number,messageId?:number) {
  const body=gotifyPrivateBody(raw,uid);return body===undefined?undefined:gotifyStage(body,nonce,step,messageId);
}
export function gotifyNativePhase(raw:string,nonce:string,uid:number) {
  nonceCheck(nonce);
  const body=gotifyPrivateBody(raw,uid);if(body===undefined)return 'not-observed';
  let value:Record<string,unknown>;try{value=JSON.parse(body);}catch{throw rejection();}
  if(value===null||Array.isArray(value)||Object.keys(value).length!==3||value.schemaVersion!==1||value.nonce!==nonce||
    !gotifyNativeFailures.includes(value.phase as typeof gotifyNativeFailures[number]))throw rejection();
  const keys=[...body.matchAll(/"([^"\\]*)"\s*:/g)].map(match=>match[1]);
  if(keys.length!==3||new Set(keys).size!==3)throw rejection();
  return value.phase as typeof gotifyNativeFailures[number];
}
export async function observeGotifyNativePhase(check:()=>Promise<void>,read:()=>Promise<string>,nonce:string,uid:number) {
  try{return gotifyNativePhase(await gotifyDeviceAction(check,read),nonce,uid);}
  catch{return 'unavailable';}
}
export function gotifyProxyAdmission(env=process.env) {
  if(['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'].some(name=>!!env[name]))
    throw new Error('Owned Gotify fixture requires a proxy-free child environment');
}
/** Check the existing full device/ADB identity fence immediately before the action. */
export async function gotifyDeviceAction<T>(check:()=>Promise<void>,action:()=>Promise<T>) {
  await check();return action();
}
/** One exact absent pair, including the applied-but-lost-acknowledgement case. */
export class GotifyReverse {
  private attempted=false;
  private readonly endpoint:string;
  constructor(port:number,private readonly adb:(args:string[])=>Promise<string>) {
    if(!Number.isInteger(port)||port<1||port>65535)throw rejection();this.endpoint=`tcp:${port}`;
  }
  private async current() {
    const lines=(await this.adb(['reverse','--list'])).trim().split('\n').filter(Boolean);
    const mappings=lines.map(line=>{
      const fields=line.trim().split(/\s+/);if(fields.length!==3||!/^tcp:[1-9][0-9]{0,4}$/.test(fields[1])||!/^tcp:[1-9][0-9]{0,4}$/.test(fields[2]))throw rejection();return fields;
    }).filter(fields=>fields[1]===this.endpoint);
    if(mappings.length>1)throw rejection();return mappings[0]?.[2];
  }
  async create() {
    if(this.attempted||await this.current()!==undefined)throw rejection();
    this.attempted=true;await this.adb(['reverse','--no-rebind',this.endpoint,this.endpoint]);
    if(await this.current()!==this.endpoint)throw rejection();
  }
  async cleanup() {
    if(!this.attempted)return;
    const current=await this.current();if(current===undefined)return;
    if(current!==this.endpoint)throw rejection();
    await this.adb(['reverse','--remove',this.endpoint]);
    if(await this.current()!==undefined)throw rejection();this.attempted=false;
  }
}
function packageUid(text:string,name:string) {
  if(!['com.github.gotify','app.lazysh.client','app.lazysh.client.test'].includes(name))throw rejection();
  const match=new RegExp(`^package:${name.replaceAll('.', '\\.')} uid:([1-9][0-9]*)\\r?\\n?$`).exec(text);
  const uid=Number(match?.[1]);if(!Number.isSafeInteger(uid)||uid<10000)throw rejection();return uid;
}
/** Hash the actual installed base APK, fenced by package UID/path/file identities. */
export async function gotifyInstalledApk(adb:(args:string[])=>Promise<string>,name:string,expected:string,expectedUid?:number) {
  const uid=packageUid(await adb(['shell','cmd','package','list','packages','-U',name]),name);
  if(expectedUid!==undefined&&uid!==expectedUid)throw rejection();
  const mapping=await adb(['shell','pm','path',name]);
  const path=/^package:(\/data\/app\/(?:~~[A-Za-z0-9_=-]+\/)?[A-Za-z0-9._=-]+\/base\.apk)\r?\n?$/.exec(mapping)?.[1];
  if(!path||!path.split('/').at(-2)?.startsWith(name+'-'))throw rejection();
  const stat=()=>adb(['shell','stat','-c','%u:%f:%h:%s:%d:%i',path]);
  const before=await stat(),fields=before.trim().split(':');
  if(fields.length!==6||!['0','1000'].includes(fields[0])||!/^[a-f0-9]+$/.test(fields[1])||
    (Number.parseInt(fields[1],16)&0xf000)!==0x8000||fields[2]!=='1'||!fields.slice(3).every(value=>/^[1-9][0-9]*$/.test(value))||Number(fields[3])>536870912)throw rejection();
  const proof=await adb(['shell','sha256sum',path]);
  if(!/^[a-f0-9]{64}$/.test(expected)||proof!==`${expected}  ${path}\n`||await stat()!==before||
    await adb(['shell','pm','path',name])!==mapping||packageUid(await adb(['shell','cmd','package','list','packages','-U',name]),name)!==uid)throw rejection();
  return {sha256:expected,uid,identity:digest(`${uid}\0${mapping}\0${before}\0${expected}`)};
}
type InstalledGotifyApk=Awaited<ReturnType<typeof gotifyInstalledApk>>;
type GotifyPackageAttempt={name:string;expected?:string;acknowledged:boolean;bound?:InstalledGotifyApk};
/** Package names alone never authorize teardown, even on the same owned emulator. */
export class OwnedGotifyPackages {
  private readonly attempts:GotifyPackageAttempt[]=[];
  constructor(private readonly adb:(args:string[])=>Promise<string>) {}
  private async absent(name:string) {
    return (await this.adb(['shell','pm','list','packages',name])).trim()==='';
  }
  async install(name:string,path:string,expected:string) {
    if(!['com.github.gotify','app.lazysh.client'].includes(name)||!/^[a-f0-9]{64}$/.test(expected)||this.attempts.some(item=>item.name===name)||!await this.absent(name))throw rejection();
    const attempt:GotifyPackageAttempt={name,expected,acknowledged:false};this.attempts.push(attempt);
    const reply=await this.adb(['install','-t',path]);
    if(reply.trim().split('\n').at(-1)!=='Success')throw rejection();
    attempt.acknowledged=true;attempt.bound=await gotifyInstalledApk(this.adb,name,expected);
    return attempt.bound;
  }
  async admitGradle() {
    const name='app.lazysh.client.test';
    if(this.attempts.some(item=>item.name===name)||!await this.absent(name))throw rejection();
    this.attempts.push({name,acknowledged:false});
  }
  // Called only after the exact private nonce-bound native stage0 was consumed.
  // Connected Gradle can reinstall the host APK; refresh that controlled binding,
  // preserving its already acknowledged UID and exact intended APK digest.
  async bindRunningArtifacts(testHash:string) {
    const app=this.attempts.find(item=>item.name==='app.lazysh.client'),test=this.attempts.find(item=>item.name==='app.lazysh.client.test');
    if(!app?.acknowledged||!app.bound||!app.expected||!test||test.acknowledged)throw rejection();
    const current=await gotifyInstalledApk(this.adb,app.name,app.expected,app.bound.uid);
    const nativeTest=await gotifyInstalledApk(this.adb,test.name,testHash);
    app.bound=current;test.expected=testHash;test.bound=nativeTest;test.acknowledged=true;
    return {app:current,test:nativeTest};
  }
  async cleanup() {
    const failures:string[]=[];
    for(const attempt of [...this.attempts].reverse())try {
      if(await this.absent(attempt.name))continue;
      // An unacknowledged install, unreadable binding or pre-stage0 Gradle
      // package may be foreign. Preserve it and make acceptance fail closed.
      if(!attempt.acknowledged||!attempt.bound||!attempt.expected){failures.push('ambiguous-package');continue;}
      const current=await gotifyInstalledApk(this.adb,attempt.name,attempt.expected,attempt.bound.uid);
      if(current.identity!==attempt.bound.identity){failures.push('replaced-package');continue;}
      try{await this.adb(['uninstall',attempt.name]);}
      catch{if(!await this.absent(attempt.name))throw rejection();}
      if(!await this.absent(attempt.name))throw rejection();
      if(attempt.name==='com.github.gotify'&&(await this.adb(['shell','cmd','notification','list'])).split('\n').some(line=>line.includes('|com.github.gotify|')))throw rejection();
    }catch{failures.push('package-cleanup-unverified');}
    return failures;
  }
}
export async function gotifyJsonRequest(origin:string,path:string,method:string,authorization:string|undefined,body:unknown,ca?:Buffer,extra:Record<string,string>={}) {
  gotifyProxyAdmission();
  const data=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  const headers={'Content-Type':'application/json',...extra,...(authorization?{Authorization:authorization}:{}),...(data?{'Content-Length':String(data.length)}:{})};
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),3000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    // Pinned Bun1.3.14 has no verified per-request environment-proxy disable.
    // Admit only the explicitly proxy-free dedicated fixture child.
    const response=await fetch(new URL(path,origin),{method,headers,body:data,redirect:'error',signal:abort.signal,...(ca?{tls:{ca}}:{})});
    if(!response.ok)throw rejection();
    reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
    if(reader)while(true) {
      const item=await reader.read();if(item.done)break;
      size+=item.value.byteLength;if(size>65536)throw rejection();chunks.push(item.value);
    }
    const text=Buffer.concat(chunks).toString();return text?JSON.parse(text):null;
  }catch{throw rejection();}
  finally {
    clearTimeout(timer);abort.abort();
    try{await reader?.cancel();}catch{/* An already-aborted body may reject cancellation. */}
    reader?.releaseLock();data?.fill(0);
  }
}

async function privateFile(path:string,limit:number) {
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await fd.stat();
    if(!before.isFile()||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.nlink!==1||before.size<1||before.size>limit)throw rejection();
    const bytes=await fd.readFile(),after=await lstat(path);
    if(bytes.length!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mode!==before.mode||after.nlink!==1)throw rejection();
    return bytes;
  }finally{await fd.close();}
}
async function freePort() {
  const server=createServer();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const address=server.address();if(!address||typeof address==='string')throw rejection();
  await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));return address.port;
}

/** Explicit hosted-owned target only. This function never boots or finds a device. */
async function runGotifyAndroid(root:string) {
  gotifyProxyAdmission();
  if(process.env.LAZYSH_ANDROID_GOTIFY!=='1'||process.env.GITHUB_ACTIONS!=='true'||process.platform!=='linux'||process.arch!=='x64')throw rejection();
  const ownership=await attestQrCamera(process.env,root),sdk=process.env.ANDROID_HOME!,serial=process.env.ANDROID_SERIAL!;
  const adb=join(sdk,'platform-tools/adb'),android=join(root,'apps/client/src-tauri/gen/android');
  const reports=join(android,'app/build/outputs/androidTest-results/connected');
  let native:OwnedProcess|undefined;
  let targetUid=0;
  const directory=await mkdtemp(join(tmpdir(),'.lazysh-gotify-'));await chmod(directory,0o700);
  const nonce=randomUUID().replaceAll('-',''),alias=`owned-gotify-${nonce.slice(0,12)}`,caName=`lazysh-gotify-${nonce}.crt`;
  const processes:OwnedProcess[]=[];
  let reverse:GotifyReverse|undefined;
  let primary=false,cleanupFailed=false,caPushed=false;
  let phase:GotifyFixturePhase='admission';
  let hostOperation='unavailable';
  let receipt:Record<string,unknown>|undefined;
  const run=async(label:GotifyFixturePhase,program:string,args:string[],milliseconds=10000,env=process.env)=>{
    phase=label;hostOperation='ownership';await ownership.check();hostOperation='command';const child=new OwnedProcess(program,args,root,env);processes.push(child);return child.finish(label,milliseconds);
  };
  const shell=(args:string[])=>gotifyDeviceAction(continuous,()=>run(phase,adb,['-s',serial,...args]));
  const guest=()=>emulatorContinuity(adb,serial,undefined,0);
  let original:{server:Awaited<ReturnType<typeof hostAdbServerIdentity>>;guest:Awaited<ReturnType<typeof guest>>}|undefined;
  const continuous=async()=>{
    hostOperation='continuity-ownership';await ownership.check();
    if(!original){hostOperation='continuity-missing-owner';throw rejection();}
    hostOperation='continuity-server-probe';const server=await hostAdbServerIdentity(adb);
    hostOperation='continuity-guest-probe';const current={server,guest:await guest()};
    if(!original||!sameNtfyClockOwner(original,current)){hostOperation=gotifyContinuityOperation(original,current);throw rejection();}
    hostOperation='continuity';
  };
  const installed=new OwnedGotifyPackages(shell);
  const wait=async<T>(until:number,read:()=>Promise<T|undefined>)=>{
    while(performance.now()<until){await continuous();const result=await read();if(result!==undefined)return result;await Bun.sleep(100);}hostOperation='stage-wait';throw rejection();
  };
  const input=async(suffix:string,value:object)=>{
    await continuous();const child=new OwnedProcess(adb,['-s',serial,'shell','run-as','app.lazysh.client','sh','-c',`'${gotifyPrivateCommand(nonce,suffix)}'`],root);
    processes.push(child);await writePrivateInput(Buffer.from(JSON.stringify(value)),child.child.stdin!,()=>child.finish('private Gotify input',5000));
    if(suffix.endsWith('.tmp')) {
      const from=`files/.lazysh-gotify-${nonce}${suffix}`,to=from.replace(/\.tmp$/,'.json');
      await shell(['shell','run-as','app.lazysh.client','sh','-c',`'ln ${from} ${to} && rm ${from}'`]);
    }
  };
  try {
    original={server:await hostAdbServerIdentity(adb),guest:await guest()};
    await continuous();await run('clean source checkout','git',['diff','--exit-code','HEAD']);
    await run('tracked fixture source','git',['ls-files','--error-unmatch','tests/android-gotify.test.ts','tests/support/androidGotify.ts',
      'apps/client/src-tauri/fixtures/gotify-provenance.json','apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/GotifyAndroidTest.kt',
      'apps/notification-service/examples/owned_gotify_android.rs']);
    phase='android-device-admission';
    if(await shell(['shell','getprop','ro.build.version.sdk'])!=='36\n')throw rejection();
    phase='android-package-admission';
    for(const name of ['com.github.gotify','app.lazysh.client','app.lazysh.client.test'])
      if((await shell(['shell','pm','list','packages',name])).trim())throw rejection();
    const pins=JSON.parse(await readFile(join(root,'apps/client/src-tauri/fixtures/gotify-provenance.json'),'utf8'));
    for(const [name,pin] of Object.entries(pins).filter(([name])=>['android','server'].includes(name)) as [string,any][]) {
      const path=join(directory,name==='android'?'Gotify.apk':'gotify.zip');
      await run('official Gotify artifact','curl',['--fail','--silent','--show-error','--location','--proto','=https','--tlsv1.2','--max-time','90','--max-filesize','33554432',pin.url,'--output',path],95000);
      await chmod(path,0o600);const bytes=await privateFile(path,33554432);
      gotifyOfficialArtifact(bytes,pin);
    }
    const apk=join(directory,'Gotify.apk');
    const signer=await run('official Gotify APK signature',join(sdk,'build-tools/36.0.0/apksigner'),['verify','--print-certs',apk]);
    gotifyOfficialArtifact(await privateFile(apk,33554432),pins.android,{output:signer,sha256:pins.android.observedSignerSha256});
    const badging=await run('official Gotify package',join(sdk,'build-tools/36.0.0/aapt2'),['dump','badging',apk]);
    if(!badging.startsWith("package: name='com.github.gotify' versionCode='36' versionName='2.10.1'")||!badging.includes("targetSdkVersion:'36'"))throw rejection();
    await run('official Gotify server extraction','unzip',['-j',join(directory,'gotify.zip'),pins.server.member,'-d',directory]);
    const binary=join(directory,pins.server.member);await chmod(binary,0o600);
    if(digest(await privateFile(binary,67108864))!==pins.server.executableSha256)throw rejection();await chmod(binary,0o500);
    await run('current test-support relay build','cargo',['build','--offline','--locked','--jobs','2','-p','lazysh-notifications','--example','owned_gotify_android','--features','test-support'],240000);
    const relayPath=resolve(root,process.env.CARGO_TARGET_DIR??'target','debug/examples/owned_gotify_android');
    const relay=new OwnedProcess(relayPath,[directory],root,{PATH:process.env.PATH,LAZYSH_ANDROID_GOTIFY:'1',LAZYSH_GOTIFY_FIXTURE_NONCE:nonce});processes.push(relay);
    const relayPhase=(name:string)=>{
      const records=relay.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
      if(records.some(record=>record.schemaVersion!==1||record.nonce!==nonce||!['certificates-ready','relay-ready','stopped'].includes(record.phase)))throw rejection();
      return records.find(record=>record.phase===name);
    };
    phase='relay-certificates';await wait(performance.now()+10000,async()=>relayPhase('certificates-ready'));
    const ca=await privateFile(join(directory,'ca.pem'),16384),port=await freePort(),origin=`https://localhost:${port}`;
    const password=randomUUID(),admin=randomBytes(32).toString('hex'),sourceToken=randomBytes(32).toString('hex');
    const server=new OwnedProcess(binary,[],directory,{PATH:process.env.PATH,GOMAXPROCS:'2',GOTIFY_CONFIG_FILE:'/dev/null',
      GOTIFY_SERVER_LISTENADDR:'127.0.0.1',GOTIFY_SERVER_PORT:'0',GOTIFY_SERVER_SSL_ENABLED:'true',GOTIFY_SERVER_SSL_REDIRECTTOHTTPS:'false',
      GOTIFY_SERVER_SSL_LISTENADDR:'127.0.0.1',GOTIFY_SERVER_SSL_PORT:String(port),GOTIFY_SERVER_SSL_CERTFILE:join(directory,'server.pem'),
      GOTIFY_SERVER_SSL_CERTKEY:join(directory,'server-key.pem'),GOTIFY_DEFAULTUSER_PASS:password});processes.push(server);
    phase='server-health';await wait(performance.now()+10000,async()=>{try{return await gotifyJsonRequest(origin,'/health','GET',undefined,undefined,ca);}catch{return undefined;}});
    phase='server-credentials';
    const basic=`Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
    const application=await gotifyJsonRequest(origin,'/application','POST',basic,{name:'owned-lazysh'},ca);
    const reader=await gotifyJsonRequest(origin,'/client','POST',basic,{name:'owned-readback'},ca);
    if(!Number.isInteger(application.id)||application.id<1||typeof application.token!=='string'||typeof reader.token!=='string')throw rejection();
    // Fresh private directory, one cooperating publisher: reveal only a fully closed file.
    await writeFile(join(directory,'relay.pending'),JSON.stringify({schemaVersion:1,nonce,origin,applicationToken:application.token,admin}),{mode:0o600,flag:'wx'});
    await rename(join(directory,'relay.pending'),join(directory,'relay.json'));
    phase='relay-ready';const ready=await wait(performance.now()+10000,async()=>relayPhase('relay-ready'));
    if(!Number.isInteger(ready.port)||ready.port<1||ready.port>65535)throw rejection();
    const relayOrigin=`http://127.0.0.1:${ready.port}`,bearer=`Bearer ${admin}`;
    phase='relay-enrollment';const account=await gotifyJsonRequest(relayOrigin,'/v1/admin/status','GET',bearer,undefined);
    await gotifyJsonRequest(relayOrigin,'/v1/admin/sources','POST',bearer,{accountId:account.accountId,id:randomUUID(),alias,tokenHash:[...createHash('sha256').update(sourceToken).digest()]});
    await gotifyJsonRequest(relayOrigin,'/v1/admin/destination/enable','POST',bearer,null);
    phase='android-reverse';reverse=new GotifyReverse(port,shell);await reverse.create();
    const nativeApk=join(android,'app/build/outputs/apk/universal/debug/app-universal-debug.apk');
    const nativeHash=digest(await readQrMetadata(nativeApk,536870912));
    phase='android-gotify-install';await installed.install('com.github.gotify',apk,pins.android.sha256);
    phase='android-client-install';await installed.install('app.lazysh.client',nativeApk,nativeHash);
    phase='android-package-identity';
    const uid=gotifyUid(await shell(['shell','cmd','package','list','packages','-U','com.github.gotify']));
    targetUid=Number((await shell(['shell','run-as','app.lazysh.client','id','-u'])).trim());
    if(!Number.isSafeInteger(targetUid)||targetUid<10000)throw rejection();
    phase='android-certificate-transfer';await shell(['shell','sh','-c',`'[ ! -e /sdcard/Download/${caName} ] && [ ! -L /sdcard/Download/${caName} ]'`]);
    caPushed=true;await shell(['push',join(directory,'ca.pem'),`/sdcard/Download/${caName}`]);
    if((await shell(['shell','sha256sum',`/sdcard/Download/${caName}`])).split(/\s+/)[0]!==digest(ca))throw rejection();
    phase='android-private-handoff';await input('.json',{schemaVersion:1,nonce,origin,username:'admin',password,caName,alias,applicationId:application.id,gotifyUid:uid});
    // Reject stale reports instead of accepting a prior successful case.
    if(await lstat(reports).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw rejection();
    await installed.admitGradle();
    phase='android-instrumentation';await continuous();native=new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon','--max-workers=2',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug','-x',':app:rustBuildUniversalDebug',
      '-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true',`-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.GotifyAndroidTest#${gotifyCase}`,
      '-Pandroid.testInstrumentationRunnerArguments.lazyshGotifyAcceptance=true',`-Pandroid.testInstrumentationRunnerArguments.lazyshGotifyNonce=${nonce}`],root);
    processes.push(native);void native.done.catch(()=>{});const until=performance.now()+180000;
    const stage=async(step:number,id?:number)=>{
      phase=gotifyNativePhases[step]??'android-native-stage';
      return wait(until,async()=>{
      const path=`files/.lazysh-gotify-${nonce}.stage-${step}.json`;
      const raw=await shell(['shell','run-as','app.lazysh.client','sh','-c',`'if [ ! -e ${path} ] && [ ! -L ${path} ]; then echo pending; else [ ! -L ${path} ] && stat -c "%u %a %h %s %d %i %f" ${path} && cat ${path} && echo && stat -c "%u %a %h %s %d %i %f" ${path}; fi'`]);
      hostOperation='native-state';
      if(raw==='pending\n'&&(native!.child.exitCode!==null||native!.child.signalCode!==null))throw rejection();
      hostOperation='stage-record';return gotifyPrivateStage(raw,nonce,step,targetUid,id);
      });
    };
    await stage(0);
    const testApks=(await readdir(join(android,'app/build/outputs/apk/androidTest'),{recursive:true})).filter(path=>path.endsWith('.apk'));
    if(testApks.length!==1)throw rejection();
    const testApk=join(android,'app/build/outputs/apk/androidTest',testApks[0]),testHash=digest(await readQrMetadata(testApk,536870912));
    phase='android-installed-artifacts';const executed=await installed.bindRunningArtifacts(testHash),executedApp=executed.app,executedTest=executed.test;
    if(executedApp.uid!==targetUid)throw rejection();
    const ids:number[]=[];
    for(let index=0;index<3;index++) {
      phase='relay-events';
      const eventId=randomUUID(),event=await gotifyJsonRequest(relayOrigin,'/v1/events','POST',`Bearer ${sourceToken}`,{eventId,kind:gotifyStates[index]});
      await wait(until,async()=>{const status=await gotifyJsonRequest(relayOrigin,`/v1/receipts/${event.receiptId}`,'GET',`Bearer ${sourceToken}`,undefined);
        if(status.eventId!==eventId||status.kind!==gotifyStates[index]||status.alias!==alias)throw rejection();if(status.state==='accepted')return true;});
      phase='server-messages';const message=await wait(until,async()=>{
        const result=await gotifyJsonRequest(origin,'/message?limit=100','GET',undefined,undefined,ca,{'X-Gotify-Key':reader.token});
        const matching=result.messages?.filter((item:any)=>item.appid===application.id&&item.title==='lazysh'&&item.message===`${alias}: ${gotifyStates[index]}`&&item.priority===(index===1?5:2));
        if(!Array.isArray(matching)||matching.length>1)throw rejection();return matching[0];
      });
      if(ids.includes(message.id))throw rejection();ids.push(message.id);
      phase='android-event-input';await input(`.message-${index}.tmp`,gotifyMessage(nonce,index,message.id));await stage(index+1,message.id);
    }
    await stage(4);phase='android-instrumentation-result';await native.finish('actual official Gotify Android acceptance',Math.max(1,until-performance.now()+60000));
    const files=(await readdir(reports,{recursive:true})).filter(name=>name.endsWith('.xml'));
    if(files.length!==1)throw rejection();const result=gotifyNativeReport((await readQrMetadata(join(reports,files[0]),262144)).toString());
    if(digest(await readQrMetadata(nativeApk,536870912))!==nativeHash||digest(await readQrMetadata(testApk,536870912))!==testHash)throw rejection();
    phase='android-final-identity';for(const [name,bound] of [['app.lazysh.client',executedApp],['app.lazysh.client.test',executedTest]] as const)
      if((await gotifyInstalledApk(shell,name,bound.sha256,bound.uid)).identity!==bound.identity)throw rejection();
    const head=(await run('source checkout','git',['rev-parse','HEAD'])).trim();if(!/^[a-f0-9]{40}$/.test(head))throw rejection();
    const source:Record<string,string>={};
    for(const path of ['tests/android-gotify.test.ts','tests/support/androidGotify.ts','apps/client/src-tauri/fixtures/gotify-provenance.json',
      'apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/GotifyAndroidTest.kt','apps/notification-service/examples/owned_gotify_android.rs'])
      source[path]=digest(await readQrMetadata(join(root,path),131072));
    receipt={schemaVersion:1,scope:'official-gotify-awake-background',head,source,serverExecutableSha256:pins.server.executableSha256,caSha256:digest(ca),officialApkSha256:pins.android.sha256,initialInputApkSha256:nativeHash,installedAppApkSha256:executedApp.sha256,installedTestApkSha256:executedTest.sha256,installedApksStable:true,
      relayAccepted:3,serverMessages:ids.length,osRecords:3,visibleCards:3,history:true,native:result};
    phase='relay-shutdown';relay.child.stdin!.end();await relay.finish('relay worker shutdown',10000);
  }catch{
    primary=true;
    if(phase.startsWith('android-native-stage')&&native&&native.child.exitCode!==null) {
      phase='android-native-exit';
      try {
        const files=(await readdir(reports,{recursive:true})).filter(name=>name.endsWith('.xml'));
        if(files.length===1)phase=gotifyNativeFailure((await readQrMetadata(join(reports,files[0]),262144)).toString())??phase;
      }catch{/* Missing or malformed reports retain the closed host failure phase. */}
    }
    if(native&&phase.startsWith('android-native-stage')&&hostOperation==='stage-wait')hostOperation=gotifyStageWaitOperation(native.stdout,native.stderr);
    const failedPhase=phase,failedOperation=hostOperation;
    let nativePhase='unavailable';
    if(native&&targetUid>=10000&&phase.startsWith('android-native-stage'))try {
      const entries=[...gotifyNativeFailures].reverse().join(' ');
      const command=`'for entry in ${entries}; do path=files/.lazysh-gotify-${nonce}.phase-$entry.json; if [ -e "$path" ] || [ -L "$path" ]; then [ ! -L "$path" ] && stat -c "%u %a %h %s %d %i %f" "$path" && cat "$path" && echo && stat -c "%u %a %h %s %d %i %f" "$path"; exit; fi; done; echo pending'`;
      nativePhase=await observeGotifyNativePhase(continuous,()=>run(failedPhase,adb,['-s',serial,'shell','run-as','app.lazysh.client','sh','-c',command],1000),nonce,targetUid);
    }catch{/* Missing, foreign or changing evidence never replaces the primary failure. */}
    finally{phase=failedPhase;hostOperation=failedOperation;}
    let diagnostic=gotifyHostDiagnostic(hostOperation,undefined,undefined,nativePhase);
    try{diagnostic=gotifyHostDiagnostic(hostOperation,native?await native.startupDiagnostic():undefined,native?native.child.signalCode!==null:undefined,nativePhase);}
    catch{/* Keep the original failure when process metadata is unavailable. */}
    throw Object.assign(new Error(`Owned Gotify acceptance failed: ${phase}`),{gotifyDiagnostic:diagnostic});
  }
  finally {
    for(const process of processes.reverse())try{await process.stop();}catch{cleanupFailed=true;}
    if((await installed.cleanup()).length)cleanupFailed=true;
    if(reverse)try{await reverse.cleanup();}catch{cleanupFailed=true;}
    if(caPushed)try{await continuous();if((await shell(['shell','sha256sum',`/sdcard/Download/${caName}`])).split(/\s+/)[0]!==digest(await privateFile(join(directory,'ca.pem'),16384)))throw rejection();
      await shell(['shell','rm',`/sdcard/Download/${caName}`]);}catch{cleanupFailed=true;}
    if(!cleanupFailed)try{await rm(directory,{recursive:true,force:true});}catch{cleanupFailed=true;}
    if(cleanupFailed){if(!primary)throw new Error('Owned Gotify cleanup failed');console.error('Owned Gotify cleanup failed after original failure');}
  }
  return {...receipt,cleanup:true};
}

/** Public artifacts contain no errors, upstream logs, URLs or private handoff data. */
export async function ownedGotifyAndroid(root:string) {
  const finite=join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results/gotify');
  await mkdir(finite,{recursive:true});
  for(const name of ['receipt.json','failure.json'])await rm(join(finite,name),{force:true});
  const retain=async(name:'receipt'|'failure',value:object)=>{
    const pending=join(finite,`${randomUUID()}.pending`);
    await writeFile(pending,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
    await rename(pending,join(finite,`${name}.json`));
  };
  try {
    const receipt=await runGotifyAndroid(root);
    await retain('receipt',receipt);return receipt;
  }catch(error) {
    try{await retain('failure',{schemaVersion:1,scope:'official-gotify-awake-background',phase:gotifyFailurePhase(error),hostDiagnostic:gotifyErrorDiagnostic(error),runtimePassed:false,notificationDelivery:false,cleanup:'unverified'});}
    catch{console.error('Finite Gotify failure receipt could not be retained');}
    throw error;
  }
}
