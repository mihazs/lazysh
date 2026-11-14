import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {disconnectOwnedSsh,openOwnedRememberedSsh,ownedSshGui} from './sshUi';
import {savePrefixAcrossKill} from './prefixShortcuts';
import {probePane,tmuxClients} from './tmuxPane';

const fixture=ownedSshGui();

it('sends a saved custom tmux prefix and a window number to the real server, keeps the prefix across an app kill and leaves the session running after the tab closes',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmux:true});
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  const name=`prefix-${ssh.nonce.slice(0,12)}`;
  // The server starts with the session; its prefix is the one the app must learn from the user, not tmux's default.
  await ssh.tmux(['new-session','-d','-s',name]);
  await ssh.tmux(['set-option','-g','prefix','C-a']);
  await ssh.tmux(['new-window','-t',name]);
  await ssh.tmux(['select-window','-t',`${name}:0`]);
  const window=async()=>(await ssh.tmux(['display-message','-p','-t',name,'#{window_index}'])).trim();
  const {browser,terminal}=await openOwnedRememberedSsh(gui,ssh,{kind:'tmux',name});
  const pane=await probePane(browser,terminal,'BEFORE','Owned tmux pane identity was not observed');
  expect(await window()).toBe('0');

  const {relaunched,restored,shortcuts}=await savePrefixAcrossKill(gui,'tmux',`Owned SSH GUI host / ${name}`);

  gui.stage='owned prefix and window number reach the tmux server';
  await (await shortcuts.$('button=Window 1')).click();
  await relaunched.waitUntil(async()=>await window()==='1',{timeout:20_000,timeoutMsg:'Window 1 did not become the remote window'});
  await (await shortcuts.$('button=Window 0')).click();
  await relaunched.waitUntil(async()=>await window()==='0',{timeout:20_000,timeoutMsg:'Window 0 did not become the remote window'});

  gui.stage='owned tab close leaves the tmux session running';
  const panes=()=>ssh.tmux(['list-panes','-s','-t',name,'-F','#{pane_id}:#{pane_pid}']);
  const running=await panes();
  expect(running.trim().split('\n')).toHaveLength(2);
  await disconnectOwnedSsh(gui,restored,`Owned SSH GUI host / ${name}`);
  await relaunched.waitUntil(async()=>await tmuxClients(ssh)===0,{timeout:20_000,timeoutMsg:'Closed tab left its tmux client attached'});
  await ssh.tmux(['has-session','-t',name]);
  expect(await panes()).toBe(running);
  expect(running.trim().split('\n')).toContain(pane);
},240_000);
