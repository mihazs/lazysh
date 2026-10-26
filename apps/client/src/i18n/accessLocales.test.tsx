// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AccessPanel from '../AccessPanel';
import {accessSnapshot,applyAccessStatus} from '../access';
import {t,uiI18n} from './core';
vi.mock('@tauri-apps/api/core',async original=>(await import('../test/nativeCoreMock')).mockNativeCore(original));
function status(locked=false){return {initialized:true,supported:true,enabled:false,locked,reason:'Raw native {{reason}} <device>',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),...(locked?{}:{nonce:'b'.repeat(64)})};}
beforeEach(()=>{vi.mocked(invoke).mockReset();applyAccessStatus(status());});
afterEach(async()=>{cleanup();vi.restoreAllMocks();await uiI18n.changeLanguage('en');});
async function locale(language:string){await act(async()=>{await uiI18n.changeLanguage(language);});}
it('retranslates retained authentication failure without repeating native configure or changing opt-in',async()=>{
  let reject!:(reason:unknown)=>void;
  vi.mocked(invoke).mockImplementation(()=>new Promise((_resolve,no)=>{reject=no;}));
  render(<AccessPanel/>);const checkbox=screen.getByRole('checkbox');checkbox.focus();fireEvent.click(checkbox);
  const original=[['app_lock_configure',{enabled:true},{headers:{'X-Lazysh-Access':'b'.repeat(64)}}]];
  expect(vi.mocked(invoke).mock.calls).toEqual(original);
  await locale('pt-BR');
  expect(screen.getByRole('status').textContent).toBe(t('accessWaitingForDeviceAuthentication'));
  expect(screen.getByRole('checkbox')).toBe(checkbox);expect(checkbox).toHaveProperty('disabled',true);
  expect(document.activeElement).toBe(checkbox);expect(vi.mocked(invoke).mock.calls).toEqual(original);
  await act(async()=>{reject(new Error('PRIVATE_NATIVE_AUTH_REASON'));});
  const alert=await screen.findByRole('alert');
  for(const language of ['es','en','pt-BR']){
    await locale(language);
    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert.textContent).toBe(t('accessDeviceAuthenticationDidNotCompleteAppLockSettingsWere'));
    expect(checkbox).toHaveProperty('checked',false);expect(checkbox).toHaveProperty('disabled',false);
    expect(document.body.textContent).not.toContain('PRIVATE_NATIVE_AUTH_REASON');
    expect(vi.mocked(invoke).mock.calls).toEqual(original);
  }
  fireEvent.click(checkbox);expect(vi.mocked(invoke).mock.calls).toEqual([...original,...original]);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async()=>{reject(new Error('second explicit cancellation'));});
});
it('keeps later access authority authoritative when an old configure rejects after locale changes',async()=>{
  let reject!:(reason:unknown)=>void;
  vi.mocked(invoke).mockImplementation(()=>new Promise((_resolve,no)=>{reject=no;}));
  render(<AccessPanel/>);fireEvent.click(screen.getByRole('checkbox'));
  await locale('es');
  await act(async()=>{applyAccessStatus(status(true));applyAccessStatus(status());});
  await act(async()=>{reject(new Error('old configure result'));});
  await locale('pt-BR');
  expect(screen.queryByRole('alert')).toBeNull();expect(screen.getByRole('checkbox')).toHaveProperty('checked',false);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('keeps an unsupported native reason literal and does not request configure on locale changes',async()=>{
  const raw='accessDeviceAuthenticationDidNotCompleteAppLockSettingsWere <{{native}}>';
  applyAccessStatus({...status(),supported:false,reason:raw});
  const view=render(<AccessPanel/>);
  for(const language of ['pt-BR','es','en']){
    await locale(language);expect(screen.getByText(raw).textContent).toBe(raw);
    expect(screen.getByRole('checkbox')).toHaveProperty('disabled',true);
    expect(view.container.querySelector('native')).toBeNull();expect(invoke).not.toHaveBeenCalled();
  }
});
