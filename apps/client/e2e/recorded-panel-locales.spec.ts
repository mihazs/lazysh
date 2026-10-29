import {expectPanelInsets} from './fixtures/panelLayout';
import {openLocalizedApp} from './fixtures/localizedApp';
import {expect,test} from '@playwright/test';
import type {mountRecordedPanels} from './fixtures/RecordedPanelsHarness';
import {panelRawText,panelSession,panelTimestamp} from '../src/test/recordedPanelData';
declare global {interface Window {recordedPanels:ReturnType<typeof mountRecordedPanels>;}}
for(const labels of [
  {locale:'pt-BR',transcript:'Transcrição do agente',path:'Caminho da transcrição',open:'Abrir transcrição',draft:'Rascunho para este terminal',stage:'Preparar no terminal',usage:'Uso de tokens registrado',usageAgent:'Agente dos dados de uso',usagePath:'Caminho da transcrição de uso',inspect:'Inspecionar uso',inbox:'Caixa de entrada dos agentes',connected:'Abrir sessão conectada',archive:'Arquivar',minute:'1 minuto'},
  {locale:'es',transcript:'Transcripción del agente',path:'Ruta de la transcripción',open:'Abrir transcripción',draft:'Borrador para este terminal',stage:'Preparar en el terminal',usage:'Uso de tokens registrado',usageAgent:'Agente de los datos de uso',usagePath:'Ruta de la transcripción de uso',inspect:'Inspeccionar uso',inbox:'Bandeja de entrada de agentes',connected:'Abrir sesión conectada',archive:'Archivar',minute:'1 minuto'},
]) test(`${labels.locale} recorded panels keep long labels readable and actions tied to original records`,async({page})=>{
  const external=await openLocalizedApp(page,labels.locale);
  await page.evaluate(async()=>{const {mountRecordedPanels}=await import('/e2e/fixtures/RecordedPanelsHarness.tsx');window.recordedPanels=mountRecordedPanels();});
  const root=page.locator('.recorded-panels-fixture');
  await expect(root.getByRole('heading',{name:labels.transcript,exact:true})).toBeVisible();
  await root.getByRole('textbox',{name:labels.path,exact:true}).fill('/literal/session.jsonl');
  await root.getByRole('button',{name:labels.open,exact:true}).click();
  await expect(root.locator('.chat-message')).toHaveCount(1);
  await root.locator('.chat-message summary').click();
  await expect(root.locator('.chat-message pre')).toHaveText(JSON.stringify({argument:panelRawText}));
  const draft=root.getByRole('textbox',{name:labels.draft,exact:true});await draft.fill(panelRawText);
  const draftNode=await draft.elementHandle();
  await root.getByRole('button',{name:labels.stage,exact:true}).click();
  expect(await page.evaluate(()=>window.recordedPanels.drafts)).toEqual([{sessionId:panelSession.id,text:panelRawText}]);
  await root.getByRole('combobox',{name:labels.usageAgent,exact:true}).selectOption('codex');
  await root.getByRole('textbox',{name:labels.usagePath,exact:true}).fill('/literal/usage.jsonl');
  await root.getByRole('button',{name:labels.inspect,exact:true}).click();
  await expect(root.getByRole('cell',{name:labels.minute,exact:true})).toBeVisible();
  expect(await root.locator('time').evaluateAll(times=>times.every(time=>time.dateTime==='2026-10-25T12:34:56.000Z'))).toBe(true);
  expect(await root.locator('time').first().getAttribute('datetime')).toBe(panelTimestamp);
  for(const name of [labels.transcript,labels.usage,labels.inbox]) {
    const panel=root.getByRole('region',{name,exact:true});
    await expect(panel).toBeVisible();
    expect(await panel.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    await expectPanelInsets(panel);
  }
  await root.getByRole('button',{name:labels.connected,exact:true}).click();
  expect(await page.evaluate(()=>window.recordedPanels.opened)).toEqual([{sessionId:panelSession.id}]);
  const before=await page.evaluate(()=>window.recordedPanels.calls);
  await page.evaluate(async()=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:'en'});});
  await expect(root.getByRole('textbox',{name:'Draft for this terminal',exact:true})).toHaveValue(panelRawText);
  expect(await draftNode!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await page.evaluate(()=>window.recordedPanels.calls)).toEqual(before);
  expect(before.map(call=>call.command)).toEqual(['agent_transcript','agent_usage']);
  await root.getByRole('button',{name:'Archive',exact:true}).click();await expect(root.locator('.notification-list article')).toHaveCount(0);
  expect(external).toEqual([]);expect(await root.locator('img,script').count()).toBe(0);
});


test('transcript checkbox captions stay beside controls at normal and enlarged display scale',async({page})=>{
  await openLocalizedApp(page,'en');
  await page.evaluate(async()=>{const {mountRecordedPanels}=await import('/e2e/fixtures/RecordedPanelsHarness.tsx');window.recordedPanels=mountRecordedPanels();});
  const root=page.locator('.recorded-panels-fixture');
  await root.evaluate(element=>{(element as HTMLElement).style.background='var(--theme-bg)';});
  const checkbox=root.locator('.chat-panel').getByRole('checkbox').first();
  await expect(checkbox).toBeVisible();
  for(const width of [393,412,1280]) for(const zoom of [1,1.35]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(scale=>{document.documentElement.style.zoom=String(scale);},zoom);
    expect(await checkbox.evaluate(input=>{
      const label=input.closest('label')!, text=Array.from(label.childNodes).find(node=>node.nodeType===Node.TEXT_NODE && node.textContent?.trim())!;
      const range=document.createRange();range.selectNodeContents(text);
      const caption=range.getBoundingClientRect(), control=input.getBoundingClientRect();
      return caption.left>=control.right && Math.abs(caption.top+caption.height/2-control.top-control.height/2)<=2;
    })).toBe(true);
    expect(await root.locator('.chat-panel').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  }
  await page.setViewportSize({width:393,height:900});
  await page.screenshot({path:test.info().outputPath('transcript-checkbox-layout.png')});
});
