import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {disconnectOwnedSsh,openOwnedSsh,ownedSshGui,workspaceAction,workspaceToolNames} from './sshUi';

const fixture=ownedSshGui();

it('drives a real Zellij session from its shortcut panel and offers no Jump To while attached to it',async()=>{
  fixture.captureSafe=false;
  const zellij=process.env.LAZYSH_TEST_ZELLIJ;
  if(!zellij?.startsWith('/'))throw new Error('The pinned Zellij binary (LAZYSH_TEST_ZELLIJ) is required');
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,zellijBinary:zellij});
  const gui=fixture.gui=await NativeGui.start();
  const name=`zellij-${ssh.nonce.slice(0,12)}`;
  const {browser,terminal}=await openOwnedSsh(gui,ssh,'ssh',ssh.port,{kind:'zellij',name});
  // The host observes tabs through the session's own CLI, never through the UI text.
  const tabs=async()=>JSON.parse(await ssh.zellij(['--session',name,'action','list-tabs','--json'])) as {position:number;name:string;active:boolean}[];
  const active=async()=>(await tabs().catch(()=>[])).find(tab=>tab.active)?.position;
  // Zellij lists a session's tabs before its attached client reports which one is active.
  await browser.waitUntil(async()=>await active()===0,{timeout:30_000,timeoutMsg:'Attached Zellij client did not report its first tab as active'});

  gui.stage='owned Zellij shortcut panel';
  await workspaceAction(gui,'Sessions');
  const panel=await browser.$('[aria-label="Multiplexer workspaces"]');await panel.waitForDisplayed({timeout:20_000});
  // The discovery probe runs once the panel opens; its Zellij row appears only when the host has Zellij.
  const list=await panel.$('button=List zellij sessions');await list.waitForDisplayed({timeout:30_000});await list.click();
  const control=await panel.$(`button=Control Zellij ${name}`);await control.waitForDisplayed({timeout:20_000});await control.click();
  const controls=await browser.$(`section[aria-label="Zellij ${name} controls"]`);await controls.waitForDisplayed({timeout:20_000});

  await (await controls.$('label=New tab name').$('input')).setValue('second');
  await (await controls.$('button=Create Zellij tab')).click();
  await browser.waitUntil(async()=>{const found=await tabs();return found.length===2&&found[1].name==='second'&&await active()===1;},{timeout:20_000,timeoutMsg:'Create Zellij tab did not add and focus the second tab'});
  await (await controls.$('button=Previous Zellij tab')).click();
  await browser.waitUntil(async()=>await active()===0,{timeout:20_000,timeoutMsg:'Previous Zellij tab did not focus the first tab'});
  await (await controls.$('button=Next Zellij tab')).click();
  await browser.waitUntil(async()=>await active()===1,{timeout:20_000,timeoutMsg:'Next Zellij tab did not focus the second tab'});
  await (await controls.$('button=Tab 1')).click();
  await browser.waitUntil(async()=>await active()===0,{timeout:20_000,timeoutMsg:'Zellij quick tab 1 did not focus the first tab'});

  gui.stage='owned Zellij tab has no Jump To';
  // The gate that lists Jump To for a tmux tab withholds it from a Zellij tab, which has no Jump tree.
  const tools=await workspaceToolNames(gui);
  expect(tools).toContain('Sessions');
  expect(tools).not.toContain('Jump To');
  await disconnectOwnedSsh(gui,terminal,`Owned SSH GUI host / ${name}`);
},240_000);
