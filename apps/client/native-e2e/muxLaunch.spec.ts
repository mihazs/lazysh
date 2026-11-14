import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {HerdrFixture,herdrTools} from '../../../tests/support/androidHerdr';
import {enterOwnedKey,ownedSshGui,savedOwnedHostId,saveOwnedSshHost,trustOwnedHostKey} from './sshUi';
import {probePane,tmuxClients} from './tmuxPane';

const fixture=ownedSshGui();
const server='owned-launch';

it('opens the requested named tmux server picker after the original GUI authenticates and attaches only the chosen session',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmux:true});
  // The decoy lives on the default server; only the requested server may reach the picker.
  await (await ssh.client(true,`tmux -L default new-session -d -s decoy-default && tmux -L ${server} new-session -d -s launch-target`)).finish('owned tmux sessions',10_000);
  const pane=(await ssh.tmux(['list-panes','-a','-F','#{pane_id}:#{pane_pid}'],server)).trim();
  expect(pane).toMatch(/^%[0-9]+:[1-9][0-9]*$/);
  const gui=fixture.gui=await NativeGui.start();const browser=gui.browser!;
  await saveOwnedSshHost(gui,ssh,'ssh',ssh.port);
  const id=await savedOwnedHostId(gui),owner=await gui.appOwner();

  gui.stage='owned warm mux launch';
  await gui.secondary(['--host',id,'--mux',`tmux:${server}`]);
  const connect=await browser.$('[role="dialog"][aria-label="Connect to Owned SSH GUI host"]');await connect.waitForDisplayed({timeout:20_000});
  expect(await connect.getText()).toContain('Mux launches use SSH for their control connection. The saved host transport is unchanged.');
  // The launch only opens the normal connection dialog; nothing connects before the user supplies an identity.
  expect(await tmuxClients(ssh,server)).toBe(0);
  await enterOwnedKey(gui,ssh,connect);
  await trustOwnedHostKey(gui,ssh);

  gui.stage='owned requested tmux picker';
  const picker=await browser.$('section.multiplexer-panel');await picker.waitForDisplayed({timeout:20_000});
  const attach=await picker.$('button=Attach launch-target');await attach.waitForDisplayed({timeout:20_000});
  expect(await picker.getText()).toContain('This request keeps its original kind and server.');
  expect(await picker.getText()).not.toContain('decoy-default');
  const field=await picker.$('input[placeholder="default"]');
  expect(await field.getValue()).toBe(server);expect(await field.isEnabled()).toBe(false);
  // Listing the server reads it over SSH; no tmux client attaches until the explicit choice.
  expect(await tmuxClients(ssh,server)).toBe(0);

  gui.stage='owned requested tmux attach';
  await attach.click();
  const terminal=await browser.$('.terminal-canvas[aria-label="Terminal for Owned SSH GUI host / launch-target"] .xterm-screen');
  await terminal.waitForDisplayed({timeout:20_000});
  expect(await probePane(browser,terminal,'LAUNCH','Requested tmux pane identity was not observed')).toBe(pane);
  expect(await tmuxClients(ssh,server)).toBe(1);
  expect(await tmuxClients(ssh)).toBe(0);
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
});

it('opens the requested Herdr session picker after the original GUI authenticates and attaches the running server',async()=>{
  const herdr=await HerdrFixture.start(herdrTools());fixture.ssh=herdr;
  const gui=fixture.gui=await NativeGui.start();const browser=gui.browser!;
  await saveOwnedSshHost(gui,herdr.ssh,'ssh',herdr.ssh.port);
  const id=await savedOwnedHostId(gui),owner=await gui.appOwner();

  gui.stage='owned warm Herdr launch';
  await gui.secondary(['--host',id,'--mux','herdr']);
  const connect=await browser.$('[role="dialog"][aria-label="Connect to Owned SSH GUI host"]');await connect.waitForDisplayed({timeout:20_000});
  await enterOwnedKey(gui,herdr.ssh,connect);
  await trustOwnedHostKey(gui,herdr.ssh);

  gui.stage='owned requested Herdr picker';
  const picker=await browser.$('section.multiplexer-panel');await picker.waitForDisplayed({timeout:20_000});
  const attach=await picker.$(`button=Attach herdr ${herdr.name}`);await attach.waitForDisplayed({timeout:20_000});
  expect(await picker.getText()).toContain('This request keeps its original kind and server.');
  // A Herdr request never offers tmux's server field or its session actions.
  expect(await picker.$('input[placeholder="default"]').isExisting()).toBe(false);

  gui.stage='owned requested Herdr attach';
  await attach.click();
  const terminal=await browser.$(`.terminal-canvas[aria-label="Terminal for Owned SSH GUI host / ${herdr.name}"] .xterm-screen`);
  await terminal.waitForDisplayed({timeout:20_000});
  // The attached Herdr client draws the running server's own tab and the original pane's startup paint.
  await browser.waitUntil(async()=>{const text=await terminal.getText();return text.includes('OWNED_SCROLL') && text.includes('OWNED_QUESTION');},{timeout:20_000,timeoutMsg:'Attached Herdr session was not observed'});
  // Attaching only displays the session; nothing the app sent reached the original receiver.
  await herdr.expectBytes(Buffer.alloc(0));
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
});
