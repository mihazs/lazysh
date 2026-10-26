import {useEffect, useState} from 'react';
import {usePreferences} from '../preferences';
import {resolveUiLocale, uiI18n} from './core';
import {nativeLocale, useNativeLocale} from './nativeLocale';

export function useClientLocale() {
  const {uiLanguage} = usePreferences();
  const status=useNativeLocale();
  const [system, setSystem] = useState(() => navigator.languages);
  useEffect(() => {
    nativeLocale.start();
    const changed = () => {setSystem([...navigator.languages]);if(nativeLocale.snapshot().mode!=='frontend')void nativeLocale.refresh().catch(()=>{});};
    const visible=()=>{if(document.visibilityState==='visible')changed();};
    window.addEventListener('languagechange', changed);
    document.addEventListener('visibilitychange',visible);
    return () => {window.removeEventListener('languagechange', changed);document.removeEventListener('visibilitychange',visible);};
  }, []);
  const locale = status.mode==='frontend' ? resolveUiLocale(uiLanguage, system) : status.native?.resolvedLocale ?? 'en';
  useEffect(() => {
    document.documentElement.lang = locale;
    void uiI18n.changeLanguage(locale);
  }, [locale]);
  return status;
}
