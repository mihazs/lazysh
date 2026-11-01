// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke}));
import PreferencesPanel from '../PreferencesPanel';
import {defaults,savePreferences} from '../preferences';
import {nativeLocale} from './nativeLocale';
import {NativeLocaleNotice} from './NativeLocaleNotice';
import {t} from './core';
import {useClientLocale} from './useClientLocale';
function Settings(){const state=useClientLocale();return <><NativeLocaleNotice state={state} retry={()=>{void nativeLocale.refresh().catch(()=>{});}}/><PreferencesPanel/></>;}
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('reconciles the visible Preferences language error after a failed save and confirmed native retry',async()=>{
  let rejectSave!:(reason:Error)=>void;
  let saving:Promise<unknown>=new Promise<never>((_,reject)=>{rejectSave=reject;});
  let reads=0;
  invoke.mockImplementation((command:string)=>{
    if(command==='ui_locale_status')return Promise.resolve({nativeAuthority:true,choice:reads++===0?'en':'es',resolvedLocale:reads===1?'en':'es',revision:reads===1?'0':'11111111-1111-1111-1111-111111111111'});
    if(command==='ui_locale_set')return saving;
    if(command==='app_icon_status')return Promise.resolve({available:false,current:'unknown',reason:'Owned fixture'});
    return Promise.reject(new Error('Unexpected owned fixture command'));
  });
  savePreferences({...defaults,uiLanguage:'en'});
  render(<Settings/>);
  fireEvent.click(screen.getByText(t('preferencesCategoryLanguage')));
  const language=await screen.findByRole<HTMLSelectElement>('combobox',{name:'App language'});
  await waitFor(()=>expect(language.disabled).toBe(false));
  fireEvent.change(language,{target:{value:'pt-BR'}});
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('ui_locale_set',expect.anything()));
  await act(async()=>{rejectSave(new Error('Owned ambiguous acknowledgement'));});
  const message='The interface language could not be saved. Retry the language check before changing it again.';
  expect(screen.getAllByText(message).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button',{name:'Retry language check'}));
  await waitFor(()=>expect(document.documentElement.lang).toBe('es'));
  expect(language.value).toBe('es');
  expect(screen.queryByText(message)).toBeNull();
  saving=Promise.resolve({nativeAuthority:true,choice:'system',resolvedLocale:'en-GB',revision:'22222222-2222-2222-2222-222222222222'});
  const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Owned settings storage failure');});
  fireEvent.click(screen.getByText(t('preferencesCategoryReset')));
  fireEvent.click(screen.getByRole('button',{name:t('preferencesResetPreferences')}));
  await waitFor(()=>expect(nativeLocale.snapshot().native?.choice).toBe('system'));
  await screen.findByText(t('preferencesSettingsCouldNotBeSavedOnThisDevice'));
  expect(screen.queryByRole('button',{name:t('nativeLocaleRetry')})).toBeNull();
  expect(screen.queryByText(t('nativeLocaleSaveFailed'))).toBeNull();
  write.mockRestore();
});
