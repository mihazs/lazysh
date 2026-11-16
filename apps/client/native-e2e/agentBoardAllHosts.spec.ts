import {rename} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {cards,openActivity,reportAll,settle,type HostReports} from './agentBoardUi';
import {openOwnedSsh,ownedCompanionSsh,ownedSshGui} from './sshUi';

const fixture=ownedSshGui();
const FIRST='Owned SSH GUI host',SECOND='Owned SSH GUI second host';
const PANEL='section.agent-panel:not([hidden])';

it('merges the reported agents of two owned SSH hosts by state, host and project, keeps a failing host\'s error beside the other rows and opens a row\'s host',async()=>{
  const first=await ownedCompanionSsh(fixture),second=await ownedCompanionSsh(fixture);
  const gui=fixture.gui=await NativeGui.start();
  const {terminal}=await openOwnedSsh(gui,first.ssh);
  await openOwnedSsh(gui,second.ssh,'ssh',undefined,undefined,SECOND);
  fixture.captureSafe=true;
  const browser=gui.browser!;
  const prompt={hook_event_name:'UserPromptSubmit'},tool={hook_event_name:'PreToolUse',tool_name:'Bash'};

  gui.stage='owned all-hosts hook events';
  // Each host answers from its own companion store; "all-build" is one session id reported by both hosts.
  const firstReports:HostReports=[
    ['%3','all-gate','/work/alpha',[prompt,tool,{hook_event_name:'Notification',notification_type:'permission_prompt'}]],
    ['%4','all-build','/work/alpha',[prompt,tool]],
    ['%5','all-docs','/work/docs',[prompt]],
  ];
  const secondReports:HostReports=[
    ['%3','all-build','/work/alpha',[prompt,tool]],
    ['%4','all-ship','/work/ship',[prompt,{hook_event_name:'Stop'}]],
  ];
  await reportAll(first.ssh,first.companion,firstReports);
  await reportAll(second.ssh,second.companion,secondReports);

  const layout=()=>browser.execute((panel:string)=>Array.from(document.querySelectorAll(`${panel} section.agent-column`),column=>({
    state:column.getAttribute('data-state'),
    // Hosts are listed in connection order; the label order keeps this case independent of it.
    hosts:Array.from(column.querySelectorAll('section.agent-host-group'),host=>({
      host:host.getAttribute('aria-label'),
      projects:Array.from(host.querySelectorAll('section.agent-project-group'),group=>({project:group.getAttribute('aria-label'),rows:Array.from(group.querySelectorAll('.agent-row-summary'),row=>row.textContent)})),
    })).sort((one,other)=>String(one.host).localeCompare(String(other.host))),
  })),PANEL);
  const projects=()=>browser.execute((panel:string)=>Array.from(document.querySelectorAll(`${panel} section.agent-project-group`),group=>group.getAttribute('aria-label')).sort(),PANEL);
  const failing=()=>browser.execute((panel:string)=>Array.from(document.querySelectorAll(`${panel} p.agent-host-error[role="alert"]`),error=>error.querySelector('strong')?.textContent),PANEL);
  const scope=(name:string)=>browser.$(`${PANEL} .agent-scope button=${name}`);

  gui.stage='owned all-hosts own board';
  const panel=await openActivity(browser);
  // The newest connection is active, and its board is the default: nothing merges until All hosts is chosen.
  await settle(browser,'the active host\'s own rows',async()=>await cards(browser)===2);
  expect(await projects()).toEqual([`alpha on ${SECOND}`,`ship on ${SECOND}`]);
  expect(await (await scope('This host')).getAttribute('aria-pressed')).toBe('true');

  gui.stage='owned all-hosts merged board';
  await (await scope('All hosts')).click();
  await settle(browser,'the rows of both hosts',async()=>await cards(browser)===5);
  expect(await layout()).toEqual([
    {state:'needs_attention',hosts:[{host:FIRST,projects:[{project:`alpha on ${FIRST}`,rows:['Agent needs attention']}]}]},
    {state:'working',hosts:[
      {host:FIRST,projects:[{project:`docs on ${FIRST}`,rows:['Working on your prompt']},{project:`alpha on ${FIRST}`,rows:['Bash']}]},
      {host:SECOND,projects:[{project:`alpha on ${SECOND}`,rows:['Bash']}]},
    ]},
    {state:'done',hosts:[{host:SECOND,projects:[{project:`ship on ${SECOND}`,rows:['Turn finished']}]}]},
  ]);
  expect(await failing()).toEqual([]);
  expect(await (await panel.$('.agent-board')).getText()).not.toMatch(/PRIVATE-PROMPT|SECRET-TOKEN/);

  gui.stage='owned all-hosts failing host';
  // The connection stays up and its companion goes away, so only that host's read fails.
  await rename(second.companion,`${second.companion}.stopped`);
  await settle(browser,'the second host\'s error',async()=>(await failing()).length===1);
  expect(await failing()).toEqual([SECOND]);
  expect(await cards(browser)).toBe(3);
  expect(await layout()).toEqual([
    {state:'needs_attention',hosts:[{host:FIRST,projects:[{project:`alpha on ${FIRST}`,rows:['Agent needs attention']}]}]},
    {state:'working',hosts:[{host:FIRST,projects:[{project:`docs on ${FIRST}`,rows:['Working on your prompt']},{project:`alpha on ${FIRST}`,rows:['Bash']}]}]},
  ]);

  gui.stage='owned all-hosts open a row';
  // A working row: a Needs you row with a pane opens the pending card in the Agent view instead of the board.
  const row=await panel.$(`section.agent-column[data-state="working"] button[aria-label="Open Claude Code report for /work/docs on ${FIRST}"]`);
  await row.click();
  await terminal.waitForDisplayed({timeout:20_000});
  await browser.waitUntil(async()=>await (await scope('This host')).getAttribute('aria-pressed')==='true',{timeout:20_000,timeoutMsg:'The opened host did not show its own board'});
  await settle(browser,'the opened host\'s own rows',async()=>await cards(browser)===3);
  expect(await projects()).toEqual([`alpha on ${FIRST}`,`alpha on ${FIRST}`,`docs on ${FIRST}`]);
  expect(gui.connections).toBe(0);
},300_000);
