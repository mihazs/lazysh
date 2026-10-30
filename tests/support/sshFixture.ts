import {OwnedProcess, identity, descendants, type OwnedPid} from './ownedProcess';
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir, userInfo} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {createServer, connect} from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export async function sshCommand(stage:string,program:string,args:string[],cwd?:string) {
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
    while(performance.now()<deadline && (await Promise.all(owned.map(same))).some(Boolean))await delay(10);
  }
  if((await Promise.all(owned.map(same))).some(Boolean))throw new Error('Owned SSH descendants survived teardown');
}
export async function stopOwnedTree(daemon:OwnedProcess,label:'SSH'|'Herdr'='SSH',cleanSupervisorExit=false) {
  let primary:unknown;
  try {
    const root=await daemon.liveIdentity();
    if(!root)throw new Error(`Owned ${label} root identity unavailable`);
    await retireDescendants(root);
    // The explicit mount supervisor exits cleanly when its owned sshd child is
    // retired. A root missing before retirement still fails the check above.
    if((await daemon.liveIdentity())?.start!==root.start && !(cleanSupervisorExit && daemon.child.exitCode===0))throw new Error(`Owned ${label} root identity lost`);
  } catch(error){primary=error;}
  try{await daemon.stop();}catch(error){primary??=error;}
  if(primary)throw primary;
}
export type HerdrTools={herdrBinary:string;agentBinary:string;receiverBinary:string};
// Two actual native installation budgets, plus explicit SSH/UI setup and teardown.
export const companionFixtureBudget=2*240_000+120_000;
export class SshFixture {
  private stopped=false;
  readonly nonce:string;
  get prompt(){return `UI_PROMPT_${this.nonce}>`;}
  get expected(){return `SSH_${this.nonce}_END`;}
  get challenge(){return `printf 'SSH_%s_END\\n' '${this.nonce}'`;}
  readonly username=userInfo().username;
  private constructor(readonly directory:string,readonly port:number,readonly privateKey:string,readonly fingerprint:string,readonly daemon:OwnedProcess,nonce:string,readonly environment?:NodeJS.ProcessEnv,private readonly privateTtyGroup=false) {this.nonce=nonce;}
  static async start(tools?:HerdrTools,options:{privateTtyGroup?:boolean;companion?:boolean}={}) {
    if(process.platform!=='linux')throw new Error('Owned SSH host fixture requires Linux');
    if(tools && options.companion)throw new Error('Companion installation requires a fixture without preinstalled tools');
    const directory=await mkdtemp(join(tools||options.companion?'/tmp':tmpdir(),tools?'lazysh-h-':'lazysh-android-ssh-'));
    let daemon:OwnedProcess|undefined;
    try {
      await chmod(directory,0o700);
      for(const name of ['host','user'])await sshCommand('ephemeral key generation','ssh-keygen',['-q','-t','ed25519','-N','','-f',join(directory,name)]);
      const privateKey=await readFile(join(directory,'user'),'utf8');
      await writeFile(join(directory,'authorized_keys'),await readFile(join(directory,'user.pub')),{mode:0o600});
      const fingerprint=(await sshCommand('host fingerprint','ssh-keygen',['-l','-E','sha256','-f',join(directory,'host.pub')])).trim().split(/\s+/)[1];
      if(!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))throw new Error('Invalid owned fingerprint');
      const username=userInfo().username;
      if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username))throw new Error('Unsupported owned SSH username');
      const port=await availablePort();
      const sshd=(await sshCommand('locate sshd','sh',['-c','command -v sshd'])).trim();
      if(!sshd.startsWith('/'))throw new Error('Owned sshd unavailable');
      // No untrusted configuration interpolation; generated private paths are plain tokens.
      if(/[\s"\\]/.test(directory))throw new Error('Unsupported owned fixture directory');
      const nonce=randomUUID().replaceAll('-','');
      const prompt=`UI_PROMPT_${nonce}> `;
      let environment:NodeJS.ProcessEnv|undefined;
      let subsystem:string|undefined;
      if(options.companion) {
        for(const candidate of ['/usr/lib/openssh/sftp-server','/usr/lib/ssh/sftp-server']) {
          if(await stat(candidate).then(value=>value.isFile()).catch(()=>false)){subsystem=candidate;break;}
        }
        if(!subsystem)throw new Error('Owned companion fixture requires installed OpenSSH SFTP server');
        environment={HOME:directory,ZDOTDIR:directory,ENV:'/dev/null',BASH_ENV:'/dev/null',PATH:'/usr/bin:/bin',SHELL:'/bin/sh',TERM:'xterm-256color',LANG:'C.UTF-8'};
        for(const [key,child] of [['XDG_CONFIG_HOME','config'],['XDG_DATA_HOME','data'],['XDG_CACHE_HOME','cache'],['LAZYSH_STATE_DIR','state'],['XDG_RUNTIME_DIR','runtime']]) {
          const path=join(directory,child);await mkdir(path,{mode:0o700});environment[key]=path;
        }
      }
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
        ...(subsystem?[`Subsystem sftp ${subsystem}`,`ForceCommand cd ${directory} && if test "$SSH_ORIGINAL_COMMAND" = '${subsystem}'; then exec /usr/bin/timeout --kill-after=1s ${companionFixtureBudget/1000}s ${subsystem} -d ${directory}; elif test -n "$SSH_ORIGINAL_COMMAND"; then exec /usr/bin/timeout --kill-after=1s ${companionFixtureBudget/1000}s /bin/sh -c "$SSH_ORIGINAL_COMMAND"; else exec /usr/bin/timeout --kill-after=1s ${companionFixtureBudget/1000}s /usr/bin/env 'PS1=${prompt}' /bin/sh -i; fi`]:[
        environment?`ForceCommand cd ${directory} && if test -n "$SSH_ORIGINAL_COMMAND"; then exec /usr/bin/timeout --kill-after=1s 90s /bin/sh -c "$SSH_ORIGINAL_COMMAND"; else exec /usr/bin/timeout --kill-after=1s 90s /usr/bin/env 'PS1=${prompt}' /bin/sh -i; fi`:`ForceCommand cd ${directory} && exec /usr/bin/timeout --kill-after=1s 90s /usr/bin/env 'PS1=${prompt}' /bin/sh -i`]),
        `Banner none`,''].join('\n'),{mode:0o600});
      const arguments_=['-D','-e','-f',config];
      if(options.privateTtyGroup) {
        // An unprivileged user namespace maps only our primary group. OpenSSH
        // otherwise chowns its PTY to the host's unmapped tty group and rejects it.
        // Change only this daemon's read-only NSS view; never the host group file.
        const groupSource='/etc/group';
        if((await stat(groupSource)).size>65_536)throw new Error('Owned namespace group file exceeds its bound');
        const groups=(await readFile(groupSource,'utf8')).split('\n');
        const tty=groups.map((row,index)=>row.startsWith('tty:')?index:-1).filter(index=>index>=0);
        if(tty.length!==1)throw new Error('Owned namespace requires one tty group entry');
        const fields=groups[tty[0]].split(':');
        if(fields.length!==4 || !/^\d+$/.test(fields[2]))throw new Error('Owned namespace tty group is invalid');
        fields[2]=String(userInfo().gid);groups[tty[0]]=fields.join(':');
        const groupFile=join(directory,'namespace-group');
        await writeFile(groupFile,groups.join('\n'),{mode:0o600,flag:'wx'});
        daemon=new OwnedProcess('/usr/bin/bwrap',['--die-with-parent','--unshare-user','--dev-bind','/','/','--ro-bind',groupFile,groupSource,'--',sshd,...arguments_]);
      } else daemon=new OwnedProcess(sshd,arguments_);
      if(!await daemon.liveIdentity())throw new Error('Owned SSH root identity unavailable');
      const fixture=new SshFixture(directory,port,privateKey,fingerprint,daemon,nonce,environment,options.privateTtyGroup);
      const deadline=performance.now()+3000;
      while(!await listening(port)) {
        if(daemon.child.exitCode!==null || performance.now()>=deadline)throw new Error('Owned sshd not ready');
        await delay(10);
      }
      return fixture;
    } catch(error) {
      try{if(daemon)await stopOwnedTree(daemon,'SSH',options.privateTtyGroup===true);}catch{console.error('Owned SSH startup cleanup failed');}
      try{await rm(directory,{recursive:true,force:true});}catch{console.error('Owned SSH startup directory cleanup failed');}
      throw error;
    }
  }
  private async keyOptions(identity=true) {
    const known=join(this.directory,'known_hosts');
    await writeFile(known,`[127.0.0.1]:${this.port} ${await readFile(join(this.directory,'host.pub'),'utf8')}`,{mode:0o600});
    return ['-F','/dev/null','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','IdentityAgent=none',
      '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${known}`,'-o','GlobalKnownHostsFile=/dev/null',
      ...(identity?['-i',join(this.directory,'user')]:['-o','IdentityFile=none'])];
  }
  async client(identity=true,remoteCommand?:string) {
    return new OwnedProcess('ssh',[remoteCommand===undefined?'-tt':'-T','-p',String(this.port),...await this.keyOptions(identity),`${this.username}@127.0.0.1`,...(remoteCommand===undefined?[]:[remoteCommand])]);
  }
  async sftp() {
    return new OwnedProcess('sftp',['-b','-','-P',String(this.port),...await this.keyOptions(),`${this.username}@127.0.0.1`]);
  }
  async stop() {
    if(this.stopped)return;
    let primary:unknown;
    try {await stopOwnedTree(this.daemon,'SSH',this.privateTtyGroup);if(await listening(this.port))throw new Error('Owned SSH listener survived teardown');}
    catch(error){primary=error;}
    try{await rm(this.directory,{recursive:true,force:true});}catch(error){primary??=error;}
    if(primary)throw primary;
    this.stopped=true;
  }
}
