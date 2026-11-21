import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountAllHostsBoard} from './fixtures/AllHostsBoardHarness';
declare global {interface Window {allHosts:ReturnType<typeof mountAllHostsBoard>;}}

const base={agent:'Claude Code',paneId:'%3',eventCount:1,updatedAt:'2026-10-25T12:40:00.000Z'};
const build=[
  {...base,sessionId:'api-one',project:'/srv/api',state:'working',summary:'Implement parser'},
  {...base,sessionId:'docs-one',project:'/srv/docs',state:'working',summary:'Write guide'},
  {...base,sessionId:'api-done',project:'/srv/api',state:'done',summary:'Ship release'},
];
const staging=[
  {...base,sessionId:'web-one',project:'/srv/deploy',state:'needs_attention',paneId:'%9',summary:'Approve the deploy'},
  {...base,sessionId:'web-two',project:'/srv/web',state:'working',summary:'Warm the cache'},
];

async function mount(page:import('@playwright/test').Page) {
  await page.evaluate(async([build,staging])=>{
    window.allHosts?.dispose();
    const {mountAllHostsBoard}=await import('/e2e/fixtures/AllHostsBoardHarness.tsx');
    window.allHosts=mountAllHostsBoard({'ssh:build':{key:'owned-build',label:'Build box'},'ssh:staging':{key:'owned-staging',label:'Staging box'}},'ssh:build');
    window.allHosts.setReports('ssh:build',build);window.allHosts.setReports('ssh:staging',staging);
  },[build,staging]);
  return page.locator('.agent-board-fixture');
}

for(const locale of ['en','pt-BR','es']) {
  test(`${locale}: the merged board groups two connected hosts by state, host and project, and one failing host keeps its own error`,async({page},testInfo)=>{
    await openLocalizedApp(page,locale);
    const root=await mount(page);
    const labels=await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return {all:t('agentsScopeAll'),host:t('agentsScopeHost'),working:t('agentsWorking'),needs:t('agentsNeedsYou'),done:t('agentsDone'),open:t('agentsOpenReport',{agent:'Claude Code',project:'/srv/deploy',host:'Staging box'}),refresh:t('agentsRefresh')};});

    // The per-connection board stays the default and reads only its own host.
    await expect(root.getByText('Implement parser',{exact:true})).toBeVisible();
    await expect(root.getByText('Approve the deploy',{exact:true})).toHaveCount(0);
    expect((await page.evaluate(()=>window.allHosts.calls)).some(call=>call.command==='agent_snapshot' && call.sessionId==='ssh:staging')).toBe(false);

    await root.getByRole('button',{name:labels.all,exact:true}).click();
    const working=root.getByRole('region',{name:labels.working,exact:true});
    await expect(working.locator(':scope > .agent-host-group')).toHaveCount(2);
    await expect(working.getByRole('region',{name:'Build box',exact:true}).locator('.agent-row-summary')).toHaveText(['Implement parser','Write guide']);
    await expect(working.getByRole('region',{name:'Staging box',exact:true}).locator('.agent-row-summary')).toHaveText(['Warm the cache']);
    await expect(root.getByRole('region',{name:labels.needs,exact:true}).getByRole('region',{name:'Staging box',exact:true})).toContainText('Approve the deploy');
    await expect(root.getByRole('region',{name:labels.done,exact:true}).getByRole('region',{name:'Build box',exact:true})).toContainText('Ship release');
    expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`agent-board-all-hosts-${locale}.png`),animations:'disabled'});

    // A host that cannot answer shows its own error and the other host's reports stay.
    await page.evaluate(()=>window.allHosts.fail('ssh:staging',true));
    await root.getByRole('button',{name:labels.refresh,exact:true}).click();
    await expect(root.getByRole('alert')).toContainText('Staging box');
    await expect(root.getByRole('alert')).toContainText('Owned fixture companion unavailable');
    await expect(root.getByText('Approve the deploy',{exact:true})).toHaveCount(0);
    await expect(root.getByText('Implement parser',{exact:true})).toBeVisible();
    expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await page.evaluate(()=>window.allHosts.fail('ssh:staging',false));
    await root.getByRole('button',{name:labels.refresh,exact:true}).click();
    await expect(root.getByRole('alert')).toHaveCount(0);
    await expect(root.getByText('Approve the deploy',{exact:true})).toBeVisible();

    // Opening a report asks the app for that host's connection and returns this panel to its own host.
    await root.getByRole('button',{name:labels.open,exact:true}).click();
    expect(await page.evaluate(()=>window.allHosts.opened)).toEqual([{sessionId:'ssh:staging',paneId:'%9',waiting:true,section:'activity'}]);
    await expect(root.getByRole('button',{name:labels.host,exact:true})).toHaveAttribute('aria-pressed','true');
  });
}

test('a connected host without reports still offers the merged board, and the board stays inside the viewport',async({page})=>{
  await openLocalizedApp(page,'en');
  const root=await mount(page);
  await page.evaluate(()=>window.allHosts.setReports('ssh:build',[]));
  await root.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(root.getByText('No agent events yet.',{exact:true})).toBeVisible();
  const merged=root.getByRole('button',{name:'All hosts',exact:true});
  await expect(merged).toBeVisible();
  await merged.click();
  await expect(root.getByRole('region',{name:'Staging box',exact:true}).first()).toBeVisible();
  await expect(root.getByText('No agent events yet.',{exact:true})).toHaveCount(0);
  expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});
