import {expect,test,type Page} from '@playwright/test';
import {startLocalTerminal} from './fixtures/localTerminal';

/** A local terminal whose program asks for bracketed paste, or not. */
async function openComposer(page:Page,bracketed:boolean) {
  await startLocalTerminal(page);
  await page.evaluate(mode=>window.simpleShortcutOutput(`$ \x1b[?2004${mode?'h':'l'}`),bracketed);
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Compose text',exact:true});
  await expect(editor).toBeFocused();
  return editor;
}
const steps=(page:Page)=>page.evaluate(()=>window.simpleShortcutSteps);
const writes=(page:Page)=>page.evaluate(()=>window.simpleShortcutWrites);
const frame=(bracketed:boolean,text:string)=>bracketed?`\x1b[200~${text}\x1b[201~`:text;

for(const bracketed of [false,true])for(const [shape,draft,pasted] of [['single line','ls -la','ls -la'],['multi-line','first line\nsecond line','first line\rsecond line']] as const){
  test(`Send writes the ${shape} draft then Enter, Insert writes only the draft (bracketed paste ${bracketed?'on':'off'})`,async({page})=>{
    const editor=await openComposer(page,bracketed);
    const resizes=await page.evaluate(()=>window.simpleShortcutResizes.length);
    await editor.fill(draft);
    await page.getByRole('button',{name:'Insert',exact:true}).click();
    // Insert is the paste alone: one write, no Enter, the composer closes, the terminal keeps focus.
    await expect.poll(()=>writes(page)).toEqual([frame(bracketed,pasted)]);
    expect(await steps(page)).toEqual([]);
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.terminal-canvas .xterm-helper-textarea')).toBeFocused();
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    await expect(editor).toHaveValue('');
    await editor.fill(draft);
    await page.getByRole('button',{name:'Send',exact:true}).click();
    // Send is that same paste plus a separate Enter, delivered as one sequence.
    await expect.poll(()=>steps(page)).toEqual([[frame(bracketed,pasted),'\r']]);
    expect(await writes(page)).toEqual([frame(bracketed,pasted),frame(bracketed,pasted)+'\r']);
    expect(await page.evaluate(()=>window.simpleShortcutResizes.length)).toBe(resizes);
  });
}

test('Ctrl+Enter sends and Ctrl+Shift+Enter inserts, whichever way the preference points',async({page})=>{
  const editor=await openComposer(page,true);
  await editor.fill('echo ok');await editor.press('Control+Enter');
  await expect.poll(()=>steps(page)).toEqual([['\x1b[200~echo ok\x1b[201~','\r']]);
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await editor.fill('echo later');await editor.press('Control+Shift+Enter');
  await expect.poll(()=>writes(page)).toEqual(['\x1b[200~echo ok\x1b[201~\r','\x1b[200~echo later\x1b[201~']);
  expect(await steps(page)).toHaveLength(1);
});

test('a failed write keeps the draft and the composer, and a retry delivers it once',async({page})=>{
  const editor=await openComposer(page,false);
  await editor.fill('keep this');
  await page.evaluate(()=>{window.simpleShortcutWriteFailure='backpressure';});
  await page.getByRole('button',{name:'Insert',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(editor).toHaveValue('keep this');
  await page.evaluate(()=>{window.simpleShortcutWriteFailure=undefined;});
  await page.getByRole('button',{name:'Insert',exact:true}).click();
  await expect(editor).toHaveCount(0);
  // The first attempt reached the recorder before it failed; only the accepted retry closed the composer.
  expect(await writes(page)).toEqual(['keep this','keep this']);
});

test('Insert accepts whitespace that Send refuses, and both are labelled',async({page},testInfo)=>{
  const editor=await openComposer(page,false);
  await editor.fill('   ');
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Insert',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Insert',exact:true})).toHaveAttribute('title','Put the draft on the input line without pressing Enter');
  await editor.fill('ls');
  const sheet=page.locator('.terminal-composer-sheet');
  expect(await sheet.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  for(const name of ['Insert','Send'])await expect(page.getByRole('button',{name,exact:true})).toBeInViewport({ratio:1});
  await page.screenshot({path:testInfo.outputPath('composer-send-insert.png'),animations:'disabled'});
});
