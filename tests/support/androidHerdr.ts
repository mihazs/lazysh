import {mkdir,open,readFile,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
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
  private navigationReceivers:{directory:string;receiver:OwnedPid}[]=[];
  private navigation: {source:ReportedAgent & {marker:string;label:string};shell:ReportedAgent & {marker:string;label:string};agent:ReportedAgent & {marker:string;label:string};workspaceLabel:string}|undefined;
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
  static async start(tools:HerdrTools,moshBinary?:string,navigation=false) {
    const ssh=await SshFixture.start(tools,moshBinary?{moshBinary,privateTtyGroup:true,observeMoshBootstraps:true}:{sharedNavigation:navigation});
    const owned=new HerdrFixture(ssh);
    try {
      for(const name of ['herdr','herdr-dev']) {
        const directory=join(ssh.environment!.XDG_CONFIG_HOME!,name);
        await mkdir(directory,{mode:0o700});
        await writeFile(join(directory,'config.toml'),"onboarding = false\n[terminal]\ndefault_shell = '/bin/sh'\nshell_mode = 'non_login'\n[update]\nversion_check = false\nmanifest_check = false\n",{mode:0o600});
      }
      await writeFile(owned.transcript,JSON.stringify({type:'user',uuid:'owned-'+ssh.nonce,message:{role:'user',content:owned.record}})+'\n',{mode:0o600});
      owned.server=ssh.herdrServer(['--session',owned.name,'server']);
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
      owned.receiver=await owned.startReceiver(pane,ssh.directory,navigation?'NAV_SOURCE_'+ssh.nonce:undefined);
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
      if(navigation)await owned.prepareNavigation();
      return owned;
    } catch(error) {
      try{await owned.stop();}catch{console.error('Owned Herdr startup cleanup also failed');}
      throw error;
    }
  }
  private async startReceiver(pane:string,directory:string,marker?:string) {
    const command=(marker?"printf '\\033[2J\\033[H%s' "+quote(marker)+"; ":'')+'exec '+quote(join(this.ssh.directory,'bin/owned-terminal-receiver'))+' '+quote(directory);
    await this.run(['pane','run',pane,command]);
    const deadline=performance.now()+3000;
    while(true) {
      const text=await readFile(join(directory,'receiver-pid'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
      if(/^[1-9][0-9]*\n$/.test(text)) {
        const pid=Number(text.trim()),receiver=Number.isSafeInteger(pid)?await identity(pid):undefined;
        if(receiver && !['Z','X'].includes(receiver.state))return receiver;
      }
      if(performance.now()>=deadline)throw new Error('Owned receiver startup deadline');
      await delay(10);
    }
  }
  private async navigationTarget() {
    const snapshot=JSON.parse(await this.run(['api','snapshot']))?.result?.snapshot;
    const pane=snapshot?.panes?.find((row:Record<string,unknown>)=>row.pane_id===snapshot.focused_pane_id);
    if(!pane || !/^w[0-9]{1,49}$/.test(pane.workspace_id) || !/^w[0-9]+:t[0-9]+$/.test(pane.tab_id)
      || !/^w[0-9]+:p[0-9]+$/.test(pane.pane_id) || pane.tab_id.length>50 || pane.pane_id.length>50
      || !pane.tab_id.startsWith(pane.workspace_id+':') || !pane.pane_id.startsWith(pane.workspace_id+':')
      || typeof pane.terminal_id!=='string' || !pane.terminal_id || pane.terminal_id.length>256 || /[\x00-\x1f\x7f-\x9f]/.test(pane.terminal_id))throw new Error('Invalid owned navigation identity');
    return {workspaceId:pane.workspace_id,tabId:pane.tab_id,paneId:pane.pane_id,terminalId:pane.terminal_id} as ReportedAgent;
  }
  private async prepareNavigation() {
    const nonce=this.ssh.nonce,workspaceLabel='NAV_WORKSPACE_'+nonce;
    const source={...this.agent!,marker:'NAV_SOURCE_'+nonce,label:'HERDR_'+nonce};
    await this.run(['workspace','create','--focus','--label',workspaceLabel,'--cwd',this.ssh.directory]);
    const shell={...await this.navigationTarget(),marker:'NAV_SHELL_'+nonce,label:'NAV_SHELL_TAB_'+nonce};
    await this.run(['tab','rename',shell.tabId,shell.label]);
    await this.run(['tab','create','--workspace',shell.workspaceId,'--focus','--label','NAV_AGENT_TAB_'+nonce,'--cwd',this.ssh.directory]);
    const agent={...await this.navigationTarget(),marker:'NAV_AGENT_'+nonce,label:'NAV_AGENT_TAB_'+nonce};
    if(source.workspaceId===shell.workspaceId || shell.workspaceId!==agent.workspaceId || shell.tabId===agent.tabId)throw new Error('Owned navigation topology differs');
    for(const [kind,target] of [['shell',shell],['agent',agent]] as const) {
      const directory=join(this.ssh.directory,'navigation-'+kind);await mkdir(directory,{mode:0o700});
      this.navigationReceivers.push({directory,receiver:await this.startReceiver(target.paneId,directory,target.marker)});
    }
    await this.run(['pane','report-agent',agent.paneId,'--source','lazysh-owned-ui','--agent','codex','--state','unknown']);
    await this.run(['workspace','focus',source.workspaceId]);
    this.navigation={source,shell,agent,workspaceLabel};
    for(const name of ['herdr','lazysh-agent','owned-terminal-receiver']) {
      const path=join(this.ssh.directory,'bin',name),size=(await stat(path)).size;
      if(!size || size>512*1024*1024)throw new Error('Owned navigation binary size');
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of createReadStream(path)){bytes+=chunk.length;if(bytes>size)throw new Error('Owned navigation binary changed');hash.update(chunk);}
      if(bytes!==size)throw new Error('Owned navigation binary changed');
      console.log(`Owned navigation binary ${name} sha256=${hash.digest('hex')}`);
    }
    await this.expectNavigationBytes();
  }
  async expectNavigationBytes() {
    if(!this.navigation)throw new Error('Owned navigation topology required');
    await this.expectBytes(Buffer.alloc(0));
    for(const {directory,receiver} of this.navigationReceivers)await this.expectBytes(Buffer.alloc(0),join(directory,'received-bytes'),receiver);
  }
  private async receiverAlive(receiver=this.receiver) {
    const current=receiver && await identity(receiver.pid);
    return !!current && current.start===receiver?.start && !['Z','X'].includes(current.state);
  }
  async expectBytes(expected:Buffer,path=this.bytes,receiver=this.receiver) {
    const deadline=performance.now()+3000;
    while(true) {
      const file=await open(path,'r').catch(error=>{
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
    if(!await this.receiverAlive(receiver))throw new Error('Owned receiver identity changed');
  }
  metadata() {
    if(!this.agent)throw new Error('Owned Herdr agent report required');
    return {name:this.name,transcript:this.transcript,record:this.record,draft:this.draft,agent:this.agent,...(this.navigation?{navigation:this.navigation}:{})};
  }
  async stop() {
    if(this.stopped)return;
    let failure:unknown;
    try {
      if(this.server)await stopOwnedTree(this.server,'Herdr',true);
      if(await this.receiverAlive() || (await Promise.all(this.navigationReceivers.map(({receiver})=>this.receiverAlive(receiver)))).some(Boolean))throw new Error('Owned Herdr receiver survived teardown');
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
