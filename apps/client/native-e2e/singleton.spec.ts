import {afterEach,expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {mkdir,realpath,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {NativeGui} from './fixture';
import {typeText,workspaceAction} from './sshUi';

let fixture:NativeGui|undefined;
afterEach(async context=>{
  const owned=fixture;fixture=undefined;if(!owned)return;
  if(context.task.result?.state==='fail')try{await owned.screenshot();}catch{console.error('Owned GUI screenshot unavailable');}
  await owned.stop();
});

it('hands actual secondary argv to the original GUI, preserves a manual password, and admits the next explicit request',async()=>{
  fixture=await NativeGui.start();const browser=fixture.browser!;
  const primary=await browser.$('button[aria-label="Connect to Primary GUI host"]');
  await primary.waitForDisplayed({timeout:30_000});await primary.click();
  const manual=await browser.$('[role="dialog"][aria-label="Connect to Primary GUI host"]');await manual.waitForDisplayed();
  const password=await manual.$('input[type="password"]');await password.setValue('synthetic-manual-value');
  const owner=await fixture.appOwner();
  await fixture.secondary(['--host','gui-selected']);
  expect(await fixture.appOwner()).toEqual(owner);
  expect(await manual.isDisplayed()).toBe(true);expect(await password.getValue()).toBe('synthetic-manual-value');
  fixture.stage='manual dialog cancellation';
  await (await manual.$('button=Cancel')).click();
  const selected=await browser.$('[role="dialog"][aria-label="Connect to Selected GUI host"]');await selected.waitForDisplayed({timeout:20_000});
  expect(await (await selected.$('input[type="password"]')).getValue()).toBe('');
  expect(fixture.connections).toBe(0);
  fixture.stage='selected host cancellation';
  await (await selected.$('button=Cancel')).click();await selected.waitForDisplayed({reverse:true});
  expect(fixture.connections).toBe(0);
  fixture.stage='second explicit mux launch';
  await fixture.secondary(['--host=gui-selected','--mux=tmux:owned-gui-server']);
  const next=await browser.$('[role="dialog"][aria-label="Connect to Selected GUI host"]');await next.waitForDisplayed({timeout:20_000});
  expect(await next.getText()).toContain('Mux launches use SSH for their control connection. The saved host transport is unchanged.');
  expect(await fixture.appOwner()).toEqual(owner);expect(fixture.connections).toBe(0);
});

it('opens a caller-relative literal directory in the original GUI and observes the real shell cwd',async()=>{
  fixture=await NativeGui.start();const browser=fixture.browser!;
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  const name="workspace 世界 '$(printf NO);";
  const caller=join(fixture.directory,'caller');
  const path=join(caller,name);await mkdir(path,{recursive:true});
  await expect(fixture.secondary(['--dir',name],join(fixture.directory,'..'))).rejects.toThrow('within the owned fixture');
  const expected=await realpath(path),owner=await fixture.appOwner();
  fixture.stage='warm relative directory launch';
  await fixture.secondary(['--dir',name],caller);
  const terminal=await browser.$('.terminal-canvas .xterm-screen');await terminal.waitForDisplayed({timeout:20_000});
  expect(await fixture.appOwner()).toEqual(owner);
  await terminal.click();await browser.keys(['p','w','d','\uE007']);
  await browser.waitUntil(async()=>(await terminal.getText()).includes(expected),{timeout:20_000,timeoutMsg:'Owned local shell cwd was not observed'});
  expect(fixture.connections).toBe(0);
});

it('opens Files and the diff of a modified file from a local session without any SSH connection',async()=>{
  fixture=await NativeGui.start();const browser=fixture.browser!;
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  const repository=join(fixture.directory,'home','local project');await mkdir(repository,{recursive:true});
  const git=(...args:string[])=>promisify(execFile)('/usr/bin/git',['-C',repository,'-c','user.name=Local GUI','-c','user.email=local@example.invalid',...args],{env:{PATH:'/usr/bin:/bin',HOME:join(fixture!.directory,'home')}});
  await git('init','-q');
  await writeFile(join(repository,'notes.txt'),'before local edit\n');
  await git('add','--','notes.txt');await git('commit','-qm','initial');
  await writeFile(join(repository,'notes.txt'),'after local edit\n');
  fixture.stage='local terminal launch';
  await fixture.secondary(['--dir','local project'],join(fixture.directory,'home'));
  await (await browser.$('.terminal-canvas .xterm-screen')).waitForDisplayed({timeout:20_000});

  fixture.stage='local Files';
  await workspaceAction(fixture,'Files');
  const directory=await browser.$('#remote-path');await directory.waitForDisplayed();
  await directory.clearValue();await directory.click();await typeText(browser,`${repository}\n`);
  const file=await browser.$('button*=notes.txt');await file.waitForDisplayed({timeout:20_000});await file.click();
  await browser.waitUntil(async()=>(await (await browser.$('[aria-label="Remote files"]')).getText()).includes('after local edit'),{timeout:20_000,timeoutMsg:'Local file content was not shown'});

  fixture.stage='local repository diff';
  await (await browser.$('button[aria-label="Return to terminal"]')).click();
  await workspaceAction(fixture,'Diff');
  const review=await browser.$('[aria-label="Repository review"]');await review.waitForDisplayed();
  const input=await review.$('input[required]');await input.clearValue();await input.click();await typeText(browser,`${repository}\n`);
  const unstaged=await review.$('button=Unstaged diff');await unstaged.waitForDisplayed({timeout:20_000});await unstaged.click();
  const diff=await review.$('table[aria-label="Side by side diff"]');await diff.waitForDisplayed({timeout:20_000});
  expect(await diff.getText()).toContain('after local edit');
  expect(await diff.getText()).toContain('before local edit');
  expect(fixture.connections).toBe(0);
});
