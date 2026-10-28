// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import ChordBuilder from '../ChordBuilder';
import {t,uiI18n} from './core';
import {LocalUiError} from './localError';
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
it('keeps literal key data and the original draft/focus while translating an already-retained parser error',async()=>{
  const save=vi.fn(()=>true);render(<ChordBuilder onSave={save}/>);
  const input=screen.getByRole('textbox',{name:'Key sequence'});
  fireEvent.change(input,{target:{value:'Ctrl+{{<key>}}'}});input.focus();
  fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
  await act(async()=>{await uiI18n.changeLanguage('pt-BR');});
  expect(screen.getByRole('alert').textContent).toBe(t('validationUnknownKeyValue1',{value1:'{{<key>}}'}));
  expect(screen.getByRole('textbox')).toBe(input);expect(input).toHaveProperty('value','Ctrl+{{<key>}}');
  expect(document.activeElement).toBe(input);expect(save).not.toHaveBeenCalled();
});

it.each([
  ['Ctrl+Ctrl+{{<step>}}','validationInvalidModifiersInValue1','Ctrl+Ctrl+{{<step>}}'],
  ['Ctrl+{{<key>}}','validationUnknownKeyValue1','{{<key>}}'],
  ['Shift+1','validationUseTheResultingCharacterInsteadOfShiftValue1','1'],
  ['Ctrl+1','validationCtrlIsUnsupportedForValue1','1'],
] as const)('retains the finite %s cause and literal interpolation data through every locale',async(source,key,value1)=>{
  const {parseChordSteps}=await import('../preferences');const{LocalUiError,uiErrorText}=await import('./localError');
  const{enablePseudoLocale}=await import('../test/pseudoLocale');
  let error:unknown;try{parseChordSteps(source);}catch(cause){error=cause;}
  expect(error).toBeInstanceOf(LocalUiError);
  expect((error as InstanceType<typeof LocalUiError>).key).toBe(key);
  for(const locale of ['en','pt-BR','es','en-XA']){
    if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);
    expect(uiErrorText(error as InstanceType<typeof LocalUiError>)).toBe(t(key,{value1}));
  }
});
it('keeps the accepted/rejected grammar and exact step bytes independent of interface language',async()=>{
  const{parseChordSteps,parseChord,parsePreferences,defaults}=await import('../preferences');
  const{compileSimpleChord}=await import('../simpleChord');const{enablePseudoLocale}=await import('../test/pseudoLocale');
  const accepted=[['C-a,M-j,Enter',['\x01','\x1bj','\r']],['text: {{<raw>}}, 世界 ',[' {{<raw>}}, 世界 ']],['S-Tab Opt+F8 Ctrl+Home',['\x1b[Z','\x1b[19;3~','\x1b[1;5H']],['comma plus dash',[',','+','-']]] as const;
  const rejected=['','Ctrl+Ctrl+z','Meta+z','Ctrl+2','Shift+2','F13','a '.repeat(9),'a,,z','text:\x00','text:','x'.repeat(129)];
  const modifiers={ctrl:true,meta:false,shift:false};
  for(const locale of ['en','pt-BR','es','en-XA']){
    if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);
    for(const [binding,bytes] of accepted){expect(parseChordSteps(binding)).toEqual(bytes);expect(parseChord(binding)).toBe(bytes.join(''));}
    for(const binding of rejected)expect(()=>parseChordSteps(binding)).toThrow();
    for(const text of ['', '\ud800','世界','a,','abcdefghj'])expect(()=>compileSimpleChord(text,modifiers)).toThrow();
    expect(compileSimpleChord('z,,q',modifiers)).toBe('C-z comma q');
    expect(parseChordSteps(compileSimpleChord('z,,q',modifiers))).toEqual(['\x1a',',','q']);
    const literal=' {{<text>}}, 世界 ';
    expect(compileSimpleChord(literal,{ctrl:false,meta:false,shift:false})).toBe('text:'+literal);
    expect(parsePreferences({...defaults,chords:[{label:'RAW label',keys:'C-a,M-j,Enter'},{label:'Rejected',keys:'Meta+z'}]}).chords).toEqual([{label:'RAW label',keys:'C-a,M-j,Enter'}]);
  }
});
it.each(['',new Error('RAW callback <{{key}}>'),{message:'RAW object'}])('preserves callback failure %j using the original String formatting',async(raw)=>{
  render(<ChordBuilder onSave={()=>{throw raw;}}/>);
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'F2'}});
  fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
  await act(async()=>{await uiI18n.changeLanguage('es');});
  expect(screen.queryByRole('alert')?.textContent??'').toBe(String(raw));
});
function finiteCauseTypeChecks(){
  new LocalUiError('validationUnknownKeyValue1','{{<literal>}}');
  // @ts-expect-error Interpolated causes require their literal string data.
  new LocalUiError('validationUnknownKeyValue1');
  // @ts-expect-error No arbitrary translation keys.
  new LocalUiError('unknownTranslationKey');
  // @ts-expect-error Fixed causes accept no interpolation options.
  new LocalUiError('terminalDraftLimit','extra');
  // @ts-expect-error Values are literal strings, not arbitrary option objects.
  new LocalUiError('validationUnknownKeyValue1',{value1:'raw'});
}
void finiteCauseTypeChecks;

it('retains a simple-mode parser cause without changing text, modifiers or callbacks',async()=>{
  const save=vi.fn(()=>true);render(<ChordBuilder onSave={save}/>);
  fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'simple'}});
  const control=screen.getByLabelText('Control');fireEvent.click(control);
  const input=screen.getByRole('textbox',{name:'Custom shortcut text'});
  fireEvent.change(input,{target:{value:'世界<{{raw}}>'}});
  fireEvent.click(screen.getByRole('button',{name:'Add chord'}));input.focus();
  const{enablePseudoLocale}=await import('../test/pseudoLocale');
  for(const locale of ['pt-BR','es','en-XA']){
    await act(async()=>{if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);});
    expect(screen.getByRole('alert').textContent).toBe(t('validationWithModifiersUsePrintableASCIIOnlyRemoveModifiersFor'));
    expect(screen.getByRole('textbox')).toBe(input);expect(input).toHaveProperty('value','世界<{{raw}}>');
    expect(control).toHaveProperty('checked',true);expect(document.activeElement).toBe(input);
    expect(save).not.toHaveBeenCalled();
  }
});

it('saves named and function keys through the existing parser without sending on selection',async()=>{
  const {parseChordSteps}=await import('../preferences');
  const save=vi.fn(()=>true);render(<ChordBuilder onSave={save}/>);
  fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'named'}});
  const picker=screen.getByLabelText('Named key');
  expect(Array.from((picker as HTMLSelectElement).options,option=>option.value)).toEqual(['Enter','Tab','Escape','Backspace','Space','Up','Down','Left','Right','Home','End','Insert','Delete','PageUp','PageDown',...Array.from({length:12},(_,i)=>`F${i+1}`)]);
  expect(save).not.toHaveBeenCalled();
  for(const [key,bytes] of [['Enter','\r'],['Backspace','\x7f'],['Space',' '],['Home','\x1b[H'],['F1','\x1bOP'],['F4','\x1bOS'],['F5','\x1b[15~'],['F12','\x1b[24~']]){
    const before=save.mock.calls.length;
    fireEvent.change(picker,{target:{value:key}});
    expect(save).toHaveBeenCalledTimes(before);
    fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
    expect(save).toHaveBeenLastCalledWith(key);
    expect(parseChordSteps(key)).toEqual([bytes]);
  }
  fireEvent.click(screen.getByLabelText('Control'));
  fireEvent.click(screen.getByLabelText('Option / Alt'));
  fireEvent.click(screen.getByLabelText('Shift'));
  fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
  expect(save).toHaveBeenLastCalledWith('C-M-S-F12');
  expect(parseChordSteps('C-M-S-F12')).toEqual(['\x1b[24;8~']);
});

it('retains independent named, literal and Advanced drafts across locale changes and failed saves',async()=>{
  const save=vi.fn(()=>false);render(<ChordBuilder label="RAW {{slot}}" binding="C-b, 1" onSave={save}/>);
  const builder=screen.getByRole('combobox',{name:'RAW {{slot}} shortcut builder'});
  fireEvent.change(builder,{target:{value:'simple'}});
  fireEvent.change(screen.getByRole('textbox'),{target:{value:' literal 世界 '}});
  fireEvent.click(screen.getByLabelText('RAW {{slot}} Control'));
  fireEvent.change(builder,{target:{value:'named'}});
  const picker=screen.getByLabelText('RAW {{slot}} named key');
  fireEvent.change(picker,{target:{value:'Tab'}});
  expect(screen.getByLabelText('RAW {{slot}} Control')).toHaveProperty('checked',false);
  fireEvent.click(screen.getByLabelText('RAW {{slot}} Shift'));picker.focus();
  const{enablePseudoLocale}=await import('../test/pseudoLocale');
  for(const locale of ['pt-BR','es','en-XA']){
    await act(async()=>{if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);});
    expect(screen.getByLabelText(t('shortcutNamedKeyForLabel',{label:'RAW {{slot}}'}))).toBe(picker);
    expect(picker).toHaveProperty('value','Tab');expect(document.activeElement).toBe(picker);
    expect(screen.getByLabelText(t('shortcutModifierForLabel',{label:'RAW {{slot}}',modifier:t('shortcutShift')}))).toHaveProperty('checked',true);
    expect(save).not.toHaveBeenCalled();
  }
  fireEvent.click(screen.getByRole('button',{name:t('shortcutSaveValue1Chord',{value1:'RAW {{slot}}'})}));
  expect(save).toHaveBeenLastCalledWith('S-Tab');
  expect(picker).toHaveProperty('value','Tab');
  fireEvent.change(builder,{target:{value:'simple'}});
  expect(screen.getByRole('textbox')).toHaveProperty('value',' literal 世界 ');
  expect(screen.getByLabelText(t('shortcutModifierForLabel',{label:'RAW {{slot}}',modifier:t('shortcutControl')}))).toHaveProperty('checked',true);
  expect(screen.getByLabelText(t('shortcutModifierForLabel',{label:'RAW {{slot}}',modifier:t('shortcutShift')}))).toHaveProperty('checked',false);
  fireEvent.change(builder,{target:{value:'advanced'}});
  expect(screen.getByRole('textbox')).toHaveProperty('value','C-b, 1');
});
