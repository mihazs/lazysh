// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke,isTauri} from '@tauri-apps/api/core';
import PushSettingsPanel from '../PushSettingsPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../access';
import {pushStatus} from '../test/pushData';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>({...await (await import('../test/nativeCoreMock')).mockNativeCore(original),isTauri:vi.fn(()=>true)}));
beforeEach(()=>{
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic push locale authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'f'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);vi.mocked(isTauri).mockReturnValue(true);
});
afterEach(async()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();await uiI18n.changeLanguage('en');});
async function translatePush(check:()=>void){
  const before=vi.mocked(invoke).mock.calls.slice();
  for(const locale of ['pt-BR','es','en']){
    await act(async()=>{await uiI18n.changeLanguage(locale);});check();
    expect(vi.mocked(invoke).mock.calls).toEqual(before);
  }
}
it.each(['','Inspecting native push configuration…','Native {{reason}} <private>'])('distinguishes local inspection text from received native reason %j without comparing strings',async reason=>{
  let resolve!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(done=>{resolve=done;}));render(<PushSettingsPanel/>);
  await translatePush(()=>expect(screen.getByRole('status').textContent).toBe(t('pushInspecting')));
  await act(async()=>{resolve({...pushStatus,reason});});await translatePush(()=>expect(screen.getByRole('status').textContent).toBe(reason));
  expect(invoke).toHaveBeenCalledExactlyOnceWith('push_registration_status',undefined,{headers:{'X-Lazysh-Access':'f'.repeat(64)}});
});
it.each(['fcm','unifiedpush'])('retains focused %s consent and cancels one held registration without reviving its late result',async provider=>{
  let complete!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>command==='push_registration_register'?new Promise(resolve=>{complete=resolve;}):{...pushStatus,provider});
  render(<PushSettingsPanel/>);await screen.findByRole('checkbox');const consent=screen.getByRole('checkbox');consent.focus();
  await translatePush(()=>{expect(screen.getByRole('checkbox')).toBe(consent);expect(document.activeElement).toBe(consent);expect(consent).toHaveProperty('checked',false);expect(screen.getByRole('button',{name:t('pushRegister')})).toHaveProperty('disabled',true);});
  fireEvent.click(consent);await translatePush(()=>{
    expect(consent).toHaveProperty('checked',true);
    const relay=screen.queryByRole('button',{name:t('pushConnectRelay')});
    if(provider==='unifiedpush')expect(relay).toHaveProperty('disabled',false);
    else expect(relay).toBeNull();
  });
  fireEvent.click(screen.getByRole('button',{name:t('pushRegister')}));await waitFor(()=>expect(complete).toBeTypeOf('function'));
  await translatePush(()=>{expect(screen.getByRole('button',{name:t(provider==='unifiedpush'?'pushUnifiedPause':'pushPause')})).toHaveProperty('disabled',false);expect(consent).toHaveProperty('disabled',true);});
  fireEvent.click(screen.getByRole('button',{name:t(provider==='unifiedpush'?'pushUnifiedPause':'pushPause')}));await waitFor(()=>expect(consent).toHaveProperty('disabled',false));
  await act(async()=>{complete({...pushStatus,provider,enabled:true,tokenPresent:true,reason:'Retired register response'});});
  await translatePush(()=>{expect(screen.getByRole('status').textContent).toBe(pushStatus.reason);expect(consent).toHaveProperty('checked',false);expect(screen.queryByText('Retired register response')).toBeNull();});
  expect(vi.mocked(invoke).mock.calls).toEqual(['push_registration_status','push_registration_register','push_registration_disable'].map(command=>[command,undefined,{headers:{'X-Lazysh-Access':'f'.repeat(64)}}]));
});
it.each(['fcm','apns','unifiedpush'] as const)('preserves %s failed revocation and its single recovery read without leaking provider errors or claiming success',async provider=>{
  let reject!:(error:unknown)=>void,recover!:(value:unknown)=>void;let reads=0;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='push_registration_disable')return new Promise((_yes,no)=>{reject=no;});
    return ++reads===1?{...pushStatus,provider,enabled:true,tokenPresent:true}:new Promise(resolve=>{recover=resolve;});
  });
  render(<PushSettingsPanel/>);fireEvent.click(await screen.findByRole('button',{name:t(provider==='apns'?'pushDisableApns':provider==='unifiedpush'?'pushUnifiedPause':'pushPause')}));
  await translatePush(()=>expect(screen.getByRole('button',{name:t('pushRefresh')})).toHaveProperty('disabled',true));
  await act(async()=>{reject(new Error('PRIVATE_PROVIDER_DETAIL'));});await waitFor(()=>expect(recover).toBeTypeOf('function'));
  await translatePush(()=>{expect(screen.getByRole('alert').textContent).toBe(t('pushPauseFailed'));expect(screen.getByRole('button',{name:t('pushRefresh')})).toHaveProperty('disabled',true);expect(document.body.textContent).not.toContain('PRIVATE_PROVIDER_DETAIL');});
  await act(async()=>{recover({...pushStatus,provider,tokenPresent:true});});
  await translatePush(()=>{expect(screen.getByRole('button',{name:t(provider==='apns'?'pushDisableApns':provider==='unifiedpush'?'pushUnifiedRetry':'pushRetryRevocation')})).toHaveProperty('disabled',false);expect(screen.getByRole('alert').textContent).toBe(t('pushPauseFailed'));});
  expect(reads).toBe(2);expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='push_registration_disable')).toHaveLength(1);
});
it('localizes the browser-only explanation without requesting permission or inspecting native registration',async()=>{
  vi.mocked(isTauri).mockReturnValue(false);render(<PushSettingsPanel/>);
  await translatePush(()=>{expect(screen.getByRole('status').textContent).toBe(t('pushNativeRequired'));expect(screen.getByRole('button',{name:t('pushRefresh')})).toHaveProperty('disabled',true);});expect(invoke).not.toHaveBeenCalled();
});
it('keeps confirmed native display review localized without admitting a command during locale changes',async()=>{
  vi.mocked(invoke).mockResolvedValue({...pushStatus,provider:'unifiedpush',enabled:true,displaySupported:true,displayEnabled:false});
  render(<PushSettingsPanel/>);
  await screen.findByRole('button',{name:t('pushReviewDisplay')});
  await translatePush(()=>expect(screen.getByRole('button',{name:t('pushReviewDisplay')})).toHaveProperty('disabled',false));
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('explains a provider-free build in every UI language without Google consent or registration claims',async()=>{
  vi.mocked(invoke).mockResolvedValue({...pushStatus,provider:'none',supported:false,configured:false,reason:'Native distribution detail'});
  render(<PushSettingsPanel/>);await waitFor(()=>expect(screen.getByRole('status').textContent).toBe(t('pushUnavailable')));
  await translatePush(()=>{
    expect(screen.getByRole('status').textContent).toBe(t('pushUnavailable'));
    expect(document.body.textContent).not.toContain('Google Firebase');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('push_registration_status',undefined,{headers:{'X-Lazysh-Access':'f'.repeat(64)}});
});
