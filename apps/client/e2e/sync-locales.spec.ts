import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import {syncConflict,syncEndpoint,syncHost,syncPassword,syncRecovery,syncUsername} from '../src/test/syncData';
import type {mountSyncHarness} from './fixtures/SyncHarness';
declare global {interface Window {syncFixture:ReturnType<typeof mountSyncHarness>;}}
for(const locale of ['en','pt-BR','es'])test(`${locale} encrypted sync keeps explicit consent, secret bytes and scope payloads through language changes`,async({page})=>{
  const external=await openLocalizedApp(page,locale);
  await page.evaluate(async()=>{const {mountSyncHarness}=await import('/e2e/fixtures/SyncHarness.tsx');window.syncFixture=mountSyncHarness();});
  const panel=page.locator('.sync-fixture');
  const labels=await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return {directory:t('syncDirectory'),username:t('syncUsername'),password:t('syncPassword'),recoveryImport:t('syncRecoveryImport'),settings:t('syncEnableSettings'),credentials:t('syncEnableCredentials'),configure:t('syncConfigure'),recovery:t('syncRecoveryKey'),show:t('syncShowRecovery'),hide:t('syncHideRecovery'),preview:t('syncPreviewCredentials'),apply:t('syncApply'),cancel:t('syncCancel'),uploadSettings:t('syncUploadSettings'),uploadCredentials:t('syncUploadCredentials'),disconnect:t('syncDisconnect')};});
  async function cycle(){
    const before=await page.evaluate(()=>window.syncFixture.calls);
    for(const language of ['pt-BR','es','en',locale]){
      const name=await page.evaluate(async language=>{const {uiI18n,t}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(language);return t('appEncryptedSync');},language);
      await expect(panel.getByRole('region',{name,exact:true})).toBeVisible();
      expect(await page.evaluate(()=>window.syncFixture.calls)).toEqual(before);
    }
  }
  await expect(panel.getByRole('button',{name:labels.configure,exact:true})).toBeEnabled();
  for(const [name,value] of [[labels.directory,syncEndpoint],[labels.username,syncUsername],[labels.password,syncPassword],[labels.recoveryImport,syncRecovery]])await panel.getByLabel(name,{exact:true}).fill(value);
  await panel.getByRole('checkbox',{name:labels.settings,exact:true}).check();await panel.getByRole('checkbox',{name:labels.credentials,exact:true}).check();
  const password=panel.getByLabel(labels.password,{exact:true});await password.focus();const input=await password.elementHandle();
  await cycle();expect(await input!.evaluate(node=>node===document.activeElement)).toBe(true);await expect(password).toHaveValue(syncPassword);
  await panel.getByRole('button',{name:labels.configure,exact:true}).click();await cycle();await expect(panel.getByRole('button',{name:labels.configure,exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.syncFixture.calls.map(call=>call.command))).toEqual(['sync_status','sync_configure']);
  expect((await page.evaluate(()=>window.syncFixture.calls))[1].args).toEqual({config:{endpoint:syncEndpoint,username:syncUsername,settingsEnabled:true,credentialsEnabled:true},password:syncPassword,recoveryKey:syncRecovery});
  await page.evaluate(()=>window.syncFixture.finish());await expect(panel.getByRole('textbox',{name:labels.recovery,exact:true})).toHaveValue(syncRecovery);await expect(password).toHaveValue('');
  await panel.getByRole('button',{name:labels.hide,exact:true}).click();await expect(panel.getByRole('textbox',{name:labels.recovery,exact:true})).toHaveCount(0);
  await panel.getByRole('button',{name:labels.show,exact:true}).click();await expect(panel.getByRole('textbox',{name:labels.recovery,exact:true})).toHaveValue(syncRecovery);
  await panel.getByRole('button',{name:labels.preview,exact:true}).click();await cycle();await expect(panel.getByRole('button',{name:labels.uploadCredentials,exact:true})).toBeDisabled();await page.evaluate(()=>window.syncFixture.finish());
  await expect(panel.getByText(syncHost.name,{exact:true})).toBeVisible();await expect(panel.getByText(syncHost.fingerprint,{exact:true})).toBeVisible();await expect(panel.getByText(syncConflict.id+': '+syncConflict.reason,{exact:true})).toBeVisible();
  const host=await panel.getByText(syncHost.name,{exact:true}).elementHandle();await cycle();expect(await host!.evaluate(node=>node.isConnected)).toBe(true);
  expect((await page.evaluate(()=>window.syncFixture.calls)).some(call=>call.command==='sync_apply'||call.command==='sync_push')).toBe(false);
  const count=(await page.evaluate(()=>window.syncFixture.calls)).length;await panel.getByRole('button',{name:labels.cancel,exact:true}).click();expect((await page.evaluate(()=>window.syncFixture.calls)).length).toBe(count);
  await panel.getByRole('button',{name:labels.preview,exact:true}).click();await page.evaluate(()=>window.syncFixture.finish());await panel.getByRole('button',{name:labels.apply,exact:true}).click();await cycle();expect(await page.evaluate(()=>window.syncFixture.hostChanges)).toBe(0);await expect(panel.getByRole('button',{name:labels.apply,exact:true})).toBeDisabled();
  expect((await page.evaluate(()=>window.syncFixture.calls)).find(call=>call.command==='sync_apply')?.args).toEqual({token:'original-preview-token'});await page.evaluate(()=>window.syncFixture.finish());
  await expect.poll(()=>page.evaluate(()=>window.syncFixture.hostChanges)).toBe(1);await cycle();await expect(panel.getByRole('button',{name:labels.apply,exact:true})).toHaveCount(0);
  const preferences=await page.evaluate(async()=>{const {getPreferences}=await import('/src/preferences.ts');return getPreferences();});
  await panel.getByRole('button',{name:labels.uploadSettings,exact:true}).click();await panel.getByRole('button',{name:labels.uploadCredentials,exact:true}).click();await cycle();
  expect((await page.evaluate(()=>window.syncFixture.calls)).filter(call=>call.command==='sync_push').map(call=>call.args)).toEqual([{scope:'settings',preferences},{scope:'credentials'}]);
  await panel.getByRole('button',{name:labels.disconnect,exact:true}).click();await cycle();await expect(panel.getByRole('button',{name:labels.show,exact:true})).toHaveCount(0);
  expect((await page.evaluate(()=>window.syncFixture.calls)).filter(call=>call.command==='sync_preview').map(call=>call.args)).toEqual([{scope:'credentials'},{scope:'credentials'}]);
  expect((await page.evaluate(()=>window.syncFixture.calls)).filter(call=>call.command==='sync_forget')).toHaveLength(1);
  expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);expect(await panel.locator('img,script,iframe').count()).toBe(0);expect(external).toEqual([]);
  const stored=await page.evaluate(()=>Object.values(localStorage).join('\n'));expect(stored).not.toContain(syncPassword);expect(stored).not.toContain(syncRecovery);
});
