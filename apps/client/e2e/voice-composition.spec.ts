import {expect,test} from '@playwright/test';
import {dictationFixture,recordDictation,completeDictation} from './fixtures/directDictation';

test('review dictation composes latest edits and repeated clips without sending until explicit Stage',async({page})=>{
  await dictationFixture(page);
  const draft=page.getByRole('textbox',{name:'Dictation draft',exact:true});
  await expect(page.getByLabel('Type final result directly into terminal',{exact:true})).not.toBeChecked();
  await draft.fill('  Typed 世界 <literal>  ');
  await recordDictation(page);await draft.fill('  Corrected 世界 <literal>  ');
  await completeDictation(page,'first sentence');
  await expect(draft).toHaveValue('  Corrected 世界 <literal>  \nfirst sentence');
  await recordDictation(page);await draft.fill('  Corrected 世界 <literal>  \nfirst sentence\nTyped follow-up');
  await completeDictation(page,'  second clip  ');
  const composed='  Corrected 世界 <literal>  \nfirst sentence\nTyped follow-up\n  second clip  ';
  await expect(draft).toHaveValue(composed);
  expect(await page.evaluate(()=>({staged:window.dictationFixture.staged,writes:window.dictationFixture.writes}))).toEqual({staged:[],writes:[]});
  await page.getByText('Recent dictation (2)',{exact:true}).click();
  expect(await page.getByRole('region',{name:'Dictation history',exact:true}).locator('li p').allTextContents()).toEqual(['  second clip  ','first sentence']);
  const region=page.getByRole('region',{name:'Local dictation',exact:true});
  expect(await region.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.getByRole('button',{name:'Stage in terminal composer',exact:true}).click();
  expect(await page.evaluate(()=>window.dictationFixture.staged)).toEqual([{sessionId:await page.evaluate(()=>window.dictationFixture.sessionId),text:composed}]);
  expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
});

test('review composition preserves the bounded draft and retranslates overflow without new native work',async({page})=>{
  await dictationFixture(page);
  const draft=page.locator('textarea').filter({visible:true});
  const initial='x'.repeat(65534),maximum=initial+'\nZ';
  await page.getByRole('textbox',{name:'Dictation draft',exact:true}).fill(initial);
  await recordDictation(page);await completeDictation(page,'Z');
  await expect(draft).toHaveValue(maximum);
  await recordDictation(page);await completeDictation(page,'overflow clip');
  const calls=await page.evaluate(()=>window.dictationFixture.calls);
  for(const [locale,message] of [
    ['en','The draft was kept because adding this dictation would exceed 65,536 characters. Shorten it before recording again.'],
    ['pt-BR','O rascunho foi mantido porque adicionar este ditado excederia 65.536 caracteres. Encurte-o antes de gravar novamente.'],
    ['es','El borrador se conservó porque añadir este dictado superaría los 65.536 caracteres. Acórtalo antes de volver a grabar.'],
  ]){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},locale);
    await expect(page.getByText(message,{exact:true})).toBeVisible();
    await expect(draft).toHaveValue(maximum);
    expect(await page.evaluate(()=>window.dictationFixture.calls)).toEqual(calls);
    expect(await page.evaluate(()=>window.dictationFixture.writes)).toEqual([]);
  }
});
