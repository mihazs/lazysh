// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke}));
import PreferencesPanel from '../PreferencesPanel';
import {defaults,savePreferences} from '../preferences';
import {nativeLocale} from './nativeLocale';
import {NativeLocaleNotice} from './NativeLocaleNotice';
import {t} from './core';
import {goBack,openSettingsPages} from '../test/preferencesPanel';
import {useClientLocale} from './useClientLocale';
function Settings(){const state=useClientLocale();return <><div id="locale-notice"><NativeLocaleNotice state={state} retry={()=>{void nativeLocale.refresh().catch(()=>{});}}/></div><PreferencesPanel/></>;}
// The notice is outside the panel's pages; scoping to it keeps role queries off the whole document.
const notice=()=>within(document.getElementById('locale-notice')!);
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
  const languages=openSettingsPages(t('preferencesCategoryLanguage'));
  const language=await languages.findByRole<HTMLInputElement>('radio',{name:'Português (Brasil)'});
  await waitFor(()=>expect(language.getAttribute('aria-disabled')).toBeNull());
  fireEvent.click(language);
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('ui_locale_set',expect.anything()));
  await act(async()=>{rejectSave(new Error('Owned ambiguous acknowledgement'));});
  const message='The interface language could not be saved. Retry the language check before changing it again.';
  expect(screen.getAllByText(message).length).toBeGreaterThan(0);
  fireEvent.click(notice().getByRole('button',{name:'Retry language check'}));
  await waitFor(()=>expect(document.documentElement.lang).toBe('es'));
  expect(languages.getByRole('radio',{name:'Español'})).toHaveProperty('checked',true);
  expect(screen.queryByText(message)).toBeNull();
  saving=Promise.resolve({nativeAuthority:true,choice:'system',resolvedLocale:'en-GB',revision:'22222222-2222-2222-2222-222222222222'});
  const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Owned settings storage failure');});
  goBack(t('navigationBack'));
  fireEvent.click(openSettingsPages(t('preferencesCategoryReset')).getByRole('button',{name:t('preferencesResetPreferences')}));
  await waitFor(()=>expect(nativeLocale.snapshot().native?.choice).toBe('system'));
  await screen.findByText(t('preferencesSettingsCouldNotBeSavedOnThisDevice'));
  expect(notice().queryByRole('button',{name:t('nativeLocaleRetry')})).toBeNull();
  expect(screen.queryByText(t('nativeLocaleSaveFailed'))).toBeNull();
  write.mockRestore();
});
