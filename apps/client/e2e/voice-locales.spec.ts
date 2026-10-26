import {expect,test} from '@playwright/test';
import {dictationFixture,completeDictation} from './fixtures/directDictation';
const labels=[
  {locale:'en',region:'Local dictation',engine:'Speech engine',model:'Model',language:'Language',record:'Record speech',stop:'Stop and transcribe',draft:'Dictation draft',direct:'Type final result directly into terminal',enter:'Auto-send: press Enter',transcribing:'Transcribing on this device…',queued:'Text and Enter queued to this terminal.',stage:'Stage in terminal composer',reuse:'Reuse dictation 1',recent:'Recent dictation (1)'},
  {locale:'pt-BR',region:'Ditado local',engine:'Mecanismo de fala',model:'Modelo',language:'Idioma',record:'Gravar fala',stop:'Parar e transcrever',draft:'Rascunho do ditado',direct:'Digitar o resultado final diretamente no terminal',enter:'Envio automático: pressionar Enter',transcribing:'Transcrevendo neste dispositivo…',queued:'Texto e Enter colocados na fila deste terminal.',stage:'Preparar no editor do terminal',reuse:'Reutilizar ditado 1',recent:'Histórico recente (1)'},
  {locale:'es',region:'Dictado local',engine:'Motor de voz',model:'Modelo',language:'Idioma',record:'Grabar voz',stop:'Detener y transcribir',draft:'Borrador del dictado',direct:'Escribir el resultado final directamente en el terminal',enter:'Envío automático: pulsar Enter',transcribing:'Transcribiendo en este dispositivo…',queued:'Texto y Enter puestos en cola para este terminal.',stage:'Preparar en el editor del terminal',reuse:'Reutilizar dictado 1',recent:'Historial reciente (1)'},
];
for(const initial of labels)test(`${initial.locale} Voice keeps recording, raw language/model, draft and exact once-only Enter delivery across live locale changes`,async({page})=>{
  await dictationFixture(page);
  await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},initial.locale);
  await expect(page.getByLabel(initial.direct,{exact:true})).not.toBeChecked();await expect(page.getByLabel(initial.enter,{exact:true})).toBeDisabled();
  await page.getByRole('combobox',{name:initial.language,exact:true}).selectOption('pt');
  await page.getByLabel(initial.direct,{exact:true}).check();await page.getByLabel(initial.enter,{exact:true}).check();
  const draft=await page.getByRole('textbox',{name:initial.draft,exact:true}).elementHandle();
  await page.getByRole('textbox',{name:initial.draft,exact:true}).fill('old draft {{literal}} <b>not HTML</b>');
  await page.getByRole('button',{name:initial.record,exact:true}).click();
  await expect(page.getByRole('button',{name:initial.stop,exact:true})).toBeVisible();
  const voiceCalls=()=>page.evaluate(()=>window.dictationFixture.calls.filter(call=>call.command.startsWith('voice_')||call.command.startsWith('apple_speech_')));
  const started=await voiceCalls();
  for(const current of labels){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);
    await expect(page.getByRole('button',{name:current.stop,exact:true})).toBeVisible();
    await expect(page.getByRole('combobox',{name:current.engine,exact:true})).toHaveValue('whisper');
    await expect(page.getByRole('combobox',{name:current.model,exact:true})).toHaveValue('tiny.bin');
    await expect(page.getByRole('combobox',{name:current.language,exact:true})).toHaveValue('pt');
    await expect(page.getByRole('textbox',{name:current.draft,exact:true})).toHaveValue('old draft {{literal}} <b>not HTML</b>');
    await expect(page.getByLabel(current.direct,{exact:true})).toBeDisabled();await expect(page.getByLabel(current.enter,{exact:true})).toBeChecked();
    expect(await voiceCalls()).toEqual(started);expect(await draft!.evaluate(node=>node.isConnected)).toBe(true);
  }
  await page.getByRole('button',{name:labels[2].stop,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.dictationFixture.complete)).toBe('function');
  const pending=await voiceCalls();
  for(const current of labels){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);
    await expect(page.getByText(current.transcribing,{exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:current.draft,exact:true}).focus();
    expect(await draft!.evaluate(node=>node===document.activeElement)).toBe(true);expect(await voiceCalls()).toEqual(pending);
    const geometry=await page.getByRole('region',{name:current.region,exact:true}).evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth}));expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  }
  await completeDictation(page,'echo 世界');
  await expect.poll(()=>page.evaluate(()=>window.dictationFixture.writes)).toEqual([{sessionId:await page.evaluate(()=>window.dictationFixture.sessionId),data:'echo 世界\r'}]);
  const delivered=await voiceCalls();
  for(const current of labels){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);
    await expect(page.getByText(current.queued,{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:current.draft,exact:true})).toHaveValue('echo 世界');
    expect(await voiceCalls()).toEqual(delivered);expect(await page.evaluate(()=>window.dictationFixture.writes.length)).toBe(1);
  }
  await page.getByText(labels[2].recent,{exact:true}).click();
  await page.getByRole('button',{name:labels[2].reuse,exact:true}).click();expect(await page.evaluate(()=>window.dictationFixture.writes.length)).toBe(1);
  await page.getByRole('button',{name:labels[2].stage,exact:true}).click();
  expect(await page.evaluate(()=>window.dictationFixture.staged)).toEqual([{sessionId:await page.evaluate(()=>window.dictationFixture.sessionId),text:'echo 世界'}]);
  expect(await page.locator('.voice-panel img,.voice-panel script').count()).toBe(0);
});
