import {OwnedProcess, OUTPUT_LIMIT, identity, descendants, type OwnedPid} from './ownedProcess';
export {OwnedProcess, identity, type OwnedPid} from './ownedProcess';
import {chmod, copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {createServer, connect} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import type {HerdrFixture} from './androidHerdr';
import {OwnedCaseCrashParser} from './androidCaseCrash';

async function command(stage:string,program:string,args:string[],cwd?:string) {
  return new OwnedProcess(program,args,cwd).finish(stage,5000);
}
async function availablePort() {
  const listener=createServer();
  await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const port=(listener.address() as {port:number}).port;
  await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  return port;
}
export async function listening(port:number) {
  return new Promise<boolean>(resolve=>{
    const socket=connect({host:'127.0.0.1',port});
    const finish=(connected:boolean)=>{socket.destroy();resolve(connected);};
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
    socket.setTimeout(500,()=>finish(false));
  });
}
async function retireDescendants(parent:OwnedPid) {
  const owned=(await descendants(parent)).reverse();
  const same=async(item:OwnedPid)=>{const current=await identity(item.pid);return current?.start===item.start;};
  for(const signal of ['SIGTERM','SIGKILL'] as const) {
    for(const item of owned)if(await same(item)) {
      try{process.kill(item.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    }
    const deadline=performance.now()+1000;
    while(performance.now()<deadline && (await Promise.all(owned.map(same))).some(Boolean))await Bun.sleep(10);
  }
  if((await Promise.all(owned.map(same))).some(Boolean))throw new Error('Owned SSH descendants survived teardown');
}
export async function stopOwnedTree(daemon:OwnedProcess,label:'SSH'|'Herdr'='SSH') {
  let primary:unknown;
  try {
    const root=await daemon.liveIdentity();
    if(!root)throw new Error(`Owned ${label} root identity unavailable`);
    await retireDescendants(root);
    if((await daemon.liveIdentity())?.start!==root.start)throw new Error(`Owned ${label} root identity lost`);
  } catch(error){primary=error;}
  try{await daemon.stop();}catch(error){primary??=error;}
  if(primary)throw primary;
}
export type HerdrTools={herdrBinary:string;agentBinary:string;receiverBinary:string};
export class SshFixture {
  private stopped=false;
  readonly nonce:string;
  get prompt(){return `UI_PROMPT_${this.nonce}>`;}
  get expected(){return `SSH_${this.nonce}_END`;}
  get challenge(){return `printf 'SSH_%s_END\\n' '${this.nonce}'`;}
  readonly username=userInfo().username;
  private constructor(readonly directory:string,readonly port:number,readonly privateKey:string,readonly fingerprint:string,readonly daemon:OwnedProcess,nonce:string,readonly environment?:NodeJS.ProcessEnv) {this.nonce=nonce;}
  static async start(tools?:HerdrTools) {
    if(process.platform!=='linux')throw new Error('Owned Android SSH host fixture requires Linux');
    const directory=await mkdtemp(join(tools?'/tmp':tmpdir(),tools?'lazysh-h-':'lazysh-android-ssh-'));
    let daemon:OwnedProcess|undefined;
    try {
      await chmod(directory,0o700);
      for(const name of ['host','user'])await command('ephemeral key generation','ssh-keygen',['-q','-t','ed25519','-N','','-f',join(directory,name)]);
      const privateKey=await readFile(join(directory,'user'),'utf8');
      await writeFile(join(directory,'authorized_keys'),await readFile(join(directory,'user.pub')),{mode:0o600});
      const fingerprint=(await command('host fingerprint','ssh-keygen',['-l','-E','sha256','-f',join(directory,'host.pub')])).trim().split(/\s+/)[1];
      if(!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))throw new Error('Invalid owned fingerprint');
      const username=userInfo().username;
      if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username))throw new Error('Unsupported owned SSH username');
      const port=await availablePort();
      const sshd=(await command('locate sshd','sh',['-c','command -v sshd'])).trim();
      if(!sshd.startsWith('/'))throw new Error('Owned sshd unavailable');
      // No untrusted configuration interpolation; generated private paths are plain tokens.
      if(/[\s"\\]/.test(directory))throw new Error('Unsupported owned fixture directory');
      const nonce=randomUUID().replaceAll('-','');
      const prompt=`UI_PROMPT_${nonce}> `;
      let environment:NodeJS.ProcessEnv|undefined;
      if(tools) {
        const bin=join(directory,'bin');await mkdir(bin,{mode:0o700});
        for(const [name,binary] of [['herdr',tools.herdrBinary],['lazysh-agent',tools.agentBinary],['owned-terminal-receiver',tools.receiverBinary]]) {
          if(!isAbsolute(binary) || !(await stat(binary)).isFile())throw new Error('Explicit current owned fixture binary required');
          await copyFile(binary,join(bin,name));await chmod(join(bin,name),0o700);
        }
        environment={HOME:directory,ZDOTDIR:directory,ENV:'/dev/null',BASH_ENV:'/dev/null',PATH:bin+':/usr/bin:/bin',SHELL:'/bin/sh',TERM:'xterm-256color',LANG:'C.UTF-8'};
        for(const [key,child] of [['XDG_CONFIG_HOME','config'],['XDG_CACHE_HOME','cache'],['XDG_STATE_HOME','state'],['XDG_RUNTIME_DIR','runtime'],['TMUX_TMPDIR','tmux']]) {
          const path=join(directory,child);await mkdir(path,{mode:0o700});environment[key]=path;
        }
      }
      const config=join(directory,'sshd_config');
      await writeFile(config,[`ListenAddress 127.0.0.1`,`Port ${port}`,`HostKey ${directory}/host`,
        `AuthorizedKeysFile ${directory}/authorized_keys`,`PidFile ${directory}/sshd.pid`,
        `AllowUsers ${username}`,'PermitUserRC no','PrintMotd no','PrintLastLog no','PasswordAuthentication no','KbdInteractiveAuthentication no','UsePAM no','StrictModes no','LogLevel ERROR',
        environment?`SetEnv ${Object.entries(environment).map(([key,value])=>`${key}=${value}`).join(' ')}`:`SetEnv HOME=${directory} ZDOTDIR=${directory} ENV=${directory}/no-profile BASH_ENV=${directory}/no-profile PATH=/usr/bin:/bin`,
        environment?`ForceCommand cd ${directory} && if test -n "$SSH_ORIGINAL_COMMAND"; then exec /usr/bin/timeout --kill-after=1s 90s /bin/sh -c "$SSH_ORIGINAL_COMMAND"; else exec /usr/bin/timeout --kill-after=1s 90s /usr/bin/env 'PS1=${prompt}' /bin/sh -i; fi`:`ForceCommand cd ${directory} && exec /usr/bin/timeout --kill-after=1s 90s /usr/bin/env 'PS1=${prompt}' /bin/sh -i`,
        `Banner none`,''].join('\n'),{mode:0o600});
      daemon=new OwnedProcess(sshd,['-D','-e','-f',config]);
      if(!await daemon.liveIdentity())throw new Error('Owned SSH root identity unavailable');
      const fixture=new SshFixture(directory,port,privateKey,fingerprint,daemon,nonce,environment);
      const deadline=performance.now()+3000;
      while(!await listening(port)) {
        if(daemon.child.exitCode!==null || performance.now()>=deadline)throw new Error('Owned sshd not ready');
        await Bun.sleep(10);
      }
      return fixture;
    } catch(error) {
      try{if(daemon)await stopOwnedTree(daemon);}catch{console.error('Owned SSH startup cleanup failed');}
      try{await rm(directory,{recursive:true,force:true});}catch{console.error('Owned SSH startup directory cleanup failed');}
      throw error;
    }
  }
  async client(identity=true,remoteCommand?:string) {
    const known=join(this.directory,'known_hosts');
    await writeFile(known,`[127.0.0.1]:${this.port} ${await readFile(join(this.directory,'host.pub'),'utf8')}`,{mode:0o600});
    return new OwnedProcess('ssh',['-F','/dev/null',remoteCommand===undefined?'-tt':'-T','-p',String(this.port),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','IdentityAgent=none',
      '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${known}`,'-o','GlobalKnownHostsFile=/dev/null',
      ...(identity?['-i',join(this.directory,'user')]:['-o','IdentityFile=none']),`${this.username}@127.0.0.1`,...(remoteCommand===undefined?[]:[remoteCommand])]);
  }
  async stop() {
    if(this.stopped)return;
    let primary:unknown;
    try {await stopOwnedTree(this.daemon);if(await listening(this.port))throw new Error('Owned SSH listener survived teardown');}
    catch(error){primary=error;}
    try{await rm(this.directory,{recursive:true,force:true});}catch(error){primary??=error;}
    if(primary)throw primary;
    this.stopped=true;
  }
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

type AndroidCleanupStage='reverse'|'fixture-file'|'Herdr'|'SSH'|'app-package'|'test-package';
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
export async function androidSshAcceptance(root=resolve(import.meta.dir,'../..'),herdr?:HerdrFixture) {
  if(process.platform!=='linux')throw new Error('Owned Android SSH UI acceptance requires Linux');
  const serial=process.env.ANDROID_SERIAL;
  if(!serial || !/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  const adb=process.env.ANDROID_HOME?join(process.env.ANDROID_HOME,'platform-tools/adb'):'adb';
  const fixture=herdr?.ssh??await SshFixture.start();
  const remote=`/data/local/tmp/lazysh-ui-ssh-${fixture.nonce}`;
  let reverse:string|undefined;
  let remoteCreated=false;
  let retainedPackages=false;
  let before:Awaited<ReturnType<typeof emulatorContinuity>>|undefined;
  let hostServerBefore:HostAdbServerSample|undefined;
  let gradle:OwnedProcess|undefined;
  let crashes:ReturnType<typeof captureOwnedCaseCrashes>|undefined;
  const timing:{gradleStartMs:number|null,gradleEndMs:number|null}={gradleStartMs:null,gradleEndMs:null};
  let primary=false;
  const shell=(args:string[])=>command('owned emulator command',adb,['-s',serial,...args]);
  try {
    // The host allowlist key must match the concrete device port removed in cleanup.
    await shell(['reverse','--no-rebind',`tcp:${fixture.port}`,`tcp:${fixture.port}`]);
    reverse=String(fixture.port);
    await shell(['shell','mkdir','-m','700',remote]);remoteCreated=true;
    const data=join(fixture.directory,'android-fixture.json');
    await writeFile(data,JSON.stringify({name:`Android SSH ${fixture.nonce}`,port:Number(reverse),username:fixture.username,
      privateKey:fixture.privateKey,fingerprint:fixture.fingerprint,prompt:fixture.prompt,challenge:fixture.challenge,expected:fixture.expected,nonce:fixture.nonce,...(herdr?{herdr:herdr.metadata()}:{})}),{mode:0o600});
    await shell(['push',data,`${remote}/fixture.json`]);
    await shell(['shell','chmod','600',`${remote}/fixture.json`]);
    try {[before,hostServerBefore]=await Promise.all([emulatorContinuity(adb,serial,reverse,fixture.port),hostAdbServerIdentity(adb)]);} catch {/* Best-effort observation never admits or blocks the acceptance. */}
    try {crashes=captureOwnedCaseCrashes(adb,serial,fixture.nonce);} catch {/* Never change test admission for unavailable diagnostics. */}
    const android=join(root,'apps/client/src-tauri/gen/android');
    timing.gradleStartMs=crashes?.elapsedMs()??null;
    gradle=new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
      herdr?'-PlazyshHerdrAcceptance=true':'-PlazyshSshAcceptance=true',
      ...(herdr?['-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true']:[]),
      '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#'+(herdr?'ownedGuardedHerdrChatThroughRealUi':'ownedOpenSshConnectsThroughRealUi'),
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`],root);
    retainedPackages=!!herdr;
    try {await gradle.finish('actual Android SSH UI instrumentation',600_000);}
    finally {timing.gradleEndMs=crashes?.elapsedMs()??null;}
    await crashes?.stop();
    if(herdr)await herdr.expectBytes(Buffer.from(herdr.draft+'\r\x1b'));
    console.log(herdr?'Owned packaged Herdr Chat: exact receiver bytes and original receiver identity verified':'Owned packaged SSH: native instrumentation completed');
  } catch(error) {
    primary=true;
    try {
      const directory=join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results',herdr?'herdr-ui':'ssh-ui');
      const crash=await crashes?.stop();
      // Sample before an inspection adb command could implicitly restart its server.
      const hostServerAfter=await hostAdbServerIdentity(adb);
      const persistedCrash={scope:'persisted-crash-buffer-sample',...await crashes?.recover()??{state:'ineligible',exceptions:[]}};
      const [exitInfo,continuity,packages]=await Promise.all([packageExitInfo(adb,serial),emulatorContinuity(adb,serial,reverse,fixture.port),retainedPackages?ownedAndroidPackagePresence(adb,serial):Promise.resolve(undefined)]);
      const summary={...exitInfo,...(packages?{packages}:{}),timing,crash:crash??{stream:'unavailable'},persistedCrash,gradle:gradleFailureClasses(gradle?.stdout??'',gradle?.stderr??''),continuity:{before:before??null,after:continuity,comparison:compareEmulatorContinuity(before,continuity)},hostAdbServer:{before:hostServerBefore??null,after:hostServerAfter,comparison:compareHostAdbServer(hostServerBefore,hostServerAfter)}};
      await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'package-exit.json'),JSON.stringify(summary)+'\n',{mode:0o600});
    } catch {console.error('Owned Android SSH exit diagnostics unavailable');}
    throw error;
  } finally {
    await crashes?.stop();
    await androidSshCleanup(primary,[
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
