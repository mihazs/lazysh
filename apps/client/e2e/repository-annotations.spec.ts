import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountFileReview} from './fixtures/FileReviewHarness';
import {fileReviewName,fileReviewRoot,fileReviewSession} from '../src/test/fileReviewData';
declare global{interface Window{repositoryNotesFixture:ReturnType<typeof mountFileReview>;}}
test('diff-side notes retain their observed references and drafts until explicit staging',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const {mountFileReview}=await import('/e2e/fixtures/FileReviewHarness.tsx');window.repositoryNotesFixture=mountFileReview();});
  const repo=page.getByRole('region',{name:'Repository review',exact:true});
  await repo.getByRole('button',{name:'Open repository',exact:true}).click();
  await repo.getByRole('button',{name:'Unstaged diff',exact:true}).click();
  const table=repo.getByRole('table',{name:'Side by side diff',exact:true});
  await expect(table.getByText('before literal',{exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>window.repositoryNotesFixture.calls);
  await repo.getByRole('button',{name:'Comment on Before line 1',exact:true}).click();
  await repo.getByRole('button',{name:'Comment on After line 1',exact:true}).click();
  const fields=repo.getByRole('region',{name:'Review comments',exact:true}).getByRole('textbox');
  await fields.nth(0).fill('Explain this removal.');
  await fields.nth(1).fill('Keep this addition literal: <img src=never-fetch>.');
  await expect(repo.getByText('Comments refer to the displayed snapshot. Host files may have changed; review paths and lines before sending.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.repositoryNotesFixture.drafts)).toEqual([]);
  expect(await page.evaluate(()=>window.repositoryNotesFixture.calls)).toEqual(calls);
  await repo.getByRole('button',{name:'Staged diff',exact:true}).click();
  await expect(table.getByText('after literal',{exact:true})).toBeVisible();
  await expect(fields.nth(0)).toHaveValue('Explain this removal.');
  await expect(fields.nth(1)).toHaveValue('Keep this addition literal: <img src=never-fetch>.');
  await repo.getByRole('button',{name:'Use in next prompt',exact:true}).click();
  expect(await page.evaluate(()=>window.repositoryNotesFixture.drafts)).toEqual([{sessionId:fileReviewSession,text:
    `${fileReviewRoot}/${fileReviewName}:1 (observed unstaged diff, before)\nExplain this removal.\n\n${fileReviewRoot}/${fileReviewName}:1 (observed unstaged diff, after)\nKeep this addition literal: <img src=never-fetch>.`}]);
  await expect(repo.getByText('Comments staged for your next prompt. Review before sending.',{exact:true})).toBeVisible();
  await expect(repo.locator('img,script,iframe')).toHaveCount(0);
  expect(await page.evaluate(()=>window.repositoryNotesFixture.calls.some(row=>row.command==='write_stdin'))).toBe(false);
  await page.evaluate(()=>window.repositoryNotesFixture.dispose());
});
