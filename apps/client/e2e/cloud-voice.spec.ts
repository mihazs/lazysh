import {workspaceControl} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';
import {cloudVoiceFixture as fixture,enrollCloud as enroll,recordCloud as record,completeCloud as complete} from './fixtures/cloudVoice';

test('Cloud is explicit, validates enrollment, then shares review and opt-in direct delivery',async({page})=>{
  await fixture(page);
  expect(await page.evaluate(()=>window.cloudVoiceFixture.calls.filter(call=>call.command.startsWith('voice_cloud_')))).toEqual([]);
  await page.getByLabel('Speech engine').selectOption('cloud');
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeDisabled();
  await expect(page.getByLabel('Device token')).toHaveAttribute('type','password');
  await enroll(page);await expect(page.getByLabel('Device token')).toHaveValue('');
  await expect(page.getByLabel('Cloud speech language').locator('option')).toHaveCount(2);
  await record(page);await complete(page,'review Cloud result');
  await expect(page.getByLabel('Dictation draft')).toHaveValue('review Cloud result');
  expect(await page.evaluate(()=>window.cloudVoiceFixture.writes)).toEqual([]);
  await page.getByLabel('Type final result directly into terminal').check();
  await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await complete(page,'echo hello');
  await expect.poll(()=>page.evaluate(()=>window.cloudVoiceFixture.writes)).toEqual(['echo hello\r']);
  await page.getByRole('button',{name:'Forget Cloud device'}).click();
  await expect(page.getByRole('button',{name:'Record speech',exact:true})).toBeDisabled();
});

test('cancelled begin and late final results never upload or type',async({page})=>{
  await fixture(page);await enroll(page);
  await page.evaluate(()=>{window.cloudVoiceFixture.deferBegin=true;});
  await page.getByRole('button',{name:'Record speech',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.cloudVoiceFixture.begin)).toBe('function');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.evaluate(()=>window.cloudVoiceFixture.begin!());
  await expect.poll(()=>page.evaluate(()=>window.cloudVoiceFixture.calls.filter(call=>call.command==='voice_cloud_cancel').length)).toBe(1);
  expect(await page.evaluate(()=>window.cloudVoiceFixture.calls.some(call=>call.command==='voice_cloud_transcribe'))).toBe(false);
  await page.evaluate(()=>{window.cloudVoiceFixture.deferBegin=false;});
  await page.getByLabel('Type final result directly into terminal').check();
  await page.getByLabel('Auto-send: press Enter').check();
  await record(page);await (await workspaceControl(page,'Terminal')).click();await complete(page,'stale command');
  expect(await page.evaluate(()=>window.cloudVoiceFixture.writes)).toEqual([]);
});
