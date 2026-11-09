import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {openOwnedSsh,ownedSshGui} from './sshUi';
import {paneIdentity,probePane,tmuxClients} from './tmuxPane';

const fixture=ownedSshGui();

it('shows the Agent view of a real tmux pane and returns to the same pane without reattaching, writing or trimming its history',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmux:true});
  const gui=fixture.gui=await NativeGui.start();
  const name=`agent-${ssh.nonce.slice(0,12)}`;
  const {browser,terminal}=await openOwnedSsh(gui,ssh,'ssh',ssh.port,{kind:'tmux',name});
  gui.stage='owned tmux pane before the Agent view';
  const pane=await probePane(browser,terminal,'BEFORE','Owned tmux pane identity was not observed');
  // History size and cursor change with any byte written to the pane or any reflow of its scrollback.
  const history=()=>ssh.tmux(['display-message','-p','-t',name,'#{history_size}:#{cursor_x}:#{cursor_y}']);
  const before=await history();
  expect(await tmuxClients(ssh)).toBe(1);
  const switcher=await browser.$('div[role="group"][aria-label="Session view"]');
  await switcher.waitForDisplayed({timeout:20_000});

  gui.stage='owned Agent view of the same tmux pane';
  await (await switcher.$('button[aria-label="Agent"]')).click();
  const agent=await browser.$('section.agent-view:not([hidden])');
  await agent.waitForDisplayed({timeout:20_000});
  await terminal.waitForDisplayed({reverse:true});
  // Without a companion report for this pane the view explains itself and offers the terminal.
  await (await agent.$('button=Show terminal')).waitForDisplayed({timeout:20_000});
  expect(await history()).toBe(before);

  gui.stage='owned terminal after the Agent view';
  await (await switcher.$('button[aria-label="Terminal"]')).click();
  await terminal.waitForDisplayed({timeout:20_000});
  expect(paneIdentity(await terminal.getText(),'BEFORE')).toBe(pane);
  expect(await history()).toBe(before);
  expect(await tmuxClients(ssh)).toBe(1);
  expect(await probePane(browser,terminal,'AFTER','Pane identity after the Agent view was not observed')).toBe(pane);
},180_000);
