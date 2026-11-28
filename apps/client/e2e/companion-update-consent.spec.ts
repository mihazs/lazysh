import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountAgentBoard} from './fixtures/AgentBoardHarness';
declare global {interface Window {agentBoard:ReturnType<typeof mountAgentBoard>;}}

/** A fresh board on the same host, as after reconnecting; the stored choice stays in localStorage. */
async function mount(page:import('@playwright/test').Page) {
  await page.evaluate(async()=>{
    window.agentBoard?.dispose();
    const {mountAgentBoard}=await import('/e2e/fixtures/AgentBoardHarness.tsx');
    window.agentBoard=mountAgentBoard({key:'owned-host',label:'Build box'});
    window.agentBoard.setCompanionVersion('1.28.0');
  });
  const root=page.locator('.agent-board-fixture');
  await root.getByRole('button',{name:'Refresh',exact:true}).click();
  return root;
}
const installs=(page:import('@playwright/test').Page)=>page.evaluate(()=>window.agentBoard.calls.filter(call=>call.command==='install_companion').length);

test('a host whose companion cannot update itself is asked once, and the answer is remembered per host',async({page},testInfo)=>{
  await openLocalizedApp(page,'en');
  let root=await mount(page);
  const question=root.getByRole('heading',{name:'Update the host companion to match this app?'});
  await expect(question).toBeVisible();
  await expect(root.getByText('cannot update itself. The host downloads and installs the new version itself, nothing is downloaded on this device')).toBeVisible();
  const buttons=root.locator('.companion-update-consent button');
  await expect(buttons).toHaveText(['Always','Not now','Never']);
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('companion-update-consent.png')});
  expect(await installs(page)).toBe(0);

  // Not now: gone for this connection, back on the next, and nothing was stored.
  await buttons.nth(1).click();
  await expect(question).toHaveCount(0);
  root=await mount(page);await expect(question).toBeVisible();

  // Never: nothing is installed, nothing is asked again, and the choice can be taken back.
  await buttons.nth(2).click();
  await expect(question).toHaveCount(0);
  root=await mount(page);
  await expect(root.locator('.agent-card').first()).toBeVisible();
  await expect(question).toHaveCount(0);
  expect(await installs(page)).toBe(0);
  await root.getByRole('button',{name:'Setup'}).click();
  await root.getByLabel(/older than the app and cannot update itself/).selectOption('ask');
  await expect(question).toBeVisible();

  // Always: the host updates itself, once, and the next connection does not ask.
  await buttons.nth(0).click();
  await expect(root.locator('.companion-update')).toHaveText(/The host companion is now version \d/);
  expect(await installs(page)).toBe(1);
  root=await mount(page);
  await expect(question).toHaveCount(0);
  await expect(root.locator('.companion-update')).toHaveText(/The host companion is now version \d/);
  expect(await installs(page)).toBe(1);
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});
