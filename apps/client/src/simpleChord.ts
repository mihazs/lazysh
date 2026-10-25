import {t} from './i18n/core';
import {parseChord} from './preferences';

export type SimpleModifiers = {ctrl: boolean; meta: boolean; shift: boolean};

// Compile custom text into the existing stored grammar, never into a new schema.
export function compileSimpleChord(text: string, modifiers: SimpleModifiers): string {
  if (!text || text.length > 128) throw new Error(t("validationEnter1128CharactersOfCustomTextNothingIs"));
  if (/[\uD800-\uDFFF]/u.test(text)) throw new Error(t("validationCustomTextMustContainValidUnicode"));
  const prefix = `${modifiers.ctrl ? 'C-' : ''}${modifiers.meta ? 'M-' : ''}${modifiers.shift ? 'S-' : ''}`;
  if (!prefix) {
    const binding = `text:${text}`;
    if (binding.length > 128) throw new Error(t("validationLiteralTextAllowsAtMost123UTF16Code"));
    parseChord(binding);
    return binding;
  }
  if (!/^[ -~]+$/.test(text)) throw new Error(t("validationWithModifiersUsePrintableASCIIOnlyRemoveModifiersFor"));
  const groups = [''];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ',' && text[i + 1] === ',') {groups[groups.length - 1] += ','; i++;}
    else if (text[i] === ',') groups.push('');
    else groups[groups.length - 1] += text[i];
  }
  if (groups.some(group => !group)) throw new Error(t("validationEveryCommaSeparatedGroupNeedsTextUseForA"));
  const aliases: Record<string, string> = {' ': 'Space', ',': 'comma', '-': 'dash', '+': 'plus'};
  const steps = groups.flatMap(group => Array.from(group, (char, i) => `${i === 0 ? prefix : ''}${aliases[char] ?? char}`));
  if (steps.length > 8) throw new Error(t("validationModifiedTextAllowsAtMost8ResultingCharacterSteps"));
  const binding = steps.join(' ');
  if (binding.length > 128) throw new Error(t("validationTheCompiledShortcutExceedsThe128CharacterBindingLimit"));
  parseChord(binding); // Reject unsupported modifier/key combinations as usual.
  return binding;
}
