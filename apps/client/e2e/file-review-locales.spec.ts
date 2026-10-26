import {attachmentReceipt} from '../src/test/attachmentData';
import {openLocalizedApp} from './fixtures/localizedApp';
import {expect,test} from '@playwright/test';
import type {mountFileReview} from './fixtures/FileReviewHarness';
import {fileReviewName,fileReviewOid,fileReviewRoot,fileReviewSession,fileReviewSource} from '../src/test/fileReviewData';
declare global {interface Window {fileReview:ReturnType<typeof mountFileReview>;}}
for(const labels of [
  {locale:'en',files:'Remote files',upload:'Upload file',destination:'Destination path',repo:'Repository review',open:'Open repository',revision:'Repository revision',comment:'Add line comment',stage:'Use in next prompt',highlight:'Highlight syntax',plain:'Show plain text',staged:'Staged diff',table:'Side by side diff'},
  {locale:'pt-BR',files:'Arquivos remotos',upload:'Enviar arquivo',destination:'Caminho de destino',repo:'Revisão do repositório',open:'Abrir repositório',revision:'Revisão do repositório',comment:'Adicionar comentário de linha',stage:'Usar no próximo prompt',highlight:'Destacar sintaxe',plain:'Mostrar texto simples',staged:'Diff preparado',table:'Diff lado a lado'},
  {locale:'es',files:'Archivos remotos',upload:'Subir archivo',destination:'Ruta de destino',repo:'Revisión del repositorio',open:'Abrir repositorio',revision:'Revisión del repositorio',comment:'Añadir comentario de línea',stage:'Usar en el próximo prompt',highlight:'Resaltar sintaxis',plain:'Mostrar texto sin formato',staged:'Diff preparado',table:'Diff en paralelo'},
])test(`${labels.locale} file review keeps selection, upload consent and editable comments through language changes`,async({page})=>{
  const external=await openLocalizedApp(page,labels.locale);
  await page.evaluate(async()=>{const {mountFileReview}=await import('/e2e/fixtures/FileReviewHarness.tsx');window.fileReview=mountFileReview();});
  const root=page.locator('.file-review-fixture');
  const files=root.getByRole('region',{name:labels.files,exact:true});
  await files.getByRole('button',{name:new RegExp(fileReviewName)}).click();
  await expect(files.locator('.file-preview pre')).toHaveText(fileReviewSource);
  await files.locator('input[type=file]').setInputFiles({name:'literal.txt',mimeType:'text/plain',buffer:Buffer.from('abc')});
  const destination=files.getByRole('textbox',{name:labels.destination,exact:true});await destination.fill('/literal/new destination.txt');
  const uploadNode=await destination.elementHandle();
  expect((await page.evaluate(()=>window.fileReview.calls)).some(call=>call.command==='upload_file')).toBe(false);
  const repo=root.getByRole('region',{name:labels.repo,exact:true});
  await repo.getByRole('button',{name:labels.open,exact:true}).click();
  await repo.getByRole('combobox',{name:labels.revision,exact:true}).selectOption(fileReviewOid);
  await repo.getByRole('button',{name:new RegExp(fileReviewName)}).click();
  await repo.getByRole('button',{name:labels.highlight,exact:true}).click();
  await expect(repo.locator('.hljs-keyword')).toBeVisible();
  const code=await repo.locator('.repository-code').elementHandle();
  await repo.getByRole('button',{name:labels.comment,exact:true}).click();
  const comment=repo.getByRole('textbox',{name:new RegExp(fileReviewName+':1')});await comment.fill('literal annotation <b>unchanged</b>');
  await repo.getByRole('button',{name:labels.stage,exact:true}).click();
  expect(await page.evaluate(()=>window.fileReview.drafts)).toEqual([{sessionId:fileReviewSession,text:`${fileReviewRoot}/${fileReviewName}:1 (commit ${fileReviewOid})\nliteral annotation <b>unchanged</b>`}]);
  const commentNode=await comment.elementHandle();await comment.focus();
  const before=await page.evaluate(()=>window.fileReview.calls);
  for(const panel of [files,repo])expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.evaluate(async()=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('en');});
  expect(await page.evaluate(()=>window.fileReview.calls)).toEqual(before);
  expect(await commentNode!.evaluate(node=>node===document.activeElement)).toBe(true);
  expect(await uploadNode!.evaluate(node=>node.isConnected&&(node as HTMLInputElement).value==='/literal/new destination.txt')).toBe(true);
  expect(await code!.evaluate(node=>node.isConnected)).toBe(true);
  const englishRepo=root.getByRole('region',{name:'Repository review',exact:true});
  await expect(englishRepo.getByRole('combobox',{name:'Repository revision',exact:true})).toHaveValue(fileReviewOid);
  await expect(englishRepo.getByRole('button',{name:'Show plain text',exact:true})).toBeVisible();
  await expect(englishRepo.locator('.repository-code')).toHaveText(fileReviewSource);
  await root.getByRole('button',{name:'Upload file',exact:true}).click();
  await expect.poll(async()=>page.evaluate(()=>window.fileReview.calls.filter(call=>call.command==='upload_file'))).toEqual([{command:'upload_file',args:{sessionId:fileReviewSession,path:'/literal/new destination.txt',data:[97,98,99],uploadId:attachmentReceipt}}]);
  await englishRepo.getByRole('combobox',{name:'Repository revision',exact:true}).selectOption('');
  await englishRepo.getByRole('button',{name:'Staged diff',exact:true}).click();
  await expect(englishRepo.getByRole('table',{name:'Side by side diff',exact:true})).toContainText('before literal');
  await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},labels.locale);
  await expect(root.getByRole('table',{name:labels.table,exact:true})).toContainText('after literal');
  expect(external).toEqual([]);expect(await root.locator('img,script,iframe').count()).toBe(0);
});
