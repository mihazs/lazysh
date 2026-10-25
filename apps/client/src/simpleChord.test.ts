import {expect,it} from 'vitest';
import {compileSimpleChord} from './simpleChord';
import {defaults,parseChord,parsePreferences} from './preferences';
const none = {ctrl:false,meta:false,shift:false};
const ctrl = {...none,ctrl:true};

it('compiles first-character modifiers, separated groups, escaped commas and literal spaces', () => {
  for (const [text,modifiers,binding,bytes] of [
    ['b1',ctrl,'C-b 1','\x021'],
    ['a,b',ctrl,'C-a C-b','\x01\x02'],
    ['a,,b',ctrl,'C-a comma b','\x01,b'],
    ['a,,,b',ctrl,'C-a comma C-b','\x01,\x02'],
    [' b ',ctrl,'C-Space b Space','\x00b '],
    ['a-+',ctrl,'C-a dash plus','\x01-+'],
    [',,b',{...none,meta:true},'M-comma b','\x1b,b'],
    ['aB',{...none,shift:true},'S-a B','AB'],
    ['a1',{ctrl:true,meta:true,shift:true},'C-M-S-a 1','\x1b\x011'],
  ] as const) {
    expect(compileSimpleChord(text,modifiers)).toBe(binding);
    expect(parseChord(binding)).toBe(bytes);
  }
});

it('preserves no-modifier Unicode, commas and whitespace through the existing saved grammar', () => {
  for (const text of [' 你好, 😀 ', ' ', ',,', 'Enter', 'x'.repeat(123), '😀'.repeat(60)+'abc']) {
    const keys = compileSimpleChord(text,none);
    expect(keys).toBe('text:'+text);
    const saved = parsePreferences(JSON.parse(JSON.stringify({...defaults,chords:[{label:'Literal',keys}]})));
    expect(saved.chords).toEqual([{label:'Literal',keys}]);
    expect(parseChord(saved.chords[0].keys)).toBe(text);
  }
});

it('rejects malformed Unicode, controls, empty groups, unsupported modifiers and all bounds without truncating', () => {
  for (const text of ['', '\ud800', '\udfff', 'a\nb', '\t', '\x7f', 'a'.repeat(124), '😀'.repeat(62), 'a'.repeat(129)]) expect(()=>compileSimpleChord(text,none)).toThrow();
  for (const text of ['a,', ',a', 'a,,b,', 'a,b,', '你好', 'b你', 'a\tb', '123', ',,', 'abcdefghi']) expect(()=>compileSimpleChord(text,ctrl)).toThrow();
  expect(()=>compileSimpleChord('1',{...none,shift:true})).toThrow();
  expect(parseChord(compileSimpleChord('abcdefgh',ctrl))).toBe('\x01bcdefgh');
});
