// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>true,invoke:transport.invoke}));
beforeEach(()=>{vi.resetModules();localStorage.clear();transport.invoke.mockReset();});
const revision='12345678-1234-1234-1234-123456789abc';
const status=(choice:string,revision='0')=>({nativeAuthority:true,choice,resolvedLocale:choice==='system'?'en-GB':choice,revision});

it('native bootstrap wins over stale browser storage and later generic preference snapshots',async()=>{
  const preferences=await import('../preferences');
  preferences.savePreferences({...preferences.defaults,uiLanguage:'pt-BR'});
  transport.invoke.mockResolvedValueOnce(status('system')).mockResolvedValueOnce(status('es',revision));
  const {nativeLocale}=await import('./nativeLocale');await nativeLocale.refresh();
  expect(preferences.getPreferences().uiLanguage).toBe('system');
  const stale={...preferences.getPreferences(),fontSize:20};
  await nativeLocale.change('es');preferences.savePreferences(stale);
  const value=preferences.getPreferences();expect(value.uiLanguage).toBe('es');expect(value.fontSize).toBe(20);
  expect(preferences.getPreferences()).toBe(value);
  localStorage.setItem('lazysh.preferences.v1',JSON.stringify({...stale,uiLanguage:'en'}));
  // The same authoritative mirror is applied when a future read reloads browser storage.
  window.dispatchEvent(new StorageEvent('storage',{key:'lazysh.preferences.v1'}));
  expect(preferences.getPreferences().uiLanguage).toBe('es');
  expect(transport.invoke.mock.calls.map(call=>call[0])).toEqual(['ui_locale_status','ui_locale_set']);
});

it('legacy import preserves locale while explicit import and reset await native persistence',async()=>{
  const preferences=await import('../preferences');
  const {nativeLocale,applyPreferenceIntent}=await import('./nativeLocale');
  transport.invoke.mockResolvedValueOnce(status('pt-BR'));await nativeLocale.refresh();
  await applyPreferenceIntent({version:1,fontSize:21},false);
  expect(preferences.getPreferences()).toMatchObject({fontSize:21,uiLanguage:'pt-BR'});
  expect(transport.invoke).toHaveBeenCalledTimes(1);
  let accept!:(value:unknown)=>void;
  transport.invoke.mockReturnValueOnce(new Promise(resolve=>{accept=resolve;}));
  const importing=applyPreferenceIntent({...preferences.defaults,fontSize:22,uiLanguage:'es'},true);
  await Promise.resolve();expect(preferences.getPreferences().fontSize).toBe(21);
  accept(status('es',revision));await importing;
  expect(preferences.getPreferences()).toMatchObject({fontSize:22,uiLanguage:'es'});
  transport.invoke.mockResolvedValueOnce(status('system','22345678-1234-1234-1234-123456789abc'));
  await applyPreferenceIntent(preferences.defaults,true);
  expect(preferences.getPreferences()).toMatchObject({fontSize:14,uiLanguage:'system'});
  expect(transport.invoke).toHaveBeenLastCalledWith('ui_locale_set',{choice:'system',expectedRevision:revision});
});

it('queued abandoned reset cannot overwrite newer preference work',async()=>{
  const preferences=await import('../preferences');const {nativeLocale,applyPreferenceIntent}=await import('./nativeLocale');
  transport.invoke.mockResolvedValueOnce(status('es'));await nativeLocale.refresh();
  preferences.savePreferences({...preferences.getPreferences(),fontSize:23});
  await expect(applyPreferenceIntent(preferences.defaults,true,()=>false)).rejects.toThrow();
  expect(preferences.getPreferences()).toMatchObject({fontSize:23,uiLanguage:'es'});
  expect(transport.invoke).toHaveBeenCalledTimes(1);
});
