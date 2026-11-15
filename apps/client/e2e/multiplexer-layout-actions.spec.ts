import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountMultiplexerHarness} from './fixtures/MultiplexerHarness';
declare global {interface Window {multiplexerActions:ReturnType<typeof mountMultiplexerHarness>;}}

// Phone and desktop projects both run this: the confirmation is the same control on each.
test('closing a tmux pane or session asks first, names it, and sends one exact-id action only when confirmed',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountMultiplexerHarness}=await import('/e2e/fixtures/MultiplexerHarness.tsx');window.multiplexerActions=mountMultiplexerHarness({rejectActions:false});});
  const actions=()=>page.evaluate(()=>window.multiplexerActions.calls.filter(call=>call.command==='tmux_action').map(call=>call.args));
  const panel=page.getByRole('region',{name:'Multiplexer workspaces',exact:true});
  const dialog=page.getByRole('alertdialog');
  await panel.getByRole('button',{name:'Close %63',exact:true}).click();
  await expect(dialog).toContainText('Close pane %63 (remote-command in');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await actions()).toEqual([]);
  await panel.getByRole('button',{name:'Close %63',exact:true}).click();
  await dialog.getByRole('button',{name:'Close it',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await actions()).toEqual([{sessionId:'browser-control',action:{type:'closePane',target:'%63'}}]);
  await panel.getByRole('button',{name:'Close session',exact:true}).click();
  await expect(dialog).toContainText('Close session');
  await dialog.getByRole('button',{name:'Close it',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect((await actions()).map(args=>(args as {action:unknown}).action)).toEqual([{type:'closePane',target:'%63'},{type:'closeSession',target:'$41'}]);
  const size=await panel.evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
  expect(size.scroll,JSON.stringify(size)).toBeLessThanOrEqual(size.width);
});
