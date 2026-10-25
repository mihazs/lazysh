import type {i18n} from 'i18next';
import {english} from '../i18n/en';
/** Test-only expansion leaves interpolation values and their contents untouched. */
export function pseudoEnglish() {
  const vowels: Record<string,string> = {a:'áa',e:'ëe',i:'ïi',o:'öo',u:'üu',A:'ÁA',E:'ËE',I:'ÏI',O:'ÖO',U:'ÜU'};
  return Object.fromEntries(Object.entries(english).map(([key,text]) => [key,
    '⟦'+text.split(/(\{\{[^}]+\}\})/).map(part => part.startsWith('{{') ? part : part.replace(/[aeiouAEIOU]/g, letter => vowels[letter])).join('')+'⟧',
  ]));
}
export async function enablePseudoLocale(instance: i18n) {
  instance.addResourceBundle('en-XA', 'translation', pseudoEnglish());
  await instance.changeLanguage('en-XA');
}
