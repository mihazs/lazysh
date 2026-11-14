import {expect,it} from 'vitest';
import {ownedSshGui} from './sshUi';
import {ReportingAgent} from './reportingAgent';

const fixture=ownedSshGui();
// A real agent turn is a section of the conversation; the report of its pane is what binds the view to it.
const turns='section.agent-view:not([hidden]) section.agent-turn';

/** Opens the Agent view of the pane and waits until it follows the agent's own conversation. */
async function showAgent(agent:ReportingAgent,expected:string) {
  const {browser}=agent;
  await (await browser.$(`${ReportingAgent.switcher} button[aria-label="Agent"]`)).click();
  const view=await browser.$('section.agent-view:not([hidden])');await view.waitForDisplayed({timeout:20_000});
  try {await browser.waitUntil(async()=>(await view.getText()).includes(expected),{timeout:30_000});}
  catch {throw new Error(`The Agent view did not follow the reporting pane (${expected}): ${await view.getText()}`);}
  return view;
}
const showTerminal=async(agent:ReportingAgent)=>{
  await (await agent.browser.$(`${ReportingAgent.switcher} button[aria-label="Terminal"]`)).click();
  await agent.terminal.waitForDisplayed({timeout:20_000});
};

it('keeps one connection, one PTY and its scrollback, and writes nothing to the pane, when Terminal, Agent and Terminal are switched mid-turn',async()=>{
  const agent=await ReportingAgent.start(fixture),{browser,terminal}=agent;
  await agent.type('hold the build');
  await browser.waitUntil(async()=>(await agent.log()).includes('HOLD'),{timeout:20_000,timeoutMsg:'The held turn did not start'});
  const before={pane:await agent.pane(),keys:await agent.keys(),node:terminal.elementId};
  expect(before.pane.count).toBe(1);

  agent.gui.stage='owned Agent view mid-turn';
  const view=await showAgent(agent,'hold the build');
  await terminal.waitForDisplayed({reverse:true});
  // The turn is still running: the pane's report says working and the conversation has no answer yet.
  expect(await (await view.$('header')).getProperty('textContent')).toContain('Working');
  expect(await (await view.$(turns)).getAttribute('data-running')).toBe('true');

  agent.gui.stage='owned terminal after the mid-turn Agent view';
  await showTerminal(agent);
  expect((await browser.$('.terminal-canvas .xterm-screen')).elementId).toBe(before.node);
  expect({pane:await agent.pane(),keys:await agent.keys()}).toEqual({pane:before.pane,keys:before.keys});

  agent.gui.stage='owned Agent view again, then the turn ends';
  await showAgent(agent,'hold the build');
  await agent.release();
  await browser.waitUntil(async()=>(await view.getText()).includes('Finished the held work.'),{timeout:30_000,timeoutMsg:'The finished turn did not reach the Agent view'});
  expect(await browser.$$(turns)).toHaveLength(1);
  expect(await (await view.$(turns)).getAttribute('data-running')).toBeNull();
  await showTerminal(agent);
  expect((await agent.pane()).clients).toBe(before.pane.clients);
  expect(await agent.keys()).toEqual(before.keys);
},180_000);

/** The codes the pane receives for a prompt sent as text and Enter, as the agent's key log records them. */
const keyCodes=(text:string)=>Array.from(text,character=>String(character.codePointAt(0)));

it('shows a prompt sent from the Agent view once in the pane and as a turn of the conversation',async()=>{
  const agent=await ReportingAgent.start(fixture),{browser,terminal}=agent;
  await agent.type('first question');
  await browser.waitUntil(async()=>(await agent.submitted()).length===1,{timeout:20_000,timeoutMsg:'The first prompt did not reach the agent'});
  const view=await showAgent(agent,'Answered: first question');
  const keysBefore=(await agent.keys()).length;

  agent.gui.stage='owned prompt sent from the Agent view';
  const draft=await view.$('textarea[aria-label="Draft for this terminal"]');
  await draft.setValue('Add a test');
  const send=await view.$('button[aria-label="Send to the agent"]');
  await browser.waitUntil(()=>send.isEnabled(),{timeout:20_000,timeoutMsg:'The Agent view composer did not bind to the pane'});
  await send.click();
  await browser.waitUntil(async()=>(await view.getText()).includes('Answered: Add a test'),{timeout:30_000,timeoutMsg:'The sent prompt did not become a turn'});
  expect(await browser.$$(turns)).toHaveLength(2);
  // The pane's process got the prompt and one Enter; a second delivery would log a second submission.
  expect(await agent.submitted()).toEqual(['first question','Add a test']);
  // The guarded send ends the line with Enter, which the pane's tty delivers as CR or LF.
  const keys=(await agent.keys()).slice(keysBefore);
  expect(keys.slice(0,-1)).toEqual(keyCodes('Add a test'));expect(['13','10']).toContain(keys.at(-1));

  await showTerminal(agent);
  // The pane painted the prompt while hidden; it shows once, and the agent's own log above is the count of deliveries.
  await browser.waitUntil(async()=>(await terminal.getText()).includes('> Add a test'),{timeout:20_000,timeoutMsg:'The sent prompt is not shown in the pane'});
  expect((await terminal.getText()).split('> Add a test')).toHaveLength(2);
  expect((await agent.pane()).count).toBe(1);
},180_000);

it('shows a prompt typed in the terminal as a new turn of the Agent view within one follow interval',async()=>{
  const agent=await ReportingAgent.start(fixture),{browser}=agent;
  await agent.type('first question');
  await browser.waitUntil(async()=>(await agent.submitted()).length===1,{timeout:20_000,timeoutMsg:'The first prompt did not reach the agent'});
  const view=await showAgent(agent,'Answered: first question');

  // Both shows the pane and its conversation side by side, so the terminal takes the typing while the view follows.
  agent.gui.stage='owned prompt typed beside the Agent view';
  // The sessions list takes 300 px, and Both needs 1100 px of session area.
  await browser.setWindowSize(1500,900);
  await (await browser.$(`${ReportingAgent.switcher} button[aria-label="Both"]`)).click();
  await agent.terminal.waitForDisplayed({timeout:20_000});await view.waitForDisplayed();
  await agent.type('Typed here');
  const sent=await agent.waitFor('SUBMIT Typed here');
  await browser.waitUntil(async()=>(await view.getText()).includes('Answered: Typed here'),{timeout:30_000,interval:50,timeoutMsg:'The typed prompt did not become a turn'});
  const latency=Date.now()-sent;
  console.info(`Owned Agent view follow latency=${latency}ms`);
  // One 2 second follow interval plus the SSH exec round trip and the shared runner's slack.
  expect(latency).toBeLessThan(5000);
  expect(await browser.$$(turns)).toHaveLength(2);
  expect(await agent.submitted()).toEqual(['first question','Typed here']);
},180_000);
