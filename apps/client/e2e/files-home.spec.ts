import {expect,test} from '@playwright/test';
import type {mountFileReview} from './fixtures/FileReviewHarness';
import {fileReviewHome,fileReviewSession} from '../src/test/fileReviewData';
declare global {interface Window {fileReview:ReturnType<typeof mountFileReview>;}}

test('Files opens ~ paths in the host home and shows the resolved absolute path',async({page})=>{
  await page.goto('/');
  await page.evaluate(async()=>{const {mountFileReview}=await import('/e2e/fixtures/FileReviewHarness.tsx');window.fileReview=mountFileReview();});
  const files=page.getByRole('region',{name:'Remote files',exact:true});
  const directory=files.getByRole('textbox',{name:'Remote directory',exact:true});
  await files.getByRole('button',{name:'unchanged.ts'}).waitFor();
  await directory.fill('~/projetos/日本語 dir/');
  await files.getByRole('button',{name:'Open',exact:true}).click();
  await expect(directory).toHaveValue(`${fileReviewHome}/projetos/日本語 dir`);
  await directory.fill('~');
  await files.getByRole('button',{name:'Open',exact:true}).click();
  await expect(directory).toHaveValue(fileReviewHome);
  await directory.fill('~root/.ssh');
  await files.getByRole('button',{name:'Open',exact:true}).click();
  await expect(files.getByRole('alert')).toContainText('Only ~ and ~/ expand');
  expect(await page.evaluate(()=>window.fileReview.calls.filter(call=>call.command==='list_directory'||call.command==='host_home'))).toEqual([
    {command:'list_directory',args:{sessionId:fileReviewSession,path:'.'}},
    {command:'host_home',args:{sessionId:fileReviewSession}},
    {command:'list_directory',args:{sessionId:fileReviewSession,path:`${fileReviewHome}/projetos/日本語 dir`}},
    {command:'list_directory',args:{sessionId:fileReviewSession,path:fileReviewHome}},
  ]);
  expect(await files.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
});
