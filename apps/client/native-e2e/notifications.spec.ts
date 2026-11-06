import {expect,it} from 'vitest';
import type {SshFixture} from '../../../tests/support/sshFixture';
import type {OwnedProcess} from '../../../tests/support/ownedProcess';
import {NativeGui} from './fixture';
import {challengeOwnedSsh,openOwnedSsh,ownedCompanionSsh,ownedSshGui,workspaceAction} from './sshUi';

const fixture=ownedSshGui();
type ServerRecord={event:'ready'|'notify'|'close'|'invoked'|'rejected';id?:number;summary?:string;body?:string;actions?:string[];action?:string};
const records=(server:OwnedProcess)=>server.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line) as ServerRecord);
const notified=(server:OwnedProcess)=>records(server).filter(record=>record.event==='notify');

/** Report one lifecycle event through the real current-source companion over the owned SSH server. */
async function report(ssh:SshFixture,companion:string,event:Record<string,string>) {
  const ingest=await ssh.client(true,`TMUX_PANE=%7 '${companion}' ingest --agent claude`);
  ingest.child.stdin!.end(JSON.stringify({session_id:'owned-gui-agent',cwd:'/owned/project',...event}));
  await ingest.finish('owned companion lifecycle report',10_000);
}

it('delivers inbox notifications to the desktop notification server, pauses them and opens the reporting session from the action',async()=>{
  const {ssh,companion}=await ownedCompanionSsh(fixture);
  await report(ssh,companion,{hook_event_name:'UserPromptSubmit'});
  const gui=fixture.gui=await NativeGui.start();
  const server=await gui.notificationServer();
  const {browser,terminal,owner}=await openOwnedSsh(gui,ssh);
  fixture.captureSafe=true;
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  const openInbox=async()=>{
    await workspaceAction(gui,'Preferences');
    const preferences=await browser.$('[role="dialog"][aria-label="Preferences"]');await preferences.waitForDisplayed();
    await (await preferences.$('button[data-settings-target="inbox"]')).click();
    const inbox=await browser.$('[role="dialog"][aria-label="Notification inbox"]');await inbox.waitForDisplayed();
    return inbox;
  };
  const row=(inbox:Awaited<ReturnType<typeof openInbox>>,state:string)=>inbox.$(`.inbox-group[data-state="${state}"] article.inbox-row`);

  gui.stage='owned inbox baseline';
  let inbox=await openInbox();
  await (await inbox.$('label*=Monitor connected hosts')).click();
  const working=await row(inbox,'working');await working.waitForDisplayed({timeout:30_000});
  expect(await (await working.$('strong')).getText()).toBe('Claude Code');
  expect(await (await working.$('code')).getText()).toBe('/owned/project');
  expect(await (await working.$('.inbox-row-context')).getText()).toContain('Owned SSH GUI host');
  expect(notified(server)).toEqual([]);

  gui.stage='owned desktop test notification';
  const test=await inbox.$('button=Test notification');
  expect(await test.isEnabled()).toBe(false);
  await (await inbox.$('button=Enable system notifications')).click();
  await (await inbox.$('//p[@role="status" and normalize-space()="System notifications enabled for new attention events while connected."]')).waitForDisplayed();
  await test.click();
  await browser.waitUntil(async()=>notified(server).length===1,{timeout:10_000,timeoutMsg:'Desktop notification server did not receive the test notification'});
  expect(notified(server)[0]).toMatchObject({summary:'lazysh notifications',body:'Local notifications are enabled on this device.'});

  gui.stage='owned attention notification';
  await report(ssh,companion,{hook_event_name:'Notification',notification_type:'idle_prompt'});
  await (await inbox.$('button[aria-label="Refresh inbox"]')).click();
  const attention=await row(inbox,'needs_attention');await attention.waitForDisplayed({timeout:20_000});
  expect(await (await attention.$('strong')).getText()).toBe('Claude Code');
  await browser.waitUntil(async()=>notified(server).length===2,{timeout:10_000,timeoutMsg:'Desktop notification server did not receive the attention notification'});
  const alert=notified(server)[1];
  expect(alert).toMatchObject({summary:'lazysh · Needs you',body:'Claude Code · /owned/project'});
  expect(alert.actions).toEqual(expect.arrayContaining(['open-session','Open session']));

  gui.stage='owned notification action';
  const agents=await browser.$('button[data-workspace-mode="agents"]');
  expect(await agents.getAttribute('aria-current')).not.toBe('page');
  server.child.stdin!.write(`invoke ${alert.id} open-session\n`);
  await inbox.waitForDisplayed({reverse:true,timeout:10_000});
  await browser.waitUntil(async()=>await agents.getAttribute('aria-current')==='page',{timeout:10_000,timeoutMsg:'Notification action did not open the reporting session agents'});
  expect(records(server).filter(record=>record.event==='invoked')).toEqual([{event:'invoked',id:alert.id,action:'open-session'}]);

  gui.stage='owned paused notifications';
  inbox=await openInbox();
  await (await inbox.$('button=Pause system notifications')).click();
  await (await inbox.$('button=Enable system notifications')).waitForDisplayed();
  expect(await (await inbox.$('button=Test notification')).isEnabled()).toBe(false);
  await report(ssh,companion,{hook_event_name:'UserPromptSubmit'});
  await (await inbox.$('button[aria-label="Refresh inbox"]')).click();
  await (await row(inbox,'working')).waitForDisplayed({timeout:20_000});
  await report(ssh,companion,{hook_event_name:'Notification',notification_type:'idle_prompt'});
  await (await inbox.$('button[aria-label="Refresh inbox"]')).click();
  await (await row(inbox,'needs_attention')).waitForDisplayed({timeout:20_000});
  // The inbox still collects the new attention event; only the OS notification is paused.
  await new Promise(resolve=>setTimeout(resolve,2000));
  expect(notified(server)).toHaveLength(2);
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
});
