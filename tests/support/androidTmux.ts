import {join} from 'node:path';
import {lstat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {OwnedProcess,identity,type OwnedPid} from './ownedProcess';
import {SshFixture,stopOwnedServer} from './sshFixture';

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

// The pinned tmux server runs in the foreground of the fixture's private user
// namespace with a private socket directory, so it cannot outlive its owner.
export class TmuxFixture {
  readonly name='owned-tmux';
  private server:OwnedProcess|undefined;
  private serverPid:OwnedPid|undefined;
  private windows:OwnedWindow[]=[];
  private history:number[]=[];
  private stopped=false;
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
  private run(args:string[],server=true) {
    return new OwnedProcess(join(this.ssh.directory,'bin/tmux'),server?['-L','default',...args]:args,this.ssh.directory,this.ssh.environment)
      .finish('owned tmux command',3000);
  }
  private panes() {return this.run(['list-panes','-s','-t',`=${this.name}`,'-F','#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{pane_id}|#{pane_pid}|#{pane_dead}']);}
  private async alive(saved:OwnedPid|undefined) {
    const current=saved && await identity(saved.pid);
    return !!current && current.start===saved?.start && current.parent===saved?.parent && !['Z','X'].includes(current.state);
  }
  /** One host sample: the original server and both pane processes, plus display clients. */
  async observe() {
    if(!await this.server?.liveIdentity() || !await this.alive(this.serverPid) || !this.windows.length)throw new Error('Owned tmux server identity changed');
    for(const window of this.windows)if(!await this.alive(window.pane))throw new Error('Owned tmux pane identity changed');
    const count=tmuxDisplayClients(await this.run(['list-clients','-t',`=${this.name}`,'-F','#{client_control_mode}']));
    if(this.history.at(-1)!==count) {
      if(this.history.length>=8)throw new Error('Owned tmux attach history exceeded');
      this.history.push(count);
    }
  }
  /** Closed numeric evidence only; never pane text, paths or process IDs. */
  diagnostic() {return {schemaVersion:1,history:[...this.history],windows:this.windows.length};}
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
  async stop() {
    if(this.stopped)return;
    await stopOwnedServer(this.ssh,this.server,'tmux',async()=>(await Promise.all([this.serverPid,...this.windows.map(window=>window.pane)]
      .map(saved=>saved?.pid?this.alive(saved):false))).some(Boolean));
    this.stopped=true;
  }
}
