import {expect,test} from '@playwright/test';
import {openLocalizedApp} from './fixtures/localizedApp';
import type {mountPush} from './fixtures/PushHarness';
declare global {interface Window {pushUi:ReturnType<typeof mountPush>;}}
for(const provider of ['fcm','apns'] as const)test(`${provider} keeps consent, pending registration and revocation recovery stable across languages`,async({page})=>{
  await openLocalizedApp(page,'en');await page.evaluate(async provider=>{const {mountPush}=await import('/e2e/fixtures/PushHarness.tsx');window.pushUi=mountPush(provider);},provider);
  const root=page.locator('.push-fixture');const consent=root.getByRole('checkbox');await expect(consent).toBeEnabled();await consent.focus();const original=await consent.elementHandle();
  async function captions(locale:string){return page.evaluate(async({locale,provider})=>{
    const {uiI18n,t}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);
    return {title:t('pushTitle'),register:t('pushRegister'),pause:t(provider==='apns'?'pushDisableApns':'pushPause'),retry:t(provider==='apns'?'pushDisableApns':'pushRetryRevocation'),failed:t('pushPauseFailed'),privacy:t('pushPrivacy',{provider:provider==='apns'?'Apple APNs':'Google Firebase'}),apple:t('pushApnsHint')};
  },{locale,provider});}
  let copy=await captions('en');
  for(const language of ['pt-BR','es','en']){copy=await captions(language);await expect(root.getByRole('heading',{name:copy.title,exact:true})).toBeVisible();expect(await original!.evaluate(node=>node===document.activeElement)).toBe(true);await expect(consent).not.toBeChecked();await expect(root.getByRole('button',{name:copy.register,exact:true})).toBeDisabled();await expect(root.getByText(copy.privacy,{exact:true})).toBeVisible();if(provider==='apns')await expect(root.getByText(copy.apple,{exact:true})).toBeVisible();expect(await page.evaluate(()=>window.pushUi.calls)).toEqual(['push_registration_status']);}
  await consent.check();const approved=await consent.elementHandle();
  for(const language of ['es','pt-BR','en']){copy=await captions(language);await expect(consent).toBeChecked();expect(await approved!.evaluate(node=>node.isConnected)).toBe(true);expect(await page.evaluate(()=>window.pushUi.calls)).toEqual(['push_registration_status']);}
  await root.getByRole('button',{name:copy.register,exact:true}).click();await expect(root.getByRole('button',{name:copy.pause,exact:true})).toBeEnabled();
  const registering=await page.evaluate(()=>window.pushUi.calls);
  for(const language of ['pt-BR','es','en']){copy=await captions(language);await expect(consent).toBeDisabled();await expect(root.getByRole('button',{name:copy.pause,exact:true})).toBeEnabled();expect(await page.evaluate(()=>window.pushUi.calls)).toEqual(registering);}
  await root.getByRole('button',{name:copy.pause,exact:true}).click();await expect(root.getByRole('status')).toHaveText('Native {{reason}} <pending revocation>');await page.evaluate(()=>window.pushUi.completeRetired());await expect(root.getByRole('status')).not.toHaveText('Retired registration response');await expect(consent).not.toBeChecked();
  await root.getByRole('button',{name:copy.retry,exact:true}).click();await expect(root.getByRole('alert')).toHaveText(copy.failed);const failedCalls=await page.evaluate(()=>window.pushUi.calls);
  for(const language of ['pt-BR','es','en']){copy=await captions(language);await expect(root.getByRole('alert')).toHaveText(copy.failed);await expect(root.getByRole('button',{name:copy.retry,exact:true})).toBeEnabled();expect(await page.evaluate(()=>window.pushUi.calls)).toEqual(failedCalls);await expect(root).not.toContainText('PRIVATE_PROVIDER_DETAIL');}
  expect(failedCalls).toEqual(['push_registration_status','push_registration_register','push_registration_disable','push_registration_disable','push_registration_status']);
  await root.getByRole('button',{name:copy.retry,exact:true}).click();await expect(root.getByRole('status')).toHaveText('Registration off');await expect(root.getByRole('alert')).toHaveCount(0);expect(await root.locator('img,script').count()).toBe(0);expect(await root.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.evaluate(()=>window.pushUi.dispose());
});
