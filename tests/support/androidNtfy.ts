import {constants} from 'node:fs';
import {chmod,mkdtemp,mkdir,open,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Writable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {OwnedProcess,nativeReportCases,hostAdbServerIdentity,compareHostAdbServer,emulatorContinuity,compareEmulatorContinuity} from './androidSsh';
import {attestQrCamera} from './androidQrOwnership';

const packages=['io.heckel.ntfy','app.lazysh.client.test','app.lazysh.client'] as const;
export class OwnedNtfyPackages {
  private pending:string[]=[];
  constructor(private readonly run:(args:string[])=>Promise<string>) {}
  admit(name:typeof packages[number]) {
    if(!packages.includes(name))throw new Error('Unknown fixture package');
    if(!this.pending.includes(name))this.pending.push(name);
  }
  async install(name:typeof packages[number],path:string) {
    this.admit(name);
    await this.run(['install','-t',path]);
  }
  async cleanup() {
    const errors:unknown[]=[];
    for(const name of this.pending.splice(0).reverse())try{
      const present=(await this.run(['shell','pm','list','packages',name])).trim().split('\n');
      if(present.includes(`package:${name}`))await this.run(['uninstall',name]);
    }catch(error){errors.push(error);}
    return errors;
  }
}
const fixtureCase='ownedNtfyEncryptedChallengeUsesNativeDialogAndBackgroundCallback';
const fixtureCases=['ownedNtfyFirstLaunchBudgetAndOneTimePermissionPolicy',
  'ownedUnifiedPushEventParserAndKeystoreReplayStateFailClosed',fixtureCase];
const invalid=()=>new Error('Owned ntfy acceptance admission failed');
type NtfyClockPoint={wall:number;before:bigint;after:bigint};
type NtfyClockComparison={
  status:'observed'|'commandFailed'|'malformed'|'outOfBounds'|'hostDiscontinuity';
  offset:'behind'|'ahead'|'overlapsZero'|'unavailable';
  magnitude:'oneToFiveSeconds'|'fiveToThirtySeconds'|'atLeastThirtySeconds'|'crossesBand'|'unavailable';
  uncertainty:'atMostTwoSeconds'|'twoToFiveSeconds'|'overFiveSeconds'|'unavailable';
  hostProgress:'consistentWithinMillisecond'|'wallAhead'|'wallBehind'|'unavailable';
};
const unavailableClock=(status:NtfyClockComparison['status']):NtfyClockComparison=>
  ({status,offset:'unavailable',magnitude:'unavailable',uncertainty:'unavailable',hostProgress:'unavailable'});
function validNtfyClockPoint(point:NtfyClockPoint) {
  return Number.isSafeInteger(point.wall) && point.wall>=0 && point.wall<8_640_000_000_000_000 &&
    typeof point.before==='bigint' && typeof point.after==='bigint' && point.before>=0n && point.after>=point.before && point.after<=9_223_372_036_854_775_807n;
}
function ntfyHostClockSpan(before:NtfyClockPoint,after:NtfyClockPoint) {
  if(!validNtfyClockPoint(before)||!validNtfyClockPoint(after)||after.before<before.after)return;
  const wall=BigInt(after.wall-before.wall)*1_000_000n;
  return {progress:after.wall<before.wall||wall<after.before-before.after-1_000_000n?'wallBehind':
    wall>after.after-before.before+1_000_000n?'wallAhead':'consistentWithinMillisecond',elapsed:after.after-before.before} as const;
}
export function ntfyClockComparison(raw:string,before:NtfyClockPoint,after:NtfyClockPoint):NtfyClockComparison {
  const match=/^(0|[1-9][0-9]{0,12})\n?$/.exec(raw);
  if(raw.length>14 || !match || match[0]!==raw)return unavailableClock('malformed');
  const guest=BigInt(match[1])*1000n;
  const host=ntfyHostClockSpan(before,after);
  if(!host||guest>=8_640_000_000_000_000n)return unavailableClock('outOfBounds');
  const hostProgress=host.progress;
  if(hostProgress!=='consistentWithinMillisecond')return {...unavailableClock('hostDiscontinuity'),hostProgress};
  // date +%s represents [second, second+1); Date.now() has millisecond quantization.
  // The guest sample occurred somewhere inside this entire command bracket.
  const lower=guest-BigInt(after.wall)-1n,upper=guest+1000n-BigInt(before.wall);
  const offset=upper<=0n?'behind':lower>=0n?'ahead':'overlapsZero';
  const low=offset==='behind'?-upper:lower,high=offset==='behind'?-lower:upper;
  const magnitude=offset==='overlapsZero'?'crossesBand':low>=1000n&&high<=5000n?'oneToFiveSeconds':low>=5000n&&high<=30000n?'fiveToThirtySeconds':
    low>=30000n?'atLeastThirtySeconds':'crossesBand';
  const width=upper-lower;
  return {status:'observed',offset,magnitude,uncertainty:width<=2000n?'atMostTwoSeconds':width<=5000n?'twoToFiveSeconds':'overFiveSeconds',hostProgress};
}
function sampleNtfyHostClock():NtfyClockPoint {
  const before=process.hrtime.bigint(),wall=Date.now();
  return {wall,before,after:process.hrtime.bigint()};
}
export async function observeNtfyClock(read:()=>Promise<string>,check:()=>Promise<void>,sample=sampleNtfyHostClock):Promise<NtfyClockComparison> {
  await check();
  const before=sample();let raw:string|undefined;
  try{raw=await read();}catch{/* Diagnostic unavailability never replaces the original acceptance flow. */}
  const after=sample();
  await check(); // Lost emulator identity must still fail closed, even after a failed read.
  return raw===undefined?unavailableClock('commandFailed'):ntfyClockComparison(raw,before,after);
}
type ControlledClockReadback='notRead'|'malformed'|'hostDiscontinuity'|'wideBracket'|'outsideDeclaredOffset'|'verified';
export function controlledNtfyClockReadback(raw:string,before:NtfyClockPoint,after:NtfyClockPoint,setAt=before):ControlledClockReadback {
  const match=/^(0|[1-9][0-9]{0,15})\n?$/.exec(raw);
  if(raw.length>17||!match||match[0]!==raw)return 'malformed';
  const guest=BigInt(match[1]);
  if(guest>=8_640_000_000_000_000n)return 'malformed';
  const host=ntfyHostClockSpan(before,after),whole=ntfyHostClockSpan(setAt,after);
  if(!host||!whole||host.progress!=='consistentWithinMillisecond'||whole.progress!=='consistentWithinMillisecond')return 'hostDiscontinuity';
  // Both samples represent millisecond intervals. Never admit overlapping-zero bounds.
  const lower=guest-BigInt(after.wall)-1n,upper=guest+1n-BigInt(before.wall);
  if(host.elapsed>250_000_000n||upper-lower>250n)return 'wideBracket';
  return lower>0n&&upper<=2000n?'verified':'outsideDeclaredOffset';
}
export async function absentNtfyPackages(command:(args:string[])=>Promise<string>) {
  for(const name of packages) {
    const raw=await command(['shell','pm','list','packages',name]);
    const rows=raw===''?[]:raw.replace(/\n$/,'').split('\n');
    if(Buffer.byteLength(raw)>4096||!rows.every(row=>/^package:[A-Za-z0-9_.]+$/.test(row))||rows.includes(`package:${name}`))
      throw new Error('Owned ntfy fixture packages/state must be absent');
  }
}
export class OwnedNtfyClock {
  private original:boolean|undefined;
  private restoreNeeded=false;
  private attempted=false;
  private restoreAttempted=false;
  private state:'notStarted'|'preparing'|'verified'='notStarted';
  private readback:ControlledClockReadback='notRead';
  private restoration:'notRequired'|'pending'|'restored'|'blocked'|'failed'='notRequired';
  constructor(private readonly command:(args:string[])=>Promise<string>,private readonly check:()=>Promise<void>,private readonly sample=sampleNtfyHostClock) {}
  private async call(args:string[]) {
    try{return await this.command(args);}catch{throw new Error('Owned ntfy controlled clock command failed');}
  }
  private async request(args:string[]) {
    await this.check();
    try{return await this.call(args);}
    finally{await this.check();}
  }
  private async autoTime() {
    const value=await this.request(['shell','cmd','time_detector','is_auto_detection_enabled']);
    if(!/^(true|false)\n?$/.test(value)||value.replace(/\n$/,'').includes('\n'))throw new Error('Owned ntfy automatic time response invalid');
    return value.startsWith('true');
  }
  private async setAutoTime(value:boolean) {
    if(await this.request(['shell','cmd','time_detector','set_auto_detection_enabled',String(value)])!=='')throw new Error('Owned ntfy automatic time update unrecognized');
    if(await this.autoTime()!==value)throw new Error('Owned ntfy automatic time update not verified');
  }
  async prepare() {
    if(this.attempted)throw new Error('Owned ntfy controlled clock cannot be repeated');
    this.attempted=true;this.state='preparing';
    await this.check();await absentNtfyPackages(args=>this.request(args));
    this.original=await this.autoTime();
    this.restoreNeeded=true;this.restoration='pending'; // A lost update acknowledgement still needs restoration.
    await this.setAutoTime(false);
    await this.check();
    const at=this.sample();
    if(!validNtfyClockPoint(at)||at.wall>8_639_999_999_998_999)throw new Error('Owned ntfy host clock invalid');
    // This is a declared disposable-VM state, not exact synchronization or a payload timestamp.
    try{if(await this.call(['shell','cmd','alarm','set-time',String(at.wall+1000)])!=='')throw new Error('Owned ntfy clock update unrecognized');}
    finally{await this.check();}
    await this.check();
    const before=this.sample();
    let raw:string,after:NtfyClockPoint;
    try{raw=await this.call(['shell','date','+%s%3N']);}
    finally{after=this.sample();await this.check();}
    this.readback=controlledNtfyClockReadback(raw,before,after,at);
    if(this.readback!=='verified')throw new Error('Owned ntfy controlled clock readback not admitted');
    await absentNtfyPackages(args=>this.request(args));this.state='verified';
  }
  async restore(teardown:()=>Promise<void>) {
    if(!this.restoreNeeded)return;
    if(this.restoreAttempted)throw new Error('Owned ntfy clock restoration cannot be repeated');
    this.restoreAttempted=true;this.restoration='blocked';
    await teardown(); // Never change time underneath retained app/high-water state.
    await this.check();await absentNtfyPackages(args=>this.request(args));
    this.restoration='failed';
    await this.setAutoTime(this.original!);this.restoration='restored';
  }
  observation() {return {state:this.state,readback:this.readback,restoration:this.restoration,declaredState:'strictlyPositiveAtMostTwoSeconds',maxReadbackUncertaintyMs:250} as const;}
}
type NtfyClockOwner={server:Awaited<ReturnType<typeof hostAdbServerIdentity>>;guest:Awaited<ReturnType<typeof emulatorContinuity>>};
export function sameNtfyClockOwner(before:NtfyClockOwner,after:NtfyClockOwner) {
  const guest=compareEmulatorContinuity(before.guest,after.guest);
  return before.guest.connection==='device'&&after.guest.connection==='device'&&compareHostAdbServer(before.server,after.server)==='same'&&
    guest.transport==='same'&&guest.boot==='same'&&guest.adbd==='same';
}
export function privateInputCommand(nonce:string) {
  if(!/^[a-f\d]{32}$/.test(nonce))throw invalid();
  return `umask 077 && [ ! -L files ] && if [ ! -e files ]; then mkdir -m 700 files; fi && [ -d files ] && [ "$(stat -c %u files)" = "$(id -u)" ] && chmod 700 files && [ "$(stat -c %a files)" = 700 ] && set -C && cat > files/.lazysh-ntfy-${nonce}.json`;
}
export async function writePrivateInput(input:Buffer,stdin:Writable,finish:()=>Promise<unknown>) {
  let rejected=false;
  const onError=()=>{rejected=true;};stdin.on('error',onError);
  const settled=finished(stdin,{readable:false,cleanup:true}).catch(()=>{rejected=true;});
  try{
    try{stdin.end(input);}catch{rejected=true;stdin.destroy();}
    await finish();
    stdin.destroy();await settled;
    if(rejected)throw new Error('Private fixture input could not be transmitted');
  }finally{stdin.destroy();await settled;stdin.off('error',onError);input.fill(0);}
}
export function ntfyEnvironment(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH','HOME','LANG'].flatMap(name=>env[name]===undefined?[]:[[name,env[name]]]));
}
export function distributorHasGooglePush(text:string,manifest=false) {
  // The pinned F-Droid flavor retains two inert declarations for its dummy
  // android.app.Service. They are not permission/component or dex exemptions.
  const checked=manifest?text
    .replace(/<action\s+android:name="com\.google\.firebase\.MESSAGING_EVENT"\s*\/>/g,'')
    .replace(/<meta-data\s+android:name="com\.google\.firebase\.messaging\.default_notification_icon"\s+android:resource="@ref\/0x[a-f\d]{8}"\s*\/>/g,''):text;
  return /\bcom\.google\.(?:firebase|android\.(?:gms|c2dm))\b|\borg\.unifiedpush\.android\.(?:foss_)?embedded_fcm_distributor\b/.test(checked);
}
export async function inspectAcceptanceTrust(apk:string,ca:string,sdk:string,
  run:(stage:string,program:string,args:string[])=>Promise<string>) {
  const analyzer=join(sdk,'cmdline-tools/latest/bin/apkanalyzer');
  const trust=await run('fixture-only trust configuration',analyzer,['resources','xml','--file','/res/xml/network_security_config.xml',apk]);
  const debug=(await run('fixture-only debuggable APK',analyzer,['manifest','debuggable',apk])).trim();
  if(!trust.includes('debug-overrides')||debug!=='true')throw new Error('Explicit fixture trust missing');
  const packaged=await run('exact owned fixture CA','unzip',['-p',apk,'res/raw/lazysh_unifiedpush_test_ca.pem']);
  if(packaged!==(await boundedFile(ca,8192)).toString('utf8'))throw new Error('Fixture trust identity mismatch');
}
async function boundedFile(path:string,limit:number) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();if(!stat.isFile()||stat.size<1||stat.size>limit)throw invalid();
    const bytes=Buffer.alloc(Math.min(stat.size+1,limit+1));
    let count=0;
    while(count<bytes.length){const result=await file.read(bytes,count,bytes.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}
    if(count!==stat.size)throw invalid();
    return bytes.subarray(0,count);
  } finally {await file.close();}
}
async function extractNtfy(directory:string,archive:string,root:string,
  command=(stage:string,program:string,args:string[])=>new OwnedProcess(program,args,root).finish(stage,10_000)) {
  const pins=JSON.parse(await readFile(join(root,'apps/client/src-tauri/fixtures/ntfy-provenance.json'),'utf8'));
  if(createHash('sha256').update(await boundedFile(archive,128*1024*1024)).digest('hex')!==pins.server.sha256)throw new Error('Official ntfy artifact digest mismatch');
  const run=(args:string[])=>command('official ntfy archive member','tar',args);
  const listed=await run(['--list','--verbose','--gzip','--file',archive,pins.server.member]);
  if(!listed.startsWith('-')||listed.trim().split('\n').length!==1)throw invalid();
  await run(['--extract','--gzip','--file',archive,'--directory',directory,'--no-same-owner','--no-same-permissions','--strip-components=1',pins.server.member]);
  const binary=join(directory,'ntfy');await chmod(binary,0o700);return binary;
}
function nativeRelay(root:string,directory:string,nonce:string) {
  return new OwnedProcess('cargo',['test','-p','lazysh-notifications','--locked','--lib',
    'tests::ntfy_android::real_ntfy_android_encrypted_challenge','--','--ignored','--exact','--nocapture'],root,
    {...process.env,LAZYSH_ANDROID_NTFY:'1',LAZYSH_NTFY_FIXTURE_DIRECTORY:directory,LAZYSH_NTFY_FIXTURE_NONCE:nonce});
}
export async function relayInput(relay:OwnedProcess,directory:string,check:()=>Promise<unknown>) {
  const deadline=performance.now()+120_000;
  while(true){
    await check();
    let input:Buffer|undefined;
    try{input=await boundedFile(join(directory,'input.json'),4096);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(relay.child.exitCode!==null||relay.child.signalCode!==null||performance.now()>deadline)throw new Error('Owned native relay readiness deadline');
    if(input)return input;
    await Bun.sleep(50);
  }
}
export async function ntfyHealth(ntfy:OwnedProcess,origin:string,directory:string,
  run:(stage:string,program:string,args:string[],milliseconds:number)=>Promise<string>) {
  const deadline=performance.now()+10_000;
  while(true){
    try{await run('owned ntfy HTTPS health','curl',['--fail','--silent','--show-error','--cacert',join(directory,'ca.pem'),'--max-time','1',origin+'/v1/health'],2000);return;}
    catch(error){
      if(ntfy.child.exitCode!==null||ntfy.child.signalCode!==null){
        const text=ntfy.stderr+'\n'+ntfy.stdout;
        console.error(JSON.stringify({ntfyStartupExit:ntfy.child.exitCode,
          ntfyStartupSignal:ntfy.child.signalCode===null?'none':ntfy.child.signalCode==='SIGTERM'?'terminated':ntfy.child.signalCode==='SIGKILL'?'killed':'other',
          cliRejected:/Incorrect Usage|flag provided but not defined/i.test(text),
          configurationRejected:/config|yaml|unmarshal/i.test(text),
          tlsRejected:/certificate|private key|tls:/i.test(text),
          listenerRejected:/listen|bind|address already in use/i.test(text),
          storageRejected:/cache|database|sqlite/i.test(text)}));
        if(ntfy.child.signalCode!==null)throw new Error('Owned ntfy startup was signalled');
        throw new Error(`Owned ntfy startup exited; exit=${ntfy.child.exitCode}`);
      }
      if(performance.now()>deadline){
        const exit=error instanceof Error?/; exit=(\d{1,3})$/.exec(error.message):null;
        console.error(JSON.stringify({ntfyAlive:true,healthExit:exit?Number(exit[1]):null}));
        throw new Error('Owned ntfy HTTPS readiness deadline');
      }
      await Bun.sleep(50);
    }
  }
}
export async function realNtfyStartup(archive:string,root=resolve(import.meta.dir,'../..')) {
  const directory=await mkdtemp(join(tmpdir(),'.lazysh-ntfy-startup-'));await chmod(directory,0o700);
  const children:OwnedProcess[]=[];let primary=false;
  try{
    const binary=await extractNtfy(directory,archive,root);
    const relay=nativeRelay(root,directory,randomUUID().replaceAll('-',''));children.push(relay);
    const data=JSON.parse((await relayInput(relay,directory,async()=>{})).toString('utf8'));
    if(!/^https:\/\/localhost:[1-9]\d{0,4}$/.test(data.ntfyOrigin))throw invalid();
    const ntfy=new OwnedProcess(binary,['serve','--config',join(directory,'ntfy.yml')],directory,ntfyEnvironment(process.env));children.push(ntfy);
    let reported=false;
    await ntfyHealth(ntfy,data.ntfyOrigin,directory,async(stage,program,args,milliseconds)=>{
      const child=new OwnedProcess(program,args,root);
      try{return await child.finish(stage,milliseconds);}catch(error){
        if(!reported&&error instanceof Error&&/; exit=60$/.test(error.message)){reported=true;console.error(JSON.stringify({
          tlsSelfSigned:/self.signed/i.test(child.stderr),tlsIssuer:/issuer|unable to get local/i.test(child.stderr),
          tlsName:/subject name|hostname/i.test(child.stderr),tlsPurpose:/purpose/i.test(child.stderr),tlsDate:/expired|not yet valid/i.test(child.stderr)}));}
        throw error;
      }
    });
  }catch(error){
    primary=true;
    if(error instanceof Error&&/^Owned ntfy (?:startup exited; exit=\d{1,3}|startup was signalled|HTTPS readiness deadline)$/.test(error.message))throw error;
    throw new Error('Owned ntfy startup preflight failed');
  }
  finally{
    let failed=false;for(const child of children.reverse())try{await child.stop();}catch{failed=true;}
    try{await rm(directory,{recursive:true,force:true});}catch{failed=true;}
    if(failed){if(primary)console.error('Owned startup cleanup failed after original failure');else throw new Error('Owned startup cleanup failed');}
  }
}
export function validateNtfyReport(text:string) {
  const {cases,failed}=nativeReportCases(text);
  if(cases.length!==fixtureCases.length||new Set(cases.map(row=>row.name)).size!==fixtureCases.length||
      cases.some(row=>row.className!=='app.lazysh.client.NativeWorkspaceTest'||!fixtureCases.includes(row.name??''))||
      failed)throw new Error('Actual native ntfy cases did not pass without skips');
  return {nativeCase:fixtureCase,nativeCases:fixtureCases,passed:fixtureCases.length,failed:0,skipped:0};
}
async function receipt(directory:string) {
  const entries=await readdir(directory,{recursive:true});
  const xml=entries.filter(name=>name.startsWith('android-results/')&&name.endsWith('.xml'));
  if(xml.length!==1)throw new Error('Expected one owned native ntfy report');
  return validateNtfyReport((await boundedFile(join(directory,xml[0]),256*1024)).toString('utf8'));
}
export function firstLaunchObservation(text:string) {
  const match=/Distributor menu; foreground=(ntfy|permission|lazysh|other) allow=(true|false) deny=(true|false) toolbar=(true|false) ownedPrompt=(true|false) attempted=(true|false)/.exec(text);
  if(!match)return;
  return {foreground:match[1],allow:match[2]==='true',deny:match[3]==='true',toolbar:match[4]==='true',ownedPrompt:match[5]==='true',attempted:match[6]==='true'};
}
export function permissionActionObservation(text:string) {
  if(Buffer.byteLength(text)>256*1024 || text.split('Ntfy first-launch action[').length!==2)return;
  const match=/Ntfy first-launch action\[stage=(none|foreground|allow|deny|toolbar|prompt|menu|click) before=(unavailable|positive|expired) after=(unavailable|positive|expired) action=(none|calling|returned|threw) snapshot=(unavailable|beforeAction|afterAction) permission=(granted|denied|unavailable)(?: clickBefore=(unavailable|positive|expired) clickAfter=(unavailable|positive|expired) firstExpiry=(none|between|foreground|allow|deny|toolbar|prompt|menu|click))?\]/.exec(text);
  if(!match)return;
  const [,stage,before,after,action,snapshot,permission,clickBefore,clickAfter,firstExpiry]=match;
  if((stage==='none')!==(before==='unavailable') ||
    (stage==='none' && (after!=='unavailable' || action!=='none' || snapshot!=='unavailable')) ||
    (stage==='click' && action==='none') ||
    ((action==='calling' || action==='threw') && (stage!=='click' || after!=='unavailable')) ||
    (stage==='click' && action==='returned' && after==='unavailable') ||
    (snapshot==='afterAction' && action!=='returned'))return;
  if(clickBefore!==undefined && (
    (action==='none' && (clickBefore!=='unavailable' || clickAfter!=='unavailable')) ||
    (action!=='none' && clickBefore==='unavailable') ||
    (action==='returned' ? clickAfter==='unavailable' : clickAfter!=='unavailable') ||
    (stage==='click' && (clickBefore!==before || clickAfter!==after))))return;
  return {stage,before,after,action,snapshot,permission,...(clickBefore===undefined?{}:{clickBefore,clickAfter,firstExpiry})};
}
export function nativeFailureStage(failure:string) {
  const stages=[['Distributor menu','distributor_menu'],['Distributor settings','distributor_settings'],
    ['Owned default server','default_server_preference'],['Default server field','distributor_server'],
    ['Save owned default server','default_server_save'],['Owned TLS trust topic','trust_topic_action'],
    ['Owned trust topic field','trust_topic_field'],['Review owned TLS certificate','certificate_subscribe'],
    ['Certificate fingerprint review','certificate_review'],['Exact owned server certificate required','certificate_identity'],
    ['Trust only the owned server certificate','certificate_trust'],['Actual native credential dialog required','native_dialog'],
    ['Explicit notification permission','notification_permission'],['Real SDK challenge must confirm native state','challenge_confirmation'],
    ['Actual native display consent dialog required','display_dialog'],['Original lease commits native display consent','display_consent'],
    ['Actual bound-event notification required','event_notification'],['Actual private generic notification','notification_privacy'],
    ['Actual immutable own-app intent without remote actions','notification_intent'],
    ['Actual replay callback reached bound admission','replay_callback'],['Replay cannot replace actual notification','replay_notification'],
    ['Authenticated relay cleanup must remove private enrollment','authenticated_cleanup']];
  return stages.find(([label])=>failure.includes(label))?.[1]??'other_native_failure';
}
export function settingsObservation(text:string) {
  const match=/Owned default server; settingsForeground=(true|false) settingsToolbar=(true|false) preferenceList=(true|false) preferenceTarget=(true|false) scrollAttempts=([012])(?:\b|$)/.exec(text);
  if(!match)return;
  return {foreground:match[1]==='true',toolbar:match[2]==='true',list:match[3]==='true',target:match[4]==='true',scrollAttempts:Number(match[5])};
}
export function eventObservation(text:string) {
  if(Buffer.byteLength(text)>256*1024 || text.split('eventObservation[').length!==2)return;
  const rows=[...text.matchAll(/Actual bound-event notification required; eventObservation\[entered=(true|false) readReturned=(true|false) initialReceipts=(zero|one|many|unavailable) finalReceipts=(zero|one|many|unavailable) appNotifications=(true|false|unavailable) postPermission=(true|false|unavailable) channelEnabled=(true|false|unavailable) ownedNotification=(true|false|unavailable)(?: reads=(zero|one|many) returnedReads=(zero|one|many) writes=(zero|one|many) returnedWrites=(zero|one|many) storedEnabled=(true|false|unavailable) clock=(unavailable|negative|rollback|beforeIssued|expired|withinWindow)(?: hostProgress=(consistentWithinSecond|wallAhead|wallBehind|unavailable) issuedInHandler=(within|outside|unavailable) postProgress=(consistentWithinSecond|wallAhead|wallBehind|unavailable) callbackProgress=(consistentWithinSecond|wallAhead|wallBehind|unavailable) postClock=(unavailable|beforeIssued|expired|withinWindow))?)?\]/g)];
  if(rows.length!==1)return;
  const match=rows[0];
  if(match[1]==='false' && match[2]==='true')return;
  const flag=(value:string)=>value==='unavailable'?null:value==='true';
  return {entered:match[1]==='true',readReturned:match[2]==='true',initialReceipts:match[3],finalReceipts:match[4],
    appNotifications:flag(match[5]),postPermission:flag(match[6]),channelEnabled:flag(match[7]),ownedNotification:flag(match[8]),
    ...(match[9]===undefined?{}:{reads:match[9],returnedReads:match[10],writes:match[11],returnedWrites:match[12],
      storedEnabled:flag(match[13]),clock:match[14],...(match[15]===undefined?{}:{hostProgress:match[15],issuedInHandler:match[16],postProgress:match[17],callbackProgress:match[18],postClock:match[19]})})};
}
async function nativeFailure(directory:string) {
  try {
    const files=(await readdir(directory,{recursive:true})).filter(name=>name.startsWith('android-results/')&&name.endsWith('.xml'));
    if(files.length!==1)return {};
    const text=(await boundedFile(join(directory,files[0]),256*1024)).toString('utf8');
    const failure=/<failure\b[\s\S]*?<\/failure>/.exec(text)?.[0]??'';
    const line=/NativeWorkspaceTest\.kt:([0-9]{1,5})/.exec(failure)?.[1];
    const firstLaunch=firstLaunchObservation(failure);
    const permissionAction=permissionActionObservation(failure);
    const settings=settingsObservation(failure);
    const event=eventObservation(failure);
    return {nativeStage:nativeFailureStage(failure),nativeSourceLine:line?Number(line):null,...(firstLaunch?{firstLaunch}:{}),...(permissionAction?{permissionAction}:{}),...(settings?{settings}:{}),...(event?{eventObservation:event}:{})};
  }catch{return {};}
}

export async function realNtfyChallenge(root=resolve(import.meta.dir,'../..')) {
  if(process.platform!=='linux'||process.arch!=='x64')throw invalid();
  const owned=await attestQrCamera(process.env,root);
  const sdk=process.env.ANDROID_HOME,serial=process.env.ANDROID_SERIAL;
  if(!sdk||!serial)throw invalid();
  const adb=join(sdk,'platform-tools/adb');
  const android=join(root,'apps/client/src-tauri/gen/android');
  const finite=join(android,'app/build/outputs/androidTest-results/ntfy');
  for(const name of ['receipt.json','failure.json'])await rm(join(finite,name),{force:true});
  const directory=await mkdtemp(join(tmpdir(),'.lazysh-ntfy-'));
  await chmod(directory,0o700);
  const nonce=randomUUID().replaceAll('-','');
  const children:OwnedProcess[]=[],reverses:string[]=[];
  let primary=false;
  let phase='owned admission';
  let clockComparison=unavailableClock('commandFailed');
  let clock:OwnedNtfyClock|undefined;
  let receiptValue:Record<string,unknown>|undefined;
  let failureValue:Record<string,unknown>|undefined;
  let originalFailure:Error|undefined;
  const run=async(stage:string,program:string,args:string[],milliseconds=10_000)=>{
    phase=stage;
    await owned.check();
    return new OwnedProcess(program,args,root).finish(stage,milliseconds);
  };
  const shell=(stage:string,args:string[])=>run(stage,adb,['-s',serial,...args]);
  const installed=new OwnedNtfyPackages(args=>shell('owned package operation',args));
  const stream=async(stage:string,program:string,args:string[],limit:number,consume:(bytes:Buffer)=>void)=>{
    phase=stage;
    await owned.check();
    const child=new OwnedProcess(program,args,root);
    let total=0,overflow=false;
    child.child.stdout!.on('data',(bytes:Buffer)=>{
      total+=bytes.length;
      if(total<=limit)consume(bytes);
      else if(!overflow){overflow=true;void child.stop().catch(()=>{});}
    });
    await child.finish(stage,60_000);
    if(overflow||total===0)throw new Error('Owned artifact stream bound failed');
  };
  const nativeDigest=async(apk:string)=>{
    const hash=createHash('sha256');
    await stream('owned current native library','unzip',['-p',apk,'lib/x86_64/liblazysh_lib.so'],512*1024*1024,bytes=>{hash.update(bytes);});
    return hash.digest('hex');
  };
  const normalArtifact=async(configuration='universalDebugRuntimeClasspath',apk?:string)=>{
    phase='normal APK trust and FOSS absence';
    await owned.check();
    const child=new OwnedProcess(process.execPath,['test',join(root,'tests/android-push-artifact.test.ts')],root,
      {...process.env,LAZYSH_ANDROID_PUSH_VARIANT:'fdroid',LAZYSH_ANDROID_PUSH_CONFIGURATION:configuration,
        ...(apk?{LAZYSH_ANDROID_PUSH_APK:apk}:{})});
    await child.finish('normal APK trust and FOSS absence',120_000);
  };
  try {
    await absentNtfyPackages(args=>shell('fixture package absence',args));
    const pins=JSON.parse(await readFile(join(root,'apps/client/src-tauri/fixtures/ntfy-provenance.json'),'utf8'));
    for(const [name,pin] of [['server',pins.server],['distributor',pins.android]] as const){
      const path=join(directory,name==='server'?'server.tar.gz':'distributor.apk');
      await run('official ntfy artifact download','curl',['--fail','--silent','--show-error','--location','--proto','=https','--tlsv1.2',
        '--connect-timeout','10','--max-time','90','--max-filesize','134217728',pin.url,'--output',path],95_000);
      const bytes=await boundedFile(path,128*1024*1024);
      if(createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw new Error('Official ntfy artifact digest mismatch');
    }
    await owned.check();
    const binary=await extractNtfy(directory,join(directory,'server.tar.gz'),root,run);
    const signer=await run('official distributor signature',join(sdk,'build-tools/36.0.0/apksigner'),['verify','--print-certs',join(directory,'distributor.apk')]);
    const fingerprints=[...signer.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f\d]{64})$/gm)].map(match=>match[1]);
    if(fingerprints.length!==1||fingerprints[0]!==pins.android.signerSha256)throw new Error('Official distributor signing identity mismatch');
    const analyzer=join(sdk,'cmdline-tools/latest/bin/apkanalyzer');
    const appId=(await run('official distributor identity',analyzer,['manifest','application-id',join(directory,'distributor.apk')])).trim();
    if(appId!==pins.android.applicationId)throw invalid();
    // Scan every chunk rather than relying on OwnedProcess's bounded text tail.
    let forbidden=false,tail='';
    const inspectGoogle=(data:Buffer)=>{
      const text=tail+String(data);tail=text.slice(-128);
      forbidden ||= distributorHasGooglePush(text);
    };
    await stream('actual FOSS distributor dex',analyzer,['dex','packages','--defined-only',join(directory,'distributor.apk')],32*1024*1024,inspectGoogle);
    const manifest:Buffer[]=[];
    await stream('actual FOSS distributor manifest',analyzer,['manifest','print',join(directory,'distributor.apk')],256*1024,bytes=>manifest.push(bytes));
    if(forbidden||distributorHasGooglePush(Buffer.concat(manifest).toString('utf8'),true))throw new Error('Distributor FOSS graph admission failed');
    const apk=join(android,'app/build/outputs/apk/universal/debug/app-universal-debug.apk');
    await normalArtifact();
    const baselineNative=await nativeDigest(apk);
    phase='owned native relay readiness';
    const relay=nativeRelay(root,directory,nonce);
    children.push(relay);
    const input=await relayInput(relay,directory,()=>owned.check());
    const data=JSON.parse(input.toString('utf8'));
    const origins=[data.relayOrigin,data.ntfyOrigin,data.untrustedOrigin];
    if(data.nonce!==nonce||!origins.every(value=>typeof value==='string'&&/^https:\/\/localhost:[1-9]\d{0,4}$/.test(value)&&Number(new URL(value).port)<=65535))throw invalid();
    const ntfy=new OwnedProcess(binary,['serve','--config',join(directory,'ntfy.yml')],directory,ntfyEnvironment(process.env));children.push(ntfy);
    await ntfyHealth(ntfy,data.ntfyOrigin,directory,run);
    for(const origin of origins){
      const port=new URL(origin).port;
      await shell('owned TLS reverse',['reverse','--no-rebind',`tcp:${port}`,`tcp:${port}`]);reverses.push(port);
    }
    const gradleArgs=['-p',android,'--no-daemon','-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64',
      '-x',':app:rustBuildX86_64Debug',`-PlazyshUnifiedPushAcceptanceCa=${join(directory,'ca.pem')}`];
    await run('native acceptance APK resources',join(android,'gradlew'),[':app:assembleUniversalDebug',...gradleArgs],120_000);
    if(await nativeDigest(apk)!==baselineNative)throw new Error('Acceptance cannot replace the current native library');
    await inspectAcceptanceTrust(apk,join(directory,'ca.pem'),sdk,run);
    phase='owned controlled clock provisioning';
    await owned.check();
    const captureClockOwner=async():Promise<NtfyClockOwner>=>({server:await hostAdbServerIdentity(adb),guest:await emulatorContinuity(adb,serial,undefined,0)});
    const clockOwner=await captureClockOwner();
    const checkClockOwner=async()=>{
      await owned.check();
      if(!sameNtfyClockOwner(clockOwner,await captureClockOwner()))throw new Error('Owned ntfy clock identity unavailable or changed');
      await owned.check();
    };
    await checkClockOwner();
    if(await shell('owned clock API36 admission',['shell','getprop','ro.build.version.sdk'])!=='36\n')throw invalid();
    phase='owned controlled clock provisioning';
    clockComparison=await observeNtfyClock(()=>new OwnedProcess(adb,['-s',serial,'shell','date','+%s'],root)
      .finish('owned host-device clock observation',2000),checkClockOwner);
    clock=new OwnedNtfyClock(args=>new OwnedProcess(adb,['-s',serial,...args],root)
      .finish('owned controlled clock operation',2000),checkClockOwner);
    await clock.prepare();
    await installed.install('io.heckel.ntfy',join(directory,'distributor.apk'));
    await installed.install('app.lazysh.client',apk);
    await owned.check();
    const transfer=new OwnedProcess(adb,['-s',serial,'shell','run-as','app.lazysh.client','sh','-c',`'${privateInputCommand(nonce)}'`],root);
    children.push(transfer);
    phase='private native fixture transfer';
    await writePrivateInput(input,transfer.child.stdin!,()=>transfer.finish('private native fixture transfer',5000));
    installed.admit('app.lazysh.client.test');
    await run('actual native ntfy instrumentation',join(android,'gradlew'),[':app:connectedUniversalDebugAndroidTest',...gradleArgs,
      '-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true',
      `-Pandroid.testInstrumentationRunnerArguments.class=${fixtureCases.map(name=>`app.lazysh.client.NativeWorkspaceTest#${name}`).join(',')}`,
      '-Pandroid.testInstrumentationRunnerArguments.lazyshNtfyAcceptance=true',
      `-Pandroid.testInstrumentationRunnerArguments.lazyshNtfyNonce=${nonce}`],240_000);
    const native=await receipt(directory);
    await relay.finish('actual relay confirmation and cleanup',10_000);
    if(!relay.stdout.includes('actualServerConfirmed=true oneConfirmation=true'))throw new Error('Owned relay proof missing');
    if(!relay.stdout.includes('boundEventAccepted=true eventReplayPublished=true'))throw new Error('Owned relay event proof missing');
    // Rebuild without the opt-in property: stale generated resources must never
    // survive into an ordinary debug or release artifact.
    const ordinaryArgs=['-p',android,'--no-daemon','-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64'];
    await run('restore ordinary debug trust',join(android,'gradlew'),[':app:assembleUniversalDebug',...ordinaryArgs,'-x',':app:rustBuildX86_64Debug'],120_000);
    await normalArtifact();
    if(await nativeDigest(apk)!==baselineNative)throw new Error('Normal artifact changed its owned native library');
    await run('ordinary release resource assembly',join(android,'gradlew'),[':app:assembleUniversalRelease',...ordinaryArgs,'-x',':app:rustBuildX86_64Release'],120_000);
    await normalArtifact('universalReleaseRuntimeClasspath',join(android,'app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk'));
    const head=(await run('source checkout identity','git',['rev-parse','HEAD'])).trim();
    if(!/^[a-f0-9]{40}$/.test(head))throw invalid();
    const source:Record<string,string>={};
    for(const path of ['apps/notification-service/src/tests/ntfy_android.rs',
      'apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt',
      'apps/client/src-tauri/gen/android/app/build.gradle.kts','tests/support/androidNtfy.ts']){
      source[path]=createHash('sha256').update(await boundedFile(join(root,path),1024*1024)).digest('hex');
    }
    receiptValue={schemaVersion:1,head,source,...native,clockComparison,serverVersion:pins.server.version,
      distributorVersion:pins.android.version,serverArchiveSha256:pins.server.sha256,distributorSha256:pins.android.sha256,
      distributorSignerSha256:pins.android.signerSha256,googleComponentsAbsent:true,actualEncryptedChallenge:true,
      activityBackground:true,authenticatedPause:true,normalDebugAndReleaseTrustAbsent:true,nativeLibraryUnchanged:true,
      releaseRustCompilation:false,notificationDelivery:true,replayCallbackObserved:true,privateGenericNotification:true};
  }catch(error){
    primary=true;
    const code=error instanceof Error?/; exit=([0-9]{1,3})$/.exec(error.message):null;
    failureValue={schemaVersion:1,phase,exit:code?Number(code[1]):null,clockComparison,
      ...await nativeFailure(directory),runtimePassed:false,notificationDelivery:false};
    // Framework/private protocol errors may contain values. Keep only the fixed
    // source stage and finite exit; raw logs remain private until owned cleanup.
    originalFailure=new Error(`Native ntfy acceptance failed at ${phase}${code?`; exit=${code[1]}`:''}`);
  }finally{
    const cleanupFailures:string[]=[];
    for(const child of children.reverse())try{await child.stop();}catch{cleanupFailures.push('child');}
    for(const port of reverses)try{await shell('owned reverse cleanup',['reverse','--remove',`tcp:${port}`]);}catch{cleanupFailures.push('reverse');}
    if((await installed.cleanup()).length)cleanupFailures.push('packages');
    try{await clock?.restore(async()=>{
      if(cleanupFailures.length)throw new Error('Owned ntfy teardown not established');
      await absentNtfyPackages(args=>shell('owned package teardown verification',args));
    });}catch{cleanupFailures.push('clockRestoration');}
    try{await rm(directory,{recursive:true,force:true});}catch{cleanupFailures.push('directory');}
    const failed=originalFailure||cleanupFailures.length>0;
    try{
      await mkdir(finite,{recursive:true});
      await writeFile(join(finite,failed?'failure.json':'receipt.json'),JSON.stringify({
        ...(failed?failureValue??{schemaVersion:1,phase:'owned cleanup',exit:null,runtimePassed:false,notificationDelivery:false}:receiptValue),
        ...(clock?{controlledClock:clock.observation()}:{}),cleanupFailures})+'\n');
    }catch{if(!failed)throw new Error('Finite ntfy receipt could not be retained');console.error('Finite ntfy failure receipt could not be retained');}
    if(cleanupFailures.length){if(primary)console.error('Owned ntfy cleanup failed after original failure');else throw new Error('Owned ntfy cleanup failed');}
  }
  if(originalFailure)throw originalFailure;
}
