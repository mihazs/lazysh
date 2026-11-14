import {expect,it} from 'vitest';
import {appendFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {NativeGui} from './fixture';
import {recordedPageCall} from '../../../tests/support/recordedCards';
import {codexLines,codexRecords,recordedCompanionBytes} from '../../../tests/support/recordedConversation';
import {recordedReader} from './recordedReader';
import {challengeOwnedSsh,disconnectOwnedSsh,openOwnedSsh,ownedCompanionSsh,ownedSshGui,workspaceAction} from './sshUi';

const fixture=ownedSshGui();
const thread='22222222-2222-4222-8222-222222222222';
const turn=[
  {id:'follow-1',role:'user',text:'Synthetic followed question.'},
  {id:'follow-2',role:'assistant',text:'Synthetic followed answer.'},
  {id:'follow-3',role:'assistant',text:'Synthetic answer appended while Follow is on.'},
  {id:'follow-4',role:'assistant',text:'Synthetic answer appended while Follow is off.'},
];

// The Follow checkbox re-reads the opened conversation two seconds after each read completes. The host appends
// Codex records while the real app watches over SSH, so only that poll can show them: Refresh is never pressed
// until Follow is off.
it('shows records appended to a recorded Codex conversation by following it, and stops when Follow is turned off',async()=>{
  fixture.captureSafe=false;
  const {ssh}=await ownedCompanionSsh(fixture,await recordedCompanionBytes(process.env.LAZYSH_TEST_AGENT_BIN));
  const directory=join(ssh.directory,'recorded-follow'),path=join(directory,'follow.jsonl');
  await mkdir(directory,{mode:0o700});
  const initial=codexRecords(thread,turn.slice(0,2));
  await writeFile(path,codexLines(initial),{flag:'wx',mode:0o600});
  let written=initial.length;
  const append=async(message:typeof turn[number])=>{
    const records=codexRecords(thread,[message],false);
    await appendFile(path,codexLines(records,written));written+=records.length;
  };
  const gui=fixture.gui=await NativeGui.start();
  const {browser,terminal,owner}=await openOwnedSsh(gui,ssh),terminalId=terminal.elementId;
  await challengeOwnedSsh(gui,ssh,terminal,owner);fixture.captureSafe=true;
  gui.stage='owned followed Codex conversation';await workspaceAction(gui,'Transcript');
  const {open,awaitPage,unchanged}=recordedReader(gui,owner);
  const shown=(count:number)=>turn.slice(0,count).map(({role,text})=>({role,text}));
  await open({agent:'codex',path});
  await awaitPage('Followed Codex conversation did not open with its two records','messages',shown(2));
  // The status line exists only while following, so both controls are queried again on every look.
  const follow=()=>browser.$('.chat-panel .chat-follow-controls input[type="checkbox"]'),status=()=>browser.$('.chat-panel .chat-follow-controls [role="status"]');
  expect(await (await follow()).isSelected()).toBe(false);
  await (await follow()).click();
  await browser.waitUntil(async()=>await (await follow()).isSelected() && await (await status()).isExisting() && await (await status()).getText()==='Following selected branch.',
    {timeout:5000,timeoutMsg:'Follow did not report that it follows the selected branch'});
  // A hidden page pauses following, so a failure here must name that cause instead of a missing record.
  expect(await browser.execute(()=>document.visibilityState)).toBe('visible');
  gui.stage='owned followed Codex conversation appended record';
  await append(turn[2]);
  await awaitPage('Following did not show the appended record without Refresh','messages',shown(3),30_000);
  await unchanged();
  gui.stage='owned unfollowed Codex conversation appended record';
  await (await follow()).click();
  await browser.waitUntil(async()=>!await (await follow()).isSelected() && !await (await status()).isExisting(),{timeout:5000,timeoutMsg:'Follow did not turn off'});
  await append(turn[3]);
  // Three poll intervals pass; the page must still hold exactly the three records it showed before.
  await browser.pause(7000);
  expect(await browser.execute(`return ${recordedPageCall('messages',shown(3))}`)).toBe(true);
  await (await browser.$('.chat-panel button[aria-label="Refresh new messages"]')).click();
  await awaitPage('Refresh did not show the record appended while Follow was off','messages',shown(4));
  await unchanged();
  await workspaceAction(gui,'Terminal');await terminal.waitForDisplayed();
  expect((await browser.$('.terminal-canvas .xterm-screen')).elementId).toBe(terminalId);
  await challengeOwnedSsh(gui,ssh,terminal,owner,'AFTER_WORKSPACES');
  await disconnectOwnedSsh(gui,terminal);
},240_000);
