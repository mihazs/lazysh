// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import SyncPanel,{parseSyncPreview} from '../SyncPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {syncConflict,syncEndpoint,syncHost,syncPassword,syncPreview,syncRecovery,syncStatus,syncUsername} from '../test/syncData';
import {getPreferences} from '../preferences';
import * as preferenceIntent from './nativeLocale';
import {LocalUiError} from './localError';
import {formatNumber,t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
function authorize(locked=false){applyAccessStatus({initialized:true,supported:true,enabled:true,locked,reason:'Synthetic sync authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'e'.repeat(64)})});if(!locked)acknowledgeAccessReady(accessSnapshot().epoch);}
beforeEach(()=>{vi.mocked(invoke).mockReset();localStorage.clear();authorize();});
afterEach(async()=>{cleanup();vi.restoreAllMocks();await uiI18n.changeLanguage('en');});
async function languages(inspect:()=>void){const before=vi.mocked(invoke).mock.calls.slice();for(const locale of ['pt-BR','es','en']){await act(async()=>{await uiI18n.changeLanguage(locale);});inspect();expect(vi.mocked(invoke).mock.calls).toEqual(before);}}
async function configured(){const changed=vi.fn();const view=render(<SyncPanel onHostsChanged={changed}/>);await waitFor(()=>expect(screen.getByRole('button',{name:t('syncConfigure')})).toHaveProperty('disabled',false));return {...view,changed};}
function setDraft(){for(const [key,value] of [['syncDirectory',syncEndpoint],['syncUsername',syncUsername],['syncPassword',syncPassword],['syncRecoveryImport',syncRecovery]] as const)fireEvent.change(screen.getByLabelText(t(key)),{target:{value}});}
it('keeps one initial status operation and disabled configuration through same-mount locale changes',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));render(<SyncPanel onHostsChanged={vi.fn()}/>);
  await languages(()=>{expect(screen.getByRole('region',{name:t('appEncryptedSync')})).toBeTruthy();expect(screen.getByRole('button',{name:t('syncConfigure')})).toHaveProperty('disabled',true);});
  expect(invoke).toHaveBeenCalledExactlyOnceWith('sync_status',undefined,{headers:{'X-Lazysh-Access':'e'.repeat(64)}});
  await act(async()=>finish({...syncStatus,configured:false}));expect(screen.queryByRole('button',{name:t('syncShowRecovery')})).toBeNull();
});
it('preserves configuration/recovery bytes and original authority, requiring explicit configure/show/hide without uploading',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(async command=>command==='sync_status'?{...syncStatus,configured:false}:command==='sync_configure'?new Promise(resolve=>{finish=resolve;}):{recoveryKey:syncRecovery});
  const view=await configured();setDraft();const password=screen.getByLabelText(t('syncPassword'));password.focus();
  await languages(()=>{expect(screen.getByLabelText(t('syncPassword'))).toBe(password);expect(password).toHaveProperty('value',syncPassword);expect(document.activeElement).toBe(password);});
  fireEvent.click(screen.getByRole('button',{name:t('syncConfigure')}));await languages(()=>{expect(screen.getByRole('button',{name:t('syncConfigure')})).toHaveProperty('disabled',true);expect(screen.getByLabelText(t('syncRecoveryImport'))).toHaveProperty('value',syncRecovery);});
  expect(invoke).toHaveBeenLastCalledWith('sync_configure',{config:{endpoint:syncEndpoint,username:syncUsername,settingsEnabled:true,credentialsEnabled:true},password:syncPassword,recoveryKey:syncRecovery},{headers:{'X-Lazysh-Access':'e'.repeat(64)}});
  await act(async()=>finish({recipient:'opaque recipient',recoveryKey:syncRecovery}));
  await languages(()=>{expect(screen.getByRole('status').textContent).toBe(t('syncConfigured'));expect(screen.getByLabelText(t('syncRecoveryKey'))).toHaveProperty('value',syncRecovery);expect(screen.getByLabelText(t('syncPassword'))).toHaveProperty('value','');expect(screen.getByLabelText(t('syncRecoveryImport'))).toHaveProperty('value','');});
  fireEvent.click(screen.getByRole('button',{name:t('syncHideRecovery')}));expect(screen.queryByLabelText(t('syncRecoveryKey'))).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:t('syncShowRecovery')}));await screen.findByLabelText(t('syncRecoveryKey'));
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['sync_status','sync_configure','sync_recovery_key']);expect(view.container.querySelector('img,script')).toBeNull();
});
it.each(['settings','credentials'] as const)('preserves explicit %s preview/cancel/apply, opaque host metadata and imported-count notices through language changes',async scope=>{
  let finishPreview!:(value:unknown)=>void;let finishApply!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='sync_status'?syncStatus:command==='sync_preview'?new Promise(resolve=>{finishPreview=resolve;}):new Promise(resolve=>{finishApply=resolve;}));
  const view=await configured();const previewKey=scope==='settings'?'syncPreviewSettings':'syncPreviewCredentials';
  fireEvent.click(screen.getByRole('button',{name:t(previewKey)}));await languages(()=>expect(screen.getByRole('button',{name:t('syncUploadSettings')}).matches(':disabled')).toBe(true));
  expect(invoke).toHaveBeenLastCalledWith('sync_preview',{scope},expect.anything());await act(async()=>finishPreview(syncPreview(scope)));
  const host=screen.getByText(syncHost.name);
  await languages(()=>{expect(screen.getByText(syncHost.name)).toBe(host);expect(screen.getByText(syncHost.fingerprint)).toBeTruthy();expect(screen.getByText(syncConflict.id+': '+syncConflict.reason)).toBeTruthy();expect(screen.getByRole('button',{name:t('syncApply')})).toHaveProperty('disabled',false);});
  fireEvent.click(screen.getByRole('button',{name:t('syncCancel')}));expect(screen.queryByRole('region',{name:t('syncReviewRegion')})).toBeNull();expect(vi.mocked(invoke).mock.calls).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:t(previewKey)}));await act(async()=>finishPreview(syncPreview(scope)));
  fireEvent.click(screen.getByRole('button',{name:t('syncApply')}));await languages(()=>expect(screen.getByRole('button',{name:t('syncApply')})).toHaveProperty('disabled',true));
  expect(invoke).toHaveBeenLastCalledWith('sync_apply',{token:'original-preview-token'},expect.anything());expect(view.changed).not.toHaveBeenCalled();
  await act(async()=>finishApply({hostsAdded:1000,credentialsAdded:1}));
  await languages(()=>expect(screen.getByRole('status').textContent).toBe(t('syncImported',{hosts:t('syncHostCount',{count:1000,value:formatNumber(1000)}),credentials:t('syncCredentialCount',{count:1,value:formatNumber(1)})})));
  expect(view.changed).toHaveBeenCalledOnce();expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['sync_status','sync_preview','sync_preview','sync_apply']);expect(view.container.querySelector('img,script')).toBeNull();
});
it.each(['settings','credentials'] as const)('uploads %s only on explicit click with unchanged scope and preference payload, then disconnects without deleting remote data',async scope=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='sync_status'?syncStatus:undefined);await configured();const preferences=getPreferences();
  fireEvent.click(screen.getByRole('button',{name:t(scope==='settings'?'syncUploadSettings':'syncUploadCredentials')}));await screen.findByRole('status');
  expect(invoke).toHaveBeenLastCalledWith('sync_push',{scope,...(scope==='settings'?{preferences}:{})},expect.anything());
  await languages(()=>expect(screen.getByRole('status').textContent).toBe(t(scope==='settings'?'syncSettingsUploaded':'syncCredentialsUploaded')));
  fireEvent.click(screen.getByRole('button',{name:t('syncDisconnect')}));await screen.findByText(t('syncDisconnected'));await languages(()=>expect(screen.getByRole('status').textContent).toBe(t('syncDisconnected')));
  expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['sync_status','sync_push','sync_forget']);expect(screen.queryByRole('button',{name:t('syncShowRecovery')})).toBeNull();
});
it.each([false,true])('preserves preference-import language intent presence=%s and callback ordering before acknowledgement',async explicit=>{
  const events:string[]=[];let commit!:()=>void;let current!:()=>boolean;
  const preferences={version:1,fontSize:19,...(explicit?{uiLanguage:'es'}:{})};
  const intent=vi.spyOn(preferenceIntent,'applyPreferenceIntent').mockImplementation((_value,_explicit,alive)=>{events.push('intent');current=alive!;return new Promise(resolve=>{commit=resolve;});});
  vi.mocked(invoke).mockImplementation(async command=>command==='sync_status'?syncStatus:command==='sync_preview'?syncPreview():{hostsAdded:0,credentialsAdded:0,preferences});
  const view=render(<SyncPanel onHostsChanged={()=>events.push('hosts')}/>);await waitFor(()=>expect(screen.getByRole('button',{name:t('syncPreviewSettings')})).toHaveProperty('disabled',false));
  fireEvent.click(screen.getByRole('button',{name:t('syncPreviewSettings')}));fireEvent.click(await screen.findByRole('button',{name:t('syncApply')}));await waitFor(()=>expect(intent).toHaveBeenCalledOnce());
  expect(events).toEqual(['hosts','intent']);expect(intent).toHaveBeenCalledWith(preferences,explicit,expect.any(Function));expect(current()).toBe(true);expect(screen.queryByRole('status')).toBeNull();
  await languages(()=>expect(screen.getByRole('button',{name:t('syncApply')})).toHaveProperty('disabled',true));await act(async()=>commit());expect(screen.getByRole('status').textContent).toBe(t('syncImported',{hosts:t('syncHostCount',{count:0,value:formatNumber(0)}),credentials:t('syncCredentialCount',{count:0,value:formatNumber(0)})}));view.unmount();expect(current()).toBe(false);
});
it.each([
  [null,'syncInvalidPreview'],[{...syncPreview(),hosts:[{...syncHost,addHost:false,importCredentials:false,port:65536}]},'syncInvalidHost'],[{...syncPreview(),hosts:[{...syncPreview().hosts[0],fingerprint:'x'.repeat(257)}]},'syncInvalidIdentity'],[{...syncPreview(),hosts:[{...syncPreview().hosts[0],jumpHostId:'x'.repeat(101)}]},'syncInvalidRouting'],[{...syncPreview(),conflicts:[{id:'literal',reason:'x'.repeat(4097)}]},'syncInvalidConflict'],
] as const)('brands only the client-created validation failure %s',async(value,key)=>{expect(()=>parseSyncPreview(value)).toThrow(t(key));try{parseSyncPreview(value);}catch(error){expect(error).toBeInstanceOf(LocalUiError);}});
it.each(['invalid','scope','recovery','raw'] as const)('keeps stored %s errors live or verbatim without reissuing operations',async mode=>{
  const raw='syncInvalidPreview <native/path> {{literal}}';
  vi.mocked(invoke).mockImplementation(async command=>{if(command==='sync_status')return syncStatus;if(mode==='raw')throw {name:'LocalUiError',key:'syncInvalidPreview',message:raw};return mode==='invalid'?null:mode==='scope'?syncPreview('credentials'):{recoveryKey:5};});
  await configured();fireEvent.click(screen.getByRole('button',{name:t(mode==='recovery'?'syncShowRecovery':'syncPreviewSettings')}));const alert=await screen.findByRole('alert');
  await languages(()=>{expect(alert.textContent).toBe(mode==='raw'?raw:t(mode==='invalid'?'syncInvalidPreview':mode==='scope'?'syncScopeMismatch':'syncInvalidRecovery'));expect(screen.queryByRole('button',{name:t('syncApply')})).toBeNull();});expect(vi.mocked(invoke).mock.calls).toHaveLength(2);
});
it('does not freshen a held preview or later actions after original access is revoked and unlocked',async()=>{
  let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(async command=>command==='sync_status'?syncStatus:new Promise(resolve=>{finish=resolve;}));await configured();fireEvent.click(screen.getByRole('button',{name:t('syncPreviewSettings')}));
  await act(async()=>{authorize(true);authorize();});await act(async()=>finish(syncPreview()));await screen.findByRole('alert');
  await languages(()=>expect(screen.queryByRole('button',{name:t('syncApply')})).toBeNull());fireEvent.click(screen.getByRole('button',{name:t('syncUploadCredentials')}));await act(async()=>{});expect(vi.mocked(invoke).mock.calls).toHaveLength(2);
});
it.each(['storage','controller'] as const)('localizes only the real %s preference-acknowledgement failure after the host callback',async mode=>{
  const order:string[]=[];const preferences={version:1,fontSize:19,...(mode==='controller'?{uiLanguage:'es'}:{})};
  const intent=vi.spyOn(preferenceIntent,'applyPreferenceIntent');
  if(mode==='storage')vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{order.push('storage');throw new Error('Synthetic storage denial');});
  else {
    const controller=preferenceIntent.createLocaleController({native:true,commit:vi.fn(),async invoke<T>(command:string){if(command==='ui_locale_status')return {nativeAuthority:true,choice:'en',resolvedLocale:'en',revision:'0'} as T;order.push('language-write');throw new Error('RAW native language failure');}});
    await controller.refresh();intent.mockImplementation((_value,_explicit,current)=>controller.change('es',current));
  }
  vi.mocked(invoke).mockImplementation(async command=>command==='sync_status'?syncStatus:command==='sync_preview'?syncPreview():{hostsAdded:1,credentialsAdded:0,preferences});
  render(<SyncPanel onHostsChanged={()=>order.push('hosts')}/>);fireEvent.click(await screen.findByRole('button',{name:t('syncPreviewSettings')}));fireEvent.click(await screen.findByRole('button',{name:t('syncApply')}));
  const alert=await screen.findByRole('alert');expect(order).toEqual(['hosts',mode==='storage'?'storage':'language-write']);
  if(mode==='storage'){expect(intent.mock.results[0].type).toBe('throw');expect(intent.mock.results[0].value).toBeInstanceOf(preferenceIntent.PreferenceStorageError);}
  else await expect(intent.mock.results[0].value).rejects.toThrow('Native interface language could not be saved');
  await languages(()=>{expect(alert.textContent).toBe(t(mode==='storage'?'preferencesSettingsCouldNotBeSavedOnThisDevice':'nativeLocaleSaveFailed'));expect(screen.queryByRole('status')).toBeNull();});
  expect(intent).toHaveBeenCalledOnce();expect(vi.mocked(invoke).mock.calls.map(([command])=>command)).toEqual(['sync_status','sync_preview','sync_apply']);
});
it('preserves a raw sync_apply rejection outside the preference catch and still runs the original host callback',async()=>{
  const raw='nativeLocaleSaveFailed <raw sync apply> {{literal}}';const changed=vi.fn();
  vi.mocked(invoke).mockImplementation(async command=>{if(command==='sync_status')return syncStatus;if(command==='sync_preview')return syncPreview();throw {name:'PreferenceStorageError',message:raw};});
  const intent=vi.spyOn(preferenceIntent,'applyPreferenceIntent');render(<SyncPanel onHostsChanged={changed}/>);fireEvent.click(await screen.findByRole('button',{name:t('syncPreviewSettings')}));fireEvent.click(await screen.findByRole('button',{name:t('syncApply')}));const alert=await screen.findByRole('alert');
  await languages(()=>expect(alert.textContent).toBe(raw));expect(changed).toHaveBeenCalledOnce();expect(intent).not.toHaveBeenCalled();
});
