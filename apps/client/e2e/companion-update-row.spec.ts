import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountAgentBoard} from './fixtures/AgentBoardHarness';
declare global {interface Window {agentBoard:ReturnType<typeof mountAgentBoard>;}}

const update=(state:string,reason?:string)=>({state,from:'1.55.0',to:'1.56.0',...(reason?{reason}:{})});

test('the host companion updating itself is one quiet row that follows the host and never covers the board',async({page},testInfo)=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{
    window.agentBoard?.dispose();
    const {mountAgentBoard}=await import('/e2e/fixtures/AgentBoardHarness.tsx');
    window.agentBoard=mountAgentBoard({key:'owned-host',label:'Build box'});
  });
  const root=page.locator('.agent-board-fixture');
  const refresh=()=>root.getByRole('button',{name:'Refresh',exact:true}).click();
  const row=root.locator('.companion-update');
  const set=(next?:ReturnType<typeof update>)=>page.evaluate(next=>window.agentBoard.setUpdate(next),next);

  await refresh();
  await expect(row).toHaveCount(0);
  await set(update('started'));await refresh();
  await expect(row).toHaveText('Updating the host companion to 1.56.0…');
  await expect(row).toHaveAttribute('aria-busy','true');
  // The reported agents stay usable while it runs.
  await expect(root.locator('.agent-card').first()).toBeVisible();
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('companion-update-running.png')});
  await set(update('done'));await refresh();
  await expect(row).toHaveText('The host companion is now version 1.56.0.');
  await set(update('skipped','policyOff'));await refresh();
  await expect(row).toContainText('Automatic updates are turned off on this host.');
  await set(update('failed','verificationFailed'));await refresh();
  await expect(row).toContainText('the download did not match release 1.56.0');
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await set(undefined);await refresh();
  await expect(row).toHaveCount(0);
});
