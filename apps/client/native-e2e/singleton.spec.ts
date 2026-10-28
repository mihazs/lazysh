import {afterEach,expect,it} from 'vitest';
import {NativeGui} from './fixture';

let fixture:NativeGui|undefined;
afterEach(async context=>{
  const owned=fixture;fixture=undefined;if(!owned)return;
  if(context.task.result?.state==='fail')try{await owned.screenshot();}catch{console.error('Owned GUI screenshot unavailable');}
  await owned.stop();
});

it('hands actual secondary argv to the original GUI, preserves a manual password, and admits the next explicit request',async()=>{
  fixture=await NativeGui.start();const browser=fixture.browser!;
  const primary=await browser.$('button[aria-label="Connect to Primary GUI host"]');
  await primary.waitForDisplayed({timeout:30_000});await primary.click();
  const manual=await browser.$('[role="dialog"][aria-label="Connect to Primary GUI host"]');await manual.waitForDisplayed();
  const password=await manual.$('input[type="password"]');await password.setValue('synthetic-manual-value');
  const owner=await fixture.appOwner();
  await fixture.secondary(['--host','gui-selected']);
  expect(await fixture.appOwner()).toEqual(owner);
  expect(await manual.isDisplayed()).toBe(true);expect(await password.getValue()).toBe('synthetic-manual-value');
  fixture.stage='manual dialog cancellation';
  await (await manual.$('button=Cancel')).click();
  const selected=await browser.$('[role="dialog"][aria-label="Connect to Selected GUI host"]');await selected.waitForDisplayed({timeout:20_000});
  expect(await (await selected.$('input[type="password"]')).getValue()).toBe('');
  expect(fixture.connections).toBe(0);
  fixture.stage='selected host cancellation';
  await (await selected.$('button=Cancel')).click();await selected.waitForDisplayed({reverse:true});
  expect(fixture.connections).toBe(0);
  fixture.stage='second explicit mux launch';
  await fixture.secondary(['--host=gui-selected','--mux=tmux:owned-gui-server']);
  const next=await browser.$('[role="dialog"][aria-label="Connect to Selected GUI host"]');await next.waitForDisplayed({timeout:20_000});
  expect(await next.getText()).toContain('Mux launches use SSH for their control connection. The saved host transport is unchanged.');
  expect(await fixture.appOwner()).toEqual(owner);expect(fixture.connections).toBe(0);
});
