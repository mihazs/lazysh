import {expect,test,type Page} from '@playwright/test';
import {cloudVoiceFixture,enrollCloud,recordCloud,completeCloud} from './fixtures/cloudVoice';

declare global {interface Window {localeHistoryTransactions:number;}}
const labels=[
  {locale:'en',record:'Record speech',draft:'Dictation draft',cloud:'Cloud service',refresh:'Refresh Cloud service',quota:'Service audio quota remaining: device 30.0 seconds; shared 60.0 seconds.',history:'Dictation history',remember:'Remember dictation history on this device',recent:'Recent dictation (1)',reuse:'Reuse dictation 1',clear:'Clear history',forget:'Forget Cloud device',failed:'Remember is off for this view, but saved history could not be deleted. Retry Delete or Clear history before closing.'},
  {locale:'pt-BR',record:'Gravar fala',draft:'Rascunho do ditado',cloud:'Serviço Cloud',refresh:'Atualizar serviço Cloud',quota:'Cota de áudio restante do serviço: dispositivo 30,0 segundos; compartilhada 60,0 segundos.',history:'Histórico de ditados',remember:'Lembrar histórico de ditados neste dispositivo',recent:'Histórico recente (1)',reuse:'Reutilizar ditado 1',clear:'Limpar histórico',forget:'Esquecer dispositivo Cloud',failed:'Lembrar está desativado nesta visualização, mas não foi possível excluir o histórico salvo. Tente Excluir ou Limpar histórico novamente antes de fechar.'},
  {locale:'es',record:'Grabar voz',draft:'Borrador del dictado',cloud:'Servicio Cloud',refresh:'Actualizar servicio Cloud',quota:'Cuota de audio restante del servicio: dispositivo 30,0 segundos; compartida 60,0 segundos.',history:'Historial de dictados',remember:'Recordar el historial de dictados en este dispositivo',recent:'Historial reciente (1)',reuse:'Reutilizar dictado 1',clear:'Borrar historial',forget:'Olvidar dispositivo Cloud',failed:'Recordar está desactivado en esta vista, pero no se pudo eliminar el historial guardado. Vuelve a intentar Eliminar o Borrar historial antes de cerrar.'},
];
const transcript='raw transcription {{name}} <img src=secret> 中文';
async function observeHistoryTransactions(page:Page){
  await page.evaluate(()=>{
    window.localeHistoryTransactions=0;const original=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args:Parameters<IDBDatabase['transaction']>){window.localeHistoryTransactions++;return original.apply(this,args);};
  });
}
for(const initial of labels)test(`${initial.locale} keeps in-flight dictation and real stored history unchanged while translating Cloud/history controls`,async({page})=>{
  await cloudVoiceFixture(page);await enrollCloud(page);
  const draft=page.getByRole('textbox',{name:'Dictation draft',exact:true});await draft.fill('edited draft before result');const draftNode=await draft.elementHandle();
  await recordCloud(page);
  const calls=await page.evaluate(()=>window.cloudVoiceFixture.calls.filter(call=>call.command.startsWith('voice_')||call.command.startsWith('apple_speech_')));
  for(const current of labels){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);
    await expect(page.getByRole('group',{name:current.cloud,exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:current.refresh,exact:true})).toBeDisabled();
    await expect(page.getByText(current.quota,{exact:true})).toBeVisible();
    await expect(page.getByRole('textbox',{name:current.draft,exact:true})).toHaveValue('edited draft before result');expect(await draftNode!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await page.evaluate(()=>window.cloudVoiceFixture.calls.filter(call=>call.command.startsWith('voice_')||call.command.startsWith('apple_speech_')))).toEqual(calls);
  }
  await completeCloud(page,transcript);
  await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},initial.locale);
  await expect(page.getByRole('textbox',{name:initial.draft,exact:true})).toHaveValue(transcript);
  await page.getByLabel(initial.remember,{exact:true}).click();
  await expect(page.getByLabel(initial.remember,{exact:true})).toBeChecked();
  await expect(page.getByLabel(initial.remember,{exact:true})).toBeEnabled();
  await page.getByText(initial.recent,{exact:true}).click();
  const row=await page.getByRole('region',{name:initial.history,exact:true}).getByRole('listitem').elementHandle();
  const date=await page.locator('.voice-panel time').getAttribute('datetime');
  await observeHistoryTransactions(page);
  for(const current of labels){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);
    await expect(page.getByLabel(current.remember,{exact:true})).toBeChecked();expect(await row!.evaluate(node=>node.isConnected)).toBe(true);
    await expect(page.locator('.voice-panel time')).toHaveAttribute('datetime',date!);
    expect(await page.evaluate(()=>window.localeHistoryTransactions)).toBe(0);
    const panel=page.getByRole('region',{name:current.history,exact:true});
    const geometry=await panel.evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth,children:[...element.querySelectorAll('*')].map(child=>({tag:child.tagName,width:child.getBoundingClientRect().width,right:child.getBoundingClientRect().right-element.getBoundingClientRect().left,scroll:child.scrollWidth})).filter(child=>child.right>element.clientWidth)}));
    expect(geometry.scroll,JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width);
    const cloud=page.getByRole('group',{name:current.cloud,exact:true});expect(await cloud.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  }
  await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},initial.locale);
  await page.getByRole('textbox',{name:initial.draft,exact:true}).fill('manual edit');await page.getByRole('button',{name:initial.reuse,exact:true}).click();await expect(page.getByRole('textbox',{name:initial.draft,exact:true})).toHaveValue(transcript);
  await page.getByRole('button',{name:initial.clear,exact:true}).click();await expect(page.getByText(initial.recent,{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:initial.forget,exact:true}).click();await expect(page.getByRole('button',{name:initial.record,exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.cloudVoiceFixture.writes)).toEqual([]);expect(await page.locator('.voice-panel img,.voice-panel script').count()).toBe(0);
});
test('failed history disable remains translated and retryable without storage work on locale changes',async({page})=>{
  await cloudVoiceFixture(page);await enrollCloud(page);await recordCloud(page);await completeCloud(page,transcript);
  await page.getByLabel(labels[0].remember,{exact:true}).click();await expect(page.getByLabel(labels[0].remember,{exact:true})).toBeChecked();await expect(page.getByLabel(labels[0].remember,{exact:true})).toBeEnabled();
  await page.evaluate(()=>{
    const original=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(..._args:Parameters<IDBDatabase['transaction']>){IDBDatabase.prototype.transaction=original;throw new Error('Synthetic history deletion failure');};
  });
  await page.getByLabel(labels[0].remember,{exact:true}).uncheck();await expect(page.getByRole('alert')).toHaveText(labels[0].failed);
  const alert=await page.getByRole('alert').elementHandle();
  await observeHistoryTransactions(page);
  for(const current of labels){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},current.locale);
    await expect(page.getByRole('alert')).toHaveText(current.failed);expect(await alert!.evaluate(node=>node.isConnected)).toBe(true);
    await expect(page.getByLabel(current.remember,{exact:true})).not.toBeChecked();expect(await page.evaluate(()=>window.localeHistoryTransactions)).toBe(0);
  }
  await page.getByRole('button',{name:labels[2].clear,exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(labels[2].recent,{exact:true})).toHaveCount(0);
});
