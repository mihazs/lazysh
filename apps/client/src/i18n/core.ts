import {createInstance} from 'i18next';
import {initReactI18next, useTranslation} from 'react-i18next';
import {english} from './en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {translation: typeof english};
    enableSelector: false;
    strictKeyChecks: true;
  }
}
export type UiLanguage = 'system' | 'en';
export function resolveUiLocale(language: UiLanguage, requested: readonly string[]): string {
  if (language === 'en') return 'en';
  for (const candidate of requested.slice(0, 16)) {
    if (typeof candidate !== 'string' || candidate.length > 80) continue;
    try {
      const [locale] = Intl.getCanonicalLocales(candidate);
      if (locale === 'en' || locale?.startsWith('en-')) return locale;
    } catch { /* Invalid or unsupported system language falls back to English. */ }
  }
  return 'en';
}
export function createUiInstance() {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng:'en', fallbackLng:'en', resources:{en:{translation:english}},
    initAsync:false, enableSelector:false, keySeparator:false,
    interpolation:{escapeValue:false}, returnNull:false,
    parseMissingKeyHandler:()=>english.unavailable, react:{useSuspense:false},
  });
  return instance;
}
export const uiI18n = createUiInstance();
type Catalog = typeof english;
export type UiKey = keyof Catalog;
type Variables<S extends string> = S extends `${string}{{${infer Name}}}${infer Rest}` ? Name | Variables<Rest> : never;
type Values<K extends UiKey> = Record<Variables<Catalog[K]>, string | number>;
/** Typed keys and interpolation values, with plain React text as the result. */
export function t<K extends UiKey>(key: K, ...args: Variables<Catalog[K]> extends never ? [values?: Values<K>] : [values: Values<K>]): string {
  return String(uiI18n.t(key as never, args[0] as never));
}
export function useUi() { useTranslation('translation', {i18n:uiI18n}); }
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(uiI18n.language, options).format(value);
}
export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(uiI18n.language, options).format(value);
}
