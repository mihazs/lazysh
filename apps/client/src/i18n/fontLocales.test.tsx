// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import PreferencesPanel from '../PreferencesPanel';
import {t,uiI18n} from './core';
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
it('retranslates an already-visible local font validation failure without retrying the import',async()=>{
  render(<PreferencesPanel/>);
  fireEvent.change(screen.getByLabelText(t('preferencesImportFontFile')),{target:{files:[new File(['bad'],'RAW {{file}}.ttf')]}});
  await screen.findByRole('alert');
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByRole('alert').textContent).toBe(t('validationChooseAFontFileNoLargerThan24MiB'));
});

it('renders stored warning roles and names in the current language with stable keys and literal diagnostic data',async()=>{
  const {fontWarningText,fontWarningKey,fontErrorCause,validateFont}=await import('../fonts');
  const {LocalUiError,uiErrorText}=await import('./localError');
  const {enablePseudoLocale}=await import('../test/pseudoLocale');
  const name='RAW font {{value1}} <b>中文</b>';
  const warnings=[{kind:'missing',role:'cjk'},{kind:'load',role:'primary',name},{kind:'error',cause:'Error: RAW IDB {{key}}'}] as const;
  const keys=warnings.map(fontWarningKey);
  let cause:unknown;try{validateFont(new ArrayBuffer(0));}catch(error){cause=error;}
  expect(cause).toBeInstanceOf(LocalUiError);
  for(const locale of ['en','pt-BR','es','en-XA']){
    if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);
    expect(fontWarningText(warnings[0])).toBe(t('fontTheSelectedValue1FontIsMissingOnThisDevice',{value1:t('fontRoleCjk')}));
    expect(fontWarningText(warnings[1])).toBe(t('fontCannotLoadValue1UsingTheFallbackFontStack',{value1:name}));
    expect(fontWarningText(warnings[2])).toBe('Error: RAW IDB {{key}}');
    expect(warnings.map(fontWarningKey)).toEqual(keys);
    expect(fontErrorCause(cause)).toBe(cause);
    expect(uiErrorText(fontErrorCause(cause))).toBe(t('validationChooseAFontFileBetween12BytesAnd24'));
  }
  for(const raw of ['',new Error('RAW browser <name>'),'Choose a font file no larger than 24 MiB.'])expect(fontErrorCause(raw)).toBe(String(raw));
});
