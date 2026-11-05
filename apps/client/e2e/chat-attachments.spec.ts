import {expect,test,type Page} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {controlContrast} from './fixtures/controlContrast';
import {attachmentDraft,attachmentUploadedPath,attachmentSession} from '../src/test/attachmentData';
import {shellPath} from '../src/attachment';
async function openChat(page:Page) {
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const {mountAttachment}=await import('/e2e/fixtures/AttachmentHarness.tsx');window.attachment=mountAttachment({chat:true});});
  return page.locator('.attachment-fixture');
}

test('mobile attachment editor keeps the draft and returns to the original reading position',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Dedicated mobile attachment view');await page.setViewportSize({width:393,height:852});
  const owner=await openChat(page);await owner.evaluate(node=>{(node as HTMLElement).style.background='var(--theme-bg)';});
  const draft=owner.getByRole('textbox',{name:'Draft for this terminal',exact:true});await draft.fill(attachmentDraft);
  const original=await draft.elementHandle(),toggle=owner.getByRole('button',{name:'Add attachment',exact:true});
  await owner.locator('.chat-panel').evaluate(node=>{const spacer=document.createElement('div');spacer.style.height='900px';node.insertBefore(spacer,node.querySelector('.chat-draft'));});
  await toggle.scrollIntoViewIfNeeded();const before=await owner.evaluate(node=>node.scrollTop);expect(before).toBeGreaterThan(0);await toggle.click();
  await expect(owner.getByRole('button',{name:'Back',exact:true})).toBeFocused();await expect(draft).toBeHidden();
  await owner.getByLabel('Choose attachment',{exact:true}).setInputFiles({name:'private-log.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic chat attachment')});
  await expect(owner.getByRole('button',{name:'Upload attachment',exact:true})).toBeInViewport({ratio:1});
  await page.screenshot({path:testInfo.outputPath('mobile-attachment-selected.png'),animations:'disabled'});
  await page.setViewportSize({width:393,height:550});await page.evaluate(()=>{document.documentElement.style.zoom='1.35';});
  expect(await owner.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  await owner.getByRole('button',{name:'Upload attachment',exact:true}).scrollIntoViewIfNeeded();await expect(owner.getByRole('button',{name:'Upload attachment',exact:true})).toBeInViewport({ratio:1});
  await page.evaluate(()=>{document.documentElement.style.zoom='';});await page.setViewportSize({width:393,height:852});
  const modal=await page.evaluateHandle(()=>{const node=document.createElement('div');node.setAttribute('role','dialog');node.setAttribute('aria-modal','true');document.body.append(node);return node;});
  expect(await page.evaluate(()=>window.dispatchEvent(new Event('lazysh-workspace-back',{cancelable:true})))).toBe(true);await modal.evaluate(node=>node.remove());
  expect(await page.evaluate(()=>window.dispatchEvent(new Event('lazysh-workspace-back',{cancelable:true})))).toBe(false);
  await expect(toggle).toBeFocused();await expect(draft).toHaveValue(attachmentDraft);expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  expect(Math.abs((await owner.evaluate(node=>node.scrollTop))-before)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(()=>window.attachment.calls.some(call=>['upload_file','write','tmux_chat','herdr_chat'].includes(call.command)))).toBe(false);
  await page.evaluate(()=>window.attachment.dispose());
});

test('mobile attachment view does not reclaim focus after hiding or changing sessions',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Dedicated mobile attachment view');
  const owner=await openChat(page);await owner.getByRole('button',{name:'Add attachment',exact:true}).click();
  const outside=await page.evaluateHandle(()=>{const button=document.createElement('button');button.textContent='Other view';document.body.append(button);button.focus();return button;});
  await owner.evaluate(node=>{(node as HTMLElement).style.display='none';});
  expect(await page.evaluate(()=>window.dispatchEvent(new Event('lazysh-workspace-back',{cancelable:true})))).toBe(true);
  expect(await outside.evaluate(node=>document.activeElement===node)).toBe(true);
  await owner.evaluate(node=>{(node as HTMLElement).style.display='';});
  await page.evaluate(()=>window.attachment.setChatSession('other-owned-session'));
  await expect(owner.getByRole('button',{name:'Add attachment',exact:true})).toBeVisible();
  expect(await outside.evaluate(node=>document.activeElement===node)).toBe(true);
  expect(await page.evaluate(()=>window.attachment.calls.some(call=>['upload_file','write','tmux_chat','herdr_chat'].includes(call.command)))).toBe(false);
  await outside.evaluate(node=>node.remove());await page.evaluate(()=>window.attachment.dispose());
});
for(const locale of ['en','pt-BR','es'])test(`${locale} Chat attachment keeps the draft and adds only its canonical path explicitly`,async({page},testInfo)=>{
  const owner=await openChat(page);
  const draft=owner.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await draft.fill(attachmentDraft);const original=await draft.elementHandle();
  await owner.getByRole('button',{name:'Add attachment',exact:true}).click();
  await owner.getByLabel('Choose attachment',{exact:true}).setInputFiles({name:'private-log.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic chat attachment')});
  await owner.getByRole('button',{name:'Upload attachment',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.attachment.calls.some(call=>call.command==='upload_file'))).toBe(true);
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);await expect(owner.locator('.chat-composer textarea')).toHaveValue(attachmentDraft);
  const expectedDraft=testInfo.project.name==='phone'?attachmentDraft:`${attachmentDraft} + edited while uploading`;
  if(testInfo.project.name==='phone')await expect(owner.locator('.chat-composer textarea')).toBeHidden();else await draft.fill(expectedDraft);
  await page.evaluate(async locale=>{const {getPreferences,savePreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:locale as 'en'|'pt-BR'|'es'});},locale);
  await page.evaluate(()=>window.attachment.complete());
  const add=locale==='pt-BR'?'Adicionar caminho enviado ao rascunho do Chat':locale==='es'?'Añadir ruta subida al borrador del Chat':'Add uploaded path to Chat draft';
  await expect(owner.getByRole('button',{name:add,exact:true})).toBeVisible();
  await expect(owner.locator('.chat-composer textarea')).toHaveValue(expectedDraft);
  expect(await page.evaluate(()=>({copied:window.attachment.copied,staged:window.attachment.staged}))).toEqual({copied:[],staged:[]});
  await owner.getByRole('button',{name:add,exact:true}).click();
  await expect(owner.locator('.chat-composer textarea')).toHaveValue(`${expectedDraft}\n${shellPath(attachmentUploadedPath)}`);
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await page.evaluate(()=>window.attachment.calls.filter(call=>call.command==='upload_file').map(call=>(call.args as {sessionId:string}).sessionId))).toEqual([attachmentSession]);
  expect(await page.evaluate(()=>window.attachment.calls.some(call=>['write','tmux_chat','herdr_chat','host_clipboard_copy'].includes(call.command)))).toBe(false);
  await expect(owner.getByRole('button',{name:add,exact:true})).toHaveCount(0);
  const help=locale==='pt-BR'?'Como preparar o rascunho':locale==='es'?'Cómo preparar el borrador':'How staging works';
  const action=owner.getByRole('button',{name:help,exact:true});
  await action.click();await expect(action).toHaveAttribute('aria-expanded','true');
  await expect(owner.locator('.chat-draft-help')).toBeVisible();
  await action.click();await expect(owner.locator('.chat-draft-help')).toBeHidden();
  await page.evaluate(()=>window.attachment.dispose());
});

test('draft actions remain reachable by keyboard and touch across widths without staging text',async({page})=>{
  const owner=await openChat(page);
  const draft=owner.getByRole('textbox',{name:'Draft for this terminal',exact:true});
  await draft.fill('A draft stays here');
  const attachment=owner.locator('.chat-draft-tools button[aria-expanded]').first();
  const help=owner.getByRole('button',{name:'How staging works',exact:true});
  for(const width of [320,393,768,1280]) {
    await page.setViewportSize({width,height:852});
    for(const action of [attachment,help,owner.getByRole('button',{name:'Clear draft'}),owner.getByRole('button',{name:'Stage in terminal'})]) {
      const box=(await action.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
    }
    expect(await owner.locator('.chat-panel').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  }
  await page.setViewportSize({width:393,height:550});
  await page.evaluate(()=>{document.documentElement.style.zoom='1.35';});
  await draft.scrollIntoViewIfNeeded();await expect(draft).toBeInViewport();
  expect(await owner.locator('.chat-panel').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  const commands=await owner.locator('.chat-draft-commands').evaluate(controlContrast);
  expect(commands.find(item=>item.text==='Stage in terminal')!.ratio).toBeGreaterThanOrEqual(4.5);
  expect(commands.filter(item=>!item.text).every(item=>item.ratio>=3)).toBe(true);
  for(const background of ['#0b1728','#f8fcff']) {
    await owner.evaluate((node,color)=>{(node as HTMLElement).style.background=color;},background);
    const contrast=await owner.locator('.chat-draft-tools').evaluate(controlContrast);
    expect(contrast.every(item=>item.ratio>=3)).toBe(true);
  }
  await owner.evaluate(node=>{(node as HTMLElement).style.background='var(--background)';});
  const protocol=await page.context().newCDPSession(page);
  await protocol.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  expect(await page.evaluate(()=>matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true);
  await expect(owner.locator('.chat-draft-header')).toHaveCSS('backdrop-filter','none');
  await protocol.send('Emulation.setEmulatedMedia',{features:[]});await protocol.detach();
  await page.emulateMedia({forcedColors:'active'});
  await expect(owner.locator('.chat-draft-header')).toHaveCSS('backdrop-filter','none');
  await page.emulateMedia({forcedColors:'none'});
  await page.evaluate(()=>{document.documentElement.style.zoom='';});
  await attachment.focus();await page.keyboard.press('Space');
  await expect(attachment).toHaveAttribute('aria-expanded','true');
  await expect(owner.getByRole('button',{name:'Back',exact:true})).toBeFocused();
  await page.keyboard.press('Space');await expect(attachment).toHaveAttribute('aria-expanded','false');
  await help.focus();await page.keyboard.press('Enter');
  await expect(help).toBeFocused();await expect(help).toHaveAttribute('aria-expanded','true');
  await expect(owner.locator('.chat-draft-help')).toContainText('verify the intended agent pane');
  await page.keyboard.press('Enter');await expect(help).toHaveAttribute('aria-expanded','false');
  await expect(draft).toHaveValue('A draft stays here');
  expect(await page.evaluate(()=>window.attachment.staged)).toEqual([]);
  expect(await page.evaluate(()=>window.attachment.calls.some(call=>['write','tmux_chat','herdr_chat'].includes(call.command)))).toBe(false);
  await page.evaluate(()=>window.attachment.dispose());
});
