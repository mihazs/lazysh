import {useEffect, useState} from 'react';
import {usePreferences} from '../preferences';
import {resolveUiLocale, uiI18n} from './core';

export function useClientLocale() {
  const {uiLanguage} = usePreferences();
  const [system, setSystem] = useState(() => navigator.languages);
  useEffect(() => {
    const changed = () => setSystem([...navigator.languages]);
    window.addEventListener('languagechange', changed);
    return () => window.removeEventListener('languagechange', changed);
  }, []);
  const locale = resolveUiLocale(uiLanguage, system);
  useEffect(() => {
    document.documentElement.lang = locale;
    void uiI18n.changeLanguage(locale);
  }, [locale]);
}
