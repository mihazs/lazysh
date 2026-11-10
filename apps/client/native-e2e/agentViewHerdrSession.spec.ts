import {mkdir,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {HerdrFixture,herdrTools} from '../../../tests/support/androidHerdr';
import {NativeGui} from './fixture';
import {openOwnedSsh,ownedSshGui} from './sshUi';

const fixture=ownedSshGui();

it('opens an explicitly selected owned Herdr agent session through the native resolver',async()=>{
  const herdr=await HerdrFixture.start(herdrTools());fixture.ssh=herdr;
  const {agent}=herdr.metadata();
  const id='11111111-1111-4111-8111-111111111111';
  const directory=join(herdr.ssh.directory,'.codex','sessions','2026','11','10');
  await mkdir(directory,{recursive:true,mode:0o700});
  const records=[{type:'session_meta',payload:{id,history_mode:'legacy'}},{type:'event_msg',payload:{type:'user_message',message:'Owned resolver prompt'}}];
  await writeFile(join(directory,`rollout-2026-11-10T00-00-00-${id}.jsonl`),records.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  // Herdr admits official lifecycle reports only while it detects that agent.
  // A named sleep process is a controlled stand-in; the original receiver remains untouched.
  const pane=JSON.parse(await herdr.run(['tab','create','--workspace',agent.workspaceId,'--cwd',herdr.ssh.directory,'--no-focus'])).result.root_pane.pane_id;
  const codex=join(herdr.ssh.directory,'bin','codex');await symlink('/bin/sleep',codex);
  await herdr.run(['pane','run',pane,`exec '${codex}' 180`]);
  const deadline=Date.now()+10_000;
  while(true) {
    const rows=JSON.parse(await herdr.run(['api','snapshot'])).result.snapshot.agents;
    if(rows.some((row:{pane_id:string;agent:string})=>row.pane_id===pane && row.agent==='codex'))break;
    if(Date.now()>deadline)throw new Error('Owned Codex stand-in was not detected');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await herdr.run(['pane','report-agent',pane,'--source','herdr:codex','--agent','codex','--state','working']);
  await herdr.run(['pane','report-agent-session',pane,'--source','herdr:codex','--agent','codex','--agent-session-id',id]);
  const rows=JSON.parse(await herdr.run(['api','snapshot'])).result.snapshot.agents;
  expect(rows.find((row:{pane_id:string})=>row.pane_id===pane)?.agent_session?.value).toBe(id);
  const gui=fixture.gui=await NativeGui.start();
  const {browser}=await openOwnedSsh(gui,herdr.ssh,'ssh',undefined,{kind:'herdr',name:herdr.name});
  gui.stage='owned Herdr session selection';
  await (await browser.$('div[role="group"][aria-label="Session view"] button[aria-label="Agent"]')).click();
  const agentView=await browser.$('section.agent-view:not([hidden])');await agentView.waitForDisplayed({timeout:20_000});
  const open=await agentView.$('button=Open conversation');await open.waitForDisplayed({timeout:20_000});await open.click();
  try {await browser.waitUntil(async()=>(await agentView.getText()).includes('Owned resolver prompt'),{timeout:20_000});}
  catch {throw new Error('Owned Herdr conversation did not resolve: '+await agentView.getText());}
  expect(await agentView.getText()).toContain('Herdr reports this session. Its association with this pane is unverified.');
  expect(await agentView.$('input[aria-label="Transcript path"]').isExisting()).toBe(false);
  expect(await agentView.$('[aria-label="Terminal input"]').isExisting()).toBe(false);
  await herdr.expectBytes(Buffer.alloc(0));
},180_000);
