import {expect,test} from '@playwright/test';
import type {mountFileReview} from './fixtures/FileReviewHarness';
import {fileReviewName,fileReviewOid,fileReviewSession,fileReviewSource} from '../src/test/fileReviewData';
declare global{interface Window{rememberedReview:ReturnType<typeof mountFileReview>;}}
const mount=(page:import('@playwright/test').Page)=>page.evaluate(async()=>{const {mountFileReview}=await import('/e2e/fixtures/FileReviewHarness.tsx');window.rememberedReview=mountFileReview();});
test('a reload reopens the historical file and revision remembered for the session',async({page})=>{
  await page.goto('/');await mount(page);
  const repo=page.getByRole('region',{name:'Repository review',exact:true});
  await repo.getByRole('button',{name:'Open repository',exact:true}).click();
  await repo.getByRole('combobox',{name:'Repository revision',exact:true}).selectOption(fileReviewOid);
  await repo.getByRole('button',{name:new RegExp(fileReviewName)}).click();
  await expect(repo.locator('.repository-code')).toHaveText(fileReviewSource);
  expect(JSON.parse(await page.evaluate(key=>sessionStorage.getItem(key)!,`lazysh-review:${fileReviewSession}`))).toMatchObject({revision:fileReviewOid,file:fileReviewName});
  await page.reload();await mount(page);
  const reopened=page.getByRole('region',{name:'Repository review',exact:true});
  await expect(reopened.getByRole('combobox',{name:'Repository revision',exact:true})).toHaveValue(fileReviewOid);
  await expect(reopened.locator('.repository-code')).toHaveText(fileReviewSource);
  const commands=(await page.evaluate(()=>window.rememberedReview.calls)).map(call=>call.command);
  expect(commands).toEqual(expect.arrayContaining(['repository_status','repository_history','repository_tree','repository_blob']));
  expect(commands).not.toContain('read_file');
});
