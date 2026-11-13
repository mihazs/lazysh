import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountAgentBoard} from './fixtures/AgentBoardHarness';
declare global {interface Window {agentBoard:ReturnType<typeof mountAgentBoard>;}}

const base={agent:'Claude Code',state:'working',paneId:'%3',eventCount:1};
const reports=[
  {...base,sessionId:'api-one',project:'/srv/api',summary:'Implement parser',updatedAt:'2026-10-25T12:40:00.000Z'},
  {...base,sessionId:'docs-one',project:'/srv/docs',summary:'Write guide',updatedAt:'2026-10-25T12:39:00.000Z'},
  {...base,sessionId:'api-two',project:'/srv/api',summary:'Fix tests',updatedAt:'2026-10-25T12:38:00.000Z'},
  {...base,sessionId:'api-done',project:'/srv/api',state:'done',summary:'Ship release',updatedAt:'2026-10-25T12:37:00.000Z'},
];

async function mount(page:import('@playwright/test').Page,rows:unknown[]) {
  await page.evaluate(async rows=>{
    window.agentBoard?.dispose();
    const {mountAgentBoard}=await import('/e2e/fixtures/AgentBoardHarness.tsx');
    window.agentBoard=mountAgentBoard({key:'owned-host',label:'Build box'});
    window.agentBoard.setReports(rows as never);
  },rows);
  const root=page.locator('.agent-board-fixture');
  await page.evaluate(async()=>{const {refreshAgents}=await import('/src/agentsRefresh.ts');refreshAgents();});
  return root;
}

test('reports group by project on the host and archive until the agent reports again',async({page},testInfo)=>{
  await openLocalizedApp(page,'en');
  let root=await mount(page,reports);
  const working=root.getByRole('region',{name:'Working',exact:true});
  await expect(working.getByRole('region')).toHaveCount(2);
  const api=working.getByRole('region',{name:'api on Build box',exact:true});
  await expect(api.locator('h5')).toContainText('Build box');
  await expect(api.locator('.agent-row-summary')).toHaveText(['Implement parser','Fix tests']);
  await expect(working.getByRole('region',{name:'docs on Build box',exact:true}).locator('.agent-row-summary')).toHaveText(['Write guide']);
  await expect(root.getByRole('region',{name:'Done',exact:true}).getByRole('region',{name:'api on Build box',exact:true})).toContainText('Ship release');
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('agent-board-groups.png')});

  await api.getByRole('button',{name:'Archive Claude Code report for api',exact:true}).first().click();
  await expect(root.getByText('Implement parser',{exact:true})).toHaveCount(0);
  const toggle=root.getByRole('button',{name:'Archived 1',exact:true});
  await expect(toggle).toBeFocused();
  await toggle.click();
  const archived=root.getByRole('region',{name:'Archived reports',exact:true});
  await expect(archived).toContainText('Implement parser');
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);

  // The archive belongs to this device and host, so a new board for the host keeps it.
  root=await mount(page,reports);
  await expect(root.getByText('Write guide',{exact:true})).toBeVisible();
  await expect(root.getByText('Implement parser',{exact:true})).toHaveCount(0);
  await expect(root.getByRole('button',{name:'Archived 1',exact:true})).toBeVisible();

  // A newer event from the same session returns it to the board.
  await page.evaluate(rows=>window.agentBoard.setReports(rows as never),[{...reports[0],summary:'Parser follow-up',updatedAt:'2026-10-25T12:45:00.000Z'},...reports.slice(1)]);
  await page.evaluate(async()=>{const {refreshAgents}=await import('/src/agentsRefresh.ts');refreshAgents();});
  await expect(root.getByRole('region',{name:'api on Build box',exact:true}).first()).toContainText('Parser follow-up');
  await expect(root.getByRole('button',{name:/^Archived/})).toHaveCount(0);

  await root.getByRole('button',{name:'Archive Claude Code report for api',exact:true}).first().click();
  await root.getByRole('button',{name:'Archived 1',exact:true}).click();
  await root.getByRole('button',{name:'Restore Claude Code report for api',exact:true}).click();
  await expect(root.getByRole('region',{name:'Working',exact:true}).getByText('Parser follow-up',{exact:true})).toBeVisible();
  await expect(root.getByRole('button',{name:/^Archived/})).toHaveCount(0);
});
