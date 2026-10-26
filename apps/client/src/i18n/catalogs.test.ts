import {afterEach, expect, it} from 'vitest';
import {english} from './en';
import {brazilianPortuguese, spanish} from './translations';
import {createUiInstance, formatDate, formatNumber, t, uiI18n} from './core';

const catalogs = {'pt-BR':brazilianPortuguese, es:spanish};
const placeholders = (text: string) => [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map(match=>match[1]).sort();
afterEach(async()=>{await uiI18n.changeLanguage('en');});
it.each(Object.entries(catalogs))('%s supplies every English key with exactly the declared interpolation and plural categories', (locale, catalog)=>{
  expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort());
  for(const key of Object.keys(english) as (keyof typeof english)[]) {
    expect(catalog[key].trim(),`${locale}.${key}`).not.toBe('');
    expect(placeholders(catalog[key]),`${locale}.${key}`).toEqual(placeholders(english[key]));
    expect(catalog[key].replace(/\{\{[^{}]+\}\}/g,''),`${locale}.${key}`).not.toMatch(/[{}]|\$t\(/);
  }
  for(const base of ["sessionCount","usageMinutes","muxWindows","syncHostCount","syncCredentialCount"]) for(const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
    expect(catalog).toHaveProperty(`${base}_${category}`);
  }
});
it.each([
  ['pt-BR',['0 sessões','1 sessão','2 sessões','1000000 sessões'],'1.234,5','25/10/2026'],
  ['es',['0 sesiones','1 sesión','2 sesiones','1000000 sesiones'],'1234,5','25/10/2026'],
] as const)('renders real %s plurals, interpolation and regional display formatting',async(locale,counts,number,date)=>{
  await uiI18n.changeLanguage(locale);
  expect([0,1,2,1_000_000].map(count=>t('sessionCount',{count}))).toEqual(counts);
  const original='raw $t(language) {{name}} <img> 中文';
  expect(t('appConnectToValue1',{value1:original})).toBe(`Conectar a ${original}`);
  expect(formatNumber(1234.5)).toBe(number);
  expect(formatDate(new Date('2026-10-25T12:34:56Z'),{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric'})).toBe(date);
});
it('retains English fallback for an absent translation and never displays a missing key as UI text',async()=>{
  const instance=createUiInstance();
  instance.removeResourceBundle('es','translation');
  instance.addResourceBundle('es','translation',{language:'Idioma'});
  await instance.changeLanguage('es');
  expect(instance.t('appAddAHost')).toBe(english.appAddAHost);
  expect(instance.t('unknown.key' as never)).toBe(english.unavailable);
});
