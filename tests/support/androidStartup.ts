import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,mkdir,readdir,realpath,rm,writeFile,appendFile} from 'node:fs/promises';
import {isAbsolute,join,dirname,relative,resolve} from 'node:path';
import {OwnedProcess,listening} from './androidSsh';
import {attestQrCamera,readQrMetadata,qrOwnershipFailure} from './androidQrOwnership';

const plan=[2,4,4,2] as const;
const limit=1024*1024,windowMs=60_000,avdName='lazysh-runtime-api36';
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const read=async(path:string,bound=64*1024)=>new TextDecoder('utf-8',{fatal:true}).decode(await readQrMetadata(path,bound));
export function cpuCount(text:string){
  if(!/^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$/.test(text.trim()))throw new Error('CPU list unavailable');
  let end=-1,count=0;
  for(const item of text.trim().split(',')){
    const [first,last=first]=item.split('-').map(Number);
    if(first<=end||last<first||last>65535||(count+=last-first+1)>4096)throw new Error('CPU list bound');
    end=last;
  }
  return count;
}
export function quota(text:string){
  const fields=text.trim().split(/\s+/);
  if(fields.length!==2||!/^\d+$/.test(fields[1])||!Number.isSafeInteger(Number(fields[1]))||Number(fields[1])<1)throw new Error('CPU quota unavailable');
  if(fields[0]==='max')return null;
  if(!/^\d+$/.test(fields[0])||!Number.isSafeInteger(Number(fields[0]))||Number(fields[0])<1)throw new Error('CPU quota unavailable');
  const value=Number(fields[0])/Number(fields[1]);
  if(!Number.isFinite(value)||value>65536)throw new Error('CPU quota bound');
  return value;
}
export async function hostBudget(load=read,root='/sys/fs/cgroup'){
  root=resolve(root);
  const status=await load('/proc/self/status'),group=await load('/proc/self/cgroup');
  const affinityText=status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]??'';
  const affinity=cpuCount(affinityText),affinityHash=digest(affinityText.trim());
  const entries=group.trim().split('\n');
  if(entries.length!==1||!entries[0].startsWith('0::/'))throw new Error('Unified CPU hierarchy required');
  const path=entries[0].slice(3);
  if(path.includes('..')||path.includes('\0')||path.includes('\\')||path.length>1024)throw new Error('CPU hierarchy unavailable');
  let current=resolve(root,`.${path}`);const levels=[];
  while(true){
    if(levels.length>=16)throw new Error('CPU hierarchy bound');
    const cpusetText=(await load(join(current,'cpuset.cpus.effective'))).trim(),cpuset=cpuCount(cpusetText),cpusetHash=digest(cpusetText);
    const max=current===root?await load(join(current,'cpu.max')).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return 'max 100000';}):await load(join(current,'cpu.max'));
    const capacity=quota(max),periodUsec=Number(max.trim().split(/\s+/)[1]),quotaUsec=capacity===null?null:Number(max.trim().split(/\s+/)[0]),stats=await load(join(current,'cpu.stat'));
    function number(key:string){const value=stats.match(new RegExp(`^${key} ([0-9]+)$`,'m'))?.[1];return value===undefined?null:Number(value);}
    const usageUsec=number('usage_usec'),periods=number('nr_periods'),throttled=number('nr_throttled'),throttledUsec=number('throttled_usec');
    if(usageUsec===null||[usageUsec,periods,throttled,throttledUsec].some(n=>n!==null&&!Number.isSafeInteger(n)))throw new Error('CPU statistics unavailable');
    if(capacity!==null&&[periods,throttled,throttledUsec].includes(null))throw new Error('CPU throttle statistics unavailable');
    levels.push({cpuset,cpusetHash,capacity,periodUsec,quotaUsec,usageUsec,periods,throttled,throttledUsec});
    if(current===root)break;
    current=dirname(current);
    if(!current.startsWith(root))throw new Error('CPU hierarchy escaped');
  }
  const effective=Math.min(affinity,...levels.flatMap(level=>[level.cpuset,level.capacity??Infinity]));
  return {affinity,affinityHash,effective,levels};
}
export function cpuAllocation(budget:Awaited<ReturnType<typeof hostBudget>>){return {affinity:budget.affinity,affinityHash:budget.affinityHash,levels:budget.levels.map(({cpusetHash,periodUsec,quotaUsec})=>({cpusetHash,periodUsec,quotaUsec}))};}
type Capture={status:'complete'|'overflow'|'unavailable';bytes:number};
export async function capture(program:string,args:string[],path:string,milliseconds=10_000,bound=limit):Promise<Capture>{
  const child=new OwnedProcess(program,args);let bytes=0,overflow=false,stderr=false;const chunks:Buffer[]=[];
  child.child.stdout!.on('data',(data:Buffer)=>{
    bytes+=data.length;
    if(bytes<=bound)chunks.push(Buffer.from(data));
    else if(!overflow){overflow=true;void child.stop().catch(()=>{});}
  });
  child.child.stderr!.on('data',(data:Buffer)=>{stderr=true;bytes+=data.length;if(bytes>bound&&!overflow){overflow=true;void child.stop().catch(()=>{});}});
  let status:Capture['status']='complete';
  try{await child.finish('startup diagnostic capture',milliseconds);}catch{status='unavailable';}
  if(stderr)status='unavailable';if(overflow)status='overflow';
  await writeFile(path,Buffer.concat(chunks),{mode:0o600});
  return {status,bytes:Math.min(bytes,bound+1)};
}
export function startupObservation(events:string,traces:string,complete:boolean){
  if(!complete||[events,traces].some(text=>text.length>limit||text.includes('\0')||text.split('\n').length>8192||text.split('\n').some(line=>line.length>64*1024)))return {anr:'unavailable' as const,gpuPriority:null,bindApplication:null};
  const systemUi=/\bam_anr\s*:\s*\[[^\n]*\bcom\.android\.systemui\b/.test(events);
  const systemUiTrace=traces.split(/^----- pid /m).find(part=>/^Cmd line: com\.android\.systemui$/m.test(part));
  return {anr:systemUi?( /\bam_anr\s*:\s*\[[^\n]*\bcom\.android\.systemui\b[^\n]*failed to complete startup/.test(events)?'startup':'other-systemui'):'not-observed',gpuPriority:systemUiTrace===undefined?null:systemUiTrace.includes('setGpuContextPriority'),bindApplication:systemUiTrace===undefined?null:systemUiTrace.includes('ActivityThread.handleBindApplication')};
}
const observationChecks=['observe-entry','camera-attestation','avd-sealed','avd-proof','avd-seal-match','pid-nomination','process-identity','process-record','result-directory','guest-online','guest-boot','guest-online-validation','guest-boot-validation','guest-boot-freshness','observation-window','events','cpu','lastanr','traces','load','host-budget','host-allocation','final-camera-attestation','classification','observation-result'] as const;
export function startupFailure(checkpoint:unknown,error:unknown){
  const checked=observationChecks.find(value=>value===checkpoint)??'unavailable';
  const cameraCheck=['camera-attestation','final-camera-attestation','guest-online','guest-boot','events','cpu','lastanr','traces','load'].includes(checked)?qrOwnershipFailure(error):undefined;
  return {checkpoint:checked,...(cameraCheck?{cameraCheck}:{})};
}
async function fingerprint(path:string,deadline=performance.now()+60_000){
  const hash=createHash('sha256');let files=0,total=0;
  async function visit(file:string,depth:number){
    if(performance.now()>=deadline)throw new Error('Fingerprint deadline');
    const info=await lstat(file);
    if(depth>8)throw new Error('Fingerprint depth bound');
    if(info.isSymbolicLink()){const target=await realpath(file);if(!target.startsWith(path+'/'))throw new Error('Fingerprint link escaped');}
    if(info.isDirectory()){
      for(const entry of (await readdir(file)).sort())await visit(join(file,entry),depth+1);
    }else{
      if((!info.isFile()&&!info.isSymbolicLink())||++files>2048||(total+=info.size)>16*1024**3)throw new Error('Fingerprint bound');
      if(file!==path)hash.update(JSON.stringify([relative(path,file),info.size]));
      const stream=createReadStream(file),timer=setTimeout(()=>stream.destroy(new Error('Fingerprint deadline')),Math.max(1,Math.min(30_000,deadline-performance.now())));
      try{for await(const chunk of stream)hash.update(chunk);}finally{clearTimeout(timer);stream.destroy();}
    }
  }
  await visit(path,0);return hash.digest('hex');
}
// Android writes spaced assignments; compare exact parsed keys and values.
function iniValues(text:string,key:string){
  if(text.length>64*1024||text.includes('\0'))throw new Error('AVD INI bound');
  const trim=(value:string)=>value.replace(/^[ \t\r]+|[ \t\r]+$/g,'');
  return text.split('\n').flatMap(line=>{const equals=line.indexOf('=');return equals<0||trim(line.slice(0,equals))!==key?[]:[{value:trim(line.slice(equals+1)),spaced:line.slice(0,equals)!==key}];});
}
export function avdConfiguration(text:string,cores:number){
  const keys=['hw.cpu.ncore','hw.ramSize','hw.device.name','image.sysdir.1'];
  const entries=keys.map(key=>iniValues(text,key).at(-1)),values=entries.map(entry=>entry?.value);
  return {coresExpected:values[0]===String(cores),ramEncoding:values[1]===undefined?'missing':values[1]==='3072M'?'suffix-mb':values[1]==='3072'?'integer-mb':'other',deviceExpected:values[2]==='pixel_2',imageExpected:values[3]==='system-images/android-36/default/x86_64/',configEncoding:entries.some(entry=>entry===undefined)?'missing':entries.every(entry=>entry!.spaced)?'spaced':entries.some(entry=>entry!.spaced)?'mixed':'compact'};
}
type State={index:number;host:string;failure?:string;avd?:{directory:string;config:string;index:string};pid?:number;start?:string;fingerprints?:{emulator:string;image:string;camera:string};rows:Record<string,unknown>[]};
async function processIdentity(pid:number){
  try{const text=await read(`/proc/${pid}/stat`,4096);const fields=text.slice(text.lastIndexOf(')')+2).split(/\s+/);if(!/^[0-9]+$/.test(fields[19]??''))throw new Error('Process identity unavailable');return {start:fields[19],retired:['Z','X'].includes(fields[0])};}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
export async function waitForRetirement(pid:number,start:string,budgetMs=10_000){
  if(!Number.isFinite(budgetMs)||budgetMs<1||budgetMs>10_000)throw new Error('Retirement budget invalid');
  const deadline=performance.now()+budgetMs;
  while(true){
    const current=await processIdentity(pid);
    if(current===null)return;
    if(current.start!==start)throw new Error('Recorded process identity changed');
    if(current.retired)return;
    const remaining=deadline-performance.now();
    if(remaining<=0)throw new Error('Recorded process retirement deadline');
    await Bun.sleep(Math.min(50,remaining));
  }
}
export async function runStartup(phase:string,env=process.env,attest=attestQrCamera){
  if(process.platform!=='linux'||env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.RUNNER_OS!=='Linux')throw new Error('Owned hosted Linux VM required');
  const temp=env.RUNNER_TEMP,root=env.GITHUB_WORKSPACE,sdk=env.ANDROID_HOME;
  if(!temp||!root||!sdk||![temp,root,sdk].every(p=>isAbsolute(p)&&!/[\n\r\0]/.test(p)))throw new Error('Owned paths unavailable');
  const base=join(temp,'lazysh-startup-cpu-budget'),results=join(base,'results'),statePath=join(base,'state.json');
  const home=await realpath(env.HOME!);const avd=join(home,'.android/avd',`${avdName}.avd`),ini=join(home,'.android/avd',`${avdName}.ini`);
  const host=digest((await read('/proc/sys/kernel/random/boot_id',64)).trim());
  let state:State;
  if(phase==='prepare'){
    await mkdir(base,{mode:0o700});await mkdir(results,{mode:0o700});state={index:0,host,rows:[]};
  }else state=JSON.parse(await read(statePath));
  async function save(){await writeFile(statePath,JSON.stringify(state),{mode:0o600});}
  async function output(){
    const rows=plan.map((cores,index)=>state.rows[index]??{index,cores,status:'inconclusive',reason:'not-run',anr:'unavailable'});
    await writeFile(join(results,'summary.json'),JSON.stringify({schemaVersion:1,host:state.host,hostUnchanged:host===state.host,windowMs,status:!state.failure&&rows.every(row=>row.status==='complete')?'complete':'inconclusive',reason:state.failure??null,samples:rows},null,2),{mode:0o600});
  }
  async function variables(ready:boolean){if(env.GITHUB_ENV)await appendFile(env.GITHUB_ENV,`STARTUP_READY=${ready}\nSTARTUP_CORES=${plan[state.index]??2}\nLAZYSH_ANDROID_QR_EMULATOR_PID_FILE=${join(base,`emulator-${state.index}.pid`)}\n`);}
  const row=()=>state.rows[state.index]??={index:state.index,cores:plan[state.index],status:'inconclusive',reason:'not-observed',anr:'unavailable'};
  async function absent(path:string){try{await lstat(path);throw new Error('Foreign AVD state exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  async function prepare(){
    await variables(false);await absent(avd);await absent(ini);await absent(join(base,`emulator-${state.index}.pid`));
    if(await listening(5580)||await listening(5581))throw new Error('Foreign emulator endpoint exists');
    const budget=await hostBudget();row().hostBefore=budget;if(budget.effective<4)throw new Error('Four effective host CPUs required');
    await save();await variables(true);
  }
  async function avdProof(){
    let check='directory-stat';
    const observation:Record<string,boolean|string|null>={phase:phase==='seal'?'seal':phase==='observe'?'observe':'retire',directoryInodeStable:null,configInodeStable:null,indexInodeStable:null,coresExpected:null,ramEncoding:'unavailable',deviceExpected:null,imageExpected:null,indexValid:null,configEncoding:'unavailable'};
    if(phase==='observe'||row().avdObservation===undefined)row().avdObservation=observation;
    try{
      const directory=await lstat(avd);check='config-stat';const config=await lstat(join(avd,'config.ini'));
      if(state.avd){observation.directoryInodeStable=String(directory.ino)===state.avd.directory;observation.configInodeStable=String(config.ino)===state.avd.config;}
      check='filesystem-proof';
      if(!directory.isDirectory()||directory.isSymbolicLink()||!config.isFile()||config.isSymbolicLink()||directory.uid!==process.getuid!()||config.uid!==process.getuid!()||await realpath(avd)!==avd)throw new Error('Owned AVD unavailable');
      check='config-read';Object.assign(observation,avdConfiguration(await read(join(avd,'config.ini')),plan[state.index]));
      check='index-stat';const index=await lstat(ini);
      if(state.avd)observation.indexInodeStable=String(index.ino)===state.avd.index;
      check='index-proof';
      if(!index.isFile()||index.isSymbolicLink()||index.uid!==process.getuid!()){observation.indexValid=false;throw new Error('AVD index ownership unavailable');}
      check='index-read';const paths=iniValues(await read(ini,4096),'path');
      observation.indexValid=paths.length===1&&paths[0].value===avd;
      check='config-values';
      if(!observation.coresExpected||observation.ramEncoding!=='suffix-mb'||!observation.deviceExpected||!observation.imageExpected)throw new Error('AVD configuration differs');
      check='index-proof';if(!observation.indexValid)throw new Error('AVD index ownership unavailable');
      return {directory:String(directory.ino),config:String(config.ino),index:String(index.ino)};
    }catch{row().avdFailure??={check};throw new Error('Owned AVD proof unavailable');}
  }
  let primary=false,checkpoint='observe-entry';
  try{
    if(host!==state.host)throw new Error('Host VM changed');
    if(phase==='prepare')await prepare();
    else if(phase==='seal'){
      state.avd=await avdProof();await save();
      const deadline=performance.now()+60_000;
      const emulator=await fingerprint(join(sdk,'emulator'),deadline),image=await fingerprint(join(sdk,'system-images/android-36/default/x86_64'),deadline);
      const camera=await fingerprint(join(root,'apps/client/src-tauri/fixtures/theme-qr-camera-feed.png'),deadline);
      state.fingerprints={emulator,image,camera};row().fingerprints=state.fingerprints;
      const first=state.rows[0]?.fingerprints;
      if(first&&JSON.stringify(first)!==JSON.stringify(state.fingerprints))throw new Error('Fingerprint drift');
      const budget=await hostBudget();row().hostAtLaunch=budget;
      const allocation=cpuAllocation(budget);
      if(budget.effective<4||(state.rows[0].allocation&&JSON.stringify(state.rows[0].allocation)!==JSON.stringify(allocation)))throw new Error('Host allocation drift');
      row().allocation=allocation;row().sealed=true;await save();
    }else if(phase==='observe'){
      row().observeEntered=true;await save();
      checkpoint='camera-attestation';const ownership=await attest(env,root);await ownership.check();
      checkpoint='avd-sealed';if(!row().sealed)throw new Error('Unsealed AVD');
      checkpoint='avd-proof';const proof=await avdProof();
      checkpoint='avd-seal-match';
      if(row().postBootConfigAdmitted||!state.avd||proof.directory!==state.avd.directory||proof.index!==state.avd.index)throw new Error('Unsealed AVD');
      // The SDK atomically rewrites config.ini at first boot. Record it only here,
      // after attestation and complete field/ownership proof; retirement stays exact.
      state.avd=proof;row().postBootConfigAdmitted=true;
      checkpoint='pid-nomination';state.pid=Number((await read(env.LAZYSH_ANDROID_QR_EMULATOR_PID_FILE!,32)).trim());
      checkpoint='process-identity';const identity=await processIdentity(state.pid);state.start=identity&&!identity.retired?identity.start:undefined;
      checkpoint='process-record';await save();
      checkpoint='process-identity';if(!state.start)throw new Error('Owned process unavailable');
      checkpoint='result-directory';const directory=join(results,String(state.index));await mkdir(directory,{mode:0o700});
      const adb=join(sdk,'platform-tools/adb'),started=performance.now();
      const get=async(name:string,args:string[],retain=true)=>{
        checkpoint=name;await ownership.check();const path=join(retain?directory:base,`${name}.txt`);
        try{
          const result=await capture(adb,['-s','emulator-5580',...args],path);
          const key=name==='guest-online'?'online':name==='guest-boot'?'boot':name;
          const retained=(row().captures??={}) as Record<string,Capture>;retained[key]={status:result.status,bytes:result.bytes};
          return {...result,text:result.status==='complete'?await read(path,limit):''};
        }
        finally{if(!retain)await rm(path,{force:true});}
      };
      const online=await get('guest-online',['shell','cat','/sys/devices/system/cpu/online'],false);
      const boot=await get('guest-boot',['shell','cat','/proc/sys/kernel/random/boot_id'],false);
      checkpoint='guest-online-validation';if(online.status!=='complete'||cpuCount(online.text)!==plan[state.index])throw new Error('Guest identity unavailable');
      checkpoint='guest-boot-validation';if(boot.status!=='complete'||! /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s*$/.test(boot.text))throw new Error('Guest identity unavailable');
      checkpoint='guest-boot-freshness';const bootHash=digest(boot.text.trim());if(state.rows.some(other=>other.boot===bootHash))throw new Error('Guest boot reused');row().boot=bootHash;row().guestCores=cpuCount(online.text);
      checkpoint='observation-window';await Bun.sleep(Math.max(0,windowMs-(performance.now()-started)));
      const specs:[string,string[]][]=[['events',['logcat','-d','-b','main','-b','system','-b','events','-v','threadtime','ActivityManager:E','am_anr:I','*:S']],['cpu',['shell','dumpsys','cpuinfo']],['lastanr',['shell','dumpsys','activity','lastanr']],['traces',['shell','dumpsys','activity','lastanr-traces']],['load',['shell','date -u; cat /proc/uptime /proc/loadavg']]];
      const captures:Record<string,Awaited<ReturnType<typeof get>>>={online,boot};
      for(const [name,args] of specs)captures[name]=await get(name,args);
      row().captures=Object.fromEntries(Object.entries(captures).map(([name,{status,bytes}])=>[name,{status,bytes}]));
      checkpoint='host-budget';row().hostAfter=await hostBudget();checkpoint='host-allocation';if(JSON.stringify(cpuAllocation(row().hostAfter as Awaited<ReturnType<typeof hostBudget>>))!==JSON.stringify(row().allocation))throw new Error('Host budget changed');
      checkpoint='final-camera-attestation';await ownership.check();
      checkpoint='classification';const complete=Object.values(captures).every(value=>value.status==='complete');
      const observation=startupObservation(captures.events.text,captures.traces.text,complete);
      Object.assign(row(),observation);
      if(!complete||observation.anr==='unavailable')throw new Error('Capture incomplete');
      checkpoint='observation-result';row().reason='awaiting-retirement';await save();
    }else if(phase==='retire'){
      await variables(false);
      row().actionOutcome=['success','failure','cancelled'].includes(env.STARTUP_ACTION_OUTCOME??'')?env.STARTUP_ACTION_OUTCOME:'unavailable';
      if(!state.pid||!state.start)throw new Error('Boot ownership unavailable');
      await waitForRetirement(state.pid,state.start);
      if(JSON.stringify(await avdProof())!==JSON.stringify(state.avd))throw new Error('AVD ownership changed');
      await rm(avd,{recursive:true});await rm(ini);row().cleanup='complete';
      if(row().reason!=='awaiting-retirement')throw new Error('Incomplete sample');
      if(row().actionOutcome!=='success'){row().reason='action-unavailable';throw new Error('Action failed');}
      row().status='complete';row().reason='observed-and-retired';
      state.index++;delete state.pid;delete state.start;delete state.avd;delete state.fingerprints;
      if(state.index<plan.length)await prepare();
    }else if(phase!=='summarize')throw new Error('Unknown diagnostic phase');
  }catch(error){
    if(phase==='observe')row().observationFailure??=startupFailure(checkpoint,error);
    primary=true;state.failure??=`${phase}-unavailable`;row().status='inconclusive';
    if(phase==='retire'){row().cleanup??='unavailable';if(row().reason==='not-observed')row().reason='boot-or-action-failure';else if(row().reason==='awaiting-retirement')row().reason='retirement-unavailable';}
    else if(row().reason==='not-observed'||row().reason==='awaiting-retirement')row().reason=`${phase}-unavailable`;
    row().anr='unavailable';await variables(false).catch(()=>{});throw new Error('Startup diagnostic inconclusive');
  }finally{
    try{await save();await output();}catch{if(!primary)throw new Error('Startup result unavailable');console.error('Startup result unavailable after original diagnostic failure');}
  }
}
if(import.meta.main)runStartup(process.argv[2]).catch(()=>{console.error('Startup diagnostic inconclusive; inspect bounded artifact metadata');process.exitCode=1;});
