import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountAttachment} from './fixtures/AttachmentHarness';
import {attachmentDraft,attachmentPath,attachmentUploadedPath,attachmentSession,attachmentReceipt} from '../src/test/attachmentData';
import {shellPath} from '../src/attachment';
declare global{interface Window{attachment:ReturnType<typeof mountAttachment>;}}
for(const locale of ['en','pt-BR','es'])test(`${locale} attachment keeps the real crop/drawing, held upload and editable draft across languages`,async({page})=>{
  const external=await openLocalizedApp(page,locale);await page.evaluate(async()=>{const {mountAttachment}=await import('/e2e/fixtures/AttachmentHarness.tsx');window.attachment=mountAttachment();});
  const root=page.locator('.attachment-fixture');
  await root.evaluate(element=>{(element as HTMLElement).style.background='var(--theme-bg)';});
  const panel=root.locator('.attachment-panel');
  for(const introduction of [panel.getByRole('heading'),panel.locator(':scope > p').first()]) {
    const bounds=(await introduction.boundingBox())!, parent=(await panel.boundingBox())!;
    expect(bounds.x-parent.x).toBeGreaterThanOrEqual(16);
    expect(parent.x+parent.width-bounds.x-bounds.width).toBeGreaterThanOrEqual(16);
  }
  const fileControls=root.locator('input[type=file]');
  await expect(fileControls).toHaveCount(2);
  expect(await fileControls.evaluateAll(inputs=>inputs.every(input=>{
    const picker=getComputedStyle(input,'::file-selector-button');
    const button=getComputedStyle(input.closest('.button-row')!.querySelector('button')!);
    return picker.backgroundColor===button.backgroundColor&&picker.color===button.color&&parseFloat(picker.minHeight)>=44;
  }))).toBe(true);
  await page.screenshot({path:test.info().outputPath('file-controls.png')});
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=100;canvas.height=80;const context=canvas.getContext('2d')!;context.fillStyle='#fff';context.fillRect(0,0,100,80);return canvas.toDataURL('image/png').split(',')[1];});
  await root.locator('input[type=file]').first().setInputFiles({name:'literal {{name}}.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await root.getByRole('checkbox').check();
  expect(await root.getByRole('checkbox').evaluate(input=>{
    const label=input.closest('label')!, text=Array.from(label.childNodes).find(node=>node.nodeType===Node.TEXT_NODE && node.textContent?.trim())!;
    const range=document.createRange();range.selectNodeContents(text);
    const caption=range.getBoundingClientRect(), control=input.getBoundingClientRect();
    return caption.left>=control.right && Math.abs(caption.top+caption.height/2-control.top-control.height/2)<=2;
  })).toBe(true);
  await page.screenshot({path:test.info().outputPath('attachment-checkbox-layout.png')});
  const canvas=root.locator('canvas');await expect(canvas).toBeVisible();
  // Wait for the actual bounded image decode before drawing.
  await expect.poll(()=>canvas.evaluate(node=>node.getContext('2d')!.getImageData(5,5,1,1).data[3])).toBe(255);
  const box=(await canvas.boundingBox())!;await page.mouse.move(box.x+box.width*.2,box.y+box.height*.3);await page.mouse.down();await page.mouse.move(box.x+box.width*.4,box.y+box.height*.5);await page.mouse.up();
  const coordinates=root.locator('input[type=number]');await coordinates.nth(2).fill('50');await coordinates.nth(2).focus();
  const canvasNode=await canvas.elementHandle();const cropNode=await coordinates.nth(2).elementHandle();const pixels=await canvas.evaluate(node=>node.toDataURL());
  const before=await page.evaluate(()=>({calls:window.attachment.calls,resources:{...window.attachment.resources}}));
  for(const language of ['pt-BR','es','en']){
    await page.evaluate(async language=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:language as 'en'|'es'|'pt-BR'});},language);
    await expect(root.getByRole('heading',{name:language==='pt-BR'?'Anexar a este servidor':language==='es'?'Adjuntar a este servidor':'Attach to this host',exact:true})).toBeVisible();
    expect(await canvasNode!.evaluate(node=>node.isConnected)).toBe(true);expect(await cropNode!.evaluate(node=>node===document.activeElement)).toBe(true);expect(await canvas.evaluate(node=>node.toDataURL())).toBe(pixels);await expect(coordinates.nth(2)).toHaveValue('50');
    expect(await page.evaluate(()=>({calls:window.attachment.calls,resources:{...window.attachment.resources}}))).toEqual(before);expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  }
  await root.getByRole('textbox',{name:'Destination path',exact:true}).fill(attachmentPath);await root.getByRole('button',{name:'Upload attachment',exact:true}).click();await expect(root.getByRole('button',{name:'Uploading…',exact:true})).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>window.attachment.calls.length)).toBe(2);const upload=await page.evaluate(()=>window.attachment.calls);expect(upload).toHaveLength(2);expect(upload[1].command).toBe('upload_file');expect(upload[1].args).toMatchObject({sessionId:attachmentSession,path:attachmentPath});
  const uploaded=upload[1].args as {data:number[]};expect(uploaded.data.slice(0,8)).toEqual([137,80,78,71,13,10,26,10]);expect(new DataView(Uint8Array.from(uploaded.data).buffer).getUint32(16)).toBe(50);
  await page.evaluate(async()=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:'pt-BR'});});await expect(root.getByRole('button',{name:'Enviando…',exact:true})).toBeDisabled();expect(await page.evaluate(()=>window.attachment.calls)).toEqual(upload);
  await page.evaluate(()=>window.attachment.complete());const prompt=root.getByRole('textbox',{name:'Prompt editável',exact:true});await expect(prompt).toHaveValue(`Revise o arquivo anexado ${shellPath(attachmentUploadedPath)}.`);await prompt.fill(attachmentDraft);await prompt.focus();const draftNode=await prompt.elementHandle();
  await page.evaluate(async()=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:'es'});});expect(await draftNode!.evaluate(node=>node===document.activeElement)).toBe(true);await expect(root.getByRole('textbox',{name:'Prompt editable',exact:true})).toHaveValue(attachmentDraft);
  expect(await page.evaluate(()=>window.attachment.calls.filter(call=>call.command==='host_clipboard_copy'))).toEqual([]);
  await root.getByRole('button',{name:'Copiar ruta sin formato en el Mac remoto',exact:true}).click();
  await expect(root.getByText('Se completó la copia al portapapeles del Mac remoto.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.attachment.calls.filter(call=>call.command==='host_clipboard_copy'))).toEqual([{command:'host_clipboard_copy',args:{sessionId:attachmentSession,uploadId:attachmentReceipt}}]);
  expect(await page.evaluate(()=>window.attachment.copied)).toEqual([]);expect(await page.evaluate(()=>window.attachment.staged)).toEqual([]);await expect(root.getByRole('textbox',{name:'Prompt editable',exact:true})).toHaveValue(attachmentDraft);await root.getByRole('button',{name:'Copiar ruta del servidor',exact:true}).click();await root.getByRole('button',{name:'Copiar prompt',exact:true}).click();expect(await page.evaluate(()=>window.attachment.copied)).toEqual([shellPath(attachmentUploadedPath),attachmentDraft]);
  await root.getByRole('button',{name:'Preparar en el terminal',exact:true}).click();expect(await page.evaluate(()=>window.attachment.staged)).toEqual([{sessionId:attachmentSession,text:attachmentDraft}]);expect(await page.evaluate(()=>window.attachment.resources)).toEqual({created:1,revoked:0,reads:0});expect(await root.textContent()).not.toContain('c'.repeat(64));expect(await root.locator('img,script').count()).toBe(0);expect(external.filter(url=>!url.startsWith('blob:http://127.0.0.1:1420/'))).toEqual([]);
});
