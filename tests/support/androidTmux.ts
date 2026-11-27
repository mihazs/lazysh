import {isAbsolute,join} from 'node:path';
import {chmod,lstat,readdir,readFile,readlink,realpath,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {OwnedProcess,descendants,identity,type OwnedPid} from './ownedProcess';
import {SshFixture,stopOwnedTree} from './sshFixture';
import {reportingAgentDeliveredOnce,reportingAgentPrompts,reportingAgentScript} from './androidTmuxAgent';

type OwnedChat={transcript:string;record:string;draft:string;window:'alpha'};
type OwnedAgent=ReturnType<typeof reportingAgentPrompts>;
type OwnedWindow={windowId:string;index:number;name:'alpha'|'beta';marker:string;paneId:string;pane:OwnedPid};
const paneRow=/^(@[0-9]{1,9})\|([0-9]{1,3})\|(alpha|beta)\|([01])\|(%[0-9]{1,9})\|([1-9][0-9]{0,9})\|([01])$/;

/** Parses one bounded `list-panes` readback; anything else is a changed topology. `extra` counts panes the app added by a split. */
export function tmuxPaneRows(text:string,extra=0) {
  const lines=text.trim().split('\n');
  if(text.length>1024 || lines.length!==2+extra)throw new Error('Owned tmux topology changed');
  return lines.map(line=>{
    const row=paneRow.exec(line);
    if(!row)throw new Error('Owned tmux topology changed');
    return {windowId:row[1],index:Number(row[2]),name:row[3] as 'alpha'|'beta',active:row[4]==='1',paneId:row[5],pid:Number(row[6]),dead:row[7]==='1'};
  });
}
const windowRow=/^(@[0-9]{1,9})\|([A-Za-z0-9_-]{1,32})\|([01])\|([01])$/;
/** Parses one bounded `list-windows` readback of the owned session: id, name, `#{window_active}` and `#{window_zoomed_flag}`. */
export function tmuxWindowRows(text:string) {
  const lines=text.trim().split('\n');
  if(text.length>1024 || lines.length>8)throw new Error('Owned tmux window topology changed');
  return lines.map(line=>{
    const row=windowRow.exec(line);
    if(!row)throw new Error('Owned tmux window topology changed');
    return {windowId:row[1],name:row[2],active:row[3]==='1',zoomed:row[4]==='1'};
  });
}
/** The one window beyond the originals that the app adds: every name it showed, in order, and whether it is gone. */
export type TmuxWindowLifecycle={windowId:string;names:string[];closed:boolean};
/**
 * Folds one readback into that window's lifecycle. The originals must keep their id and name, so a rename or a
 * close that reached one of them fails here, and a second added window or a reappearance is a changed topology.
 */
export function tmuxWindowLifecycle(rows:ReturnType<typeof tmuxWindowRows>,originals:readonly {windowId:string;name:string}[],seen?:TmuxWindowLifecycle) {
  for(const original of originals)
    if(rows.find(row=>row.windowId===original.windowId)?.name!==original.name)throw new Error('Owned tmux original window changed');
  const extra=rows.filter(row=>!originals.some(original=>original.windowId===row.windowId));
  if(extra.length>1 || (extra.length===1 && seen && (seen.windowId!==extra[0].windowId || seen.closed)))throw new Error('Owned tmux window topology changed');
  if(!extra.length)return seen && {...seen,closed:true};
  if(!seen)return {windowId:extra[0].windowId,names:[extra[0].name],closed:false};
  return seen.names.at(-1)===extra[0].name?seen:{...seen,names:[...seen.names,extra[0].name]};
}
/** What the display of the original windows shows: the active window and whether its panes are zoomed. */
export type TmuxView={window:'alpha'|'beta'|'other';zoomed:boolean};
/** Appends the active window's view to a history that keeps only changes, so the host sees each state the app left the server in. */
export function tmuxViewHistory(rows:ReturnType<typeof tmuxWindowRows>,originals:readonly {windowId:string;name:string}[],history:readonly TmuxView[]) {
  const active=rows.filter(row=>row.active);
  if(active.length!==1)throw new Error('Owned tmux window topology changed');
  const name=originals.find(original=>original.windowId===active[0].windowId)?.name;
  const view:TmuxView={window:name==='alpha' || name==='beta'?name:'other',zoomed:active[0].zoomed};
  const last=history.at(-1);
  if(last?.window===view.window && last.zoomed===view.zoomed)return history;
  if(history.length>=24)throw new Error('Owned tmux view history exceeded');
  return [...history,view];
}
/** The gesture phase ends the history in this order: beta unzoomed, a pinch zooms it, a pinch unzooms it, a swipe left shows the next window (alpha), a swipe right returns to beta. */
export function tmuxGesturesVerified(history:readonly TmuxView[]) {
  const expected:TmuxView[]=[{window:'beta',zoomed:false},{window:'beta',zoomed:true},{window:'beta',zoomed:false},{window:'alpha',zoomed:false},{window:'beta',zoomed:false}];
  return history.length>=expected.length
    && expected.every((view,index)=>history[history.length-expected.length+index].window===view.window && history[history.length-expected.length+index].zoomed===view.zoomed);
}
/** The names the app gives the window it creates and renames, and the host expects in that order. */
export const tmuxLifecycleNames=['scratch','renamed'] as const;
const splitRow=/^(%[0-9]{1,9})\|([1-9][0-9]{0,9})\|([01])\|(\/[^|\n]{0,1023})$/;
/** Parses the bounded `list-panes` readback of the split window: pane, process, window zoom flag and directory. */
export function tmuxSplitRows(text:string) {
  const lines=text.trim().split('\n');
  if(text.length>2048 || lines.length!==2)throw new Error('Owned tmux split topology changed');
  return lines.map(line=>{
    const row=splitRow.exec(line);
    if(!row)throw new Error('Owned tmux split topology changed');
    return {paneId:row[1],pid:Number(row[2]),zoomed:row[3]==='1',path:row[4]};
  });
}
/** Display clients exclude tmux control-mode clients such as the app's Jump binding. */
export function tmuxDisplayClients(text:string) {
  const lines=text.split('\n').filter(Boolean);
  if(text.length>64 || lines.length>8 || lines.some(line=>line!=='0' && line!=='1'))throw new Error('Owned tmux client readback invalid');
  return lines.filter(line=>line==='0').length;
}
/** Compressed display-client history: no client, then `attaches` rounds of attach and detach (two: attach, detach, reattach, final detach). */
export function tmuxAttachHistoryVerified(history:readonly number[],attaches=2) {
  return history.length===1+2*attaches && history.every((count,index)=>count===(index%2===1?1:0));
}
/** tmux 3.3 added `allow-passthrough`; an older server drops a DCS-wrapped sequence instead of forwarding it. */
export function tmuxPassthroughSupported(version:string) {
  const parts=/^tmux ([0-9]+)[.]([0-9]+)[a-z]?$/.exec(version);
  return !!parts && (Number(parts[1])>3 || (Number(parts[1])===3 && Number(parts[2])>=3));
}
/** Compressed `pane_in_mode` history of the first window's pane: out of a mode, in copy mode, out again. */
export function tmuxCopyModeVerified(history:readonly number[]) {
  return history.length===3 && [0,1,0].every((mode,index)=>history[index]===mode);
}

/**
 * The Chat draft must sit in exactly one pane, once, and that pane is the one the attached client displayed.
 * Captures are `capture-pane -p -J` texts keyed by pane id; anything else is a different delivery.
 */
export function tmuxChatDeliveredOnce(captures:readonly {paneId:string;text:string}[],draft:string,expected:string) {
  if(!draft || !captures.some(item=>item.paneId===expected) || new Set(captures.map(item=>item.paneId)).size!==captures.length)throw new Error('Owned tmux Chat readback invalid');
  const holders=captures.filter(item=>item.text.includes(draft));
  if(holders.length!==1 || holders[0].paneId!==expected || holders[0].text.split(draft).length!==2)throw new Error('Owned tmux Chat input did not reach exactly the original pane once');
}
/** The session the host's saved Default multiplexer must create, absent on the owned server; tmux refuses `:` and `.` in a name. */
export const tmuxDefaultName='my-work';
const sessionRow=/^(\$[0-9]{1,9})\|([A-Za-z0-9_-]{1,32})\|([0-9]{1,3})$/;
/** Parses one bounded `list-sessions` readback. */
export function tmuxSessionRows(text:string) {
  const lines=text.trim().split('\n');
  if(text.length>1024 || lines.length>8)throw new Error('Owned tmux session topology changed');
  return lines.map(line=>{
    const row=sessionRow.exec(line);
    if(!row)throw new Error('Owned tmux session topology changed');
    return {sessionId:row[1],name:row[2],windows:Number(row[3])};
  });
}
/** The one session beyond the original that the saved default creates, by tmux's own id. */
export type TmuxDefaultSession={sessionId:string};
/**
 * Folds one session readback. The original keeps its id and name (its windows belong to the window lifecycle); at most one other session
 * exists, only under the default name with its one window; and once seen it keeps its id, so a second creation under that name
 * (a killed and recreated session, or a second row) is a changed topology, as is a vanished one.
 */
export function tmuxDefaultSession(rows:ReturnType<typeof tmuxSessionRows>,original:{sessionId:string;name:string},seen?:TmuxDefaultSession):TmuxDefaultSession|undefined {
  const kept=rows.filter(row=>row.sessionId===original.sessionId);
  if(kept.length!==1 || kept[0].name!==original.name)throw new Error('Owned tmux original session changed');
  const extra=rows.filter(row=>row.sessionId!==original.sessionId);
  if(extra.length>1 || extra.some(row=>row.name!==tmuxDefaultName || row.windows!==1) || (seen && seen.sessionId!==extra[0]?.sessionId))
    throw new Error('Owned tmux default session topology changed');
  return extra[0] && {sessionId:extra[0].sessionId};
}
/** The default session's attach history from its first sighting (the app creates it a moment before it attaches): attach, detach, reattach and final detach. */
export function tmuxDefaultAttachVerified(history:readonly number[]) {
  const attached=history[0]===0?history.slice(1):history;
  return attached.length===4 && [1,0,1,0].every((count,index)=>attached[index]===count);
}
/** The default session's one pane started in the login directory the saved default's `-c .` resolves to. */
export function tmuxDefaultDirectory(text:string,directory:string) {
  if(text.length>512 || text.trim()!==directory)throw new Error('Owned tmux default session directory changed');
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

/** The multiplexer an owned fixture serves: tmux, or rmux driven through the same tmux-family commands. */
export type MuxBinary='tmux'|'rmux';
/** The variable that names each pinned executable; CI installs both (rmux: the `bin/rmux` of its install tree). */
export const muxVariable={tmux:'LAZYSH_TEST_TMUX',rmux:'LAZYSH_TEST_RMUX'} as const;
// Everything that differs between the two. The fixed `Owned tmux ...` messages stay as they are for both.
const flavours={
  tmux:{session:'owned-tmux',marker:'TMUX',client:['-L','default'],server:['-D','-f','/dev/null','-L','default'],
    temporary:'TMUX_TMPDIR',socketDirectory:(uid:number)=>`tmux-${uid}`,
    // `list-panes -s` takes a session target as the bare exact name.
    sessionTarget:(name:string)=>`=${name}`},
  // rmux refuses `list-panes -s -t =name`, so the trailing colon names the session's current window.
  rmux:{session:'owned-rmux',marker:'RMUX',client:['-u','-L','default'],server:['-u','-L','default','-f','/dev/null','-D'],
    temporary:'RMUX_TMPDIR',socketDirectory:(uid:number)=>`rmux-${uid}`,sessionTarget:(name:string)=>`=${name}:`},
} as const;
/** `rmux -V` prints tmux branding, so the version comes from the capability record. */
async function muxVersion(binary:MuxBinary,run:(args:string[],server:boolean)=>Promise<string>) {
  if(binary==='tmux') {
    const version=(await run(['-V'],false)).trim();
    if(!/^tmux [0-9]+[.][0-9]+[a-z]?$/.test(version))throw new Error('Owned tmux version unavailable');
    return version;
  }
  const version=(JSON.parse(await run(['capabilities','--json'],false)) as {version?:unknown}).version;
  if(typeof version!=='string' || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version))throw new Error('Owned tmux version unavailable');
  return `rmux ${version}`;
}

// The pinned server runs in the foreground of the fixture's private user
// namespace with a private socket directory, so it cannot outlive its owner.
export class TmuxFixture {
  /** The session the fixture serves: `owned-tmux` or `owned-rmux`. */
  readonly name:string;
  /** The version the host read, such as `tmux 3.4` or `rmux 0.10.0`. */
  version='';
  private server:OwnedProcess|undefined;
  private serverPid:OwnedPid|undefined;
  private windows:OwnedWindow[]=[];
  private history:number[]=[];
  private views:TmuxView[]=[];
  private lifecycle:TmuxWindowLifecycle|undefined;
  private extraPanes=0;
  private chat:OwnedChat|undefined;
  private sessionId='';
  private defaultSession:TmuxDefaultSession|undefined;
  private defaultHistory:number[]=[];
  private modes:number[]=[];
  private agent:OwnedAgent|undefined;
  private constructor(readonly ssh:SshFixture,readonly binary:MuxBinary) {this.name=flavours[binary].session;}
  /**
   * `binary` is the explicit pinned executable of that multiplexer (rmux: the `bin/rmux` of its install tree), by default from `LAZYSH_TEST_TMUX` or `LAZYSH_TEST_RMUX`.
   * With an `agent` companion the fixture also owns a synthetic Claude transcript, so the app can open it and send Chat input.
   * With `reporting` too, window alpha runs the hook-reporting stand-in agent instead of `sleep`, so the Agent view binds to a real pane.
   */
  static async start(binary?:string,agent?:string,kind:MuxBinary='tmux',reporting=false) {
    binary??=process.env[muxVariable[kind]];
    if(agent!==undefined && !isAbsolute(agent))throw new Error('Explicit current-source companion required');
    if(agent!==undefined && kind!=='tmux')throw new Error('Owned companion requires pinned tmux');
    if(reporting && agent===undefined)throw new Error('The reporting agent needs the current-source companion');
    const flavour=flavours[kind];
    if(!binary || !binary.startsWith('/'))throw new Error(`Explicit pinned ${kind} binary required`);
    const ssh=await SshFixture.start(undefined,{privateTtyGroup:true,...(kind==='rmux'?{rmuxBinary:binary}:{tmuxBinary:binary,agentBinary:agent})});
    const owned=new TmuxFixture(ssh,kind);
    try {
      owned.version=await muxVersion(kind,(args,server)=>owned.run(args,server));
      if(kind==='tmux' && !tmuxPassthroughSupported(owned.version))throw new Error('Owned tmux 3.3 or later required for escape passthrough');
      console.log(`Owned Android ${kind} fixture ${owned.version}`);
      owned.server=kind==='rmux'?ssh.rmuxServer([...flavour.server]):ssh.tmuxServer(['-v',...flavour.server]);
      const socket=join(ssh.environment![flavour.temporary]!,flavour.socketDirectory(process.getuid!()),'default');
      const until=performance.now()+3000;
      // list-sessions never starts a server, so readiness cannot admit an unowned daemon.
      while(!(await lstat(socket).then(info=>info.isSocket(),()=>false) && await owned.run(['list-sessions']).then(()=>true,()=>false))) {
        if(performance.now()>=until || !await owned.server.liveIdentity())throw new Error('Owned tmux startup deadline');
        await delay(10);
      }
      // The pinned server forwards a DCS-wrapped escape sequence from a pane to its attached clients, as tmux 3.3 added.
      if(kind==='tmux')await owned.run(['set-option','-g','allow-passthrough','on']);
      // Copy mode takes plain keys (k, V, Enter) whatever the host's EDITOR would have chosen.
      await owned.run(['set-option','-gw','mode-keys','vi']);
      if(reporting)owned.agent=await owned.prepareAgent();
      for(const [index,name] of [[0,'alpha'],[1,'beta']] as const) {
        // beta stays an interactive shell, so the app can print a passthrough sequence there; alpha only waits.
        const marker=`${flavour.marker}_${name.toUpperCase()}_${ssh.nonce}`,command=reporting && index===0?owned.agentCommand():`printf '%s\\n' '${marker}'; exec ${kind==='tmux' && name==='beta'?'/bin/sh -i':'sleep 3600'}`;
        await owned.run(index===0?['new-session','-d','-s',owned.name,'-n',name,'-x','80','-y','24','-c',ssh.directory,command]
          :['new-window','-d','-t',`=${owned.name}:${index}`,'-n',name,'-c',ssh.directory,command]);
        owned.windows.push({windowId:'',index,name,marker,paneId:'',pane:{pid:0,parent:0,start:'',state:''}});
      }
      const pid=Number((await owned.run(['display-message','-p','-t',`=${owned.name}`,'#{pid}'])).trim());
      owned.serverPid=Number.isSafeInteger(pid) && pid>0?await identity(pid):undefined;
      owned.sessionId=tmuxSessionRows(await owned.sessions()).find(row=>row.name===owned.name)?.sessionId??'';
      if(!owned.sessionId)throw new Error('Owned tmux topology changed');
      let ancestor=owned.serverPid,admitted=false;
      for(let depth=0;ancestor && depth<4 && !admitted;depth++) {admitted=ancestor.parent===owned.server.child.pid;ancestor=await identity(ancestor.parent);}
      if(!admitted)throw new Error('Owned tmux server is not the namespaced fixture server');
      const rows=tmuxPaneRows(await owned.panes());
      for(const window of owned.windows) {
        const row=rows.find(value=>value.index===window.index && value.name===window.name);
        const pane=row && await identity(row.pid);
        if(!row || row.dead || row.active!==(window.index===0) || !pane || pane.parent!==owned.serverPid!.pid)throw new Error('Owned tmux topology changed');
        Object.assign(window,{windowId:row.windowId,paneId:row.paneId,pane});
        // The stand-in repaints its pane, so its own READY record is its readiness; it first runs the companion's SessionStart hook.
        const stand=reporting && window.index===0,deadline=performance.now()+(stand?10_000:3000);
        while(!(stand?(await owned.agentLog()).includes('READY'):(await owned.run(['capture-pane','-p','-t',row.paneId])).includes(window.marker))) {
          if(performance.now()>=deadline)throw new Error('Owned tmux pane marker unavailable');
          await delay(10);
        }
      }
      if(agent && !reporting)await owned.prepareChat();
      await owned.observe();
      return owned;
    } catch(error) {
      try{await owned.stop();}catch{console.error('Owned tmux startup cleanup also failed');}
      throw error;
    }
  }
  private async run(args:string[],server=true) {
    const command=new OwnedProcess(this.ssh.ownedBinary(this.binary),server?[...flavours[this.binary].client,...args]:args,this.ssh.directory,this.ssh.environment);
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
    const found:OwnedPid[]=[];
    for(const entry of await readdir('/proc')) {
      if(!/^[1-9][0-9]{0,9}$/.test(entry) || Number(entry)===this.serverPid?.pid)continue;
      if(!this.ssh.ownsExecutable(this.binary,await readlink(`/proc/${entry}/exe`).catch(()=>'')))continue;
      const current=await identity(Number(entry));
      if(!current || ['Z','X'].includes(current.state))continue;
      if(found.length>=16)throw new Error('Owned tmux client count exceeded');
      found.push(current);
    }
    return found;
  }
  private sessions() {return this.run(['list-sessions','-F','#{session_id}|#{session_name}|#{session_windows}']);}
  private panes() {return this.run(['list-panes','-s','-t',flavours[this.binary].sessionTarget(this.name),'-F','#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{pane_id}|#{pane_pid}|#{pane_dead}']);}
  private async alive(saved:OwnedPid|undefined) {
    const current=saved && await identity(saved.pid);
    return !!current && current.start===saved?.start && current.parent===saved?.parent && !['Z','X'].includes(current.state);
  }
  /** One host sample: the original server and both pane processes, the active window and its zoom flag, plus display clients. Returns the current display-client count. */
  async observe() {
    if(!await this.server?.liveIdentity() || !await this.alive(this.serverPid) || !this.windows.length)throw new Error('Owned tmux server identity changed');
    for(const window of this.windows)if(!await this.alive(window.pane))throw new Error('Owned tmux pane identity changed');
    const windows=tmuxWindowRows(await this.run(['list-windows','-t',`=${this.name}`,'-F','#{window_id}|#{window_name}|#{window_active}|#{window_zoomed_flag}']));
    this.lifecycle=tmuxWindowLifecycle(windows,this.windows,this.lifecycle);
    this.views=[...tmuxViewHistory(windows,this.windows,this.views)];
    const count=tmuxDisplayClients(await this.run(['list-clients','-t',`=${this.name}`,'-F','#{client_control_mode}']));
    if(this.history.at(-1)!==count) {
      if(this.history.length>=8)throw new Error('Owned tmux attach history exceeded');
      this.history.push(count);
    }
    this.defaultSession=tmuxDefaultSession(tmuxSessionRows(await this.sessions()),{sessionId:this.sessionId,name:this.name},this.defaultSession);
    if(this.defaultSession) {
      const clients=tmuxDisplayClients(await this.run(['list-clients','-t',`=${tmuxDefaultName}`,'-F','#{client_control_mode}']));
      if(this.defaultHistory.at(-1)!==clients) {
        if(this.defaultHistory.length>=8)throw new Error('Owned tmux default attach history exceeded');
        this.defaultHistory.push(clients);
      }
    }
    const mode=(await this.run(['display-message','-p','-t',this.windows[0].paneId,'#{pane_in_mode}'])).trim();
    if(mode!=='0' && mode!=='1')throw new Error('Owned tmux pane mode readback invalid');
    if(this.modes.at(-1)!==Number(mode)) {
      if(this.modes.length>=8)throw new Error('Owned tmux pane mode history exceeded');
      this.modes.push(Number(mode));
    }
    return count;
  }
  /** Closed numeric evidence only; never pane text, paths or process IDs. */
  diagnostic() {return {schemaVersion:1,history:[...this.history],defaultHistory:[...this.defaultHistory],modes:[...this.modes],views:this.views.map(view=>`${view.window}${view.zoomed?'+zoom':''}`),windows:this.windows.length,server:tmuxServerStatus(this.server?.child)};}
  /** Whether window `index`'s original pane still shows `text` on the host, so bytes the app typed reached that pane's own tty. */
  async paneHolds(index:number,text:string) {
    const window=this.windows.find(value=>value.index===index);
    if(!window)throw new Error('Owned tmux topology required');
    return (await this.run(['capture-pane','-p','-t',window.paneId])).includes(text);
  }
  /** Samples until the last display client has gone, for at most five seconds. */
  private async untilDetached() {
    const deadline=performance.now()+5000;
    while(true) {
      await this.observe();
      if(this.history.at(-1)===0 || performance.now()>=deadline)break;
      await delay(25);
    }
  }
  async verifyDetachedAndReattached() {
    await this.untilDetached();
    if(!tmuxAttachHistoryVerified(this.history))throw new Error('Owned tmux attach, detach and reattach were not observed');
    const rows=tmuxPaneRows(await this.panes(),this.extraPanes);
    if(rows.filter(value=>value.name==='alpha').length!==1)throw new Error('Owned tmux remote state differs');
    for(const window of this.windows) {
      const row=rows.find(value=>value.paneId===window.paneId);
      // The app switched to beta through Jump To; the detached session keeps that window.
      if(!row || row.dead || row.windowId!==window.windowId || row.index!==window.index || row.name!==window.name
        || row.pid!==window.pane.pid || row.active!==(window.name==='beta'))throw new Error('Owned tmux remote state differs');
      if(!(await this.run(['capture-pane','-p','-t',window.paneId])).includes(window.marker))throw new Error('Owned tmux pane content changed');
    }
  }
  /** The app created one more window, renamed it and closed it: the monitor saw exactly those names in order, and no window beyond the originals now. */
  async verifyWindowLifecycle() {
    await this.observe();
    if(!this.lifecycle?.closed || this.lifecycle.names.join()!==tmuxLifecycleNames.join())throw new Error('Owned tmux window create, rename and close were not observed');
  }
  /**
   * The app split beta's original pane top/bottom and zoomed the new pane twice, so the window ends
   * unzoomed with the original pane untouched and a second pane started in its directory.
   */
  async verifySplitAndZoom() {
    const beta=this.windows.find(window=>window.name==='beta');
    if(!beta)throw new Error('Owned tmux topology required');
    const rows=tmuxSplitRows(await this.run(['list-panes','-t',beta.windowId,'-F','#{pane_id}|#{pane_pid}|#{window_zoomed_flag}|#{pane_current_path}']));
    const original=rows.find(row=>row.paneId===beta.paneId),added=rows.find(row=>row.paneId!==beta.paneId);
    if(!original || !added || original.pid!==beta.pane.pid || added.pid===beta.pane.pid || rows.some(row=>row.zoomed))throw new Error('Owned tmux split and zoom were not observed');
    if(await realpath(added.path)!==await realpath(this.ssh.directory))throw new Error('Owned tmux split directory differs');
    this.extraPanes=1;
  }
  /** One synthetic Claude record the companion reads, and a draft that is distinct per run and echoed by the pane's tty. */
  private async prepareChat() {
    const nonce=this.ssh.nonce,transcript=join(this.ssh.directory,'owned-transcript.jsonl'),record=`OWNED_TMUX_RECORD_${nonce}`;
    await writeFile(transcript,JSON.stringify({type:'user',uuid:`owned-${nonce}`,message:{role:'user',content:record}})+'\n',{mode:0o600});
    // The companion the app will run over SSH must read this record through the same private environment.
    const read=await this.ssh.client(true,`lazysh-agent transcript --agent claude --path '${transcript}' --offset 0 --limit 50`);
    const page=JSON.parse(await read.finish('owned tmux companion transcript preflight',5000));
    if(page.schemaVersion!==1 || !JSON.stringify(page.messages).includes(record))throw new Error('Owned tmux companion did not read the synthetic transcript');
    this.chat={transcript,record,draft:`tmux chat ${nonce}: it's "quoted" $HOME #{pane_id} a;b`,window:'alpha'};
  }
  /** The stand-in agent, its fixed prompts and the companion's own state directory, which the app's companion reads over SSH too. */
  private async prepareAgent() {
    const directory=this.ssh.directory;
    await writeFile(join(directory,'agent.sh'),await readFile(reportingAgentScript),{mode:0o700,flag:'wx'});
    await chmod(join(directory,'agent.sh'),0o700);
    return reportingAgentPrompts(this.ssh.nonce);
  }
  private agentCommand() {
    const directory=this.ssh.directory,[agent,log,companion]=['session.jsonl','agent.log','bin/lazysh-agent'].map(name=>`'${join(directory,name)}'`);
    // The companion's default state directory under the fixture's XDG_STATE_HOME; the app's companion reads the same one.
    return `exec bash '${join(directory,'agent.sh')}' ${agent} ${log} ${companion} '${join(directory,'state/lazysh')}' report`;
  }
  private readonly agentFile=(name:string)=>readFile(join(this.ssh.directory,name),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  private agentLog() {return this.agentFile('agent.log');}
  /**
   * After the run: the display client attached once and detached, the original server and panes survived, and the stand-in
   * received exactly the three prompts once each, in order, with no other key from any view switch.
   */
  async verifyReportingAgent() {
    const agent=this.agent,alpha=this.windows[0];
    if(!agent || alpha?.name!=='alpha')throw new Error('Owned tmux reporting agent fixture required');
    await this.untilDetached();
    if(!tmuxAttachHistoryVerified(this.history,1))throw new Error('Owned tmux agent display was not attached exactly once and then detached');
    const pane=await this.run(['capture-pane','-p','-J','-t',alpha.paneId]);
    reportingAgentDeliveredOnce(await this.agentLog(),await this.agentFile('agent.log.keys'),pane,[agent.hold,agent.sent,agent.typed]);
  }
  /** After the run: the confirmed draft is in the original pane only (by pane id), once, and that pane is the same process. */
  async verifyChatInput() {
    const chat=this.chat,alpha=this.windows.find(window=>window.name===chat?.window);
    if(!chat || !alpha)throw new Error('Owned tmux Chat fixture required');
    await this.observe();
    const captures=[];
    for(const window of this.windows)captures.push({paneId:window.paneId,text:await this.run(['capture-pane','-p','-J','-t',window.paneId])});
    tmuxChatDeliveredOnce(captures,chat.draft,alpha.paneId);
  }
  /** The app's saved default created the one missing session in the login directory, attached it, and after a disconnect attached that same session again. */
  async verifyDefaultSession() {
    const deadline=performance.now()+5000;
    while(true) {
      await this.observe();
      if(this.defaultHistory.at(-1)===0 || performance.now()>=deadline)break;
      await delay(25);
    }
    if(!this.defaultSession || !tmuxDefaultAttachVerified(this.defaultHistory))throw new Error('Owned tmux default session create, attach, detach and reattach were not observed');
    tmuxDefaultDirectory(await this.run(['list-panes','-s','-t',`=${tmuxDefaultName}`,'-F','#{pane_current_path}']),this.ssh.directory);
  }
  /** The first window's pane entered copy mode and left it, and tmux's newest buffer is exactly the line the app copied. */
  async verifyCopied() {
    await this.observe();
    if(!tmuxCopyModeVerified(this.modes))throw new Error('Owned tmux copy mode was not entered and left');
    // A selected line carries its newline.
    if(await this.run(['show-buffer'])!==`${this.windows[0].marker}\n`)throw new Error('Owned tmux copied line differs');
  }
  /** The native controls arm attaches once, verifies the original window order, and leaves the server intact. */
  async verifyNativeControls() {
    await this.verifyCopied();
    const deadline=performance.now()+5000;
    while(await this.observe()!==0 && performance.now()<deadline)await delay(25);
    if(this.history.join(',')!=='0,1,0' || this.lifecycle || this.defaultSession ||
      this.views.some(view=>view.zoomed) || this.views.map(view=>view.window).join(',')!=='alpha,beta,alpha,beta')
      throw new Error('Owned tmux native controls did not preserve the original display and windows');
  }
  /** After the split, the app pinched the zoom on and off and swiped to the next window and back: the monitor saw those states last, in that order. */
  async verifyGestures() {
    await this.observe();
    if(!tmuxGesturesVerified(this.views))throw new Error('Owned tmux pinch zoom, unzoom and two-finger window swipes were not observed');
  }
  metadata() {
    if(this.windows.length!==2)throw new Error('Owned tmux topology required');
    return {binary:this.binary,version:this.version,name:this.name,windows:this.windows.map(({index,name,marker,paneId})=>({index,name,marker,paneId})),lifecycle:[...tmuxLifecycleNames],defaultName:tmuxDefaultName,...(this.chat?{chat:this.chat}:{}),...(this.agent?{agent:this.agent}:{})};
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
