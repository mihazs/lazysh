import {workspaceControl} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';
import {dictationFixture as fixture,recordDictation as record,completeDictation as complete} from './fixtures/directDictation';

test('review remains default; direct opt-in writes exactly one final payload with optional Enter',async({page})=>{
  await fixture(page);
  const direct=page.getByLabel('Type final result directly into terminal'),enter=page.getByLabel('Auto-send: press Enter');
  await expect(direct).not.toBeChecked();await expect(enter).not.toBeChecked();await expect(enter).toBeDisabled();
  await record(page);await complete(page,'review only');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review only');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  await direct.check();await record(page);
  await expect(direct).toBeDisabled();await expect(enter).toBeDisabled();
  await complete(page,'echo 世界');
  await expect.poll(()=>page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['echo 世界']);
  await enter.check();await record(page);await complete(page,'pwd');
  await expect.poll(()=>page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['echo 世界','pwd\r']);
  const ids=await page.evaluate(()=>window.dictationFixture.writes.map(write=>write.sessionId));expect(new Set(ids).size).toBe(1);
  await (await workspaceControl(page,'Terminal')).click();await (await workspaceControl(page,'Dictate')).click();
  await expect(direct).not.toBeChecked();await expect(enter).not.toBeChecked();
});

test('Parakeet keeps editable review and cancelled native finishing cannot type or press Enter',async({page})=>{
  await fixture(page,true);
  await page.getByRole('combobox',{name:'Speech engine',exact:true}).selectOption('parakeet');
  await record(page);await complete(page,'review Parakeet result');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review Parakeet result');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  await page.getByLabel('Type final result directly into terminal').check();await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeDisabled();
  await complete(page,'cancelled command');
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeEnabled();
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review Parakeet result');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
});

test('invalid text and native queue failures preserve the draft and never append Enter later',async({page})=>{
  await fixture(page);await page.getByLabel('Type final result directly into terminal').check();await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await complete(page,'first\nsecond');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('first\nsecond');await expect(page.getByRole('alert')).toContainText('one line');
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  await page.evaluate(()=>{window.dictationFixture.rejectWrite=true;});
  await record(page);await complete(page,'failed command');
  await expect(page.getByRole('alert')).toContainText('queue is full');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('failed command');
  expect(await page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['failed command\r']);
  await page.getByLabel('Dictation draft').fill('edited locally');
  await page.getByText('Recent dictation (2)',{exact:true}).click();await page.getByRole('button',{name:'Reuse dictation 1'}).click();
  await expect(page.getByLabel('Dictation draft')).toHaveValue('failed command');
  expect(await page.evaluate(()=>window.dictationFixture.writes.map(write=>write.data))).toEqual(['failed command\r']);
});

for(const action of ['cancel','navigate','disconnect','disconnect intent','replace session'] as const){
  test(`late completion after ${action} cannot type or press Enter`,async({page})=>{
    await fixture(page);await page.getByLabel('Type final result directly into terminal').check();await page.getByLabel('Auto-send: press Enter').check();await record(page);
    if(action==='cancel')await page.getByRole('button',{name:'Cancel',exact:true}).click();
    else if(action==='navigate')await (await workspaceControl(page,'Terminal')).click();
    else if(action==='disconnect intent'){
      await page.evaluate(()=>{window.dictationFixture.deferDisconnect=true;});
      await (await workspaceControl(page,'End Local terminal connection')).click();
    }else if(action==='replace session'){
      if((page.viewportSize()?.width ?? 1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
      await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
      await expect(page.getByRole('tab')).toHaveCount(2);
      await expect(page.getByRole('region',{name:'Local dictation'})).toHaveCount(0);
    }else await page.evaluate(()=>window.dictationFixture.close());
    await complete(page,'stale command');
    if(action==='cancel')await expect(page.getByLabel('Dictation draft')).toHaveValue('');
    else if(action==='disconnect intent')await expect(page.getByLabel('Dictation draft')).toHaveValue('stale command');
    else await expect(page.getByRole('region',{name:'Local dictation'})).toHaveCount(0);
    expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  });
}
