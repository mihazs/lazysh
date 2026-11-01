import {readFile,readlink,readdir,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {descendants,sameIdentity,type OwnedPid} from './ownedProcess';
import type {SshFixture} from './sshFixture';

// Only private fixture receipts and descendants of its retained namespace owner.
// Nothing here inspects an arbitrary host, changes a connection, or emits PIDs.
export function observeAndroidMoshBackground(ssh:Pick<SshFixture,'directory'> & {daemon:Pick<SshFixture['daemon'],'liveIdentity'>}) {
  let stopped=false,verified=false,failed=false,failure:unknown;
  let phase:'before-receipt'|'before-ownership'|'before-ack'|'after-receipt'|'after-ownership'|'after-output'|'after-ack'|'complete'='before-receipt';
  const evidence={beforeValidated:false,beforeAck:false,afterValidated:false,outputValidated:false,afterAck:false};
  const deadline=performance.now()+600_000;
  const receipt=async(part:string)=>{
    const path=join(ssh.directory,`background-${part}`);
    const size=await stat(path).catch(error=>{if(error.code==='ENOENT')return;throw error;});
    if(!size)return;
    if(!size.isFile() || size.size>128)throw new Error('Owned Mosh receipt bound');
    const text=await readFile(path,'utf8');
    const match=/^([1-9][0-9]{0,9}) ([1-9][0-9]{0,19})\n$/.exec(text);
    if(!match)throw new Error('Owned Mosh receipt shape');
    return {pid:Number(match[1]),start:match[2]};
  };
  const snapshot=async(remote:{pid:number;start:string})=>{
    const root=await ssh.daemon.liveIdentity();
    if(!root)throw new Error('Owned Mosh namespace identity unavailable');
    const members=await descendants(root);
    let shell:OwnedPid|undefined;
    const daemons:{owner:OwnedPid;inode:string}[]=[];
    const udp=await readFile('/proc/net/udp','utf8');
    if(udp.length>256*1024)throw new Error('Owned Mosh UDP table bound');
    const sockets=new Set(udp.split('\n').slice(1).map(line=>line.trim().split(/\s+/)[9]).filter(Boolean));
    for(const member of members) {
      const status=await readFile(`/proc/${member.pid}/status`,'utf8').catch(()=> '');
      if(status.length>16*1024)throw new Error('Owned Mosh status bound');
      const namespace=status.match(/^NSpid:\s+([0-9]+(?:\s+[0-9]+)*)\s*$/m)?.[1].split(/\s+/);
      if(namespace && namespace.length===2 && Number(namespace[1])===remote.pid && member.start===remote.start) {
        if(shell)throw new Error('Owned Mosh shell identity ambiguous');
        shell=member;
      }
      if(await readlink(`/proc/${member.pid}/exe`).catch(()=> '')!==join(ssh.directory,'bin/mosh-server'))continue;
      const files=await readdir(`/proc/${member.pid}/fd`).catch(()=>[]);
      if(files.length>256)throw new Error('Owned Mosh descriptor bound');
      for(const file of files) {
        const inode=(await readlink(`/proc/${member.pid}/fd/${file}`).catch(()=> '')).match(/^socket:\[([0-9]+)\]$/)?.[1];
        if(inode && sockets.has(inode))daemons.push({owner:member,inode});
      }
    }
    if(!shell || daemons.length!==1 || shell.parent!==daemons[0].owner.pid ||
      !await sameIdentity(shell) || !await sameIdentity(daemons[0].owner) ||
      (await readFile(join(ssh.directory,'mosh-bootstraps'),'utf8'))!=='bootstrap\n')
      throw new Error('Owned Mosh shell, UDP owner or single bootstrap unverified');
    return {shell,daemon:daemons[0]};
  };
  const task=(async()=>{
    try {
      let before:Awaited<ReturnType<typeof snapshot>>|undefined;
      for(const part of ['before','after'] as const) {
        phase=`${part}-receipt`;
        let observed:Awaited<ReturnType<typeof receipt>>=undefined;
        while(!stopped && performance.now()<deadline && !(observed=await receipt(part)))await delay(50);
        if(stopped)return;
        if(!observed)throw new Error('Owned Mosh background receipt deadline');
        phase=`${part}-ownership`;
        const current=await snapshot(observed);
        if(before && (current.shell.pid!==before.shell.pid || current.shell.start!==before.shell.start ||
          current.daemon.owner.pid!==before.daemon.owner.pid || current.daemon.owner.start!==before.daemon.owner.start ||
          current.daemon.inode!==before.daemon.inode))throw new Error('Owned Mosh background transport identity changed');
        evidence[part==='before'?'beforeValidated':'afterValidated']=true;
        before=current;
        if(part==='after') {
          phase='after-output';
          const samples=await readFile(join(ssh.directory,'background-samples'),'utf8');
          if(!/^[1-9][0-9]{0,2}\n$/.test(samples) || Number(samples)<263 || Number(samples)>900 ||
            await stat(join(ssh.directory,'background-expired')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))
            throw new Error('Owned Mosh busy output expired or generated fewer than 256 KiB');
          evidence.outputValidated=true;
        }
        phase=`${part}-ack`;
        await writeFile(join(ssh.directory,`background-${part}-ack`),'observed\n',{mode:0o600,flag:'wx'});
        evidence[part==='before'?'beforeAck':'afterAck']=true;
      }
      verified=true;phase='complete';
    } catch(error){failed=true;failure=error;}
  })();
  return {
    diagnostic(){return {schemaVersion:1 as const,phase,...evidence,verified,stopped,failure:failed?'witness-failure' as const:null};},
    check(){if(failure)throw failure;},
    async stop(){stopped=true;await task;},
    async assertVerified(){stopped=true;await task;if(failure)throw failure;if(!verified)throw new Error('Owned Mosh background witness incomplete');
      if(await readFile(join(ssh.directory,'mosh-bootstraps'),'utf8')!=='bootstrap\n')throw new Error('Owned Mosh bootstrapped again');
      console.log('Owned Android Mosh: same remote shell birth, UDP daemon/socket and exactly one bootstrap across background interval');},
  };
}
