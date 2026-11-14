import {join} from 'node:path';
import {lstat,readdir,readlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {OwnedProcess,descendants,identity,type OwnedPid} from './ownedProcess';
import {SshFixture,stopOwnedTree} from './sshFixture';

type OwnedWindow={windowId:string;index:number;name:'alpha'|'beta';marker:string;paneId:string;pane:OwnedPid};
const paneRow=/^(@[0-9]{1,9})\|([0-9]{1,3})\|(alpha|beta)\|([01])\|(%[0-9]{1,9})\|([1-9][0-9]{0,9})\|([01])$/;

/** Parses one bounded `list-panes` readback; anything else is a changed topology. */
export function tmuxPaneRows(text:string) {
  const lines=text.trim().split('\n');
  if(text.length>1024 || lines.length!==2)throw new Error('Owned tmux topology changed');
  return lines.map(line=>{
    const row=paneRow.exec(line);
    if(!row)throw new Error('Owned tmux topology changed');
    return {windowId:row[1],index:Number(row[2]),name:row[3] as 'alpha'|'beta',active:row[4]==='1',paneId:row[5],pid:Number(row[6]),dead:row[7]==='1'};
  });
}
/** Display clients exclude tmux control-mode clients such as the app's Jump binding. */
export function tmuxDisplayClients(text:string) {
  const lines=text.split('\n').filter(Boolean);
  if(text.length>64 || lines.length>8 || lines.some(line=>line!=='0' && line!=='1'))throw new Error('Owned tmux client readback invalid');
  return lines.filter(line=>line==='0').length;
}
/** Compressed display-client history: attach, detach, reattach and final detach. */
export function tmuxAttachHistoryVerified(history:readonly number[]) {
  return history.length===5 && [0,1,0,1,0].every((count,index)=>history[index]===count);
}

const teardownErrors=['Owned tmux root identity unavailable','Owned tmux root identity lost','Owned SSH descendants survived teardown',
  'Owned fixture process teardown deadline','Owned fixture descendant count exceeded','Owned tmux process survived teardown','Owned tmux server exited uncleanly',
  'Owned SSH root identity unavailable','Owned SSH root identity lost','Owned SSH listener survived teardown'];
/** A failed tmux command keeps only a fixed class of the client's own error, never its text. */
export function tmuxCommandFailure(stderr:string,failure:unknown) {
  if(failure instanceof Error && failure.message.startsWith('Owned fixture deadline'))return 'deadline';
  if(/server exited unexpectedly|lost server/.test(stderr))return 'lost-server';
  if(/no server running|error connecting to/.test(stderr))return 'no-server';
  if(/can't find session|session not found/.test(stderr))return 'no-session';
  return 'other';
}
/** Supervisor status only: whether the namespaced server ended, and its bounded exit code or signal. */
export function tmuxServerStatus(child?:{exitCode:number|null;signalCode:NodeJS.Signals|null}) {
  if(!child)return {state:'absent' as const,exit:null,signal:'none'};
  const code=child.exitCode,signal=child.signalCode;
  return {state:code===null && signal===null?'running' as const:'exited' as const,exit:Number.isInteger(code) && code!>=0 && code!<=255?code:null,
    signal:signal==null?'none':(['SIGTERM','SIGKILL','SIGSEGV','SIGABRT','SIGHUP'] as const).find(value=>value===signal)??'other'};
}
/** Attached clients by PID only; anything else is an invalid readback. */
export function tmuxClientPids(text:string) {
  const lines=text.split('\n').filter(Boolean);
  if(text.length>128 || lines.length>8 || lines.some(line=>!/^[1-9][0-9]{0,9}$/.test(line)))throw new Error('Owned tmux client readback invalid');
  return lines.map(Number);
}
export const tmuxClientCount=(text:string)=>tmuxClientPids(text).length;
/** Counts only: live client processes of the owned tmux copy, and how many belong to the SSH tree. */
export type TmuxClientProcesses={live:number;inSsh:number};
export type TmuxTeardownEvidence={serverAtStop:'absent'|'live'|'exited';clients:number|null;processes:TmuxClientProcesses|null;detached:'not-requested'|'all'|'deadline';
  straysRetired:number|null;sockets:number|null;shutdown:'not-requested'|'clean'|'unclean'|'deadline';exitMs:number|null};
/** Closed teardown evidence: fixed fixture messages, socket count, supervisor status and timing only. */
export function tmuxTeardownObservation(evidence:TmuxTeardownEvidence,failure:unknown,server?:{child:{exitCode:number|null;signalCode:NodeJS.Signals|null}}) {
  const message=(error:unknown)=>error===undefined?'none':error instanceof Error && teardownErrors.includes(error.message)?error.message:'other';
  const status=tmuxServerStatus(server?.child);
  return {scope:'tmux-teardown',...evidence,failure:message(failure),supervisorExit:status.exit,supervisorSignal:status.signal};
}

// The pinned tmux server runs in the foreground of the fixture's private user
// namespace with a private socket directory, so it cannot outlive its owner.
export class TmuxFixture {
  readonly name='owned-tmux';
  private server:OwnedProcess|undefined;
  private serverPid:OwnedPid|undefined;
  private windows:OwnedWindow[]=[];
  private history:number[]=[];
  private constructor(readonly ssh:SshFixture) {}
  static async start(binary=process.env.LAZYSH_TEST_TMUX) {
    if(!binary || !binary.startsWith('/'))throw new Error('Explicit pinned tmux binary required');
    const ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmuxBinary:binary});
    const owned=new TmuxFixture(ssh);
    try {
      const version=(await owned.run(['-V'],false)).trim();
      if(!/^tmux [0-9]+[.][0-9]+[a-z]?$/.test(version))throw new Error('Owned tmux version unavailable');
      console.log(`Owned Android tmux fixture ${version}`);
      owned.server=ssh.tmuxServer(['-D','-f','/dev/null','-L','default']);
      const socket=join(ssh.environment!.TMUX_TMPDIR!,`tmux-${process.getuid!()}`,'default');
      const until=performance.now()+3000;
      // list-sessions never starts a server, so readiness cannot admit an unowned daemon.
      while(!(await lstat(socket).then(info=>info.isSocket(),()=>false) && await owned.run(['list-sessions']).then(()=>true,()=>false))) {
        if(performance.now()>=until || !await owned.server.liveIdentity())throw new Error('Owned tmux startup deadline');
        await delay(10);
      }
      for(const [index,name] of [[0,'alpha'],[1,'beta']] as const) {
        const marker=`TMUX_${name.toUpperCase()}_${ssh.nonce}`,command=`printf '%s\\n' '${marker}'; exec sleep 3600`;
        await owned.run(index===0?['new-session','-d','-s',owned.name,'-n',name,'-x','80','-y','24','-c',ssh.directory,command]
          :['new-window','-d','-t',`=${owned.name}:${index}`,'-n',name,'-c',ssh.directory,command]);
        owned.windows.push({windowId:'',index,name,marker,paneId:'',pane:{pid:0,parent:0,start:'',state:''}});
      }
      const pid=Number((await owned.run(['display-message','-p','-t',`=${owned.name}`,'#{pid}'])).trim());
      owned.serverPid=Number.isSafeInteger(pid) && pid>0?await identity(pid):undefined;
      let ancestor=owned.serverPid,admitted=false;
      for(let depth=0;ancestor && depth<4 && !admitted;depth++) {admitted=ancestor.parent===owned.server.child.pid;ancestor=await identity(ancestor.parent);}
      if(!admitted)throw new Error('Owned tmux server is not the namespaced fixture server');
      const rows=tmuxPaneRows(await owned.panes());
      for(const window of owned.windows) {
        const row=rows.find(value=>value.index===window.index && value.name===window.name);
        const pane=row && await identity(row.pid);
        if(!row || row.dead || row.active!==(window.index===0) || !pane || pane.parent!==owned.serverPid!.pid)throw new Error('Owned tmux topology changed');
        Object.assign(window,{windowId:row.windowId,paneId:row.paneId,pane});
        const deadline=performance.now()+3000;
        while(!(await owned.run(['capture-pane','-p','-t',row.paneId])).includes(window.marker)) {
          if(performance.now()>=deadline)throw new Error('Owned tmux pane marker unavailable');
          await delay(10);
        }
      }
      await owned.observe();
      return owned;
    } catch(error) {
      try{await owned.stop();}catch{console.error('Owned tmux startup cleanup also failed');}
      throw error;
    }
  }
  private async run(args:string[],server=true) {
    const command=new OwnedProcess(join(this.ssh.directory,'bin/tmux'),server?['-L','default',...args]:args,this.ssh.directory,this.ssh.environment);
    try {return await command.finish('owned tmux command',3000);}
    catch(error){throw new Error(`Owned tmux command failed: ${tmuxCommandFailure(command.stderr,error)}`);}
  }
  private async clientPids() {return tmuxClientPids(await this.run(['list-clients','-F','#{client_pid}']));}
  private async clients() {return (await this.clientPids()).length;}
  /**
   * Every live process executing this fixture's private tmux copy, except the original server.
   * A client detached by the server leaves list-clients while its connection still holds the
   * server's exit, so ownership comes from the private executable path, never the client list.
   */
  private async clientProcesses() {
    const binary=join(this.ssh.directory,'bin/tmux'),found:OwnedPid[]=[];
    for(const entry of await readdir('/proc')) {
      if(!/^[1-9][0-9]{0,9}$/.test(entry) || Number(entry)===this.serverPid?.pid)continue;
      if(await readlink(`/proc/${entry}/exe`).catch(()=>'')!==binary)continue;
      const current=await identity(Number(entry));
      if(!current || ['Z','X'].includes(current.state))continue;
      if(found.length>=16)throw new Error('Owned tmux client count exceeded');
      found.push(current);
    }
    return found;
  }
  private panes() {return this.run(['list-panes','-s','-t',`=${this.name}`,'-F','#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{pane_id}|#{pane_pid}|#{pane_dead}']);}
  private async alive(saved:OwnedPid|undefined) {
    const current=saved && await identity(saved.pid);
    return !!current && current.start===saved?.start && current.parent===saved?.parent && !['Z','X'].includes(current.state);
  }
  /** One host sample: the original server and both pane processes, plus display clients. Returns the current display-client count. */
  async observe() {
    if(!await this.server?.liveIdentity() || !await this.alive(this.serverPid) || !this.windows.length)throw new Error('Owned tmux server identity changed');
    for(const window of this.windows)if(!await this.alive(window.pane))throw new Error('Owned tmux pane identity changed');
    const count=tmuxDisplayClients(await this.run(['list-clients','-t',`=${this.name}`,'-F','#{client_control_mode}']));
    if(this.history.at(-1)!==count) {
      if(this.history.length>=8)throw new Error('Owned tmux attach history exceeded');
      this.history.push(count);
    }
    return count;
  }
  /** Closed numeric evidence only; never pane text, paths or process IDs. */
  diagnostic() {return {schemaVersion:1,history:[...this.history],windows:this.windows.length,server:tmuxServerStatus(this.server?.child)};}
  async verifyDetachedAndReattached() {
    const deadline=performance.now()+5000;
    while(true) {
      await this.observe();
      if(this.history.at(-1)===0 || performance.now()>=deadline)break;
      await delay(25);
    }
    if(!tmuxAttachHistoryVerified(this.history))throw new Error('Owned tmux attach, detach and reattach were not observed');
    if((await this.run(['list-sessions','-F','#{session_name}'])).trim()!==this.name)throw new Error('Owned tmux sessions changed');
    const rows=tmuxPaneRows(await this.panes());
    for(const window of this.windows) {
      const row=rows.find(value=>value.paneId===window.paneId);
      // The app switched to beta through Jump To; the detached session keeps that window.
      if(!row || row.dead || row.windowId!==window.windowId || row.index!==window.index || row.name!==window.name
        || row.pid!==window.pane.pid || row.active!==(window.name==='beta'))throw new Error('Owned tmux remote state differs');
      if(!(await this.run(['capture-pane','-p','-t',window.paneId])).includes(window.marker))throw new Error('Owned tmux pane content changed');
    }
  }
  metadata() {
    if(this.windows.length!==2)throw new Error('Owned tmux topology required');
    return {name:this.name,windows:this.windows.map(({index,name,marker})=>({index,name,marker}))};
  }
  private stopping:Promise<void>|undefined;
  /** Idempotent: every caller observes the one teardown's result. */
  stop() {return this.stopping??=this.stopOnce();}
  private async stopOnce() {
    const server=this.server,serverAtStop=!server?'absent':await server.liveIdentity()?'live':'exited';
    const observation:TmuxTeardownEvidence={serverAtStop,clients:null,processes:null,detached:'not-requested',straysRetired:null,sockets:null,shutdown:'not-requested',exitMs:null};
    let failure:unknown;
    // A remote client still attached at teardown, such as the app's control-mode Jump
    // binding, first leaves through the original server's own detach, not an SSH signal.
    if(server && serverAtStop==='live')try {
      observation.clients=await this.clients();
      const root=await this.ssh.daemon.liveIdentity();
      const tree=new Set(root?(await descendants(root)).map(item=>item.pid):[]);
      const processes=await this.clientProcesses();
      observation.processes={live:processes.length,inSsh:processes.filter(item=>tree.has(item.pid)).length};
      if(observation.clients) {
        await this.run(['detach-client','-s',`=${this.name}`]).catch(()=>{});
        const until=performance.now()+3000;
        let remaining=observation.clients;
        while(remaining && performance.now()<until){await delay(25);remaining=await this.clients();}
        observation.detached=remaining?'deadline':'all';
      }
    } catch {/* Detach evidence is advisory; SSH retirement below still owns every remote client. */}
    // Remote clients belong to the SSH tree. tmux's clean exit waits for every client
    // connection, so retire that tree before asking the server to shut down.
    try{await this.ssh.retire();}catch(error){failure=error;}
    try {
      if(server && serverAtStop==='live') {
        // SSH retirement ended every remote client in its tree. An owned client still live now
        // runs outside it and would hold the server's clean exit; retire it by its identity.
        observation.straysRetired=0;
        for(const item of await this.clientProcesses()) {
          if((await identity(item.pid))?.start!==item.start)continue;
          try{process.kill(item.pid,'SIGKILL');observation.straysRetired++;}catch{/* Already gone. */}
        }
        observation.sockets=this.serverPid?await socketCount(this.serverPid):null;
        // Ask the original server to exit through its own socket and require its namespaced
        // supervisor to report that exit as clean; the reply can race the shutdown itself.
        const started=performance.now();
        await this.run(['kill-server']).catch(()=>{});
        const code=await Promise.race([server.done.then(value=>value,()=>null),delay(10_000).then(()=>'deadline' as const)]);
        observation.exitMs=Math.min(60_000,Math.round(performance.now()-started));
        observation.shutdown=code==='deadline'?'deadline':code===0?'clean':'unclean';
        if(code==='deadline')await stopOwnedTree(server,'tmux',true);
        else if(code!==0)throw new Error('Owned tmux server exited uncleanly');
      }
      await this.retireSurvivors();
    } catch(error){failure??=error;}
    try{await this.ssh.stop();}catch(error){failure??=error;}
    if(failure) {
      try{console.error('Owned tmux teardown '+JSON.stringify(tmuxTeardownObservation(observation,failure,server)));}catch{/* Keep the original failure. */}
      throw failure;
    }
  }
  /** The original server and pane processes, by PID and start time only, must be gone. */
  private async retireSurvivors() {
    const saved=[this.serverPid,...this.windows.map(window=>window.pane)].filter((value):value is OwnedPid=>!!value?.pid);
    const present=async(item:OwnedPid)=>{const current=await identity(item.pid);return current?.start===item.start && !['Z','X'].includes(current.state);};
    const deadline=performance.now()+3000;
    while((await Promise.all(saved.map(present))).some(Boolean) && performance.now()<deadline)await delay(25);
    const survivors=(await Promise.all(saved.map(async item=>await present(item)?item:undefined))).filter((value):value is OwnedPid=>!!value);
    if(!survivors.length)return;
    for(const item of survivors)if(await present(item))try{process.kill(item.pid,'SIGKILL');}catch{/* Already gone. */}
    throw new Error('Owned tmux process survived teardown');
  }
}

async function socketCount(saved:OwnedPid) {
  try {
    const current=await identity(saved.pid);
    if(current?.start!==saved.start)return null;
    const entries=await readdir(`/proc/${saved.pid}/fd`);
    if(entries.length>4096)return null;
    let count=0;
    for(const entry of entries)if((await readlink(`/proc/${saved.pid}/fd/${entry}`).catch(()=>'')).startsWith('socket:'))count++;
    return count;
  } catch {return null;}
}
