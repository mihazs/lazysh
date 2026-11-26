import {expect,test} from '@playwright/test';
import {installLocalTerminal,connectLocalTerminal} from '../e2e/fixtures/localTerminal';
import {onEngine} from '../src/e2eTerminalBackend';

/** What the user (or a developer) asked for before the app loads: a stored engine preference and the developer override. */
type Ask={preference?:'native'|'xterm';override?:'native'|'xterm'};
const refused={id:'xterm',reason:'fallback',fallbacks:[{id:'native',reason:'disabled in this build'}]};
const asks:[string,Ask,typeof refused][]=[
  ['nothing (Auto)',{},refused],
  ['Native in Settings',{preference:'native'},refused],
  ['Native by the developer override',{override:'native'},refused],
  ['Native in Settings and by the developer override',{preference:'native',override:'native'},refused],
  ['xterm.js in Settings',{preference:'xterm'},{id:'xterm',reason:'preference',fallbacks:[]}],
];

for(const [name,ask,recorded] of asks)test(`a new session runs xterm.js in a build with the native engine off when it was asked for ${name}`,async({page})=>{
  await installLocalTerminal(page);
  await page.addInitScript(({preference,override})=>{
    if(preference)localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,terminalEngine:preference}));
    if(override)localStorage.setItem('lazysh.terminal.backend',override);
  },ask);
  if (ask.preference === 'native' && !ask.override) await page.setViewportSize({width: 1028, height: 749});
  await page.goto('/');
  if (ask.preference === 'native' && !ask.override) {
    await page.locator('button.workspace-tools-trigger').click();
    await page.locator('#workspace-tools-page-application').getByRole('button', {name: 'Preferences', exact: true}).click();
    await page.getByRole('button', {name: 'Terminal and accessibility', exact: true}).click();
    await expect(page.locator('#terminal-engine-native-off')).toContainText('disabled in this build');
    const native = page.getByRole('radio', {name: 'Native', exact: true});
    await expect(native).toBeChecked();
    await expect(native).toBeDisabled();
    await page.getByRole('button', {name: 'Close Preferences', exact: true}).click();
  }
  await connectLocalTerminal(page);
  const {backend,selection}=await onEngine(page);
  expect(backend).toBe('xterm');
  expect(selection).toEqual(recorded);
});
