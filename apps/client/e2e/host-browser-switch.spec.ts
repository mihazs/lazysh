import {expect,test,type Locator,type Page,type TestInfo} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {openAgentSetup} from './fixtures/workspaceControl';
import type {mountAgentBoard} from './fixtures/AgentBoardHarness';
import {agentBoardSession} from '../src/test/agentBoardData';
declare global {interface Window {agentBoard:ReturnType<typeof mountAgentBoard>;}}

const mount=(page:Page,key:string)=>page.evaluate(async key=>{
  const {mountAgentBoard}=await import('/e2e/fixtures/AgentBoardHarness.tsx');
  window.agentBoard?.dispose();window.agentBoard=mountAgentBoard({key,label:key});
},key);
const commandCalls=(page:Page,command:string)=>page.evaluate(command=>window.agentBoard.calls.filter(call=>call.command===command).map(call=>call.args),command);
const updates=(page:Page)=>commandCalls(page,'update_host_browser_settings');
/** The element is fully inside the viewport and the board does not scroll sideways. */
async function fits(page:Page,element:Locator,root:Locator) {
  await element.scrollIntoViewIfNeeded();
  const box=(await element.boundingBox())!,viewport=page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
}

/** The localized app with the host settings of `host` open at the phone or desktop size; `external` collects what left the page. */
async function openHostSettings(page:Page,testInfo:TestInfo,host:string) {
  if(testInfo.project.name==='desktop')await page.setViewportSize({width:1280,height:800});
  const external=await openLocalizedApp(page,'en');
  await mount(page,host);await openAgentSetup(page);
  return {external,root:page.locator('.agent-board-fixture')};
}
/** What the encrypted settings sync would upload: it never carries a host id or a browser choice. */
const syncedPreferences=(page:Page)=>page.evaluate(async()=>{const {getPreferences,syncablePreferences}=await import('/src/preferences.ts');return JSON.stringify(syncablePreferences(getPreferences()));});

test('the host browser is confirmed once per host and stays on this device, at phone and desktop sizes',async({page},testInfo)=>{
  const {external,root}=await openHostSettings(page,testInfo,'host-a');
  const box=root.getByRole('checkbox',{name:'Host browser',exact:true});
  await expect(box).not.toBeChecked();
  // The first label under a fieldset legend used to be squeezed to a few pixels beside it.
  for(const name of ['Transcript discovery','Host browser'])expect((await root.getByRole('checkbox',{name,exact:true}).locator('..').boundingBox())!.width).toBeGreaterThan(120);
  await box.check();await root.getByRole('button',{name:'Save host browser setting',exact:true}).click();
  const confirmation=root.getByRole('group',{name:'Turn on the host browser for this host?',exact:true});
  await expect(confirmation).toBeFocused();
  await expect(confirmation).toContainText('network and the services listening only on the host');
  await expect(confirmation).toContainText('Any file on the host that the browser can open');
  await expect(confirmation).toContainText('Every site you sign in to inside it');
  await expect(confirmation).toContainText('remembered on this device for this host only');
  await fits(page,confirmation,root);await fits(page,confirmation.getByRole('button',{name:'Keep it off',exact:true}),root);
  await page.screenshot({path:testInfo.outputPath('host-browser-confirmation.png')});
  expect(await updates(page)).toEqual([]);
  await confirmation.getByRole('button',{name:'Turn on host browser',exact:true}).click();
  await expect(root.getByText('Host browser setting saved for new browser sessions.',{exact:true})).toBeVisible();
  expect(await updates(page)).toEqual([{sessionId:agentBoardSession,settings:{expectedRevision:0,hostBrowserEnabled:true}}]);
  await expect(box).toBeChecked();
  // The same host is not asked again; the host browser call never carries the three switches.
  await mount(page,'host-a');await openAgentSetup(page);
  await expect(box).not.toBeChecked();await box.check();await root.getByRole('button',{name:'Save host browser setting',exact:true}).click();
  await expect(root.getByText('Host browser setting saved for new browser sessions.',{exact:true})).toBeVisible();
  await expect(confirmation).toHaveCount(0);
  expect(await updates(page)).toEqual([{sessionId:agentBoardSession,settings:{expectedRevision:0,hostBrowserEnabled:true}}]);
  // Another host is asked.
  await mount(page,'host-b');await openAgentSetup(page);
  await box.check();await root.getByRole('button',{name:'Save host browser setting',exact:true}).click();
  await expect(confirmation).toBeVisible();expect(await updates(page)).toEqual([]);
  // Only host ids are stored, and the sync snapshot never sees them.
  expect(await page.evaluate(()=>localStorage.getItem('lazysh.hostBrowserConfirmed.v1'))).toBe('["host-a"]');
  expect(await syncedPreferences(page)).not.toContain('host-a');
  expect(external).toEqual([]);
});

test('Keep profile is off by default and per host, and Clear browser data names what it deletes with the switch off, at phone and desktop sizes',async({page},testInfo)=>{
  const {external,root}=await openHostSettings(page,testInfo,'host-a');
  const keep=root.getByRole('checkbox',{name:'Keep profile',exact:true});
  const clear=root.getByRole('button',{name:'Clear browser data',exact:true});
  // The host browser switch is off, and both controls are still offered; Keep profile starts off.
  await expect(root.getByRole('checkbox',{name:'Host browser',exact:true})).not.toBeChecked();
  await expect(keep).toBeEnabled();await expect(keep).not.toBeChecked();await expect(clear).toBeEnabled();
  await expect(root.getByText('cookies and sign-ins stay on this host\'s disk until you use Clear browser data')).toBeVisible();
  await fits(page,keep,root);await fits(page,clear,root);
  await keep.check();
  await clear.click();
  const confirmation=root.getByRole('group',{name:'Clear the browser data kept on this host?',exact:true});
  await expect(confirmation).toBeFocused();
  await expect(confirmation).toContainText('deletes the kept browser profile directory on this host');
  await expect(confirmation).toContainText('cookies, sign-ins and site data that Keep profile saved');
  await expect(confirmation).toContainText('cannot be undone');
  await fits(page,confirmation,root);await fits(page,confirmation.getByRole('button',{name:'Delete browser data',exact:true}),root);
  await page.screenshot({path:testInfo.outputPath('host-browser-clear-confirmation.png')});
  expect(await commandCalls(page,'host_browser_clear_data')).toEqual([]);
  await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(confirmation).toHaveCount(0);await expect(clear).toBeFocused();
  expect(await commandCalls(page,'host_browser_clear_data')).toEqual([]);
  await clear.click();await confirmation.getByRole('button',{name:'Delete browser data',exact:true}).click();
  await expect(root.getByText('Browser data cleared: the kept profile was deleted from this host.',{exact:true})).toBeVisible();
  expect(await commandCalls(page,'host_browser_clear_data')).toEqual([{sessionId:agentBoardSession}]);
  expect(await updates(page)).toEqual([]);
  // The host has nothing left the second time.
  await clear.click();await confirmation.getByRole('button',{name:'Delete browser data',exact:true}).click();
  await expect(root.getByText('Nothing to clear: this host keeps no browser profile.',{exact:true})).toBeVisible();
  // The choice is per host and stays on this device: another host starts off, and the sync snapshot never sees it.
  await mount(page,'host-b');await openAgentSetup(page);
  await expect(keep).toBeEnabled();await expect(keep).not.toBeChecked();
  await mount(page,'host-a');await openAgentSetup(page);
  await expect(keep).toBeEnabled();await expect(keep).toBeChecked();
  expect(await page.evaluate(()=>localStorage.getItem('lazysh.hostBrowserKeepProfile.v1'))).toBe('["host-a"]');
  expect(await syncedPreferences(page)).not.toContain('host-a');
  expect(external).toEqual([]);
});
