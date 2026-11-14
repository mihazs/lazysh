import {expect,test} from '@playwright/test';
import type {mountMultiplexerHarness} from './fixtures/MultiplexerHarness';
declare global {interface Window {muxHistory:ReturnType<typeof mountMultiplexerHarness>;}}

test.use({permissions:['clipboard-read','clipboard-write']});
for(const truncated of [false,true])test(`History of the attached pane renders, searches and copies${truncated?' and says it was cut':''}`,async({page})=>{
  await page.goto('/');
  await page.evaluate(async truncated=>{const{mountMultiplexerHarness}=await import('/e2e/fixtures/MultiplexerHarness.tsx');window.muxHistory=mountMultiplexerHarness({truncated});},truncated);
  await page.getByRole('button',{name:'Read history',exact:true}).click();
  const history=page.getByRole('region',{name:'Pane history',exact:true});
  const lines=history.locator('pre');
  await expect(lines).toContainText('line 5000');
  expect(await lines.evaluate(node=>[node.textContent!.startsWith('line 1\nline 2\n'),node.textContent!.endsWith('\nline 5000')])).toEqual([true,true]);
  expect(await page.evaluate(()=>window.muxHistory.calls.filter(call=>call.command==='multiplexer_history').map(call=>call.args))).toEqual([{sessionId:'browser-control',kind:'tmux',name:'work'}]);
  await expect(history.getByRole('note')).toHaveText(truncated?['Older output is not shown: this view keeps the newest 20,000 lines or 2 MiB.']:[]);
  await history.getByRole('searchbox',{name:'Search history',exact:true}).fill('LINE 4999');
  await expect(history.getByRole('status')).toHaveText('Lines shown: 1 of 5,000');
  await expect(lines).toHaveText('line 4999');
  await history.getByRole('button',{name:'Copy these lines',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe('line 4999');
  const panel=page.getByRole('region',{name:'Multiplexer workspaces',exact:true});
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});
