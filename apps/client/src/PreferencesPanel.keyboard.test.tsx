// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, within } from "@testing-library/react";
import {mountPreferences,showingPage} from "./test/preferencesPanel";
import {budgetStyleLookups} from "./test/styleBudget";
import { defaults, getPreferences, parseChord, savePreferences, toolbarRows } from "./preferences";
afterEach(() => cleanup());
budgetStyleLookups(1150);

describe("keyboard settings", () => {
  it('keeps Advanced default and existing records, while saving Simple text verbatim', () => {
    savePreferences({...defaults,chords:[{label:'Existing',keys:'F12, M-h'}]});
    const page=mountPreferences('Keyboard and gestures','Keyboard chords');
    expect(page.getByLabelText<HTMLSelectElement>('Shortcut builder').value).toBe('advanced');
    fireEvent.change(page.getByLabelText('Shortcut builder'),{target:{value:'simple'}});
    fireEvent.change(page.getByLabelText('Chord name'),{target:{value:'Literal'}});
    fireEvent.change(page.getByLabelText('Custom shortcut text'),{target:{value:' 你好,, world '}});
    fireEvent.click(page.getByRole('button',{name:'Add chord'}));
    expect(getPreferences().chords).toEqual([{label:'Existing',keys:'F12, M-h'},{label:'Literal',keys:'text: 你好,, world '}]);
    fireEvent.change(page.getByLabelText('Chord name'),{target:{value:'Prefix'}});
    fireEvent.click(page.getByLabelText('Control'));
    fireEvent.change(page.getByLabelText('Custom shortcut text'),{target:{value:'b1'}});
    fireEvent.click(page.getByRole('button',{name:'Add chord'}));
    expect(parseChord(getPreferences().chords[2].keys)).toBe('\x021');
    fireEvent.change(page.getByLabelText('Shortcut builder'),{target:{value:'advanced'}});
    fireEvent.change(page.getByLabelText('Chord name'),{target:{value:'Advanced literal'}});
    fireEvent.change(page.getByLabelText('Key sequence'),{target:{value:'text: trailing '}});
    fireEvent.click(page.getByRole('button',{name:'Add chord'}));
    expect(getPreferences().chords[3].keys).toBe('text: trailing ');
  });
  it('reports Simple validation errors and retains the complete unsaved input', () => {
    savePreferences({...defaults});
    const page=mountPreferences('Keyboard and gestures','Keyboard chords');
    fireEvent.change(page.getByLabelText('Shortcut builder'),{target:{value:'simple'}});
    fireEvent.change(page.getByLabelText('Chord name'),{target:{value:'Unsent'}});
    expectRejectedShortcutDrafts(page,['a'.repeat(124),'a'.repeat(200),'a\nb']);
    fireEvent.click(page.getByLabelText('Control'));
    expectRejectedShortcutDrafts(page,['b你好','abcdefghi','a,','1']);
  });
  it("sets the toolbar key height with a bounded slider, shows it live and resets to the default size", () => {
    savePreferences({...defaults});
    const page=mountPreferences('Keyboard and gestures', 'Toolbar keys and order');
    const slider = page.getByLabelText<HTMLInputElement>("Toolbar key height");
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(["28", "56", "2", "32"]);
    expect(slider.getAttribute("aria-valuetext")).toBe("32 px");
    const preview = document.querySelector<HTMLElement>(".toolbar-preview-keys")!;
    expect(preview.style.getPropertyValue("--terminal-key-height")).toBe("32px");
    const reset = page.getByRole("button", {name: "Default size"});
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
    const page=mountPreferences('Keyboard and gestures', 'Toolbar keys and order');
    const status = within(document.querySelector<HTMLElement>("[data-settings-page=\"preferencesToolbarKeysAndOrder\"]")!).getByRole("status");
    fireEvent.change(page.getByLabelText("Toolbar rows"), {target: {value: "2"}});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["esc", "ctrl", "tab"], []]);
    const tab = page.getByRole("button", {name: "tab"});
    tab.focus();
    fireEvent.keyDown(tab, {key: "ArrowDown", altKey: true});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["esc", "ctrl"], ["tab"]]);
    expect(status.textContent).toBe("tab moved to row 2, position 1");
    expect(document.activeElement).toBe(page.getByRole("button", {name: "tab"}));
    fireEvent.keyDown(document.activeElement!, {key: "ArrowLeft", altKey: true});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["esc", "ctrl", "tab"], []]);
    fireEvent.keyDown(page.getByRole("button", {name: "esc"}), {key: "ArrowLeft", altKey: true});
    expect(status.textContent).toBe("esc cannot move further");
    // A single tap opens the same moves for pointer and screen-reader users.
    fireEvent.click(page.getByRole("button", {name: "esc"}));
    const actions = page.getByRole("group", {name: "Move esc"});
    expect(document.activeElement).toBe(actions.querySelector("button"));
    fireEvent.click(page.getByRole("button", {name: "Move esc to row 2"}));
    fireEvent.click(page.getByRole("button", {name: "Move esc later"}));
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["ctrl", "tab"], ["esc"]]);
    // Escape closes the key actions first instead of leaving the settings page.
    fireEvent.keyDown(document.activeElement!, {key: "Escape"});
    expect(page.queryByRole("group", {name: "Move esc"})).toBeNull();
    // The page is the region itself, so it is queried from the detail area that holds it.
    expect(within(document.querySelector<HTMLElement>(".settings-detail")!).getByRole("region", {name: "Toolbar keys and order"}).hidden).toBe(false);
    expect(document.activeElement).toBe(page.getByRole("button", {name: "esc"}));
    fireEvent.keyDown(document.activeElement!, {key: "Delete"});
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["ctrl", "tab"], []]);
    expect(status.textContent).toBe("esc removed");
    expect(document.activeElement).toBe(page.getByRole("button", {name: "Add esc"}));
    fireEvent.click(page.getByRole("button", {name: "Add esc"}));
    expect(toolbarRows(getPreferences().toolbar)).toEqual([["ctrl", "tab"], ["esc"]]);
    expect(status.textContent).toBe("esc added to row 2, position 1");
    fireEvent.change(page.getByLabelText("Toolbar rows"), {target: {value: "1"}});
    expect(getPreferences().toolbar).toEqual(["ctrl", "tab", "esc"]);
  });
});

function expectRejectedShortcutDrafts(page: ReturnType<typeof showingPage>, values: string[]) {
  for (const text of values) {
      fireEvent.change(page.getByLabelText('Custom shortcut text'),{target:{value:text}});
      fireEvent.click(page.getByRole('button',{name:'Add chord'}));
      expect(page.getByRole('alert')).toBeTruthy();
      expect(page.getByLabelText<HTMLTextAreaElement>('Custom shortcut text').value).toBe(text);
      expect(getPreferences().chords).toEqual([]);
  }
}

