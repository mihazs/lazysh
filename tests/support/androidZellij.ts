import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {SshFixture,companionFixtureBudget} from './sshFixture';

type ActiveTab=0|1|null;
const tabNames=['alpha','beta'] as const;

/** The active tab of one bounded `list-tabs --json` readback; null while no client is attached. Anything but the owned two tabs is a changed topology. */
export function zellijActiveTab(text:string):ActiveTab {
  let tabs:unknown;
  try{tabs=JSON.parse(text);}catch{throw new Error(`Owned Zellij topology changed (unreadable, ${text.length} bytes)`);}
  if(text.length>16384 || !Array.isArray(tabs) || tabs.length!==2 || tabs.some((tab,index)=>tab?.position!==index || tab.name!==tabNames[index] || typeof tab.active!=='boolean'))
    throw new Error('Owned Zellij topology changed');
  const active=tabs.filter(tab=>tab.active);
  if(active.length>1)throw new Error('Owned Zellij topology changed');
  return active.length?active[0].position:null;
}
/** A busy session can answer one readback with nothing readable, or with a failed command; only an answer or failure that stays across several samples counts. */
export async function zellijActiveTabSettled(read:()=>Promise<string>,attempts=10):Promise<ActiveTab> {
  for(let attempt=1;;attempt++) {
    try{return zellijActiveTab(await read());}
    catch(error){if(attempt>=attempts)throw error;await Bun.sleep(25);}
  }
}
/** The attached clients of one `list-clients` readback: a header row, then one row per client. */
export function zellijClientCount(text:string) {
  const rows=text.trim().split('\n');
  if(text.length>16384 || !/^CLIENT_ID\s+ZELLIJ_PANE_ID/.test(rows[0]))throw new Error(`Owned Zellij client list unreadable (${text.length} bytes)`);
  return rows.length-1;
}
/** Attach, numbered Tab 2, tab-close detach, reattach on the remembered tab, numbered Tab 1, Jump To tab 2 and the final detach. */
export function zellijTabHistoryVerified(history:readonly ActiveTab[]) {
  const expected:ActiveTab[]=[null,0,1,null,1,0,1,null];
  return history.length===expected.length && expected.every((tab,index)=>history[index]===tab);
}

// The session is created through the fixture's own sshd, so its server lives in sshd's
// private PID namespace and retiring SSH retires it with every pane it started.
export class ZellijFixture {
  readonly name:string;
  private history:ActiveTab[]=[];
  private constructor(readonly ssh:SshFixture,private readonly markers:Record<(typeof tabNames)[number],string>,name?:string) {this.name=name??`owned-zellij-${ssh.nonce.slice(0,12)}`;}
  /** `name` fixes the session's name for a saved host that must name it before the fixture exists. */
  static async start(binary=process.env.LAZYSH_TEST_ZELLIJ,name?:string) {
    if(!binary || !binary.startsWith('/'))throw new Error('Explicit pinned Zellij binary required');
    const ssh=await SshFixture.start(undefined,{privateTtyGroup:true,zellijBinary:binary,shellSeconds:companionFixtureBudget/1000});
    const markers={alpha:`ZELLIJ_ALPHA_${ssh.nonce}`,beta:`ZELLIJ_BETA_${ssh.nonce}`};
    const owned=new ZellijFixture(ssh,markers,name);
    try {
      const version=(await ssh.zellij(['--version'])).trim();
      if(version!=='zellij 0.45.1')throw new Error('Owned Zellij version unavailable');
      console.log(`Owned Android Zellij fixture ${version}`);
      // One command pane per tab; each records every start so a restarted pane is detectable, and borderless keeps its title out of the screen.
      const tab=(name:(typeof tabNames)[number])=>`tab name="${name}" { pane command="sh" borderless=true { args "-c" "echo started >> '${owned.starts(name)}'; echo '${markers[name]}'; exec sleep 3600"; }; }`;
      await writeFile(join(ssh.directory,'config','zellij','layouts','owned.kdl'),`layout {\n${tabNames.map(tab).join('\n')}\n}\n`,{mode:0o600});
      await (await ssh.client(true,`zellij attach --create-background '${owned.name}' options --default-layout owned`)).finish('owned Zellij session creation',10_000);
      const deadline=performance.now()+10_000;
      while(true) {
        if(await owned.read().then(()=>true,()=>false))break;
        if(performance.now()>=deadline)throw new Error('Owned Zellij startup deadline');
        await Bun.sleep(50);
      }
      for(const name of tabNames)await owned.waitStarted(name,deadline);
      return owned;
    } catch(error) {
      try{await owned.stop();}catch{console.error('Owned Zellij startup cleanup also failed');}
      throw error;
    }
  }
  private starts(name:(typeof tabNames)[number]) {return join(this.ssh.directory,`starts-${name}`);}
  private async waitStarted(name:(typeof tabNames)[number],deadline:number) {
    while(await readFile(this.starts(name),'utf8').catch(()=>'')!=='started\n') {
      if(performance.now()>=deadline)throw new Error('Owned Zellij pane start unavailable');
      await Bun.sleep(25);
    }
  }
  private read() {return zellijActiveTabSettled(()=>this.ssh.zellij(['--session',this.name,'action','list-tabs','--json']));}
  /** One host sample of the session's own active tab; only changes are kept. */
  async observe() {
    const active=await this.read();
    if(this.history.at(-1)!==active) {
      if(this.history.length>=12)throw new Error('Owned Zellij attach history exceeded');
      this.history.push(active);
    }
  }
  /** Closed numeric evidence only; never pane text, paths or process IDs. */
  diagnostic() {return {schemaVersion:1,history:[...this.history],tabs:tabNames.length};}
  async verifyDetachedAndReattached() {
    const deadline=performance.now()+5000;
    while(true) {
      await this.observe();
      if(this.history.at(-1)===null || performance.now()>=deadline)break;
      await Bun.sleep(25);
    }
    if(!zellijTabHistoryVerified(this.history))throw new Error('Owned Zellij attach, numbered tabs and detach were not observed');
    // The original command panes ran exactly once: no detach, reattach or tab switch restarted them.
    await this.checkOriginal();
  }
  private async checkOriginal() {
    if((await this.ssh.zellij(['list-sessions','--short','--no-formatting'])).trim()!==this.name)throw new Error('Owned Zellij sessions changed');
    // Each command pane started exactly once: its shell is the original process, not a restarted one.
    for(const name of tabNames)if(await readFile(this.starts(name),'utf8')!=='started\n')throw new Error('Owned Zellij pane restarted');
  }
  /** One restore sample: the original session and panes are intact; returns the attached display clients. */
  async observeRestore() {
    await this.read();
    await this.checkOriginal();
    return {clients:zellijClientCount(await this.ssh.zellij(['--session',this.name,'action','list-clients']))};
  }
  /** Whether the second tab's pane (`terminal_1`, the one the restore cases type into) still shows `text`. */
  async paneHolds(text:string) {return (await this.ssh.zellij(['--session',this.name,'action','dump-screen','--pane-id','terminal_1'])).includes(text);}
  metadata() {return {name:this.name,tabs:tabNames.map((name,position)=>({position,name,marker:this.markers[name]}))};}
  private stopping:Promise<void>|undefined;
  /** Idempotent: every caller observes the one teardown's result. */
  stop() {return this.stopping??=this.ssh.stop();}
}
