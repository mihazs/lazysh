import {openPreferenceCategory} from './fixtures/workspaceControl';
import {expect,test} from '@playwright/test';

test('Preferences saves a thirteenth chord and snippet and retains their exact text after reload',async({page})=>{
  await page.goto('/');
  await page.evaluate(()=>{
    const entries=Array.from({length:12},(_,i)=>({label:`Saved ${i}`,keys:'F12',text:`Value ${i}`}));
    localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,chords:entries,snippets:entries}));
  });
  await page.reload();
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  for(const chord of [true,false]){
    await openPreferenceCategory(page,'Input');
    await page.getByText(chord?'Keyboard chords':'Text snippets',{exact:true}).click();
    await page.getByLabel(chord?'Chord name':'Snippet name',{exact:true}).fill('Thirteenth');
    await page.getByLabel(chord?'Key sequence':'Snippet text',{exact:true}).fill(chord?'text: 你好 tail ':' 你好 tail ');
    await page.getByRole('button',{name:chord?'Add chord':'Add snippet',exact:true}).click();
  }
  await page.reload();
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  for(const kind of ['chord','snippet']){
    await openPreferenceCategory(page,'Input');
    await page.getByText(kind==='chord'?'Keyboard chords':'Text snippets',{exact:true}).click();
    await expect(page.getByRole('button',{name:`Remove ${kind} Thirteenth`,exact:true})).toBeVisible();
  }
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!));
  expect(stored.chords).toHaveLength(13);
  expect(stored.snippets).toHaveLength(13);
  expect(stored.chords[12]).toEqual({label:'Thirteenth',keys:'text: 你好 tail '});
  expect(stored.snippets[12]).toEqual({label:'Thirteenth',text:' 你好 tail '});
});
