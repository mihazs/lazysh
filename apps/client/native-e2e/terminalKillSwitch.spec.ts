import {expect,it} from 'vitest';
import {join} from 'node:path';
import {NativeGui} from './fixture';
import {ownedSshGui,typeText,workspaceAction} from './sshUi';

const fixture=ownedSshGui();

it.skipIf(process.env.LAZYSH_NATIVE_TERMINAL!=='off')('the Linux kill switch keeps a real local terminal in xterm with Native requested',async()=>{
  const gui=fixture.gui=await NativeGui.start();
  const browser=gui.browser!;
  const ready=()=>browser.$('button[aria-label="Connect to Primary GUI host"]').waitForDisplayed({timeout:30_000});
  await ready();
  await browser.execute(()=>{
    localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,terminalEngine:'native'}));
    localStorage.setItem('lazysh.terminal.backend','native');
  });
  await browser.refresh();
  await ready();
  fixture.captureSafe=true;

  gui.stage='kill switch core availability';
  const availability=await browser.execute(async()=>{
    const bridge=Reflect.get(window,'__TAURI_INTERNALS__');
    return bridge.invoke('terminal_core_available');
  });
  expect(availability).toEqual({available:false,reason:'The native terminal core is not built into this app'});

  gui.stage='kill switch engine preference';
  await workspaceAction(gui,'Preferences');
  const preferences=await browser.$('[role="dialog"][aria-label="Preferences"]');
  await preferences.waitForDisplayed();
  await (await preferences.$('button[data-settings-target="terminal"]')).click();
  const reason=await preferences.$('#terminal-engine-native-off');
  await reason.waitForDisplayed();
  expect(await reason.getText()).toContain('disabled in this build');
  const native=await preferences.$('input[name="terminal-engine"][value="native"]');
  expect(await native.isSelected()).toBe(true);
  expect(await native.isEnabled()).toBe(false);
  await (await preferences.$('button[aria-label="Close Preferences"]')).click();
  await preferences.waitForDisplayed({reverse:true});

  gui.stage='kill switch real local terminal';
  await gui.secondary(['--dir',join(gui.directory,'home')]);
  const terminal=await browser.$('.terminal-canvas .xterm-screen');
  await terminal.waitForDisplayed({timeout:20_000});
  await browser.waitUntil(async()=>(await terminal.getText()).trim().length>0,{timeout:20_000});
  await terminal.click();
  await typeText(browser,"printf 'KILL_%s\\n' SWITCH\n");
  await browser.waitUntil(async()=>(await terminal.getText()).includes('KILL_SWITCH'),{timeout:20_000});
  expect(await browser.$$('[data-terminal-surface="native"]')).toHaveLength(0);
});
