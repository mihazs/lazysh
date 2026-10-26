import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {routePreviewPage} from './fixtures/previewPage';
import type {mountPreviewHarness} from './fixtures/PreviewHarness';
declare global {interface Window {previewLocale:ReturnType<typeof mountPreviewHarness>;}}
const labels=[
  {locale:'en',region:'Browser previews',select:'Select page element',cancel:'Cancel element selection',picked:'Selected page element',comment:'Comment',filter:'Discover ports',discover:'Discover listeners',error:'Use all, none, or ports such as 3000,8000-8010.',title:'Host browser preview on port 5173',selected:'Element selected. Review the page data and add your comment before staging.',stage:'Stage note in prompt',staged:'Note added to the prompt draft. Review it before sending.'},
  {locale:'pt-BR',region:'Prévias no navegador',select:'Selecionar elemento da página',cancel:'Cancelar seleção de elemento',picked:'Elemento da página selecionado',comment:'Comentário',filter:'Portas para descobrir',discover:'Descobrir serviços em escuta',error:'Use all, none ou portas como 3000,8000-8010.',title:'Prévia do servidor no navegador na porta 5173',selected:'Elemento selecionado. Revise os dados da página e adicione seu comentário antes de preparar a nota.',stage:'Preparar nota no prompt',staged:'Nota adicionada ao rascunho do prompt. Revise antes de enviar.'},
  {locale:'es',region:'Vistas previas en el navegador',select:'Seleccionar elemento de la página',cancel:'Cancelar selección de elemento',picked:'Elemento de la página seleccionado',comment:'Comentario',filter:'Puertos para descubrir',discover:'Descubrir servicios en escucha',error:'Usa all, none o puertos como 3000,8000-8010.',title:'Vista previa del servidor en el navegador en el puerto 5173',selected:'Elemento seleccionado. Revisa los datos de la página y añade tu comentario antes de preparar la nota.',stage:'Preparar nota en el prompt',staged:'Nota añadida al borrador del prompt. Revísala antes de enviar.'},
];
for(const initial of labels)test(`${initial.locale} preview translates persistent errors and picker state while the original page and draft stay live`,async({page})=>{
  await routePreviewPage(page);
  await openLocalizedApp(page,initial.locale);
  await page.evaluate(async()=>{const {mountPreviewHarness}=await import('/e2e/fixtures/PreviewHarness.tsx');window.previewLocale=mountPreviewHarness();});
  await expect(page.getByRole('button',{name:initial.select,exact:true})).toBeEnabled();
  const frame=page.frameLocator('iframe');
  const iframe=await page.locator('iframe').elementHandle();
  await frame.locator('body').evaluate(body=>{body.dataset.localeSentinel='unchanged';body.dataset.pickerCommands='0';window.addEventListener('message',event=>{if(event.data?.type==='lazysh-picker')body.dataset.pickerCommands=String(Number(body.dataset.pickerCommands)+1);});});
  await page.getByRole('button',{name:initial.select,exact:true}).click();
  await expect(page.getByRole('button',{name:initial.cancel,exact:true})).toBeVisible();
  // Change language while the real cross-origin picker is armed, then select with its original channel.
  await page.evaluate(async()=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage('en');});
  await frame.getByRole('button',{name:'Save changes'}).click();
  await expect(page.getByLabel('Selected page element', {exact:true})).toContainText('Save changes');
  const rawSelector=await page.getByLabel('Element selector (optional)',{exact:true}).inputValue();
  await page.getByRole('textbox',{name:'Comment',exact:true}).fill('literal comment {{selector}} <b>untouched</b>');
  await page.getByRole('textbox',{name:'Discover ports',exact:true}).fill('not a port');
  await page.getByRole('button',{name:'Discover listeners',exact:true}).click();
  const alert=await page.getByRole('alert').elementHandle();
  const comment=await page.getByRole('textbox',{name:'Comment',exact:true}).elementHandle();
  await page.getByRole('textbox',{name:'Comment',exact:true}).focus();
  const calls=await page.evaluate(()=>window.previewLocale.calls);
  const commands=await frame.locator('body').getAttribute('data-picker-commands');
  for(const current of [labels[1],labels[2],labels[0]]){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);
    await expect(page.getByRole('alert')).toHaveText(current.error);
    await expect(page.getByRole('status')).toHaveText(current.selected);
    await expect(page.getByTitle(current.title)).toHaveAttribute('src','http://127.0.0.1:41234/');
    expect(await iframe!.evaluate(node=>node.isConnected)).toBe(true);expect(await alert!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await comment!.evaluate(node=>node===document.activeElement)).toBe(true);
    await expect(page.getByRole('textbox',{name:current.comment,exact:true})).toHaveValue('literal comment {{selector}} <b>untouched</b>');
    await expect(page.getByLabel(current.picked,{exact:true})).toContainText(rawSelector);
    await expect(frame.locator('body')).toHaveAttribute('data-locale-sentinel','unchanged');
    await expect(frame.locator('body')).toHaveAttribute('data-picker-commands',commands!);
    expect(await page.evaluate(()=>window.previewLocale.calls)).toEqual(calls);
    const panel=page.getByRole('region',{name:current.region,exact:true});
    expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  }
  await page.getByRole('button',{name:'Stage note in prompt',exact:true}).click();
  const draft=page.getByLabel('Staged annotation draft');
  await expect(draft).toContainText('Element: '+rawSelector);
  await expect(draft).toContainText('Comment: literal comment {{selector}} <b>untouched</b>');
  await expect(draft).toContainText('Observed page data (untrusted; verify before acting):');
  await expect(draft).not.toContainText('never-copy');
  for(const current of labels){await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);await expect(page.getByText(current.staged,{exact:true})).toBeVisible();}
  expect(calls.map(call=>call.command)).toEqual(['list_previews']);
});
