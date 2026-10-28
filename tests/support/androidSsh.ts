import {spawn, type ChildProcess} from 'node:child_process';
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {createServer, connect} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import type {HerdrFixture} from './androidHerdr';
import {OwnedCaseCrashParser} from './androidCaseCrash';

const OUTPUT_LIMIT=16*1024;
// shortcut: foreground fixture tools only. A background child can outlive a reaped
// leader; never signal a recycled PGID or claim that orphan was cleaned. Add a real
// supervisor/OS ownership facility before using this helper for daemonizing tools.
export class OwnedProcess {
  readonly child:ChildProcess;
  readonly done:Promise<number>;
  private readonly original:Promise<OwnedPid|undefined>;
  stdout=''; stderr='';
  constructor(program:string,args:string[],cwd?:string,env=process.env,captureOutput=true) {
    this.child=spawn(program,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    this.original=(this.child.pid?identity(this.child.pid):Promise.resolve(undefined)).catch(()=>undefined);
    this.child.stdout!.on('data',data=>{if(captureOutput)this.stdout=(this.stdout+String(data)).slice(-OUTPUT_LIMIT);});
    this.child.stderr!.on('data',data=>{if(captureOutput)this.stderr=(this.stderr+String(data)).slice(-OUTPUT_LIMIT);});
    this.done=new Promise((resolve,reject)=>{
      this.child.once('error',()=>reject(new Error('Owned fixture process could not start')));
      this.child.once('close',code=>resolve(code??1));
    });
  }
  async liveIdentity() {
    const original=await this.original;
    if(!original || this.child.exitCode!==null || this.child.signalCode!==null)return;
    const current=await identity(original.pid);
    if(this.child.exitCode===null && this.child.signalCode===null && current?.start===original.start && current.parent===process.pid && !['Z','X'].includes(current.state))return original;
  }
  async stop() {
    const original=await this.liveIdentity();
    const pid=original?.pid;
    let force:ReturnType<typeof setTimeout>|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {
      if(original && pid && this.child.exitCode===null && this.child.signalCode===null) {
        try {process.kill(-pid,'SIGTERM');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
        force=setTimeout(()=>{void this.liveIdentity().then(current=>{if(current?.start===original.start)try{process.kill(-pid,'SIGKILL');}catch{}}).catch(()=>{});},1000);
      }
      await Promise.race([this.done,new Promise<never>((_,reject)=>{
        deadline=setTimeout(()=>reject(new Error('Owned fixture process teardown deadline')),2000);
      })]);
    } finally {
      if(force)clearTimeout(force);if(deadline)clearTimeout(deadline);
      this.child.stdin?.destroy();this.child.stdout?.destroy();this.child.stderr?.destroy();
    }
  }
  async finish(stage:string,milliseconds:number) {
    let timer:ReturnType<typeof setTimeout>|undefined;
    let primary=false;
    try {
      const code=await Promise.race([this.done,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(`Owned fixture deadline: ${stage}`)),milliseconds);
      })]);
      if(code!==0)throw new Error(`Owned fixture failed: ${stage}; exit=${code}`);
      return this.stdout;
    } catch(error) {primary=true;throw error;}
    finally {
      if(timer)clearTimeout(timer);
      try{await this.stop();}catch(error){if(!primary)throw error;console.error('Owned fixture cleanup failed after original failure');}
    }
  }
}
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
export type OwnedPid={pid:number,parent:number,start:string,state:string};
export async function identity(pid:number):Promise<OwnedPid|undefined> {
  try {
    const text=await readFile(`/proc/${pid}/stat`,'utf8');
    const fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
    return {pid,parent:Number(fields[1]),start:fields[19],state:fields[0]};
  } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
async function sameIdentity(saved:OwnedPid) {
  const current=await identity(saved.pid);
  return current?.start===saved.start && current.parent===saved.parent && !['Z','X'].includes(current.state);
}
async function descendants(parent:OwnedPid,seen:OwnedPid[]=[]):Promise<OwnedPid[]> {
  if(!await sameIdentity(parent))return seen;
  let children:string;
  try {children=await readFile(`/proc/${parent.pid}/task/${parent.pid}/children`,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return seen;throw error;}
  if(children.length>4096)throw new Error('Owned SSH descendant bound exceeded');
  for(const value of children.trim().split(/\s+/).filter(Boolean)) {
    if(!await sameIdentity(parent))return seen;
    const child=await identity(Number(value));
    if(!child || child.parent!==parent.pid || !await sameIdentity(parent))continue;
    if(seen.length>=64)throw new Error('Owned SSH descendant count exceeded');
    seen.push(child);await descendants(child,seen);
  }
  return seen;
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

// Only observations of the explicitly selected emulator; no raw command output is retained.
export async function emulatorContinuity(adb:string,serial:string,reverse:string|undefined,targetPort:number) {
  const summary:{connection:string;process:string;mainPids:number[];reverse:string;transport:string;transportHash:string|null;boot:string;bootHash:string|null}={connection:'unavailable',process:'unavailable',mainPids:[],reverse:reverse?'unavailable':'not-created',transport:'unavailable',transportHash:null,boot:'unavailable',bootHash:null};
  await Promise.all((['connection','process','reverse','transport','boot'] as const).map(async kind=>{
    if(kind==='reverse' && !reverse)return;
    const args=kind==='connection'?['get-state']:kind==='process'?['shell','pidof','app.lazysh.client']:kind==='transport'?['transport-id']:kind==='boot'?['shell','cat','/proc/sys/kernel/random/boot_id']:['reverse','--list'];
    const owned=new OwnedProcess(adb,['-s',serial,...args],undefined,process.env,false);
    let output='',overflow=false;
    owned.child.stdout!.on('data',(data:Buffer)=>{
      if(Buffer.byteLength(output)+data.length>4096){overflow=true;output='';return;}
      if(!overflow)output+=String(data);
    });
    try {
      await owned.finish('owned emulator continuity',1000);
      if(overflow){summary[kind]='overflow';return;}
      if(kind==='transport' || kind==='boot') {
        const value=output.trim();
        const valid=kind==='transport'?/^[1-9][0-9]{0,19}$/.test(value) && BigInt(value)<=18446744073709551615n:/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
        summary[kind]=valid?'available':'unrecognized';
        if(valid)summary[kind==='boot'?'bootHash':'transportHash']=createHash('sha256').update(value.toLowerCase()).digest('hex');
      }
      if(kind==='connection')summary.connection=['device','offline','unknown'].includes(output.trim())?output.trim():'unrecognized';
      if(kind==='process') {
        const tokens=output.trim().split(/\s+/);
        if(tokens.length<=16 && tokens.every(pid=>/^[1-9][0-9]{0,9}$/.test(pid))) {summary.mainPids=tokens.map(Number);summary.process='present';}
        else summary.process='unrecognized';
      }
      // The selected transport scopes this query; Android16 emits host-N/(reverse) display labels.
      if(kind==='reverse')summary.reverse=output.split(/\r?\n/).some(row=>{
        const fields=row.trim().split(/\s+/);
        return fields.length===3 && fields[1]===`tcp:${reverse}` && fields[2]===`tcp:${targetPort}`;
      })?'present':'missing';
    } catch {summary[kind]='unavailable';}
  }));
  return summary;
}

// Equality brackets two samples only; ADB can reuse transport IDs after a restart.
export function compareEmulatorContinuity(before:Awaited<ReturnType<typeof emulatorContinuity>>|undefined,after:Awaited<ReturnType<typeof emulatorContinuity>>) {
  const compare=(kind:'transport'|'boot')=>{
    const key=kind==='boot'?'bootHash':'transportHash';
    return before?.[kind]==='available' && after[kind]==='available' && before[key] && after[key]?(before[key]===after[key]?'same':'changed'):'unknown';
  };
  return {transport:compare('transport'),boot:compare('boot'),reverseLost:before && ['present','missing'].includes(before.reverse) && ['present','missing'].includes(after.reverse)?before.reverse==='present' && after.reverse==='missing':null};
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

type AndroidCleanupStage='reverse'|'fixture-file'|'Herdr'|'SSH';
export async function androidSshCleanup(primary:boolean,steps:readonly (readonly [AndroidCleanupStage,()=>Promise<unknown>])[]) {
  let failed=false;
  for(const [stage,cleanup] of steps)try{await cleanup();}catch{failed=true;console.error(`Owned Android SSH cleanup stage failed: ${stage}`);}
  if(failed){if(primary)console.error('Owned Android SSH cleanup failed after original failure');else throw new Error('Owned Android SSH cleanup failed');}
}

// No raw crash output enters OwnedProcess's retained output windows. This is a
// best-effort diagnostic child on the explicitly selected owned emulator only.
export function captureOwnedCaseCrashes(adb:string,serial:string,nonce:string) {
  const parser=new OwnedCaseCrashParser(nonce);
  const child=new OwnedProcess(adb,['-s',serial,'logcat','-b','main','-b','crash','-v','threadtime','-T','1',
    'LazyshOwnedCase:I','AndroidRuntime:E','DEBUG:F','*:S'],undefined,process.env,false);
  let stream:'running'|'stopped'|'closed'|'unavailable'|'overflow'|'deadline'='running';
  let stopping=false;
  const close:{phase:'unobserved'|'before-stop'|'during-stop',exitCode:number|null,signal:'none'|'SIGTERM'|'SIGKILL'|'SIGPIPE'|'SIGABRT'|'SIGSEGV'|'other',processError:boolean,stopFailed:boolean}={phase:'unobserved',exitCode:null,signal:'none',processError:false,stopFailed:false};
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
    close.exitCode=code!==null && Number.isInteger(code) && code>=0 && code<=255?code:null;
    close.signal=signal==null?'none':(['SIGTERM','SIGKILL','SIGPIPE','SIGABRT','SIGSEGV'] as const).find(value=>value===signal)??'other';
    parser.finish();
  });
  void child.done.then(code=>{if(!stopping)stream=code===0?'closed':'unavailable';},()=>{stream='unavailable';});
  timer=setTimeout(()=>{stream='deadline';void stop();},600_000);
  return {stop,snapshot};
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
  let before:Awaited<ReturnType<typeof emulatorContinuity>>|undefined;
  let gradle:OwnedProcess|undefined;
  let crashes:ReturnType<typeof captureOwnedCaseCrashes>|undefined;
  let primary=false;
  const shell=(args:string[])=>command('owned emulator command',adb,['-s',serial,...args]);
  try {
    const allocated=(await shell(['reverse','--no-rebind','tcp:0',`tcp:${fixture.port}`])).trim();
    if(!/^[0-9]{1,5}$/.test(allocated)||Number(allocated)<1||Number(allocated)>65535)throw new Error('Invalid owned reverse port');
    reverse=allocated;
    await shell(['shell','mkdir','-m','700',remote]);remoteCreated=true;
    const data=join(fixture.directory,'android-fixture.json');
    await writeFile(data,JSON.stringify({name:`Android SSH ${fixture.nonce}`,port:Number(reverse),username:fixture.username,
      privateKey:fixture.privateKey,fingerprint:fixture.fingerprint,prompt:fixture.prompt,challenge:fixture.challenge,expected:fixture.expected,nonce:fixture.nonce,...(herdr?{herdr:herdr.metadata()}:{})}),{mode:0o600});
    await shell(['push',data,`${remote}/fixture.json`]);
    await shell(['shell','chmod','600',`${remote}/fixture.json`]);
    try {before=await emulatorContinuity(adb,serial,reverse,fixture.port);} catch {/* Best-effort observation never admits or blocks the acceptance. */}
    try {crashes=captureOwnedCaseCrashes(adb,serial,fixture.nonce);} catch {/* Never change test admission for unavailable diagnostics. */}
    const android=join(root,'apps/client/src-tauri/gen/android');
    gradle=new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
      herdr?'-PlazyshHerdrAcceptance=true':'-PlazyshSshAcceptance=true',
      '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#'+(herdr?'ownedGuardedHerdrChatThroughRealUi':'ownedOpenSshConnectsThroughRealUi'),
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`],root);
    await gradle.finish('actual Android SSH UI instrumentation',600_000);
    await crashes?.stop();
    if(herdr)await herdr.expectBytes(Buffer.from(herdr.draft+'\r\x1b'));
    console.log(herdr?'Owned packaged Herdr Chat: exact receiver bytes and original receiver identity verified':'Owned packaged SSH: native instrumentation completed');
  } catch(error) {
    primary=true;
    try {
      const directory=join(root,'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results',herdr?'herdr-ui':'ssh-ui');
      const crash=await crashes?.stop();
      const [exitInfo,continuity]=await Promise.all([packageExitInfo(adb,serial),emulatorContinuity(adb,serial,reverse,fixture.port)]);
      const summary={...exitInfo,crash:crash??{stream:'unavailable'},gradle:gradleFailureClasses(gradle?.stdout??'',gradle?.stderr??''),continuity:{before:before??null,after:continuity,comparison:compareEmulatorContinuity(before,continuity)}};
      await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'package-exit.json'),JSON.stringify(summary)+'\n',{mode:0o600});
    } catch {console.error('Owned Android SSH exit diagnostics unavailable');}
    throw error;
  } finally {
    await crashes?.stop();
    await androidSshCleanup(primary,[
      ['reverse',()=>reverse?shell(['reverse','--remove',`tcp:${reverse}`]):Promise.resolve()],
      ['fixture-file',()=>remoteCreated?shell(['shell','rm','-rf','--',remote]):Promise.resolve()],
      [herdr?'Herdr':'SSH',()=>herdr?herdr.stop():fixture.stop()],
    ]);
  }
}
