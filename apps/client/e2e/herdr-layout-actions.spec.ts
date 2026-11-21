import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountMultiplexerHarness} from './fixtures/MultiplexerHarness';
import {remoteMuxName} from '../src/test/multiplexerFixture';
declare global {interface Window {herdrActions:ReturnType<typeof mountMultiplexerHarness>;}}

// Phone and desktop projects both run this: the confirmation is the same control on each.
test('closing a Herdr pane or workspace asks first, names it, and sends one exact-id action only when confirmed',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountMultiplexerHarness}=await import('/e2e/fixtures/MultiplexerHarness.tsx');window.herdrActions=mountMultiplexerHarness();});
  const actions=()=>page.evaluate(()=>window.herdrActions.calls.filter(call=>call.command==='herdr_action').map(call=>(call.args as {action:unknown}).action));
  await page.getByRole('button',{name:'List herdr sessions',exact:true}).click();
  await page.getByRole('button',{name:`Browse Herdr ${remoteMuxName}`,exact:true}).click();
  const panel=page.getByRole('region',{name:`Herdr ${remoteMuxName} workspaces`,exact:true});
  const dialog=page.getByRole('alertdialog');
  await panel.getByRole('button',{name:'Close w7:p9',exact:true}).click();
  await expect(dialog).toContainText('Close pane w7:p9');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await actions()).toEqual([]);
  await panel.getByRole('button',{name:'Close w7:p9',exact:true}).click();
  await dialog.getByRole('button',{name:'Close it',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await actions()).toEqual([{type:'closePane',target:'w7:p9'}]);
  await panel.getByRole('button',{name:'Close Herdr workspace w7',exact:true}).click();
  await expect(dialog).toContainText(`Close workspace ${remoteMuxName} (w7)`);
  await dialog.getByRole('button',{name:'Close it',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await actions()).toEqual([{type:'closePane',target:'w7:p9'},{type:'closeWorkspace',target:'w7'}]);
  await panel.getByRole('button',{name:'Move w7:p9 divider right',exact:true}).click();
  await expect.poll(actions).toHaveLength(3);
  expect((await actions()).at(-1)).toEqual({type:'resizePane',target:'w7:p9',direction:'right',amount:5});
  const size=await panel.evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
  expect(size.scroll,JSON.stringify(size)).toBeLessThanOrEqual(size.width);
});
