// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import PreferencesPanel from '../PreferencesPanel';
import {defaults,getPreferences,parsePreferences,savePreferences} from '../preferences';
import {t,uiI18n} from './core';
import {useClientLocale} from './useClientLocale';
function Settings() {useClientLocale();return <PreferencesPanel/>;}
beforeEach(async()=>{savePreferences({...defaults});await uiI18n.changeLanguage('en');});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('migrates absent or invalid language values without altering saved custom text',()=>{
  const snippets=[{label:'原文',text:'echo C-b, 世界'}];
  for(const uiLanguage of [undefined,'pt-PT','es-MX','en-XA',{},null,true]) {
    const parsed=parsePreferences({...defaults,uiLanguage,snippets});
    expect(parsed.uiLanguage).toBe('system');expect(parsed.snippets).toEqual(snippets);
  }
  for(const uiLanguage of ['en','pt-BR','es'] as const) expect(parsePreferences({...defaults,uiLanguage}).uiLanguage).toBe(uiLanguage);
});
it('persists the actual language selector and reacts to system changes only in system mode',async()=>{
  const languages=vi.spyOn(navigator,'languages','get').mockReturnValue(['en-GB']);
  const view=render(<Settings/>);fireEvent.click(screen.getByText(t('preferencesCategoryLanguage')));
  await waitFor(()=>expect(document.documentElement.lang).toBe('en-GB'));
  fireEvent.change(screen.getByLabelText('App language'),{target:{value:'en'}});
  expect(getPreferences().uiLanguage).toBe('en');
  await waitFor(()=>expect(document.documentElement.lang).toBe('en'));
  languages.mockReturnValue(['en-AU']);window.dispatchEvent(new Event('languagechange'));
  await waitFor(()=>expect(document.documentElement.lang).toBe('en'));
  view.unmount();render(<Settings/>);fireEvent.click(screen.getByText(t('preferencesCategoryLanguage')));
  expect(screen.getByLabelText('App language')).toHaveProperty('value','en');
  fireEvent.change(screen.getByLabelText('App language'),{target:{value:'system'}});
  await waitFor(()=>expect(document.documentElement.lang).toBe('en-AU'));
  fireEvent.click(screen.getByText(t('preferencesCategoryReset')));
  fireEvent.click(screen.getByRole('button',{name:'Reset preferences'}));
  expect(getPreferences().uiLanguage).toBe('system');
});

it.each([['pt-BR','Idioma do aplicativo','Preferências do terminal'],['es','Idioma de la aplicación','Preferencias del terminal']] as const)('persists explicit %s while a different system language changes',async(locale,label,title)=>{
  vi.spyOn(navigator,'languages','get').mockReturnValue(['en-GB']);
  const view=render(<Settings/>);fireEvent.click(screen.getByText(t('preferencesCategoryLanguage')));
  fireEvent.change(screen.getByLabelText('App language'),{target:{value:locale}});
  await waitFor(()=>expect(document.documentElement.lang).toBe(locale));
  expect(screen.getByRole('heading',{name:title})).toBeTruthy();
  window.dispatchEvent(new Event('languagechange'));
  view.unmount();render(<Settings/>);fireEvent.click(screen.getByText(t('preferencesCategoryLanguage')));
  await waitFor(()=>expect(screen.getByLabelText(label)).toHaveProperty('value',locale));
  expect(getPreferences().uiLanguage).toBe(locale);
});
