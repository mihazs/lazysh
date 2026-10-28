import {OwnedProcess, identity, descendants, type OwnedPid} from './ownedProcess';
export {OwnedProcess} from './ownedProcess';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer, connect} from 'node:net';
import {randomUUID} from 'node:crypto';

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
async function stopSshd(daemon:OwnedProcess) {
  let primary:unknown;
  try {
    const root=await daemon.liveIdentity();
    if(!root)throw new Error('Owned SSH root identity unavailable');
    await retireDescendants(root);
    if((await daemon.liveIdentity())?.start!==root.start)throw new Error('Owned SSH root identity lost');
  } catch(error){primary=error;}
  try{await daemon.stop();}catch(error){primary??=error;}
  if(primary)throw primary;
}
export class SshFixture {
  private stopped=false;
  readonly nonce:string;
  get prompt(){return `UI_PROMPT_${this.nonce}>`;}
  get expected(){return `SSH_${this.nonce}_END`;}
  get challenge(){return `printf 'SSH_%s_END\\n' '${this.nonce}'`;}
  readonly username=userInfo().username;
  private constructor(readonly directory:string,readonly port:number,readonly privateKey:string,readonly fingerprint:string,readonly daemon:OwnedProcess,nonce:string) {this.nonce=nonce;}
  static async start() {
    if(process.platform!=='linux')throw new Error('Owned Android SSH host fixture requires Linux');
    const directory=await mkdtemp(join(tmpdir(),'lazysh-android-ssh-'));
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
      const config=join(directory,'sshd_config');
      await writeFile(config,[`ListenAddress 127.0.0.1`,`Port ${port}`,`HostKey ${directory}/host`,
        `AuthorizedKeysFile ${directory}/authorized_keys`,`PidFile ${directory}/sshd.pid`,
        `AllowUsers ${username}`,'PermitUserRC no','PrintMotd no','PrintLastLog no','PasswordAuthentication no','KbdInteractiveAuthentication no','UsePAM no','StrictModes no','LogLevel ERROR',
        `SetEnv HOME=${directory} ZDOTDIR=${directory} ENV=${directory}/no-profile BASH_ENV=${directory}/no-profile PATH=/usr/bin:/bin`,
        `ForceCommand cd ${directory} && exec /usr/bin/timeout --kill-after=1s 90s /usr/bin/env 'PS1=${prompt}' /bin/sh -i`,
        `Banner none`,''].join('\n'),{mode:0o600});
      daemon=new OwnedProcess(sshd,['-D','-e','-f',config]);
      if(!await daemon.liveIdentity())throw new Error('Owned SSH root identity unavailable');
      const fixture=new SshFixture(directory,port,privateKey,fingerprint,daemon,nonce);
      const deadline=performance.now()+3000;
      while(!await listening(port)) {
        if(daemon.child.exitCode!==null || performance.now()>=deadline)throw new Error('Owned sshd not ready');
        await Bun.sleep(10);
      }
      return fixture;
    } catch(error) {
      try{if(daemon)await stopSshd(daemon);}catch{console.error('Owned SSH startup cleanup failed');}
      try{await rm(directory,{recursive:true,force:true});}catch{console.error('Owned SSH startup directory cleanup failed');}
      throw error;
    }
  }
  async client(identity=true) {
    const known=join(this.directory,'known_hosts');
    await writeFile(known,`[127.0.0.1]:${this.port} ${await readFile(join(this.directory,'host.pub'),'utf8')}`,{mode:0o600});
    return new OwnedProcess('ssh',['-F','/dev/null','-tt','-p',String(this.port),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','IdentityAgent=none',
      '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${known}`,'-o','GlobalKnownHostsFile=/dev/null',
      ...(identity?['-i',join(this.directory,'user')]:['-o','IdentityFile=none']),`${this.username}@127.0.0.1`]);
  }
  async stop() {
    if(this.stopped)return;
    let primary:unknown;
    try {await stopSshd(this.daemon);if(await listening(this.port))throw new Error('Owned SSH listener survived teardown');}
    catch(error){primary=error;}
    try{await rm(this.directory,{recursive:true,force:true});}catch(error){primary??=error;}
    if(primary)throw primary;
    this.stopped=true;
  }
}
export async function androidSshAcceptance(root=resolve(import.meta.dir,'../..')) {
  if(process.platform!=='linux')throw new Error('Owned Android SSH UI acceptance requires Linux');
  const serial=process.env.ANDROID_SERIAL;
  if(!serial || !/^emulator-[0-9]{4,5}$/.test(serial))throw new Error('Use an explicitly selected owned emulator');
  const adb=process.env.ANDROID_HOME?join(process.env.ANDROID_HOME,'platform-tools/adb'):'adb';
  const fixture=await SshFixture.start();
  const remote=`/data/local/tmp/lazysh-ui-ssh-${fixture.nonce}`;
  let reverse:string|undefined;
  let remoteCreated=false;
  let primary=false;
  const shell=(args:string[])=>command('owned emulator command',adb,['-s',serial,...args]);
  try {
    const allocated=(await shell(['reverse','--no-rebind','tcp:0',`tcp:${fixture.port}`])).trim();
    if(!/^[0-9]{1,5}$/.test(allocated)||Number(allocated)<1||Number(allocated)>65535)throw new Error('Invalid owned reverse port');
    reverse=allocated;
    await shell(['shell','mkdir','-m','700',remote]);remoteCreated=true;
    const data=join(fixture.directory,'android-fixture.json');
    await writeFile(data,JSON.stringify({name:`Android SSH ${fixture.nonce}`,port:Number(reverse),username:fixture.username,
      privateKey:fixture.privateKey,fingerprint:fixture.fingerprint,prompt:fixture.prompt,challenge:fixture.challenge,expected:fixture.expected,nonce:fixture.nonce}),{mode:0o600});
    await shell(['push',data,`${remote}/fixture.json`]);
    await shell(['shell','chmod','600',`${remote}/fixture.json`]);
    const android=join(root,'apps/client/src-tauri/gen/android');
    const gradle=new OwnedProcess(join(android,'gradlew'),['-p',android,':app:connectedUniversalDebugAndroidTest','--no-daemon',
      '-PabiList=x86_64','-ParchList=x86_64','-PtargetList=x86_64','-x',':app:rustBuildX86_64Debug',
      '-PlazyshSshAcceptance=true',
      '-Pandroid.testInstrumentationRunnerArguments.class=app.lazysh.client.NativeWorkspaceTest#ownedOpenSshConnectsThroughRealUi',
      `-Pandroid.testInstrumentationRunnerArguments.lazyshSshFixture=${remote}/fixture.json`],root);
    await gradle.finish('actual Android SSH UI instrumentation',600_000);
  } catch(error) {primary=true;throw error;} finally {
    const failures:unknown[]=[];
    for(const cleanup of [
      ()=>reverse?shell(['reverse','--remove',`tcp:${reverse}`]):Promise.resolve(),
      ()=>remoteCreated?shell(['shell','rm','-rf','--',remote]):Promise.resolve(),
      ()=>fixture.stop(),
    ])try{await cleanup();}catch(error){failures.push(error);}
    if(failures.length){if(primary)console.error('Owned Android SSH cleanup failed after original failure');else throw new Error('Owned Android SSH cleanup failed');}
  }
}
