import {parseChord} from './preferences';

export type SimpleModifiers = {ctrl: boolean; meta: boolean; shift: boolean};

// Compile custom text into the existing stored grammar, never into a new schema.
export function compileSimpleChord(text: string, modifiers: SimpleModifiers): string {
  if (!text || text.length > 128) throw new Error('Enter 1–128 characters of custom text; nothing is truncated.');
  if (/[\uD800-\uDFFF]/u.test(text)) throw new Error('Custom text must contain valid Unicode.');
  const prefix = `${modifiers.ctrl ? 'C-' : ''}${modifiers.meta ? 'M-' : ''}${modifiers.shift ? 'S-' : ''}`;
  if (!prefix) {
    const binding = `text:${text}`;
    if (binding.length > 128) throw new Error('Literal text allows at most 123 UTF-16 code units, including spaces.');
    parseChord(binding);
    return binding;
  }
  if (!/^[ -~]+$/.test(text)) throw new Error('With modifiers, use printable ASCII only; remove modifiers for Unicode text.');
  const groups = [''];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ',' && text[i + 1] === ',') {groups[groups.length - 1] += ','; i++;}
    else if (text[i] === ',') groups.push('');
    else groups[groups.length - 1] += text[i];
  }
  if (groups.some(group => !group)) throw new Error('Every comma-separated group needs text; use ,, for a literal comma.');
  const aliases: Record<string, string> = {' ': 'Space', ',': 'comma', '-': 'dash', '+': 'plus'};
  const steps = groups.flatMap(group => Array.from(group, (char, i) => `${i === 0 ? prefix : ''}${aliases[char] ?? char}`));
  if (steps.length > 8) throw new Error('Modified text allows at most 8 resulting character steps.');
  const binding = steps.join(' ');
  if (binding.length > 128) throw new Error('The compiled shortcut exceeds the 128-character binding limit.');
  parseChord(binding); // Reject unsupported modifier/key combinations as usual.
  return binding;
}
