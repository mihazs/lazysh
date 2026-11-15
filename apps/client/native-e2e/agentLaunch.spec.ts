import {mkdir,readFile,realpath,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {openOwnedSsh,ownedSshGui,typeText} from './sshUi';
import {paneIdentity} from './tmuxPane';

const fixture=ownedSshGui();

// The Codex CLI's stand-in: it records where and how it started next to the fixture's bin directory, fills the pane
// with history, prints the pane and process it runs as, and answers every line typed into it with the same identity.
const codex=`#!/bin/sh
log="$(dirname "$0")/../codex.log"
{ printf 'cwd=%s\\n' "$(pwd -P)"; printf 'pane=%s\\n' "$TMUX_PANE"; for argument in "$@"; do printf 'argument=%s\\n' "$argument"; done; } > "$log.part" && mv "$log.part" "$log"
i=0; while [ "$i" -lt 60 ]; do printf 'STUB_HISTORY_%s\\n' "$i"; i=$((i+1)); done
printf 'PANE<%s:%s:STARTED>\\n' "$TMUX_PANE" "$$"
while IFS= read -r tag; do printf 'PANE<%s:%s:%s>\\n' "$TMUX_PANE" "$$" "$tag"; done
`;

it('starts an agent in a new window of the attached tmux session from the Agent view and keeps its pane across the Terminal and Agent switch',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmux:true,commands:{codex}});
  const folder=join(ssh.directory,'work');await mkdir(folder);
  const gui=fixture.gui=await NativeGui.start();
  const name=`launch-${ssh.nonce.slice(0,12)}`;
  const {browser,terminal}=await openOwnedSsh(gui,ssh,'ssh',ssh.port,{kind:'tmux',name});
  gui.stage='owned tmux session before the launch';
  const windows=async()=>(await ssh.tmux(['list-windows','-t',name,'-F','#{window_id}'])).split('\n').filter(Boolean);
  const [original]=await windows();
  const originalScreen=()=>ssh.tmux(['capture-pane','-p','-t',original]);
  const before=await originalScreen();
  const switcher=await browser.$('div[role="group"][aria-label="Session view"]');
  await switcher.waitForDisplayed({timeout:20_000});

  gui.stage='owned Agent view launcher';
  await (await switcher.$('button[aria-label="Agent"]')).click();
  const agent=await browser.$('section.agent-view:not([hidden])');
  await agent.waitForDisplayed({timeout:20_000});
  await (await agent.$('button=New agent')).click();
  const dialog=await browser.$('[role="dialog"][aria-label="New agent"]');
  await dialog.waitForDisplayed({timeout:20_000});
  // The host lists the agents it finds: the stand-in on the login PATH is installed and can be picked.
  const choice=await dialog.$('select');
  await choice.waitForExist({timeout:20_000});
  const option=await choice.$('option[value="codex"]');
  await option.waitForExist({timeout:20_000});
  expect(await option.isEnabled()).toBe(true);
  await choice.selectByAttribute('value','codex');
  await (await (await dialog.$('label*=Host folder')).$('input')).setValue(folder);
  const prompt="review 'this'\nthen go";
  // Enter key events keep the line break in the field; setValue would drop it.
  const field=await dialog.$('textarea');await field.click();await typeText(browser,prompt);
  expect(await field.getValue()).toBe(prompt);
  await (await dialog.$('button=Review commands')).click();
  await (await dialog.$('ol')).waitForDisplayed({timeout:20_000});
  const reviewed=await dialog.$$('ol code').map(code=>code.getText());
  expect(reviewed[0]).toBe("'command' '-v' '--' 'codex'");
  expect(reviewed.at(-1)).toContain(`'new-window'`);
  expect(reviewed.at(-1)).toContain(`'-c' '${folder}'`);
  // Reviewing runs nothing on the host.
  expect(await windows()).toEqual([original]);
  await expect(stat(join(ssh.directory,'codex.log'))).rejects.toMatchObject({code:'ENOENT'});

  gui.stage='owned tmux window of the launched agent';
  await (await dialog.$('button=Create and start agent')).click();
  await dialog.waitForDisplayed({reverse:true,timeout:30_000});
  await browser.waitUntil(async()=>(await windows()).length===2,{timeout:20_000,timeoutMsg:'The launched tmux window was not created'});
  const started=await ssh.tmux(['list-panes','-t',name,'-s','-F','#{window_id} #{pane_id} #{pane_current_path}']);
  const created=started.split('\n').map(line=>line.split(' ')).find(([window])=>window!==original)!;
  expect(created[2]).toBe(await realpath(folder));
  let record='';
  await browser.waitUntil(async()=>{record=await readFile(join(ssh.directory,'codex.log'),'utf8').catch(()=>'');return record!=='';},{timeout:20_000,timeoutMsg:'The stand-in agent did not start'});
  // The prompt, with its quote and line break, reaches the agent as one argument; no pane but the new one saw input.
  expect(record).toBe(`cwd=${await realpath(folder)}\npane=${created[1]}\nargument=${prompt}\n`);
  expect(await originalScreen()).toBe(before);
  // The Agent view stays shown; the terminal is one tap away.
  expect(await agent.isDisplayed()).toBe(true);
  expect(await terminal.isDisplayed()).toBe(false);

  gui.stage='owned terminal showing the launched agent';
  await (await switcher.$('button[aria-label="Terminal"]')).click();
  await terminal.waitForDisplayed({timeout:20_000});
  let identity:string|undefined;
  await browser.waitUntil(async()=>!!(identity=paneIdentity(await terminal.getText(),'STARTED')),{timeout:20_000,timeoutMsg:'The launched agent was not shown in the terminal'});
  expect(identity!.split(':')[0]).toBe(created[1]);
  // History size and cursor change with any byte written to the pane or any reflow of its scrollback.
  const history=()=>ssh.tmux(['display-message','-p','-t',created[1],'#{history_size}:#{cursor_x}:#{cursor_y}']);
  const clients=()=>ssh.tmux(['list-clients','-F','#{client_tty}']);
  const scrollback=await history(),attached=await clients();
  expect(Number(scrollback.split(':')[0])).toBeGreaterThan(0);
  expect(attached.split('\n').filter(Boolean)).toHaveLength(1);

  gui.stage='owned Agent view and back to the launched agent';
  await (await switcher.$('button[aria-label="Agent"]')).click();
  await agent.waitForDisplayed({timeout:20_000});
  await terminal.waitForDisplayed({reverse:true});
  expect(await history()).toBe(scrollback);
  await (await switcher.$('button[aria-label="Terminal"]')).click();
  await terminal.waitForDisplayed({timeout:20_000});
  // Same pane and process, same single client, nothing written to or trimmed from the scrollback.
  expect(await history()).toBe(scrollback);
  expect(await clients()).toBe(attached);
  await terminal.click();await typeText(browser,'AFTER\n');
  await browser.waitUntil(async()=>paneIdentity(await terminal.getText(),'AFTER')===identity,{timeout:20_000,timeoutMsg:'The launched agent did not answer from the same pane and process'});
  expect(await windows()).toHaveLength(2);
},180_000);
