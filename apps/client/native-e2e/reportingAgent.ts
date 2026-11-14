import {chmod,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {openOwnedSsh,ownedCompanionSsh,ownedSshGui,typeText} from './sshUi';
import {tmuxClients} from './tmuxPane';

type Browser=NonNullable<NativeGui['browser']>;
const lines=(path:string)=>readFile(path,'utf8').then(text=>text.split('\n').filter(Boolean),()=>[] as string[]);

/**
 * The shared fixture agent (`src-tauri/src/tmux_agent_session_agent.sh`, also driven by the Rust scripted session) running in a
 * real tmux pane of an owned SSH server. It runs the real companion's `ingest --reported-history` hook with the pane's `TMUX_PANE`,
 * so the Agent view binds to its conversation the way it does to a Claude Code pane.
 */
export class ReportingAgent {
  static readonly switcher='div[role="group"][aria-label="Session view"]';
  private constructor(readonly gui:NativeGui,readonly ssh:SshFixture,readonly browser:Browser,readonly terminal:Awaited<ReturnType<Browser['$']>>,readonly name:string) {}
  private path(name:string) {return join(this.ssh.directory,name);}
  /** What the agent logged: READY, SUBMIT <prompt>, HOLD, HOLD_ENDED and the other events of the stand-in. */
  log() {return lines(this.path('agent.log'));}
  /** The code of every key the agent's pane received, one per line. */
  keys() {return lines(this.path('agent.log.keys'));}
  submitted() {return this.log().then(rows=>rows.filter(row=>row.startsWith('SUBMIT ')).map(row=>row.slice(7)));}
  /** Waits for the agent to log `row` and returns when it was seen, to the poll's resolution. */
  async waitFor(row:string) {
    await this.browser.waitUntil(async()=>(await this.log()).includes(row),{timeout:20_000,interval:20,timeoutMsg:`The agent did not log ${row}`});
    return Date.now();
  }
  /** Lets a `hold` turn finish. */
  release() {return writeFile(this.path('agent.log.release'),'');}
  /** The tmux server's view of the pane the GUI shows; any byte lazysh wrote to or reflowed in the pane would change it. */
  async pane() {
    const [pane,clients]=await Promise.all([
      this.ssh.tmux(['display-message','-p','-t',this.name,'#{pane_id}:#{pane_pid}:#{pane_tty}:#{history_size}:#{cursor_x}:#{cursor_y}']),
      this.ssh.tmux(['list-clients','-F','#{client_pid}:#{client_tty}']),
    ]);
    return {pane,clients,count:await tmuxClients(this.ssh)};
  }
  /** Types into the visible terminal as a user does and presses Enter. */
  async type(text:string) {await this.terminal.click();await typeText(this.browser,`${text}\n`);}

  static async start(fixture:ReturnType<typeof ownedSshGui>) {
    fixture.captureSafe=false;
    const {ssh,companion}=await ownedCompanionSsh(fixture,undefined,{tmux:process.env.LAZYSH_TEST_TMUX??true});
    const root=join(import.meta.dirname,'../src-tauri/src/tmux_agent_session_agent.sh');
    await writeFile(join(ssh.directory,'agent.sh'),await readFile(root),{mode:0o700,flag:'wx'});
    // A short command to type: the pane's shell replaces itself with the agent.
    await writeFile(join(ssh.directory,'launch.sh'),`d=$(dirname "$0")\nexec bash "$d/agent.sh" "$d/session.jsonl" "$d/agent.log" '${companion}' "$d/state" report\n`,{mode:0o700,flag:'wx'});
    await chmod(join(ssh.directory,'launch.sh'),0o700);
    const gui=fixture.gui=await NativeGui.start();
    const name=`agent-${ssh.nonce.slice(0,12)}`;
    const {browser,terminal}=await openOwnedSsh(gui,ssh,'ssh',ssh.port,{kind:'tmux',name});
    const agent=new ReportingAgent(gui,ssh,browser,terminal,name);
    gui.stage='owned reporting agent launch';
    await agent.type(`exec bash ${ssh.directory}/launch.sh`);
    await browser.waitUntil(async()=>(await agent.log()).includes('READY'),{timeout:20_000,timeoutMsg:'Reporting agent did not start in its pane'});
    return agent;
  }
}
