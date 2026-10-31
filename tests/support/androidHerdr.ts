import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {OwnedProcess,identity,type OwnedPid} from './ownedProcess';
import {SshFixture,stopOwnedTree,type HerdrTools} from './sshFixture';
import {setTimeout as delay} from 'node:timers/promises';

const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
type ReportedAgent={terminalId:string;workspaceId:string;tabId:string;paneId:string};
export class HerdrFixture {
  readonly name:string;
  readonly record:string;
  readonly transcript:string;
  readonly bytes:string;
  readonly pidFile:string;
  private server:OwnedProcess|undefined;
  private receiver:OwnedPid|undefined;
  private agent:ReportedAgent|undefined;
  private stopped=false;
  private constructor(readonly ssh:SshFixture) {
    this.name='owned-guard';
    this.record='OWNED_HERDR_RECORD_'+ssh.nonce;
    this.transcript=join(ssh.directory,'owned-transcript.jsonl');
    this.bytes=join(ssh.directory,'received-bytes');
    this.pidFile=join(ssh.directory,'receiver-pid');
  }
  get draft(){return '  literal{'+this.ssh.nonce+'}<text>\nsecond\t世界  ';}
  async run(args:string[]) {
    const env=this.ssh.environment;
    if(!env)throw new Error('Owned Herdr environment required');
    return new OwnedProcess(join(this.ssh.directory,'bin/herdr'),['--session',this.name,...args],this.ssh.directory,env)
      .finish('owned Herdr command',3000);
  }
  static async start(tools:HerdrTools,moshBinary?:string) {
    const ssh=await SshFixture.start(tools,moshBinary?{moshBinary,privateTtyGroup:true,observeMoshBootstraps:true}:{});
    const owned=new HerdrFixture(ssh);
    try {
      for(const name of ['herdr','herdr-dev']) {
        const directory=join(ssh.environment!.XDG_CONFIG_HOME!,name);
        await mkdir(directory,{mode:0o700});
        await writeFile(join(directory,'config.toml'),"onboarding = false\n[terminal]\ndefault_shell = '/bin/sh'\nshell_mode = 'non_login'\n[update]\nversion_check = false\nmanifest_check = false\n",{mode:0o600});
      }
      await writeFile(owned.transcript,JSON.stringify({type:'user',uuid:'owned-'+ssh.nonce,message:{role:'user',content:owned.record}})+'\n',{mode:0o600});
      owned.server=new OwnedProcess(join(ssh.directory,'bin/herdr'),['--session',owned.name,'server'],ssh.directory,ssh.environment);
      const until=performance.now()+3000;
      while(true) {
        const ready=await owned.run(['api','snapshot']).then(()=>true,()=>false);
        if(ready)break;
        if(performance.now()>=until || !await owned.server.liveIdentity())throw new Error('Owned Herdr startup deadline');
        await delay(10);
      }
      await owned.run(['workspace','create','--focus','--label','HERDR_'+ssh.nonce,'--cwd',ssh.directory]);
      const snapshot=JSON.parse(await owned.run(['api','snapshot']));
      const pane=snapshot?.result?.snapshot?.focused_pane_id;
      if(typeof pane!=='string' || !pane || pane.length>128 || /[\x00-\x1f\x7f-\x9f]/.test(pane))throw new Error('Invalid owned receiver pane');
      const command=quote(join(ssh.directory,'bin/owned-terminal-receiver'))+' '+quote(ssh.directory);
      await owned.run(['pane','run',pane,command]);
      const deadline=performance.now()+3000;
      while(true) {
        const text=await readFile(owned.pidFile,'utf8').catch(error=>{
          if((error as NodeJS.ErrnoException).code==='ENOENT')return '';
          throw error;
        });
        if(/^[1-9][0-9]*\n$/.test(text)) {
          const pid=Number(text.trim());
          const receiver=Number.isSafeInteger(pid)?await identity(pid):undefined;
          if(receiver && !['Z','X'].includes(receiver.state)){owned.receiver=receiver;break;}
        }
        if(performance.now()>=deadline)throw new Error('Owned receiver startup deadline');
        await delay(10);
      }
      // A custom hook report has no elapsed-time TTL. Seed only after the
      // original receiver is running; never heartbeat or mask its retirement.
      await owned.run(['pane','report-agent',pane,'--source','lazysh-owned-ui','--agent','codex','--state','unknown']);
      const reported=JSON.parse(await owned.run(['api','snapshot']))?.result?.snapshot;
      const rows=reported?.agents;
      const panes=reported?.panes;
      if(!Array.isArray(rows) || rows.length!==1 || !Array.isArray(panes) || panes.length!==1)
        throw new Error('Owned Herdr agent snapshot unavailable');
      const row=rows[0],source=panes[0];
      if(!row || !source || row.agent!=='codex' || row.agent_status!=='unknown'
        || row.pane_id!==pane || source.pane_id!==pane || row.terminal_id!==source.terminal_id
        || row.workspace_id!==source.workspace_id || row.tab_id!==source.tab_id
        || typeof row.terminal_id!=='string' || !row.terminal_id || row.terminal_id.length>256
        || /[\x00-\x1f\x7f-\x9f]/.test(row.terminal_id)
        || typeof row.workspace_id!=='string' || row.workspace_id.length>50 || !/^w[0-9]+$/.test(row.workspace_id)
        || typeof row.tab_id!=='string' || row.tab_id.length>50 || !/^w[0-9]+:t[0-9]+$/.test(row.tab_id)
        || pane.length>50 || !/^w[0-9]+:p[0-9]+$/.test(pane)
        || !row.tab_id.startsWith(row.workspace_id+':') || !pane.startsWith(row.workspace_id+':'))
        throw new Error('Owned Herdr agent identity changed');
      owned.agent={terminalId:row.terminal_id,workspaceId:row.workspace_id,tabId:row.tab_id,paneId:pane};
      await owned.expectBytes(Buffer.alloc(0));
      return owned;
    } catch(error) {
      try{await owned.stop();}catch{console.error('Owned Herdr startup cleanup also failed');}
      throw error;
    }
  }
  private async receiverAlive() {
    const current=this.receiver && await identity(this.receiver.pid);
    return !!current && current.start===this.receiver?.start && !['Z','X'].includes(current.state);
  }
  async expectBytes(expected:Buffer) {
    const deadline=performance.now()+3000;
    while(true) {
      const file=await open(this.bytes,'r').catch(error=>{
        if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
        throw error;
      });
      if(!file){if(performance.now()>=deadline)throw new Error('Owned receiver output missing');await delay(10);continue;}
      let received:Buffer;
      try {
        const bytes=Buffer.alloc(expected.length+1);
        const {bytesRead}=await file.read(bytes,0,bytes.length,0);
        received=bytes.subarray(0,bytesRead);
      } finally {await file.close();}
      if(received.equals(expected))break;
      if(received.length>expected.length || performance.now()>=deadline)throw new Error('Owned receiver bytes differ');
      await delay(10);
    }
    if(!await this.receiverAlive())throw new Error('Owned receiver identity changed');
  }
  metadata() {
    if(!this.agent)throw new Error('Owned Herdr agent report required');
    return {name:this.name,transcript:this.transcript,record:this.record,draft:this.draft,agent:this.agent};
  }
  async stop() {
    if(this.stopped)return;
    let failure:unknown;
    try {
      if(this.server)await stopOwnedTree(this.server,'Herdr');
      if(await this.receiverAlive())throw new Error('Owned Herdr receiver survived teardown');
    } catch(error){failure=error;}
    try{await this.ssh.stop();}catch(error){failure??=error;}
    if(failure)throw failure;
    this.stopped=true;
  }
}
export function herdrTools():HerdrTools {
  const herdrBinary=process.env.LAZYSH_TEST_HERDR;
  const agentBinary=process.env.LAZYSH_TEST_AGENT_BIN;
  const receiverBinary=process.env.LAZYSH_TEST_RECEIVER_BIN;
  if(!herdrBinary || !agentBinary || !receiverBinary)throw new Error('Explicit current-source Herdr and companion binaries required');
  return {herdrBinary,agentBinary,receiverBinary};
}
