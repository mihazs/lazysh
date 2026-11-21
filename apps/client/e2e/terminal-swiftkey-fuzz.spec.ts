import {expect,test,type Page} from '@playwright/test';
import {KeyboardModel,keyboard,open,random,state,swiftkeyUserAgent} from './fixtures/swiftkeyKeyboard';

/**
 * 1000 fuzzed keyboard sessions (letters, word ends, dots and punctuation, autospace, autocorrect, Backspace, erased
 * composing words, swipes) against the real terminal bridge in Chromium. Each must leave the terminal line, the editor
 * and the keyboard's own model equal: every key delivered once and in order, nothing swallowed and no edit held back.
 * A failure names its seed and the actions, which replay the same session.
 */
test.use({userAgent:swiftkeyUserAgent});
test.skip(({isMobile})=>!isMobile,'The soft keyboard exists on the phone project only.');
test.describe.configure({mode:'parallel'});
test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedHistory?.dispose());});

/** The state once the bridge has been idle for 30 ms: its completions are timers, so a read right after the last call is early. */
async function quiet(page:Page) {
  let seen=await state(page);
  for(let stable=0;stable<3;) {
    await page.waitForTimeout(10);
    const next=await state(page);
    stable=next.writes.length===seen.writes.length&&next.editor===seen.editor?stable+1:0;seen=next;
  }
  return seen;
}
const batches=4,perBatch=250;
for(let batch=0;batch<batches;batch++)
  test(`fuzzed keyboard sessions ${batch*perBatch+1}-${(batch+1)*perBatch} deliver every key exactly once`,async({page})=>{
    test.setTimeout(240_000);
    await open(page);
    const ime=await keyboard(page,2),failures:string[]=[];
    for(let index=0;index<perBatch&&failures.length<3;index++) {
      const seed=batch*perBatch+index+1,model=new KeyboardModel(ime,random(seed));
      await page.evaluate(()=>{window.ownedHistory.writes.length=0;});
      const length=3+Math.floor(random(seed*31)()*8);
      for(let action=0;action<length;action++)await model.step();
      const seen=await quiet(page);
      let typed='';
      for(const data of seen.writes.filter(data=>!data.startsWith('\x1b[<')))for(const character of data)typed=character==='\x7f'?typed.slice(0,-1):typed+character;
      if(typed!==model.text||seen.editor!==model.text||seen.skipped)failures.push(`seed ${seed}: keyboard ${JSON.stringify(model.text)}, editor ${JSON.stringify(seen.editor)}, terminal ${JSON.stringify(typed)}, held ${seen.skipped}; ${model.actions.join(' | ')}`);
      // The next session starts from the clean line a shell has after Enter.
      await page.keyboard.press('Enter');await quiet(page);
    }
    await ime.done();
    expect(failures).toEqual([]);
  });
