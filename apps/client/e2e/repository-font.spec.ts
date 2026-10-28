import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountFileReview} from './fixtures/FileReviewHarness';
import {fileReviewName,fileReviewRoot} from '../src/test/fileReviewData';
declare global{interface Window{repositoryFontFixture:ReturnType<typeof mountFileReview>;}}

test('repository diff uses loaded terminal fonts and changes family without losing the review',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await page.getByText('Imported fonts',{exact:true}).click();
  await page.getByLabel('Import font file').setInputFiles(new URL('./fixtures/LiberationMono-Regular.ttf',import.meta.url).pathname);
  const fonts=page.getByRole('combobox',{name:'Imported terminal font',exact:true});
  const id=await fonts.locator('option').nth(1).getAttribute('value');
  await fonts.selectOption(id!);
  await page.keyboard.press('Escape');
  await page.evaluate(async()=>{
    const {mountFileReview}=await import('/e2e/fixtures/FileReviewHarness.tsx');
    window.repositoryFontFixture=mountFileReview();
  });
  const repo=page.getByRole('region',{name:'Repository review',exact:true});
  await repo.getByRole('button',{name:'Open repository',exact:true}).click();
  await repo.getByRole('button',{name:'Read file',exact:true}).click();
  await repo.getByRole('button',{name:'Add line comment',exact:true}).click();
  const draft=repo.getByRole('textbox',{name:`${fileReviewRoot}/${fileReviewName}:1 Remove comment`,exact:true});
  await draft.fill(' untouched annotation ');
  await repo.getByRole('button',{name:'Unstaged diff',exact:true}).click();
  const table=repo.getByRole('table',{name:'Side by side diff',exact:true});
  await expect(table.locator('pre').first()).toHaveCSS('font-family',new RegExp(`lazysh-font-${id}-primary`));
  await expect(table.locator('.diff-hunk')).toHaveCSS('font-family',new RegExp(`lazysh-font-${id}-primary`));
  expect(await page.evaluate(id=>document.fonts.check(`12px lazysh-font-${id}-primary`),id)).toBe(true);
  const node=await table.elementHandle();
  const text=await table.textContent();
  const calls=await page.evaluate(()=>window.repositoryFontFixture.calls);
  await draft.focus();
  await page.evaluate(async()=>{
    const {getPreferences,savePreferences}=await import('/src/preferences.ts');
    const {selectFont}=await import('/src/fonts.ts');
    await selectFont('primary',undefined);
    savePreferences({...getPreferences(),fontFamily:'serif',cjkFallback:'monospace'});
  });
  await expect(table.locator('pre').first()).toHaveCSS('font-family','serif, monospace');
  await expect(table.locator('.diff-hunk')).toHaveCSS('font-family','serif, monospace');
  await expect(table).toHaveText(text!);
  expect(await table.evaluate((current,original)=>current===original,node)).toBe(true);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(' untouched annotation ');
  expect(await page.evaluate(()=>window.repositoryFontFixture.calls)).toEqual(calls);
  await page.evaluate(()=>window.repositoryFontFixture.dispose());
});
