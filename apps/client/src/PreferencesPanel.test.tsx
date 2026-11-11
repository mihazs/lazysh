// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import PreferencesPanel from "./PreferencesPanel";
import {uiI18n,t} from "./i18n/core";
import { defaults, getPreferences, savePreferences, parseChord, toolbarRows } from "./preferences";
afterEach(() => cleanup());

function mountPreferences(...summaries:string[]) {
  render(<PreferencesPanel/>);
  for(const summary of summaries)fireEvent.click(screen.getByRole('button',{name:summary}));
}

describe("terminal settings", () => {
  it.each([['en','Hide keyboard when scrolling past local history bottom'],['pt-BR','Ocultar teclado ao rolar além do fim do histórico local'],['es','Ocultar teclado al desplazarse más allá del final del historial local']])('persists optional past-bottom dismissal and gesture reset in %s',async(language,label)=>{
    await act(async()=>{await uiI18n.changeLanguage(language);});
    try {
    savePreferences({...defaults});mountPreferences(t('preferencesCategoryInput'),t('preferencesTerminalTouchGestures'));
    const toggle=screen.getByRole('checkbox',{name:label});
    expect(toggle).toHaveProperty('checked',false);fireEvent.click(toggle);expect(getPreferences().dismissKeyboardOnOverscroll).toBe(true);
    cleanup();mountPreferences(t('preferencesCategoryInput'),t('preferencesTerminalTouchGestures'));expect(screen.getByRole('checkbox',{name:label})).toHaveProperty('checked',true);
    fireEvent.click(screen.getByRole('button',{name:t('preferencesResetGestures')}));expect(getPreferences().dismissKeyboardOnOverscroll).toBe(false);
    } finally {cleanup();await act(async()=>{await uiI18n.changeLanguage('en');});}
  });
  it('switches each edge swipe on or off, sets the zone width and resets them with the gestures', () => {
    savePreferences({...defaults});mountPreferences(t('preferencesCategoryInput'),t('preferencesTerminalTouchGestures'));
    const left=screen.getByRole('checkbox',{name:t('edgeGestureLeftMenu')});
    expect(left).toHaveProperty('checked',true);
    expect(screen.getByRole('checkbox',{name:t('edgeGestureBottomMenu')})).toHaveProperty('checked',true);
    expect(screen.getByRole('checkbox',{name:t('edgeGestureViewSwitch')})).toHaveProperty('checked',true);
    fireEvent.click(left);
    fireEvent.change(screen.getByRole('slider',{name:t('edgeGestureZoneWidth',{value:'24'})}),{target:{value:'40'}});
    expect(getPreferences().edgeGestures).toEqual({leftMenu:false,bottomMenu:true,viewSwitch:true,zoneWidth:40});
    fireEvent.click(screen.getByRole('button',{name:t('preferencesResetGestures')}));
    expect(getPreferences().edgeGestures).toBeUndefined();
  });
  it('keeps gesture and D-pad drafts isolated and saves only explicitly compiled bindings', () => {
    savePreferences({...defaults, bodyGestures:{...defaults.bodyGestures,tap:'custom',doubleTap:'custom'}, dpadCorners:{...defaults.dpadCorners,left:'custom'},gestureChords:{tap:'F12, M-h',doubleTap:'C-b, T',cornerLeft:'S-Tab'}});
    mountPreferences('Keyboard and gestures','Terminal touch gestures');
    const slot=(label:string)=>within(screen.getByText(label,{selector:'label'}).parentElement!);
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
    mountPreferences('Keyboard and gestures','Terminal touch gestures');
    for (const label of ['Single tap','Double tap']) {
      fireEvent.change(screen.getByLabelText(`${label} shortcut builder`),{target:{value:'simple'}});
      fireEvent.change(screen.getByLabelText(`${label} custom shortcut text`),{target:{value:'unsaved'}});
    }
    act(() => savePreferences({...getPreferences(),gestureChords:{tap:'M-h',doubleTap:'C-b'}}));
    expect(screen.getByLabelText<HTMLSelectElement>('Single tap shortcut builder').value).toBe('advanced');
    expect(screen.getByLabelText<HTMLInputElement>('Single tap chord').value).toBe('M-h');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Double tap custom shortcut text').value).toBe('unsaved');
    fireEvent.change(screen.getByLabelText('Single tap shortcut builder'),{target:{value:'simple'}});
    expect(screen.getByLabelText<HTMLTextAreaElement>('Single tap custom shortcut text').value).toBe('');
    expect(getPreferences().gestureChords).toEqual({tap:'M-h',doubleTap:'C-b'});
  });
  it('retains per-slot validation errors and complete invalid drafts without altering saved bindings', () => {
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,tap:'custom'},dpadCorners:{...defaults.dpadCorners,right:'custom'},gestureChords:{tap:'F12',cornerRight:'C-c'}});
    mountPreferences('Keyboard and gestures','Terminal touch gestures');
    fireEvent.change(screen.getByLabelText('Single tap shortcut builder'),{target:{value:'simple'}});
    fireEvent.click(screen.getByLabelText('Single tap Control'));
    fireEvent.change(screen.getByLabelText('Single tap custom shortcut text'),{target:{value:'a,'}});
    fireEvent.click(screen.getByRole('button',{name:'Save Single tap chord'}));
    expect(screen.getByRole('alert').textContent).toContain('comma-separated');
    fireEvent.change(screen.getByLabelText('D-pad right corner chord'),{target:{value:'M-h'}});
    fireEvent.click(screen.getByRole('button',{name:'Save D-pad right corner chord'}));
    expect(screen.getByRole('alert').textContent).toContain('comma-separated');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Single tap custom shortcut text').value).toBe('a,');
    expect(getPreferences().gestureChords).toEqual({tap:'F12',cornerRight:'M-h'});
    fireEvent.click(screen.getByLabelText('Single tap Control'));
    const oversized='x'.repeat(200);
    fireEvent.change(screen.getByLabelText('Single tap custom shortcut text'),{target:{value:oversized}});
    fireEvent.click(screen.getByRole('button',{name:'Save Single tap chord'}));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Single tap custom shortcut text').value).toBe(oversized);
    expect(getPreferences().gestureChords.tap).toBe('F12');
  });
  it('keeps Advanced default and existing records, while saving Simple text verbatim', () => {
    savePreferences({...defaults,chords:[{label:'Existing',keys:'F12, M-h'}]});
    mountPreferences('Keyboard and gestures','Keyboard chords');
    expect(screen.getByLabelText<HTMLSelectElement>('Shortcut builder').value).toBe('advanced');
    fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'simple'}});
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Literal'}});
    fireEvent.change(screen.getByLabelText('Custom shortcut text'),{target:{value:' 你好,, world '}});
    fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
    expect(getPreferences().chords).toEqual([{label:'Existing',keys:'F12, M-h'},{label:'Literal',keys:'text: 你好,, world '}]);
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Prefix'}});
    fireEvent.click(screen.getByLabelText('Control'));
    fireEvent.change(screen.getByLabelText('Custom shortcut text'),{target:{value:'b1'}});
    fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
    expect(parseChord(getPreferences().chords[2].keys)).toBe('\x021');
    fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'advanced'}});
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Advanced literal'}});
    fireEvent.change(screen.getByLabelText('Key sequence'),{target:{value:'text: trailing '}});
    fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
    expect(getPreferences().chords[3].keys).toBe('text: trailing ');
  });
  it('reports Simple validation errors and retains the complete unsaved input', () => {
    savePreferences({...defaults});
    mountPreferences('Keyboard and gestures','Keyboard chords');
    fireEvent.change(screen.getByLabelText('Shortcut builder'),{target:{value:'simple'}});
    fireEvent.change(screen.getByLabelText('Chord name'),{target:{value:'Unsent'}});
    expectRejectedShortcutDrafts(['a'.repeat(124),'a'.repeat(200),'a\nb']);
    fireEvent.click(screen.getByLabelText('Control'));
    expectRejectedShortcutDrafts(['b你好','abcdefghi','a,','1']);
  });
  it("sets the toolbar key height with a bounded slider, shows it live and resets to the default size", () => {
    savePreferences({...defaults});
    mountPreferences('Keyboard and gestures', 'Toolbar keys and order');
    const slider = screen.getByLabelText<HTMLInputElement>("Toolbar key height");
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(["28", "56", "2", "32"]);
    expect(slider.getAttribute("aria-valuetext")).toBe("32 px");
    const preview = document.querySelector<HTMLElement>(".toolbar-preview-keys")!;
    expect(preview.style.getPropertyValue("--terminal-key-height")).toBe("32px");
    const reset = screen.getByRole("button", {name: "Default size"});
    expect(reset.hasAttribute("disabled")).toBe(true);
    fireEvent.change(slider, {target: {value: "44"}});
    expect(getPreferences().toolbarKeyHeight).toBe(44);
    expect(slider.value).toBe("44");
    expect(preview.style.getPropertyValue("--terminal-key-height")).toBe("44px");
    expect(reset.hasAttribute("disabled")).toBe(false);
    fireEvent.click(reset);
    expect(getPreferences().toolbarKeyHeight).toBeUndefined();
    expect(slider.value).toBe("32");
    expect(reset.hasAttribute("disabled")).toBe(true);
  });
  it("rearranges toolbar rows without dragging through key actions, keyboard shortcuts and announcements", () => {
    savePreferences({...defaults, toolbar: ["esc", "ctrl", "tab"]});
    mountPreferences('Keyboard and gestures', 'Toolbar keys and order');
    const status = within(document.querySelector<HTMLElement>("[data-settings-page=\"preferencesToolbarKeysAndOrder\"]")!).getByRole("status");
    fireEvent.change(screen.getByLabelText("Toolbar rows"), {target: {value: "2"}});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["esc", "ctrl", "tab"], []]);
    const tab = screen.getByRole("button", {name: "tab"});
    tab.focus();
    fireEvent.keyDown(tab, {key: "ArrowDown", altKey: true});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["esc", "ctrl"], ["tab"]]);
    expect(status.textContent).toBe("tab moved to row 2, position 1");
    expect(document.activeElement).toBe(screen.getByRole("button", {name: "tab"}));
    fireEvent.keyDown(document.activeElement!, {key: "ArrowLeft", altKey: true});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["esc", "ctrl", "tab"], []]);
    fireEvent.keyDown(screen.getByRole("button", {name: "esc"}), {key: "ArrowLeft", altKey: true});
    expect(status.textContent).toBe("esc cannot move further");
    // A single tap opens the same moves for pointer and screen-reader users.
    fireEvent.click(screen.getByRole("button", {name: "esc"}));
    const actions = screen.getByRole("group", {name: "Move esc"});
    expect(document.activeElement).toBe(actions.querySelector("button"));
    fireEvent.click(screen.getByRole("button", {name: "Move esc to row 2"}));
    fireEvent.click(screen.getByRole("button", {name: "Move esc later"}));
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["ctrl", "tab"], ["esc"]]);
    // Escape closes the key actions first instead of leaving the settings page.
    fireEvent.keyDown(document.activeElement!, {key: "Escape"});
    expect(screen.queryByRole("group", {name: "Move esc"})).toBeNull();
    expect(screen.getByRole("region", {name: "Toolbar keys and order"}).hidden).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", {name: "esc"}));
    fireEvent.keyDown(document.activeElement!, {key: "Delete"});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["ctrl", "tab"], []]);
    expect(status.textContent).toBe("esc removed");
    expect(document.activeElement).toBe(screen.getByRole("button", {name: "Add esc"}));
    fireEvent.click(screen.getByRole("button", {name: "Add esc"}));
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["ctrl", "tab"], ["esc"]]);
    expect(status.textContent).toBe("esc added to row 2, position 1");
    fireEvent.change(screen.getByLabelText("Toolbar rows"), {target: {value: "1"}});
    expect(getPreferences().toolbar).toEqual(["ctrl", "tab", "esc"]);
  });
  it("persists theme and reordered toolbar, rejects invalid theme import, and resets", () => {
    savePreferences({...defaults});
    mountPreferences('Appearance and fonts');
    expect(screen.getByLabelText<HTMLSelectElement>("Session switcher layout").value).toBe("list");
    fireEvent.change(screen.getByLabelText("Session switcher layout"), {target: {value: "cards"}});
    expect(getPreferences().sessionLayout).toBe("cards");
    fireEvent.change(screen.getByLabelText("Terminal theme"), {target: {value: "paper"}});
    expect(getPreferences().theme).toBe("paper");
    fireEvent.click(screen.getByRole("button",{name:"Back"}));
    fireEvent.click(screen.getByRole("button",{name:"Keyboard and gestures"}));
    fireEvent.click(screen.getByRole("button",{name:"Toolbar keys and order"}));
    fireEvent.click(screen.getByRole("button", {name: "ctrl"}));
    fireEvent.click(screen.getByRole("button", {name: "Move ctrl earlier"}));
    expect(toolbarRows(getPreferences().toolbar)[1].slice(0, 2)).toEqual(["ctrl", "shift"]);
    fireEvent.click(screen.getByRole("button",{name:"Back"}));
    fireEvent.click(screen.getByRole("button",{name:"Back"}));
    fireEvent.click(screen.getByRole("button",{name:"Appearance and fonts"}));
    fireEvent.click(screen.getByText("Import and share theme",{exact:true}));
    fireEvent.change(screen.getByLabelText("Theme JSON or share code"), {target: {value: '{"background":"url(https://bad)","foreground":"#ffffff"}'}});
    fireEvent.click(screen.getByRole("button", {name: "Preview theme"}));
    expect(screen.getByText(/Invalid theme color/).getAttribute('role')).toBe('status');
    expect(getPreferences().customTheme).toBeUndefined();
    fireEvent.click(screen.getByRole("button",{name:"Back"}));
    fireEvent.click(screen.getByRole("button",{name:"Reset settings"}));
    fireEvent.click(screen.getByRole("button", {name: "Reset preferences"}));
    expect(getPreferences()).toEqual(defaults);
  });
});

function expectRejectedShortcutDrafts(values: string[]) {
  for (const text of values) {
      fireEvent.change(screen.getByLabelText('Custom shortcut text'),{target:{value:text}});
      fireEvent.click(screen.getByRole('button',{name:'Add chord'}));
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByLabelText<HTMLTextAreaElement>('Custom shortcut text').value).toBe(text);
      expect(getPreferences().chords).toEqual([]);
  }
}


it('navigates category pages and preserves an unsaved snippet and restored list focus',()=>{
  savePreferences({...defaults});
  const {container}=render(<PreferencesPanel/>);
  expect(container.querySelectorAll('[data-settings-page]:not([hidden])')).toHaveLength(0);
  const input=screen.getByRole('button',{name:'Keyboard and gestures'});fireEvent.click(input);
  fireEvent.click(screen.getByRole('button',{name:'Text snippets'}));
  const name=screen.getByLabelText('Snippet name'),text=screen.getByLabelText('Snippet text');
  fireEvent.change(name,{target:{value:'Unsent draft'}});fireEvent.change(text,{target:{value:' exact draft '}});
  fireEvent.click(screen.getByRole('button',{name:'Back'}));
  expect(screen.getByRole('button',{name:'Text snippets'})).toBe(document.activeElement);
  fireEvent.click(screen.getByRole('button',{name:'Back'}));
  expect(input).toBe(document.activeElement);
  fireEvent.click(screen.getByRole('button',{name:'Appearance and fonts'}));
  expect(screen.getByRole('spinbutton',{name:'Font size'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Back'}));
  fireEvent.click(input);fireEvent.click(screen.getByRole('button',{name:'Text snippets'}));
  expect(screen.getByLabelText('Snippet text')).toBe(text);
  expect(name).toHaveProperty('value','Unsent draft');expect(text).toHaveProperty('value',' exact draft ');
  expect(getPreferences().snippets).toEqual(defaults.snippets);
});
