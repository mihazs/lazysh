import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountZellijLayoutHarness} from './fixtures/ZellijLayoutHarness';
declare global {interface Window {zellijLayout:ReturnType<typeof mountZellijLayoutHarness>;}}

// Phone and desktop projects both run this: the confirmation is the same control on each.
test('closing a Zellij pane or session asks first, names it, and sends one exact action only when confirmed',async({page})=>{
  const external=await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountZellijLayoutHarness}=await import('/e2e/fixtures/ZellijLayoutHarness.tsx');window.zellijLayout=mountZellijLayoutHarness();});
  const sent=(command:string)=>page.evaluate(command=>window.zellijLayout.calls.filter(call=>call.command===command).map(call=>call.args),command);
  await page.getByRole('button',{name:'List zellij sessions',exact:true}).click();
  await page.getByRole('button',{name:'Control Zellij builds',exact:true}).click();
  const panel=page.getByRole('region',{name:'Zellij builds controls',exact:true});
  const dialog=page.getByRole('alertdialog');
  await panel.getByRole('button',{name:'Read Zellij panes',exact:true}).click();
  await expect(panel.getByText('Pane 3 · tail -f build.log',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Close pane 3',exact:true}).click();
  await expect(dialog).toContainText('Close “Pane 3 · tail -f build.log”?');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(await sent('zellij_action')).toEqual([]);
  await panel.getByRole('button',{name:'Close pane 3',exact:true}).click();
  await dialog.getByRole('button',{name:'Confirm close',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Close pane 3',exact:true})).toHaveCount(0);
  expect(await sent('zellij_action')).toEqual([{sessionId:'browser-control',name:'builds',action:{type:'closePane',target:3}}]);
  await panel.getByRole('button',{name:'Move the divider of pane 0 right',exact:true}).click();
  await expect.poll(async()=>(await sent('zellij_action')).length).toBe(2);
  await panel.getByRole('button',{name:'Close Zellij session',exact:true}).click();
  await expect(dialog).toContainText('Close “builds”?');
  await dialog.getByRole('button',{name:'Confirm close',exact:true}).click();
  await expect(panel).toHaveCount(0);
  expect((await sent('zellij_action')).map(args=>(args as {action:unknown}).action)).toEqual([{type:'closePane',target:3},{type:'resizePane',target:0,direction:'right',amount:1},{type:'closeSession'}]);
  expect(external).toEqual([]);
});

test('the pane list and its actions fit the viewport',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const{mountZellijLayoutHarness}=await import('/e2e/fixtures/ZellijLayoutHarness.tsx');window.zellijLayout=mountZellijLayoutHarness();});
  await page.getByRole('button',{name:'List zellij sessions',exact:true}).click();
  await page.getByRole('button',{name:'Control Zellij builds',exact:true}).click();
  const panel=page.getByRole('region',{name:'Zellij builds controls',exact:true});
  await panel.getByRole('button',{name:'Read Zellij panes',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Rename pane 3',exact:true})).toBeVisible();
  const size=await panel.evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));
  expect(size.scroll,JSON.stringify(size)).toBeLessThanOrEqual(size.width);
});
