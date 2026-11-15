import {chmod,mkdir,readFile,symlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {expect,vi} from 'vitest';
import {HerdrFixture,herdrTools} from '../../../tests/support/androidHerdr';
import {SshFixture} from '../../../tests/support/sshFixture';
import {NativeGui} from './fixture';
import {socketInventory} from './socketOwner';
import {openOwnedSsh,ownedCompanionSsh,ownedSshGui,typeText} from './sshUi';
import {tmuxClients} from './tmuxPane';

type Browser=NonNullable<NativeGui['browser']>;
type Fixture=ReturnType<typeof ownedSshGui>;
const lines=(path:string)=>readFile(path,'utf8').then(text=>text.split('\n').filter(Boolean),()=>[] as string[]);
/** The session id the stand-in writes in every record of its transcript. */
const session='5f0c1d2e-0000-4000-8000-0000000000aa';
/** Output a pane prints before its agent starts; the agent only clears the visible screen, so this is the scrollback a switch must not lose. */
const earlierOutput='i=0; while [ "$i" -lt 120 ]; do echo EARLIER_OUTPUT_$i; i=$((i+1)); done';
/** What the multiplexer says about the pane the GUI shows: a byte lazysh wrote to it or a reflow would change `pane`, and a reconnect would change `clients`. */
export type PaneObservation={pane:string;clients:string;count:number};

/**
 * The shared fixture agent (`src-tauri/src/tmux_agent_session_agent.sh`, also driven by the Rust scripted session) running in a
 * real multiplexer pane of an owned SSH server, behind the real GUI. It logs every key its pane receives, so a byte nobody typed
 * and the Agent view did not send shows up there.
 */
export abstract class ReportingAgent {
  static readonly switcher='div[role="group"][aria-label="Session view"]';
  protected constructor(readonly gui:NativeGui,readonly ssh:SshFixture,readonly browser:Browser,readonly terminal:Awaited<ReturnType<Browser['$']>>) {}
  private path(name:string) {return join(this.ssh.directory,name);}
  /** What the agent logged: READY, SUBMIT <prompt>, HOLD, HOLD_ENDED and the other events of the stand-in. */
  log() {return lines(this.path('agent.log'));}
  /** The code of every key the agent's pane received, one per line. */
  keys() {return lines(this.path('agent.log.keys'));}
  submitted() {return this.log().then(rows=>rows.filter(row=>row.startsWith('SUBMIT ')).map(row=>row.slice(7)));}
  /**
   * Asserts what the pane submitted. A mismatch names the key codes the pane received, so a dropped character shows
   * whether it never reached the pane (a code is missing) or reached it and was misread.
   */
  async expectSubmitted(expected:string[]) {
    const actual=await this.submitted();
    if(JSON.stringify(actual)===JSON.stringify(expected))return;
    const codes=(await this.keys().catch(()=>[] as string[])).filter(key=>/^\d{1,3}$/.test(key));
    throw new Error(`The pane submitted ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}; expected key codes ${expected.flatMap(text=>Array.from(text,character=>String(character.codePointAt(0)))).join(' ')}, pane received ${codes.slice(-64).join(' ')}`);
  }
  /** Waits for the agent to log `row` and returns when it was seen, to the poll's resolution. */
  async waitFor(row:string) {
    try {await this.browser.waitUntil(async()=>(await this.log()).includes(row),{timeout:20_000,interval:20,timeoutMsg:`The agent did not log ${row}`});}
    catch(error) {
      // The stand-in logs key codes from this owned test pane, not the SSH key used to connect.
      try {
        const keys=await this.keys(),submitted=await this.submitted();
        console.info('Owned reporting agent input state',JSON.stringify({keyCount:keys.length,recentKeyCodes:keys.slice(-64).filter(key=>/^\d{1,3}$/.test(key)),submittedCount:submitted.length}));
      } catch { /* Keep the original wait failure if diagnostics fail. */ }
      throw error;
    }
    return Date.now();
  }
  /** Lets a `hold` turn finish. */
  release() {return writeFile(this.path('agent.log.release'),'');}
  abstract pane():Promise<PaneObservation>;
  /** Types into the visible terminal as a user does and presses Enter. */
  async type(text:string) {await this.terminal.click();await typeText(this.browser,`${text}\n`);}
  /** Copies the stand-in into the owned root; the multiplexer's pane runs it from there. */
  protected static async install(directory:string) {
    const script=join(directory,'agent.sh');
    await writeFile(script,await readFile(join(import.meta.dirname,'../src-tauri/src/tmux_agent_session_agent.sh')),{mode:0o700,flag:'wx'});
    return script;
  }
}

/** The stand-in in a real tmux pane. It runs the real companion's `ingest` hook with the pane's `TMUX_PANE`, so the Agent view binds to its conversation the way it does to a pane of the agent it stands in for: `claude` writes a Claude Code transcript and reports its path (`--reported-history`), `opencode` writes OpenCode 2.2's database under `XDG_DATA_HOME` and reports only its status, which the view matches to the database's session. */
export class TmuxReportingAgent extends ReportingAgent {
  private constructor(gui:NativeGui,ssh:SshFixture,browser:Browser,terminal:ReportingAgent['terminal'],readonly name:string) {super(gui,ssh,browser,terminal);}
  /** The tmux server's view of the pane the GUI shows. */
  async pane() {
    const [pane,clients]=await Promise.all([
      this.ssh.tmux(['display-message','-p','-t',this.name,'#{pane_id}:#{pane_pid}:#{pane_tty}:#{history_size}:#{cursor_x}:#{cursor_y}']),
      this.ssh.tmux(['list-clients','-F','#{client_pid}:#{client_tty}']),
    ]);
    return {pane,clients,count:await tmuxClients(this.ssh)};
  }

  static async start(fixture:Fixture,flavour:'claude'|'opencode'='claude') {
    fixture.captureSafe=false;
    const {ssh,companion}=await ownedCompanionSsh(fixture,undefined,{tmux:process.env.LAZYSH_TEST_TMUX??true});
    const script=await this.install(ssh.directory);
    // A short command to type: the pane's shell replaces itself with the agent.
    const [transcript,report]=flavour==='opencode'?['data/opencode/opencode.db','opencode']:['session.jsonl','report'];
    await writeFile(join(ssh.directory,'launch.sh'),`d=$(dirname "$0")\n${earlierOutput}\nexec bash '${script}' "$d/${transcript}" "$d/agent.log" '${companion}' "$d/state" ${report}\n`,{mode:0o700,flag:'wx'});
    await chmod(join(ssh.directory,'launch.sh'),0o700);
    const gui=fixture.gui=await NativeGui.start();
    const name=`agent-${ssh.nonce.slice(0,12)}`;
    const {browser,terminal}=await openOwnedSsh(gui,ssh,'ssh',ssh.port,{kind:'tmux',name});
    const agent=new TmuxReportingAgent(gui,ssh,browser,terminal,name);
    gui.stage='owned reporting agent launch';
    await agent.type(`exec bash ${ssh.directory}/launch.sh`);
    await agent.waitFor('READY');
    expect(Number(await ssh.tmux(['display-message','-p','-t',name,'#{history_size}']))).toBeGreaterThan(0);
    return agent;
  }
}

/** Every established connection to the owned server as its sshd sees it (port, the client's port, the socket's inode): a reconnect changes the row. */
async function sshConnections(port:number) {
  const address=`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`;
  const rows=(await socketInventory()).split('\n').slice(1).map(row=>row.trim().split(/\s+/)).filter(fields=>fields[1]===address && fields[3]==='01');
  return rows.map(fields=>[fields[1],fields[2],fields[9]].join(' ')).sort();
}

/**
 * The stand-in in a real guarded Herdr pane, started under the name `claude` because Herdr detects an agent by its process. Herdr
 * links the conversation of the focused pane by the session that agent reports, which the transcript below answers to; the
 * stand-in reports its state to Herdr's own CLI (see its `hook`).
 */
export class HerdrReportingAgent extends ReportingAgent {
  private constructor(gui:NativeGui,private readonly herdr:HerdrFixture,browser:Browser,terminal:ReportingAgent['terminal'],private readonly paneId:string) {super(gui,herdr.ssh,browser,terminal);}
  /** Herdr's view of the pane (its terminal, tab and scrollback length) and the server's SSH connections; the fixture's original receiver pane must stay empty. */
  async pane() {
    const info=JSON.parse(await this.herdr.run(['pane','get',this.paneId])).result.pane;
    await this.herdr.expectBytes(Buffer.alloc(0));
    const connections=await sshConnections(this.ssh.port);
    return {pane:[info.pane_id,info.terminal_id,info.tab_id,info.scroll.max_offset_from_bottom].join(':'),clients:connections.join('\n'),count:connections.length};
  }

  static async start(fixture:Fixture) {
    fixture.captureSafe=false;
    const herdr=await HerdrFixture.start(herdrTools());fixture.ssh=herdr;
    const {ssh}=herdr,directory=ssh.directory;
    const script=await this.install(directory);
    // Herdr resolves a reported Claude session in the agent's own home: `$HOME/.claude/projects/<folder>/<session>.jsonl`.
    const transcript=join(directory,'.claude','projects','-work-fixture',`${session}.jsonl`);
    await mkdir(dirname(transcript),{recursive:true,mode:0o700});
    await symlink('/bin/bash',join(directory,'bin','claude'));
    // The agent's tab is the focused one, so the attached client types into it and the Agent view follows it.
    const tab=JSON.parse(await herdr.run(['tab','create','--workspace',herdr.metadata().agent.workspaceId,'--cwd',directory,'--label','OWNED_AGENT','--focus'])).result;
    const pane:string=tab.root_pane.pane_id;
    // Output before the agent starts is the scrollback a switch must not lose; the agent only clears the visible screen.
    await herdr.run(['pane','run',pane,`${earlierOutput}; exec '${directory}/bin/claude' '${script}' '${transcript}' '${directory}/agent.log' '${directory}/bin/lazysh-agent' '${directory}/state' keys`]);
    // Herdr admits a session report only while it detects the agent, which it does a moment after the process starts.
    await vi.waitFor(async()=>{
      const agents:{pane_id:string;agent:string}[]=JSON.parse(await herdr.run(['api','snapshot'])).result.snapshot.agents;
      if(!agents.some(row=>row.pane_id===pane && row.agent==='claude'))throw new Error('Owned Claude stand-in was not detected');
    },{timeout:15_000,interval:100});
    await herdr.run(['pane','report-agent-session',pane,'--source','herdr:claude','--agent','claude','--agent-session-id',session]);
    const gui=fixture.gui=await NativeGui.start();
    const {browser,terminal}=await openOwnedSsh(gui,ssh,'ssh',ssh.port,{kind:'herdr',name:herdr.name});
    const agent=new HerdrReportingAgent(gui,herdr,browser,terminal,pane);
    await agent.waitFor('READY');
    return agent;
  }
}
