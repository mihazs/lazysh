import {stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {moshReceipt,moshSnapshot} from './androidMoshBackground';
import type {OwnedSshRelay} from '../../apps/client/native-e2e/sshRelay';
import type {SshFixture} from './sshFixture';

/** The device waits longer than this after the manual reconnect before its explicit Upload. */
export const UPLOAD_RECOVERY_QUIET_MS=1500;

/**
 * Host half of the closed SSH-control upload recovery (#1523). The device types a command in its Mosh
 * shell that publishes a receipt and waits; this closes only the app's relayed SSH stream (server
 * attributed), proves the same Mosh shell and UDP daemon survived, then releases the shell. Afterwards
 * it watches the destination: absent while the control is closed and for a quiet interval after the
 * manual reconnect, then never changed once the explicit Upload completed.
 */
export function observeAndroidUploadRecovery(ssh:Pick<SshFixture,'directory'> & {daemon:Pick<SshFixture['daemon'],'liveIdentity'>},relay:Pick<OwnedSshRelay,'active'|'closeOwnedServer'>,name:string) {
  let stopped=false,failure:unknown;
  const evidence={closed:false,quiet:false};
  const destination=join(ssh.directory,name);
  const deadline=performance.now()+600_000;
  const look=()=>stat(destination,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return;throw error;});
  const samples:{ino:bigint;size:bigint;mtime:bigint}[]=[];
  const task=(async()=>{
    try {
      let receipt:Awaited<ReturnType<typeof moshReceipt>>;
      while(!stopped && !(receipt=await moshReceipt(ssh,'upload-control'))) {
        if(performance.now()>deadline)throw new Error('Owned upload recovery receipt deadline');
        await delay(50);
      }
      if(stopped)return;
      const before=await moshSnapshot(ssh,receipt!);
      const root=await ssh.daemon.liveIdentity();
      if(!root)throw new Error('Owned SSH namespace identity unavailable');
      await relay.closeOwnedServer(root);
      const after=await moshSnapshot(ssh,receipt!);
      if(relay.active!==0 || after.shell.pid!==before.shell.pid || after.shell.start!==before.shell.start ||
        after.daemon.owner.pid!==before.daemon.owner.pid || after.daemon.owner.start!==before.daemon.owner.start || after.daemon.inode!==before.daemon.inode)
        throw new Error('Owned Mosh transport changed when only its SSH stream closed');
      evidence.closed=true;
      await writeFile(join(ssh.directory,'upload-control-ack'),'observed\n',{mode:0o600,flag:'wx'});
      let reconnected:number|undefined;
      while(!stopped) {
        if(performance.now()>deadline)throw new Error('Owned upload recovery deadline');
        const file=await look();
        if(reconnected===undefined) {
          if(file)throw new Error('Owned upload created its destination before the manual reconnect');
          if(relay.active>0)reconnected=performance.now();
        } else if(!evidence.quiet) {
          if(file)throw new Error('Owned reconnect uploaded without an explicit Upload');
          evidence.quiet=performance.now()-reconnected>=UPLOAD_RECOVERY_QUIET_MS;
        } else if(file) {
          const next={ino:file.ino,size:file.size,mtime:file.mtimeNs},last=samples.at(-1);
          if(!last || last.ino!==next.ino || last.size!==next.size || last.mtime!==next.mtime) {
            if(samples.length>=4096)throw new Error('Owned upload sample bound');
            samples.push(next);
          }
        }
        await delay(20);
      }
    } catch(error){failure=error;}
  })();
  return {
    check(){if(failure)throw failure;},
    async stop(){stopped=true;await task;},
    /** The file must reach exactly `bytes` and, once there, keep its inode, size and modification time. */
    async assertVerified(bytes:number){
      stopped=true;await task;
      if(failure)throw failure;
      const final=await look(),done=samples.findIndex(sample=>sample.size===BigInt(bytes));
      if(!evidence.closed || !evidence.quiet || !final || done<0)throw new Error('Owned upload recovery witness incomplete');
      const changed=(sample:typeof samples[number])=>sample.ino!==samples[done].ino || sample.size!==samples[done].size || sample.mtime!==samples[done].mtime;
      if(samples.slice(done).some(changed) || changed({ino:final.ino,size:final.size,mtime:final.mtimeNs}))throw new Error('Owned uploaded file changed after it completed');
      console.log('Owned Android upload recovery: SSH-only closure kept the same Mosh shell and UDP daemon; destination stayed absent until the explicit Upload and unchanged afterwards');
    },
  };
}
