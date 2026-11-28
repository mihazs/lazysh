import type {SshFixture} from '../../../tests/support/sshFixture';
import type {NativeGui} from './fixture';

type Browser=NonNullable<NativeGui['browser']>;
type Hook=Record<string,unknown>;
/** Reports for one owned host: pane, session, project and the hook events that session sent. */
export type HostReports=[string,string,string,Hook[]][];
const PANEL='section.agent-panel:not([hidden])';

/** Runs the current-source companion's Claude hook command on the owned host as an agent's hook does: the event on stdin, the pane in the multiplexer environment. */
export async function hook(ssh:SshFixture,companion:string,command:string,pane:string,event:Hook) {
  const process=await ssh.client(true,`TMUX_PANE=${pane} '${companion}' ${command}`);
  process.child.stdin!.end(JSON.stringify(event));
  return process;
}
export async function report(ssh:SshFixture,companion:string,pane:string,session:string,project:string,event:Hook) {
  // Everything but the event name, session and folder is private to the host: the board must never receive them.
  const ingest=await hook(ssh,companion,'ingest --agent claude',pane,{session_id:session,cwd:project,response:'PRIVATE-PROMPT',tool_input:{token:'SECRET-TOKEN'},...event});
  await ingest.finish(`owned companion lifecycle report for ${session}`,10_000);
}
export async function reportAll(ssh:SshFixture,companion:string,reports:HostReports) {
  for(const [pane,session,project,events] of reports)for(const event of events)await report(ssh,companion,pane,session,project,event);
}

/** Opens Agents, Activity of the active connection and returns its board panel. */
export async function openActivity(browser:Browser) {
  await (await browser.$('button[data-workspace-mode="agents"]')).click();
  await (await browser.$('button=Activity')).click();
  const panel=await browser.$(PANEL);await panel.waitForDisplayed({timeout:20_000});
  return panel;
}
export const cards=(browser:Browser)=>browser.execute((panel:string)=>document.querySelectorAll(`${panel} article.agent-card`).length,PANEL);
/** Refreshes the shown board until `probe` holds; the panel is found anew each time because switching scope replaces its controls. */
export async function settle(browser:Browser,what:string,probe:()=>Promise<boolean>) {
  await browser.waitUntil(async()=>{
    const refresh=await browser.$(`${PANEL} button[title="Refresh"]`);
    await refresh.waitForEnabled();await refresh.click();
    return probe();
  },{timeout:30_000,interval:500,timeoutMsg:`Owned board did not show ${what}`});
}
