// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {cleanup, render} from '@testing-library/react';
import {createUiInstance, formatDate, formatNumber, resolveUiLocale, t, uiI18n} from './core';
import {english} from './en';
import {enablePseudoLocale} from '../test/pseudoLocale';

afterEach(async () => {cleanup(); await uiI18n.changeLanguage('en');});
it('negotiates supported language tags and falls back without trusting persisted or system strings', () => {
  expect(resolveUiLocale('system',['pt-BR','en-GB'])).toBe('pt-BR');
  expect(resolveUiLocale('system',['pt-PT'])).toBe('pt-BR');
  expect(resolveUiLocale('system',['es-MX'])).toBe('es-MX');
  expect(resolveUiLocale('pt-BR',['en-GB'])).toBe('pt-BR');
  expect(resolveUiLocale('es',['pt-BR'])).toBe('es');
  expect(resolveUiLocale('en',['en-GB'])).toBe('en');
  for (const requested of [['fr'],['en_US'],['__proto__'],['x'.repeat(81)],[]]) expect(resolveUiLocale('system',requested)).toBe('en');
  expect(resolveUiLocale('system',[...Array(16).fill('fr'),'en-GB'])).toBe('en');
});
it('uses English for missing resources and a safe English message for unknown keys', async () => {
  const instance=createUiInstance();
  instance.addResourceBundle('en-GB','translation',{language:'Interface language'});
  await instance.changeLanguage('en-GB');
  expect(instance.t('language')).toBe('Interface language');
  expect(instance.t('appAddAHost')).toBe(english.appAddAHost);
  expect(instance.t('absent.translation.key' as never)).toBe('Unavailable.');
});
it('interpolates user content as React text and handles zero, one and multiple counts', () => {
  const name='<img src=x onerror=alert(1)> {{unsafe}} 中文';
  const view=render(<span>{t('appConnectToValue1',{value1:name})}</span>);
  expect(view.container.textContent).toBe(`Connect to ${name}`);
  expect(view.container.querySelector('img,script')).toBeNull();
  expect([0,1,2].map(count=>t('sessionCount',{count}))).toEqual(['0 sessions','1 session','2 sessions']);
});
it('formats display values using the selected locale while preserving machine timestamps', async () => {
  const iso='2026-10-25T12:34:56.000Z';
  await uiI18n.changeLanguage('en-GB');
  expect(formatNumber(1234.5)).toBe('1,234.5');
  expect(formatDate(new Date(iso),{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'})).toBe('25/10/2026');
  await uiI18n.changeLanguage('en-US');
  expect(formatDate(new Date(iso),{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'})).toBe('10/25/2026');
  expect(new Date(iso).toISOString()).toBe(iso);
});
it('expands catalog copy without changing interpolation values or offering a production pseudo language', async () => {
  await enablePseudoLocale(uiI18n);
  expect(t('appConnectToValue1',{value1:'raw C-b, 世界'})).toContain('raw C-b, 世界');
  expect(t('appConnectToValue1',{value1:'raw'})).toMatch(/^⟦.*⟧$/);
  expect(resolveUiLocale('system',['qps-ploc'])).toBe('en');
});
// TypeScript checks these contracts; executing deliberately invalid calls is unnecessary.
function typedCatalogContracts() {
  // @ts-expect-error Unknown catalog keys are rejected.
  t('aKeyThatDoesNotExist');
  // @ts-expect-error Interpolation values are required.
  t('appConnectToValue1');
  // @ts-expect-error A misspelled interpolation parameter is rejected.
  t('appConnectToValue1',{name:'host'});
}
void typedCatalogContracts;
