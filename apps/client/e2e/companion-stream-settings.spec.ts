import {expect, test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {openAgentSetup} from './fixtures/workspaceControl';
import type {mountAgentBoard} from './fixtures/AgentBoardHarness';
declare global {interface Window {agentBoard:ReturnType<typeof mountAgentBoard>;}}
test('host stream policy saves independently of device tools', async ({page}) => {
  await openLocalizedApp(page, 'en');
  await page.evaluate(async () => {const {mountAgentBoard} = await import('/e2e/fixtures/AgentBoardHarness.tsx'); window.agentBoard = mountAgentBoard();});
  await openAgentSetup(page);
  const settings = page.locator('.agent-board-fixture');
  await settings.getByRole('checkbox', {name:'Device preview streaming'}).uncheck();
  await expect(settings.getByRole('checkbox', {name:'Device preview streaming'})).not.toBeChecked();
  await expect(settings.getByRole('checkbox', {name:'Device tools', exact:true})).toBeChecked();
  const calls = await page.evaluate(() => window.agentBoard.calls);
  expect(calls.filter(call => call.command === 'companion_stream_settings').at(-1)?.args).toMatchObject({expectedRevision:0, enabled:false});
  expect(calls.some(call => call.command === 'update_companion_settings')).toBe(false);
});
