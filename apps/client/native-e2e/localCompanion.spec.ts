import {afterEach,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdir,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {NativeGui} from './fixture';

let fixture:NativeGui|undefined;
afterEach(async context=>{
  const owned=fixture;fixture=undefined;if(!owned)return;
  if(context.task.result?.state==='fail') {
    console.error(`Owned local companion GUI failure stage: ${owned.stage}`);
    try{await owned.screenshot();}catch{console.error('Owned GUI screenshot unavailable');}
  }
  await owned.stop();
});

it('shows a hook event of a local agent on the Agents board under This device and answers its approval, with no SSH connection',async()=>{
  // The current-source companion, as the other owned companion cases take it.
  const source=process.env.LAZYSH_TEST_AGENT_BIN;
  if(!source?.startsWith('/'))throw new Error('An owned current-source companion binary is required');
  fixture=await NativeGui.startWithCompanion(await readFile(source));
  const gui=fixture,browser=gui.browser!;
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  const home=join(gui.directory,'home'),project=join(home,'local-agent');await mkdir(project,{recursive:true});
  gui.stage='local terminal launch';
  await gui.secondary(['--dir','local-agent'],home);
  await (await browser.$('.terminal-canvas .xterm-screen')).waitForDisplayed({timeout:20_000});

  gui.stage='local Agents navigation';
  const agents=await browser.$('.workspace-navigation-modes button[aria-label="Agents navigation"]');
  await agents.waitForEnabled({timeout:20_000});await agents.click();
  const panel=await browser.$('section.agent-panel');await panel.waitForDisplayed({timeout:20_000});
  const refresh=await panel.$('button.agent-tool[title="Refresh"]');

  gui.stage='local companion source';
  await (await panel.$('button.agent-tool[title="Setup"]')).click();
  // The companion beside the application wins over the managed copy the fixture placed.
  const bundled=existsSync(join(dirname(gui.binary),'lazysh-agent'));
  const line=await panel.$('p[data-companion-source]');await line.waitForDisplayed({timeout:20_000});
  expect(await line.getAttribute('data-companion-source')).toBe(bundled?'bundled':'managed');
  expect(await line.getText()).toContain(bundled?'Source: Bundled.':'Source: Managed copy.');
  await (await panel.$('button.agent-tool[title="Setup"]')).click();

  gui.stage='local lifecycle report on the Agents board';
  await gui.hook(['ingest','--agent','claude'],{hook_event_name:'UserPromptSubmit',session_id:'native-local-agent',cwd:project,prompt:'hello'}).finish('local lifecycle report',10_000);
  const group=await panel.$('section.agent-project-group[aria-label="local-agent on This device"]');
  await browser.waitUntil(async()=>{await refresh.click();return group.isDisplayed();},{timeout:30_000,interval:1000,timeoutMsg:'The local agent was not listed under This device'});
  expect(await (await group.$('.agent-project-host')).getText()).toBe('This device');
  expect(await group.getText()).toContain('Claude Code');

  gui.stage='local approval answered from the GUI';
  const waiting=gui.hook(['approval-request','--agent','claude','--timeout-seconds','60'],
    {hook_event_name:'PermissionRequest',session_id:'native-local-approval',cwd:project,tool_name:'Bash',tool_input:{command:'echo local'}});
  const card=await panel.$('.approval-panel article.approval-card');
  await card.waitForDisplayed({timeout:30_000});
  expect(await card.getText()).toContain('echo local');
  await (await card.$('button.approval-allow')).click();
  const decision=JSON.parse(await waiting.finish('local approval decision',20_000)) as {hookSpecificOutput:{decision:{behavior:string}}};
  expect(decision.hookSpecificOutput.decision.behavior).toBe('allow');
  await card.waitForDisplayed({reverse:true,timeout:20_000});
  expect(gui.connections).toBe(0);
},180_000);
