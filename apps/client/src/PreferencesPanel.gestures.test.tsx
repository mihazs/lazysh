// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {mountPreferences} from "./test/preferencesPanel";
import {budgetStyleLookups} from "./test/styleBudget";
import {uiI18n,t} from "./i18n/core";
import { defaults, getPreferences, savePreferences, parseChord } from "./preferences";
afterEach(() => cleanup());
budgetStyleLookups(300);

describe("terminal gesture settings", () => {
  it.each([['en','Hide keyboard when scrolling past local history bottom'],['pt-BR','Ocultar teclado ao rolar além do fim do histórico local'],['es','Ocultar teclado al desplazarse más allá del final del historial local']])('persists optional past-bottom dismissal and gesture reset in %s',async(language,label)=>{
    await act(async()=>{await uiI18n.changeLanguage(language);});
    try {
    savePreferences({...defaults});let page=mountPreferences(t('preferencesCategoryInput'),t('preferencesTerminalTouchGestures'));
    const toggle=page.getByRole('checkbox',{name:label});
    expect(toggle).toHaveProperty('checked',false);fireEvent.click(toggle);expect(getPreferences().dismissKeyboardOnOverscroll).toBe(true);
    cleanup();page=mountPreferences(t('preferencesCategoryInput'),t('preferencesTerminalTouchGestures'));expect(page.getByRole('checkbox',{name:label})).toHaveProperty('checked',true);
    fireEvent.click(page.getByRole('button',{name:t('preferencesResetGestures')}));expect(getPreferences().dismissKeyboardOnOverscroll).toBe(false);
    } finally {cleanup();await act(async()=>{await uiI18n.changeLanguage('en');});}
  });
  it('switches each edge swipe on or off, sets the zone width and resets them with the gestures', () => {
    savePreferences({...defaults});const page=mountPreferences(t('preferencesCategoryInput'),t('preferencesTerminalTouchGestures'));
    const left=page.getByRole('checkbox',{name:t('edgeGestureLeftMenu')});
    expect(left).toHaveProperty('checked',true);
    expect(page.getByRole('checkbox',{name:t('edgeGestureBottomMenu')})).toHaveProperty('checked',true);
    expect(page.getByRole('checkbox',{name:t('edgeGestureViewSwitch')})).toHaveProperty('checked',true);
    fireEvent.click(left);
    fireEvent.change(page.getByRole('slider',{name:t('edgeGestureZoneWidth',{value:'40'})}),{target:{value:'64'}});
    expect(getPreferences().edgeGestures).toEqual({leftMenu:false,bottomMenu:true,viewSwitch:true,zoneWidth:64,mode:'auto'});
    fireEvent.change(page.getByRole('combobox',{name:t('gestureModeLabel')}),{target:{value:'edges'}});
    expect(getPreferences().edgeGestures).toMatchObject({mode:'edges'});
    fireEvent.click(page.getByRole('button',{name:t('preferencesResetGestures')}));
    expect(getPreferences().edgeGestures).toBeUndefined();
  });
  it('lists the gesture styles with the automatic one first',()=>{
    savePreferences({...defaults});const page=mountPreferences(t('preferencesCategoryInput'),t('preferencesTerminalTouchGestures'));
    const style=page.getByRole('combobox',{name:t('gestureModeLabel')}) as HTMLSelectElement;
    expect([...style.options].map(option=>option.value)).toEqual(['auto','handles','edges','off']);
    expect(style.value).toBe('auto');
  });
  it('keeps gesture and D-pad drafts isolated and saves only explicitly compiled bindings', () => {
    savePreferences({...defaults, bodyGestures:{...defaults.bodyGestures,tap:'custom',doubleTap:'custom'}, dpadCorners:{...defaults.dpadCorners,left:'custom'},gestureChords:{tap:'F12, M-h',doubleTap:'C-b, T',cornerLeft:'S-Tab'}});
    const page=mountPreferences('Keyboard and gestures','Terminal touch gestures');
    const slot=(label:string)=>within(page.getByText(label,{selector:'label'}).parentElement!);
    const tap=slot('Single tap'),doubleTap=slot('Double tap'),corner=slot('D-pad left corner');
    fireEvent.change(tap.getByLabelText('Single tap shortcut builder'),{target:{value:'simple'}});
    fireEvent.change(tap.getByLabelText('Single tap custom shortcut text'),{target:{value:' 你好,, 😀 '}});
    fireEvent.change(corner.getByLabelText('D-pad left corner shortcut builder'),{target:{value:'simple'}});
    fireEvent.click(corner.getByLabelText('D-pad left corner Control'));
    fireEvent.change(corner.getByLabelText('D-pad left corner custom shortcut text'),{target:{value:'a,b'}});
    expect(getPreferences().gestureChords).toEqual({tap:'F12, M-h',doubleTap:'C-b, T',cornerLeft:'S-Tab'});
    fireEvent.change(tap.getByLabelText('Single tap shortcut builder'),{target:{value:'advanced'}});
    expect(tap.getByLabelText<HTMLInputElement>('Single tap chord').value).toBe('F12, M-h');
    fireEvent.change(tap.getByLabelText('Single tap shortcut builder'),{target:{value:'simple'}});
    expect(tap.getByLabelText<HTMLTextAreaElement>('Single tap custom shortcut text').value).toBe(' 你好,, 😀 ');
    fireEvent.click(tap.getByRole('button',{name:'Save Single tap chord'}));
    expect(getPreferences().gestureChords.tap).toBe('text: 你好,, 😀 ');
    expect(tap.getByLabelText<HTMLSelectElement>('Single tap shortcut builder').value).toBe('advanced');
    expect(corner.getByLabelText<HTMLTextAreaElement>('D-pad left corner custom shortcut text').value).toBe('a,b');
    fireEvent.click(corner.getByRole('button',{name:'Save D-pad left corner chord'}));
    expect(parseChord(getPreferences().gestureChords.cornerLeft!)).toBe('\x01\x02');
    expect(getPreferences().gestureChords.doubleTap).toBe('C-b, T');
    fireEvent.change(tap.getByLabelText('Single tap shortcut builder'),{target:{value:'advanced'}});
    expect(tap.getByLabelText<HTMLInputElement>('Single tap chord').value).toBe('text: 你好,, 😀 ');
    fireEvent.change(doubleTap.getByLabelText('Double tap chord'),{target:{value:'text: trailing '}});
    fireEvent.blur(doubleTap.getByLabelText('Double tap chord'));
    expect(getPreferences().gestureChords.doubleTap).toBe('C-b, T');
    fireEvent.click(doubleTap.getByRole('button',{name:'Save Double tap chord'}));
    expect(getPreferences().gestureChords.doubleTap).toBe('text: trailing ');
  });
  it('refreshes only the externally changed slot and discards its stale drafts', () => {
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,tap:'custom',doubleTap:'custom'},gestureChords:{tap:'F12',doubleTap:'C-b'}});
    const page=mountPreferences('Keyboard and gestures','Terminal touch gestures');
    for (const label of ['Single tap','Double tap']) {
      fireEvent.change(page.getByLabelText(`${label} shortcut builder`),{target:{value:'simple'}});
      fireEvent.change(page.getByLabelText(`${label} custom shortcut text`),{target:{value:'unsaved'}});
    }
    act(() => savePreferences({...getPreferences(),gestureChords:{tap:'M-h',doubleTap:'C-b'}}));
    expect(page.getByLabelText<HTMLSelectElement>('Single tap shortcut builder').value).toBe('advanced');
    expect(page.getByLabelText<HTMLInputElement>('Single tap chord').value).toBe('M-h');
    expect(page.getByLabelText<HTMLTextAreaElement>('Double tap custom shortcut text').value).toBe('unsaved');
    fireEvent.change(page.getByLabelText('Single tap shortcut builder'),{target:{value:'simple'}});
    expect(page.getByLabelText<HTMLTextAreaElement>('Single tap custom shortcut text').value).toBe('');
    expect(getPreferences().gestureChords).toEqual({tap:'M-h',doubleTap:'C-b'});
  });
  it('retains per-slot validation errors and complete invalid drafts without altering saved bindings', () => {
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,tap:'custom'},dpadCorners:{...defaults.dpadCorners,right:'custom'},gestureChords:{tap:'F12',cornerRight:'C-c'}});
    const page=mountPreferences('Keyboard and gestures','Terminal touch gestures');
    fireEvent.change(page.getByLabelText('Single tap shortcut builder'),{target:{value:'simple'}});
    fireEvent.click(page.getByLabelText('Single tap Control'));
    fireEvent.change(page.getByLabelText('Single tap custom shortcut text'),{target:{value:'a,'}});
    fireEvent.click(page.getByRole('button',{name:'Save Single tap chord'}));
    expect(page.getByRole('alert').textContent).toContain('comma-separated');
    fireEvent.change(page.getByLabelText('D-pad right corner chord'),{target:{value:'M-h'}});
    fireEvent.click(page.getByRole('button',{name:'Save D-pad right corner chord'}));
    expect(page.getByRole('alert').textContent).toContain('comma-separated');
    expect(page.getByLabelText<HTMLTextAreaElement>('Single tap custom shortcut text').value).toBe('a,');
    expect(getPreferences().gestureChords).toEqual({tap:'F12',cornerRight:'M-h'});
    fireEvent.click(page.getByLabelText('Single tap Control'));
    const oversized='x'.repeat(200);
    fireEvent.change(page.getByLabelText('Single tap custom shortcut text'),{target:{value:oversized}});
    fireEvent.click(page.getByRole('button',{name:'Save Single tap chord'}));
    expect(page.getByLabelText<HTMLTextAreaElement>('Single tap custom shortcut text').value).toBe(oversized);
    expect(getPreferences().gestureChords.tap).toBe('F12');
  });
});
